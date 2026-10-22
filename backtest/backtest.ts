// 回测脚本（PRD M1 + 裁决记录 §3-3）：与实盘同一套纯函数引擎。
// 数据：Gate.io 期货 K 线公开 API，30M 蜡烛逐根推进（Q19/Q24）。
// 用法：npx tsx backtest/backtest.ts [BTC|XAU] [天数=14] [--old]
//   --old = 旧口径（单根收盘 BOS、扫荡唯一扳机、5m 重采样），用于 A/B 对照。
//
// 新口径（Q12–Q24）：4H+30M；摆动点=收线回头根；BOS=连续两根收盘；
// 扳机=扫荡或背离（背离半仓）；POI=FVG 独占（30 根生命周期）；止损=背离低点/结构点。
// 模拟对齐实盘 signalRunner：时段过滤（北京时间 20:00–24:00）、周五尾盘禁开、checkRisk。
import type { Candle } from "../convex/indicators";
import { swingPoints, bosEvents, mssAfter, atr14, detectDivergence, fvgZones, chochAfter } from "../convex/indicators";
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
  let stats = { trigSweep: 0, trigDiv: 0, noTrig: 0, noPoi: 0, noMss: 0, rrReject: 0, noTarget: 0, stopTooFar: 0, dupSetup: 0, rrAbsurd: 0 };

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
      // 扫荡方向按影线刺穿侧判定：下刺（low<level 且收回上方）=抓下方流动性，极值=low；上刺反之
      const sweptLow = c.low < lvl.price && c.close > lvl.price;
      const sweptHigh = c.high > lvl.price && c.close < lvl.price;
      const swept = sweptLow || sweptHigh;
      const broken = c.close < lvl.price - atrBuf || c.close > lvl.price + atrBuf;
      if (lvl.status === "untouched") {
        if (swept) { lvl.status = "swept"; lvl.sweptTime = c.openTime; lvl.sweepExtreme = sweptLow ? c.low : c.high; }
        else if (broken) { lvl.status = "broken"; }
      } else if (lvl.status === "broken") {
        const backInside = lvl.price > c.close ? c.close > lvl.price - atrBuf : c.close < lvl.price + atrBuf;
        if (backInside) { lvl.status = "swept"; lvl.sweptTime = c.openTime; lvl.sweepExtreme = c.close > lvl.price ? c.low : c.high; }
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
      .map((l) => ({ kind: l.kind, price: l.price, status: "swept", sweptTime: l.sweptTime, sweepExtreme: l.sweepExtreme }));
    const div = detectDivergence(m30, 6);
    const divOk = div !== null && div.direction === (dir === "up" ? "long" : "short");
    const swept = sweptLevels.length
      ? sweptLevels.reduce((a, b) => ((b.sweptTime ?? 0) > (a.sweptTime ?? 0) ? b : a))
      : null;
    if (!swept && !divOk) { stats.noTrig++; continue; }
    const trigger: "sweep" | "divergence" = swept ? "sweep" : "divergence";
    if (trigger === "sweep") stats.trigSweep++; else stats.trigDiv++;

    // 8) 第 3 层：MSS + 转势位（2026-10-22 晚重排，用户裁决「先改」）：
    // 体系主锚是「转」（05 篇 §6 ①-⑤）：MSS 确认后用 chochAfter 定位转势位
    // （结局点与被结局高/低点之间的极值点，连续两根收盘突破=转确认）。
    const triggerTime = trigger === "sweep" ? (swept!.sweptTime ?? 0) : (div!.time ?? 0);
    const mss = mssAfter(m30, triggerTime, dir, 6);
    if (!mss) { stats.noMss++; continue; }
    const choch = chochAfter(m30, triggerTime, dir, 6);
    if (!choch) { stats.noMss++; continue; } // 无转势位=体系里「没有入场锚」→ 不做
    // 转势位锚点：「那个低点」（05 篇 §7 步骤 7）——多头=转势低点，空头=转势高点
    const chochLevel = dir === "up" ? choch.pivotLow : choch.pivotHigh;
    const atr30 = atr14(m30);

    // 9) 第 4 层：FVG POI
    const zones = fvgZones(m30, m30.length - 1, 30);
    const poi = zones.filter((z) =>
      dir === "up" ? z.direction === "long" : z.direction === "short",
    )[ zones.length ? zones.length - 1 : 0 ];
    const poiList = zones.filter((z) => (dir === "up" ? z.direction === "long" : z.direction === "short"));
    if (!poiList.length) { stats.noPoi++; continue; }
    // POI 选择（2026-10-22 晚重排）：取「转位回踩路径上」最近的 FVG——
    // 多头=low 在转势位上方（回踩先到 FVG 再到转位）；且距离转位 ≤1×ATR。全都不满足才算「无 FVG」。
    const chochLv = dir === "up" ? choch.pivotLow : choch.pivotHigh;
    const onPath = poiList.filter((z) => {
      const edge = dir === "up" ? z.high : z.low;
      return dir === "up"
        ? edge >= chochLv && edge - chochLv <= 1.0 * atr30
        : edge <= chochLv && chochLv - edge <= 1.0 * atr30;
    });
    if (!onPath.length) { stats.noPoi++; continue; }
    const poiFinal = onPath[onPath.length - 1]!;
    void poi;

    // 10) 第 5 层（S6/S7）：MSS 后 12 根窗口内等待回踩+形态；市价追单路径
    // MSS 蜡烛在 m30 中的索引
    const mssIdx = m30.findIndex((c) => c.openTime === mss.time);
    if (mssIdx < 0) continue;
    const dirLong = dir === "up";
    // 入场区（2026-10-22 晚重排）：回踩必须「到转位以内」（19 篇 §1）——
    // 多头回踩触及 chochLevel（转势低点）及其上方缓冲；FVG 作为确认条件须与转位相邻（≤0.5×ATR）。
    const entryZoneEdge = dirLong ? chochLevel : chochLevel; // 回踩目标边=转势位
    const poiEdge = dirLong ? poiFinal.high : poiFinal.low;
    // FVG 须在回踩路径上：多头=入场边（FVG 高缘）在转位上方 ≤1×ATR（回踩能同时经过 FVG 到转位）
    const fvgNearChoch = dirLong
      ? poiEdge >= chochLevel && poiEdge - chochLevel <= 1.0 * atr30
      : poiEdge <= chochLevel && chochLevel - poiEdge <= 1.0 * atr30;
    if (!fvgNearChoch) { stats.noPoi++; continue; } // FVG 不在转位回踩路径上=不是体系入场区
    const winBars = m30.slice(mssIdx); // MSS 蜡烛起至当前
    let marketChase = false;
    let hitKind: string | null = null;
    let hitBar: typeof m30[number] | null = null;
    for (const c of winBars) {
      // 回踩到转位以内：影线触及 [chochLevel, poiEdge] 区间（多头）或 [poiEdge, chochLevel]（空头）
      const zLo = Math.min(chochLevel, poiEdge), zHi = Math.max(chochLevel, poiEdge);
      const touched = c.low <= zHi && c.high >= zLo;
      const walkedAway = dirLong ? c.close - poiEdge > atr30 : poiEdge - c.close > atr30;
      if (walkedAway && !touched) {
        const earlierTouch = winBars.slice(0, winBars.indexOf(c)).some(
          (p) => p.low <= poiFinal.high && p.high >= poiFinal.low,
        );
        if (!earlierTouch) { marketChase = true; hitKind = "marketChase"; hitBar = c; break; }
      }
      if (touched) {
        const idx = winBars.indexOf(c);
        for (let j = idx; j <= Math.min(idx + 1, winBars.length - 1); j++) {
          const seg = m30.slice(0, m30.indexOf(winBars[j]!) + 1);
          const lc = seg[seg.length - 1]!, pv = seg[seg.length - 2]!;
          const kind =
            (dirLong && lc.close > lc.open && lc.close > pv.high) ||
            (!dirLong && lc.close < lc.open && lc.close < pv.low)
              ? "engulf"
              : (dirLong && lc.low < poiFinal.low && lc.close > poiFinal.low) ||
                (!dirLong && lc.high > poiFinal.high && lc.close < poiFinal.high)
                ? "sweepReversal"
                : (dirLong && lc.close > pv.high && lc.close > lc.open) ||
                  (!dirLong && lc.close < pv.low && lc.close < lc.open)
                  ? "choch" : null;
          if (kind) { hitKind = kind; hitBar = winBars[j]!; break; }
        }
        if (hitKind) break;
      }
    }
    if (!hitKind) continue;
    const triggerKind = hitKind;

    // 11) 入场/止损/止盈
    const direction: "long" | "short" = dirLong ? "long" : "short";
    const entryRef = dirLong ? poiFinal.high : poiFinal.low;
    let stopRef: number;
    if (trigger === "divergence") {
      const divLevel = dirLong ? (div!.divergenceLow ?? poiFinal.low) : (div!.divergenceHigh ?? poiFinal.high);
      stopRef = dirLong ? divLevel - 0.05 * atr30 : divLevel + 0.05 * atr30;
    } else {
      // 止损（2026-10-22 晚重排）：挂「那个低点」=转势位外侧（05 篇 §7 步骤 7；03 篇背离低点同理）。
      // 转势位=最后一次进攻的起点，价格回到它下方=转失败。
      stopRef = dirLong
        ? chochLevel - 0.2 * atr30
        : chochLevel + 0.2 * atr30;
    }
    if (Math.abs(entryRef - stopRef) > 1.6 * atr30) { stats.stopTooFar++; continue; }
    const risk = Math.abs(entryRef - stopRef);
    // 止盈（用户裁决 ②B）：打【大池子】——昨日高低 / 亚洲盘高低优先，其次 swing 摆动位；
    // 只要求顺方向未破（swept 未收回的仍可作为目标），距离 ≥1×ATR 过滤路边的微小位。
    const bigFirst = (k: string) => (k === "prevDayHigh" || k === "prevDayLow" || k === "asiaHigh" || k === "asiaLow") ? 0 : 1;
    const bigTargets = levels
      .filter((l) => l.status !== "broken")
      .map((l) => l.price)
      .filter((p) => (dirLong ? p > entryRef : p < entryRef))
      .filter((p) => Math.abs(p - entryRef) >= atr30);
    const kindOf = new Map(levels.map((l) => [l.price, l.kind]));
    bigTargets.sort((a, b) => {
      const ka = bigFirst(kindOf.get(a) ?? ""), kb = bigFirst(kindOf.get(b) ?? "");
      if (ka !== kb) return ka - kb;
      return dirLong ? a - b : b - a;
    });
    if (!bigTargets.length) { stats.noTarget++; continue; }
    let tp = bigTargets[0]!;
    let rr = Math.abs(tp - entryRef) / risk;
    if (rr < DEFAULT_PARAMS.minRR) { stats.rrReject++; continue; }

    // 12) 信号幂等 + 开仓（Q14：入场价 = 挂单价 entryRef，触发蜡烛只做确认）
    // 幂等（2026-10-22 补充）：同一 setup 不重复开仓——同方向、同一 FVG（poiFinal）只做一次。
    // 「背离一出，两张单结束」「30 分钟图每天 2-3 单」：同 setup 打两笔违反纪律。
    const trigRef = trigger === "sweep" ? swept!.price : (dirLong ? div!.divergenceLow : div!.divergenceHigh) ?? 0;
    const signalNo = `${symbol}_${trigger}_${trigRef}_${mss.time}_${direction}`;
    if (trades.some((t) => t.signalNo === signalNo)) continue;
    const sameSetup = trades.find(
      (t) => t.symbol === symbol && t.direction === direction &&
        Math.abs(t.entry - entryRef) < 0.25 * atr30, // 入场价差 <0.25×ATR 视为同一 FVG
    );
    if (sameSetup) { stats.dupSetup = (stats.dupSetup ?? 0) + 1; continue; }
    // 目标选择（查尔斯口径）：顺方向**最近的**结构性流动性——「先看前低/前高」，不是最远水平。
    // RR 上限 5：波动定预期（03 篇规则 11），RR>5 说明目标选错或止损过窄。
    // RR>5（波动定预期，03 篇规则 11）：大池子太远 → 降级取顺方向最近 swing 目标；仍>5 才拒
    if (rr > 5) {
      const nearSwing = levels
        .filter((l) => l.kind.startsWith("swing") && l.status !== "broken")
        .map((l) => l.price)
        .filter((p) => (dirLong ? p > entryRef : p < entryRef))
        .sort((a, b) => (dirLong ? a - b : b - a))[0];
      if (nearSwing) {
        const rr2 = Math.abs(nearSwing - entryRef) / risk;
        // 降级目标必须仍在 [minRR, 5] 带内，否则=无明确目标位，不做（19 篇 §4）
        if (rr2 >= DEFAULT_PARAMS.minRR && rr2 <= 5) {
          tp = nearSwing;
          rr = rr2;
        } else { stats.rrAbsurd = (stats.rrAbsurd ?? 0) + 1; continue; }
      } else { stats.rrAbsurd = (stats.rrAbsurd ?? 0) + 1; continue; }
    }

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
  console.log(`拒绝统计: 无扳机 ${stats.noTrig} | 无MSS ${stats.noMss} | 无FVG ${stats.noPoi} | 止损超限 ${stats.stopTooFar} | RR不足 ${stats.rrReject} | RR离谱 ${stats.rrAbsurd} | 重复setup ${stats.dupSetup} | 无目标 ${stats.noTarget}`);
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
