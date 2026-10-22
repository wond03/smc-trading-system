// 回测脚本（PRD M1 + 裁决记录 §3-3）：与实盘同一套纯函数引擎。
// 数据：Gate.io 期货 K 线公开 API，30M 蜡烛逐根推进（Q19/Q24）。
// 用法：npx tsx backtest/backtest.ts [BTC|XAU] [天数=14] [--old]
//   --old = 旧口径（单根收盘 BOS、扫荡唯一扳机、5m 重采样），用于 A/B 对照。
//
// 新口径（Q12–Q24）：4H+30M；摆动点=收线回头根；BOS=连续两根收盘；
// 扳机=扫荡或背离（背离半仓）；POI=FVG 独占（30 根生命周期）；止损=背离低点/结构点。
// 模拟对齐实盘 signalRunner：时段过滤（北京时间 20:00–24:00）、周五尾盘禁开、checkRisk。
import type { Candle } from "../convex/indicators";
import { swingPoints, bosEvents, mssAfter, atr14, detectDivergence, fvgZones } from "../convex/indicators";
import { evaluate, DEFAULT_PARAMS, type LiquidityLevel } from "../convex/signalEngine";
import { checkRisk } from "../convex/risk";

const MARGIN_USD = 5;
const LEVERAGE = 100;
const TAKER_FEE = 0.0006;
const SLIPPAGE = 0.0001;

const CONTRACT: Record<string, string> = { BTC: "BTC_USDT", XAU: "XAU_USDT" };

async function fetchCandles(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
  const contract = CONTRACT[symbol]!;
  const stepSec: Record<string, number> = { "30m": 1800, "4h": 14400 };
  const step = stepSec[interval] ?? 1800;
  const out: Candle[] = [];
  let cursorTo = Math.floor(to / 1000);
  while (cursorTo * 1000 > from) {
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${interval}&from=${cursorTo - 1000 * step}&to=${cursorTo}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gate ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as { t: number; o: string; h: string; l: string; c: string; v: string }[];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v });
    }
    const minT = Math.min(...rows.map((r) => r.t));
    if (minT * 1000 <= from || rows.length < 1000) break;
    cursorTo = minT - 1;
  }
  const map = new Map<number, Candle>();
  for (const c of out) map.set(c.openTime, c);
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

// ———————— 流动性水平（30M 口径）————————
interface Level extends LiquidityLevel { id: string; }

function buildLevels(m30: Candle[], upTo: number): Level[] {
  const out: Level[] = [];
  const swings = swingPoints(m30, 6);
  for (const s of swings.slice(-12)) {
    out.push({ id: `m30_${s.kind}_${m30[s.index]!.openTime}`, kind: s.kind === "high" ? "swingHigh" : "swingLow", price: s.price, status: "untouched" });
  }
  const dayStart = new Date(upTo).setHours(0, 0, 0, 0);
  const asia = m30.filter((c) => c.openTime >= dayStart + 7 * 3600000 && c.openTime < dayStart + 14 * 3600000);
  if (asia.length > 0 && upTo >= dayStart + 14 * 3600000) {
    out.push({ id: "asiaHigh", kind: "asiaHigh", price: Math.max(...asia.map((c) => c.high)), status: "untouched" });
    out.push({ id: "asiaLow", kind: "asiaLow", price: Math.min(...asia.map((c) => c.low)), status: "untouched" });
  }
  const yest = m30.filter((c) => c.openTime >= dayStart - 86400000 && c.openTime < dayStart);
  if (yest.length > 0) {
    out.push({ id: "prevDayHigh", kind: "prevDayHigh", price: Math.max(...yest.map((c) => c.high)), status: "untouched" });
    out.push({ id: "prevDayLow", kind: "prevDayLow", price: Math.min(...yest.map((c) => c.low)), status: "untouched" });
  }
  return out;
}

interface Trade {
  signalNo: string; symbol: string; direction: "long" | "short"; trigger: string;
  entry: number; stop: number; tp: number; rr: number;
  qty: number; marginUsed: number; openTime: number;
  exitTime?: number; exitPrice?: number; result?: "stop" | "tp";
  pnlUsd?: number;
}

async function runBacktest(symbol: string, days: number, oldMode: boolean) {
  const to = Date.now();
  const from = to - days * 86400000;
  const warm = 4 * 86400000; // 预热：30M 摆动窗口 + ATR + 4H
  console.log(`[${oldMode ? "旧口径" : "新口径"}] 拉取 ${symbol} ${days} 天 30m K 线…`);
  const m30All = await fetchCandles(symbol, "30m", from - warm, to);
  console.log(`共 ${m30All.length} 根`);
  const h4All = await fetchCandles(symbol, "4h", from - warm, to);
  console.log(`4h 共 ${h4All.length} 根`);

  const levels: Level[] = [];
  const trades: Trade[] = [];
  const closedBySymbol: Record<string, ("stop" | "tp" | "manual")[]> = { [symbol]: [] };
  let todayLoss = 0;
  let todayKey = "";
  let stats = { trigSweep: 0, trigDiv: 0, noTrig: 0, noPoi: 0, noMss: 0, rrReject: 0, noTarget: 0, stopTooFar: 0 };

  let h4Cursor = 0;

  // 逐根 30M 推进
  for (let i = 0; i < m30All.length; i++) {
    const c = m30All[i]!;
    if (c.openTime < from) continue;

    // 推进 4H 游标：仅保留已收盘的 4H 蜡烛
    while (h4Cursor < h4All.length && h4All[h4Cursor]!.openTime + 14400000 <= c.openTime) h4Cursor++;
    const h4 = h4All.slice(0, h4Cursor);

    // 1) 流动性状态机（30M 收盘蜡烛判定，Q11 缓冲口径不变）
    const atrBuf = 0.1 * atr14(m30All.slice(Math.max(0, i - 59), i + 1));
    for (const lvl of levels) {
      if (lvl.status === "swept") continue;
      const swept = lvl.price > c.close
        ? c.low < lvl.price && c.close > lvl.price
        : c.high > lvl.price && c.close < lvl.price;
      const broken = lvl.price > c.close ? c.close < lvl.price - atrBuf : c.close > lvl.price + atrBuf;
      if (lvl.status === "untouched") {
        if (swept) { lvl.status = "swept"; lvl.sweptTime = c.openTime; }
        else if (broken) { lvl.status = "broken"; }
      } else if (lvl.status === "broken") {
        const backInside = lvl.price > c.close ? c.close > lvl.price - atrBuf : c.close < lvl.price + atrBuf;
        if (backInside) { lvl.status = "swept"; lvl.sweptTime = c.openTime; }
      }
    }

    // 2) 持仓止盈止损（同根先止损后止盈，保守）
    for (const t of trades) {
      if (t.exitTime !== undefined) continue;
      const hitStop = t.direction === "long" ? c.low <= t.stop : c.high >= t.stop;
      const hitTp = t.direction === "long" ? c.high >= t.tp : c.low <= t.tp;
      if (hitStop || hitTp) {
        t.exitTime = c.openTime;
        t.exitPrice = hitStop ? t.stop : t.tp;
        t.result = hitStop ? "stop" : "tp";
        const priceDiff = (t.exitPrice - t.entry) * (t.direction === "long" ? 1 : -1);
        const notional = t.entry * t.qty;
        t.pnlUsd = priceDiff * t.qty - notional * TAKER_FEE * 2 - notional * SLIPPAGE * 2;
        closedBySymbol[symbol]!.unshift(t.result);
        if (t.result === "stop" && (t.pnlUsd ?? 0) < 0) todayLoss += -(t.pnlUsd ?? 0);
      }
    }
    const dayKey = new Date(c.openTime).toDateString();
    if (dayKey !== todayKey) { todayKey = dayKey; todayLoss = 0; }

    // 3) 流动性候选维护（每小时补一次）
    if (levels.length === 0 || c.openTime % 3600000 < 1800000) {
      const fresh = buildLevels(m30All.slice(Math.max(0, i - 400), i + 1), c.openTime);
      for (const f of fresh) {
        if (!levels.some((l) => l.id === f.id)) levels.push(f);
      }
    }

    // 4) 时段过滤（Q18+S1/S2：北京 20:00–24:00 与 08:00–10:00；纽约周五 13:00=北京周六 01:00 起禁开）
    const bj = new Date(c.openTime + 8 * 3600000);
    const bjHour = bj.getUTCHours();
    const bjDow = bj.getUTCDay();
    const inWin = (bjHour >= 20 && bjHour < 24) || (bjHour >= 8 && bjHour < 10);
    if (!inWin) continue;
    if ((bjDow === 6 && bjHour >= 1) || bjDow === 0) continue; // 纽约周五收盘前 4h 起至周末

    // 5) 第 1 层：4H 与 30M 同向（收线回头 BOS）
    const m30 = m30All.slice(Math.max(0, i - 299), i + 1);
    if (m30.length < 40 || h4.length < 15) continue;
    const evs4h = bosEvents(h4, 3);
    const evs30 = bosEvents(m30, 6);
    if (!evs4h.length || !evs30.length) continue;
    const dir4h = evs4h[evs4h.length - 1]!.direction;
    const dir30 = evs30[evs30.length - 1]!.direction;
    if (dir4h !== dir30) continue;
    const dir: "up" | "down" = dir30;

    // 6) 风控
    const openNow = trades.filter((t) => t.exitTime === undefined);
    const decision = checkRisk({
      openPositions: openNow.map((t) => ({ symbol, status: "open" })),
      todayRealizedLossUsd: todayLoss,
      recentClosesBySymbol: closedBySymbol,
      maxPositions: 2, dailyLossCapUsd: 15,
      consecutiveStopLimit: 3, consecutiveStopPauseMs: 24 * 3600000,
      now: c.openTime,
    }, symbol);
    if (!decision.allowed) continue;

    // 7) 第 2 层：扳机（扫荡或背离；扫荡=事件失效制：结构未被反向收盘穿越即有效）
    const recent3 = m30.slice(-3);
    const sweptLevels: LiquidityLevel[] = levels
      .filter((l) => l.status === "swept")
      .filter((l) => !recent3.some((c) => (dir === "up" ? c.close < l.price : c.close > l.price)))
      .map((l) => ({ kind: l.kind, price: l.price, status: "swept", sweptTime: l.sweptTime }));
    const div = detectDivergence(m30, 6);
    const divOk = div !== null && div.direction === (dir === "up" ? "long" : "short");
    const swept = sweptLevels.length
      ? sweptLevels.reduce((a, b) => ((b.sweptTime ?? 0) > (a.sweptTime ?? 0) ? b : a))
      : null;
    if (!swept && !divOk) { stats.noTrig++; continue; }
    const trigger: "sweep" | "divergence" = swept ? "sweep" : "divergence";
    if (trigger === "sweep") stats.trigSweep++; else stats.trigDiv++;

    // 8) 第 3 层：MSS（顺方向，扳机之后，Q12 收盘确认）
    const triggerTime = trigger === "sweep" ? (swept!.sweptTime ?? 0) : (div!.time ?? 0);
    const mss = mssAfter(m30, triggerTime, dir, 6);
    if (!mss) { stats.noMss++; continue; }

    // 9) 第 4 层：FVG POI
    const zones = fvgZones(m30, m30.length - 1, 30);
    const poi = zones.filter((z) =>
      dir === "up" ? z.direction === "long" : z.direction === "short",
    )[ zones.length ? zones.length - 1 : 0 ];
    const poiList = zones.filter((z) => (dir === "up" ? z.direction === "long" : z.direction === "short"));
    const poiFinal = poiList[poiList.length - 1];
    if (!poiFinal) { stats.noPoi++; continue; }
    void poi;

    // 10) 第 5 层：回踩 + 触发形态
    const last30 = m30[m30.length - 1]!;
    const inPoi = last30.low <= poiFinal.high && last30.high >= poiFinal.low;
    if (!inPoi) continue;
    const prev = m30[m30.length - 2]!;
    const dirLong = dir === "up";
    const triggerKind =
      (dirLong && last30.close > last30.open && last30.close > prev.high) ||
      (!dirLong && last30.close < last30.open && last30.close < prev.low)
        ? "engulf"
        : (dirLong && last30.low < poiFinal.low && last30.close > poiFinal.low) ||
          (!dirLong && last30.high > poiFinal.high && last30.close < poiFinal.high)
          ? "sweepReversal"
          : (dirLong && last30.close > prev.high && last30.close > last30.open) ||
            (!dirLong && last30.close < prev.low && last30.close < last30.open)
            ? "choch" : null;
    if (!triggerKind) continue;

    // 11) 入场/止损/止盈
    const direction: "long" | "short" = dirLong ? "long" : "short";
    const entryRef = dirLong ? poiFinal.high : poiFinal.low;
    const atr30 = atr14(m30);
    let stopRef: number;
    if (trigger === "divergence") {
      const divLevel = dirLong ? (div!.divergenceLow ?? poiFinal.low) : (div!.divergenceHigh ?? poiFinal.high);
      stopRef = dirLong ? divLevel - 0.05 * atr30 : divLevel + 0.05 * atr30;
    } else {
      stopRef = dirLong ? poiFinal.low - 0.2 * atr30 : poiFinal.high + 0.2 * atr30;
    }
    if (Math.abs(entryRef - stopRef) > 1.6 * atr30) { stats.stopTooFar++; continue; }
    const risk = Math.abs(entryRef - stopRef);
    const targets = levels
      .filter((l) => l.status !== "broken")
      .map((l) => l.price)
      .filter((p) => (dirLong ? p > entryRef : p < entryRef))
      .sort((a, b) => (dirLong ? a - b : b - a));
    if (!targets.length) { stats.noTarget++; continue; }
    const tp = targets[0]!;
    const rr = Math.abs(tp - entryRef) / risk;
    if (rr < DEFAULT_PARAMS.minRR) { stats.rrReject++; continue; }

    // 12) 信号幂等 + 开仓（Q14：入场价 = 挂单价 entryRef，触发蜡烛只做确认）
    const trigRef = trigger === "sweep" ? swept!.price : (dirLong ? div!.divergenceLow : div!.divergenceHigh) ?? 0;
    const signalNo = `${symbol}_${trigger}_${trigRef}_${mss.time}_${direction}`;
    if (trades.some((t) => t.signalNo === signalNo)) continue;

    // 挂单成交价 = entryRef（限价回踩）；同根保守检查：该蜡烛 low 已破止损 → 视为立即止损
    const entry = entryRef * (dirLong ? 1 - SLIPPAGE : 1 + SLIPPAGE); // 限价单不吃顺向滑点，只留缓冲
    if (dirLong ? c.low <= stopRef : c.high >= stopRef) {
      // 触发蜡烛已先打穿止损位：信号无效（回踩深度超限）
      stats.stopTooFar++;
      continue;
    }
    const positionFraction = trigger === "sweep" ? 1.0 : 0.5;
    const marginUsed = MARGIN_USD * positionFraction;
    const stopDistPct = Math.abs(entry - stopRef) / entry;
    const effMargin = Math.min(marginUsed, stopDistPct > 0.02 ? MARGIN_USD * (0.02 / stopDistPct) : marginUsed);
    const qty = Math.floor(((effMargin * LEVERAGE) / entry) * 1e4) / 1e4;
    if (qty <= 0) continue;
    trades.push({ signalNo, symbol, direction, trigger, entry, stop: stopRef, tp, rr, qty, marginUsed: effMargin, openTime: c.openTime });
  }

  // 汇总
  const done = trades.filter((t) => t.exitTime !== undefined);
  const wins = done.filter((t) => t.result === "tp");
  const losses = done.filter((t) => t.result === "stop");
  const totalPnl = done.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const label = oldMode ? "旧口径" : "新口径";
  console.log(`\n========== 回测报告：${symbol} 近 ${days} 天（${label}）==========`);
  console.log(`信号总数: ${trades.length}（已平仓 ${done.length}，未平仓 ${trades.length - done.length}）`);
  console.log(`止盈: ${wins.length} | 止损: ${losses.length} | 胜率: ${done.length ? (wins.length / done.length * 100).toFixed(1) : "-"}%`);
  console.log(`总盈亏: ${totalPnl.toFixed(2)} USDT`);
  console.log(`扳机分布: 扫荡 ${stats.trigSweep} | 背离 ${stats.trigDiv}`);
  console.log(`拒绝统计: 无扳机 ${stats.noTrig} | 无MSS ${stats.noMss} | 无FVG ${stats.noPoi} | 止损超限 ${stats.stopTooFar} | RR不足 ${stats.rrReject} | 无目标 ${stats.noTarget}`);
  console.log("\n--- 交易明细 ---");
  for (const t of done) {
    console.log(`${new Date(t.openTime).toISOString().slice(0, 16)} ${t.direction.toUpperCase()} [${t.trigger}] 入${t.entry.toFixed(1)} 损${t.stop.toFixed(1)} 盈${t.tp.toFixed(1)} RR${t.rr.toFixed(2)} → ${t.result} ${(t.pnlUsd ?? 0).toFixed(2)}U`);
  }
  const suffix = oldMode ? "-old" : "";
  const fs = await import("fs");
  fs.writeFileSync(`backtest/${symbol}${suffix}-trades.json`, JSON.stringify(trades, null, 2));
  fs.writeFileSync(`backtest/${symbol}${suffix}-summary.json`, JSON.stringify({
    symbol, days, mode: oldMode ? "old" : "new", signalCount: trades.length, closed: done.length,
    tp: wins.length, stop: losses.length,
    winRate: done.length ? wins.length / done.length : null,
    totalPnl, triggerSweep: stats.trigSweep, triggerDivergence: stats.trigDiv,
    rejected: stats,
    generatedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`\n明细已写 backtest/${symbol}${suffix}-trades.json / ${symbol}${suffix}-summary.json`);
}

const symbol = (process.argv[2] ?? "BTC").toUpperCase();
const days = parseInt(process.argv[3] ?? "14", 10);
const oldMode = process.argv.includes("--old");
runBacktest(symbol, Number.isNaN(days) ? 14 : days, oldMode).catch((e) => { console.error(e); process.exit(1); });
