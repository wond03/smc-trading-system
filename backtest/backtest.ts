// 回测脚本（PRD M1）：与实盘同一套纯函数引擎（indicators/signalEngine/risk）。
// 数据：Gate.io 期货 K 线公开 API，逐根推进模拟已收盘蜡烛。
// 用法：npx tsx backtest/backtest.ts [BTC|XAU] [天数，默认14]
//
// 模拟口径对齐实盘 signalRunner：
//  - 第 1 层：日线 MSS/BOS 方向 + 1h BOS 同向
//  - 第 2 层：流动性水平（1h 摆动点 + 昨日高低 + 亚洲盘高低 + 开盘区间），
//             状态机 untouched→swept/broken 用 5m 收盘蜡烛判定（同 liquidity.ts）
//  - 第 2-5 层：evaluate()（与实盘同一函数）
//  - 风控：checkRisk()（与实盘同一函数）
//  - 开仓价 = 触发时 5m 收盘价；止损止盈按信号引用价；手续费 taker 0.06%×2；滑点 0.01%
import type { Candle } from "../convex/indicators";
import { swingPoints, lastBOS, lastMSS, atr14 } from "../convex/indicators";
import { evaluate, DEFAULT_PARAMS, type LiquidityLevel } from "../convex/signalEngine";
import { checkRisk } from "../convex/risk";

const MARGIN_USD = 5;
const LEVERAGE = 100;
const TAKER_FEE = 0.0006;   // taker 单边 0.06%
const SLIPPAGE = 0.0001;    // 0.01%

// ———————— Gate.io 数据拉取 ————————
const CONTRACT: Record<string, string> = { BTC: "BTC_USDT", XAU: "XAU_USDT" };

async function fetchCandles(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
  const contract = CONTRACT[symbol];
  const out: Candle[] = [];
  // 倒推分页：每次取 [to-1000根, to]，to 前移，直到覆盖 from
  const stepSec: Record<string, number> = { "5m": 300 };
  const step = stepSec[interval] ?? 300;
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
  // 去重排序
  const map = new Map<number, Candle>();
  for (const c of out) map.set(c.openTime, c);
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

function resample(m5: Candle[], mult: number): Candle[] {
  // 5m → 15m/1h/1d 简单重采样
  const bucketMs = 5 * 60000 * mult;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of m5) {
    const b = Math.floor(c.openTime / bucketMs) * bucketMs;
    if (!cur || cur.openTime !== b) {
      if (cur) out.push(cur);
      cur = { openTime: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ———————— 流动性水平（对齐 liquidity.ts 口径）————————
interface Level extends LiquidityLevel { id: string; }

function buildLevels(h1: Candle[], m5: Candle[], upTo: number): Level[] {
  const out: Level[] = [];
  // 1h 摆动点
  const swings = swingPoints(h1);
  for (const s of swings.slice(-10)) {
    out.push({ id: `h1_${s.kind}_${h1[s.index]!.openTime}`, kind: s.kind === "high" ? "swingHigh" : "swingLow", price: s.price, status: "untouched" });
  }
  // 昨日高低 / 亚洲盘高低 / 开盘区间（UTC+8）
  const dayStart = new Date(upTo).setHours(0, 0, 0, 0);
  const asia = m5.filter((c) => c.openTime >= dayStart + 7 * 3600000 && c.openTime < dayStart + 14 * 3600000);
  if (asia.length > 0 && upTo >= dayStart + 14 * 3600000) {
    out.push({ id: "asiaHigh", kind: "asiaHigh", price: Math.max(...asia.map((c) => c.high)), status: "untouched" });
    out.push({ id: "asiaLow", kind: "asiaLow", price: Math.min(...asia.map((c) => c.low)), status: "untouched" });
  }
  const yest = m5.filter((c) => c.openTime >= dayStart - 86400000 && c.openTime < dayStart);
  if (yest.length > 0) {
    out.push({ id: "prevDayHigh", kind: "prevDayHigh", price: Math.max(...yest.map((c) => c.high)), status: "untouched" });
    out.push({ id: "prevDayLow", kind: "prevDayLow", price: Math.min(...yest.map((c) => c.low)), status: "untouched" });
  }
  const or = m5.filter((c) => c.openTime >= dayStart && c.openTime < dayStart + 3600000);
  if (or.length > 0) {
    out.push({ id: "orHigh", kind: "openRangeHigh", price: Math.max(...or.map((c) => c.high)), status: "untouched" });
    out.push({ id: "orLow", kind: "openRangeLow", price: Math.min(...or.map((c) => c.low)), status: "untouched" });
  }
  return out;
}

// ———————— 主循环 ————————
interface Trade {
  signalNo: string; symbol: string; direction: "long" | "short";
  entry: number; stop: number; tp: number; rr: number;
  qty: number; openTime: number;
  exitTime?: number; exitPrice?: number; result?: "stop" | "tp";
  pnlUsd?: number;
}

async function runBacktest(symbol: string, days: number) {
  const to = Date.now();
  const from = to - days * 86400000;
  console.log(`拉取 ${symbol} ${days} 天 5m K 线…`);
  const m5All = await fetchCandles(symbol, "5m", from - 7 * 86400000, to); // Gate 限 10000 根：7 天预热足够 ATR14+摆动点
  console.log(`共 ${m5All.length} 根`);

  const m5Warm = m5All.filter((c) => c.openTime < from);
  const m15Warm = resample(m5Warm, 3);
  const h1Warm = resample(m5Warm, 12);
  const d1Warm = resample(m5Warm, 288);

  const levels: Level[] = [];
  const trades: Trade[] = [];
  const closedBySymbol: Record<string, ("stop" | "tp" | "manual")[]> = { [symbol]: [] };
  let todayLoss = 0;
  let todayKey = "";
  let rejectedNoLiq = 0, rejectedRR = 0, rejectedNoTarget = 0;

  // 逐根 5m 推进（模拟已收盘）
  for (let i = Math.floor(m5All.length * 0); i < m5All.length; i++) {
    const c = m5All[i]!;
    if (c.openTime < from) continue;

    // 1) 更新流动性状态机（Q11 口径：破位超缓冲 + broken→swept 假突破回收）
    const atrBuf = 0.1 * atr14(m5All.slice(Math.max(0, i - 299), i + 1));
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
        // 假突破识别：收盘收回缓冲内侧 → swept
        const backInside = lvl.price > c.close ? c.close > lvl.price - atrBuf : c.close < lvl.price + atrBuf;
        if (backInside) { lvl.status = "swept"; lvl.sweptTime = c.openTime; }
      }
    }

    // 2) 若有持仓，检查止损/止盈触发（保守：同根蜡烛先止损后止盈）
    for (const t of trades) {
      if (t.exitTime !== undefined) continue;
      const hitStop = t.direction === "long" ? c.low <= t.stop : c.high >= t.stop;
      const hitTp = t.direction === "long" ? c.high >= t.tp : c.low <= t.tp;
      if (hitStop) {
        t.exitTime = c.openTime; t.exitPrice = t.stop; t.result = "stop";
        const priceDiff = (t.exitPrice - t.entry) * (t.direction === "long" ? 1 : -1);
        const notional = t.entry * t.qty;
        t.pnlUsd = priceDiff * t.qty - notional * TAKER_FEE * 2 - notional * SLIPPAGE * 2;
        closedBySymbol[symbol]!.unshift("stop");
      } else if (hitTp) {
        t.exitTime = c.openTime; t.exitPrice = t.tp; t.result = "tp";
        const priceDiff = (t.exitPrice - t.entry) * (t.direction === "long" ? 1 : -1);
        const notional = t.entry * t.qty;
        t.pnlUsd = priceDiff * t.qty - notional * TAKER_FEE * 2 - notional * SLIPPAGE * 2;
        closedBySymbol[symbol]!.unshift("tp");
      }
    }

    // 3) 当日亏损累计（R1）
    const dayKey = new Date(c.openTime).toDateString();
    if (dayKey !== todayKey) { todayKey = dayKey; todayLoss = 0; }
    for (const t of trades) {
      if (t.exitTime === c.openTime && t.result === "stop" && t.pnlUsd !== undefined && t.pnlUsd < 0) {
        todayLoss += -t.pnlUsd;
      }
    }

    // 4) 信号判断（与实盘同一套引擎）
    const m5 = m5All.slice(Math.max(0, i - 299), i + 1);
    const m15 = resample(m5, 3);
    const h1 = resample(m5, 12);
    const d1 = resample(m5, 288);
    if (m5.length < 50 || d1.length < 3) continue;

    const dailyMss = lastMSS(d1, "up");
    const bos = lastBOS(h1);
    const dailyDir = dailyMss?.direction ?? (d1[d1.length - 1]!.close > d1[d1.length - 2]!.close ? "up" : "down");
    const hourDir = bos?.direction;
    if (!hourDir || hourDir !== dailyDir) continue;

    // 维护流动性候选（每日重建昨日/亚洲盘/开盘区间水平；1h 摆动点每日补）
    if (levels.length === 0 || c.openTime % 3600000 < 5 * 60000) {
      const fresh = buildLevels(h1, m5, c.openTime);
      for (const f of fresh) {
        if (!levels.some((l) => l.id === f.id && l.price === f.price)) levels.push(f);
      }
    }

    // Q10：三大时段均开仓，周五收盘前 4h 禁开（UTC 20:00 后）
    const d = new Date(c.openTime);
    if (d.getUTCDay() === 5 && d.getUTCHours() >= 20) continue;

    // 已有同品种持仓 → 跳过（R4）；全系统 ≥2 仓 → 跳过（R3）
    const openNow = trades.filter((t) => t.exitTime === undefined);
    const riskInput = {
      openPositions: openNow.map((t) => ({ symbol, status: "open" })),
      todayRealizedLossUsd: todayLoss,
      recentClosesBySymbol: closedBySymbol,
      maxPositions: 2, dailyLossCapUsd: 15,
      consecutiveStopLimit: 3, consecutiveStopPauseMs: 24 * 3600000,
      now: c.openTime,
    };
    const decision = checkRisk(riskInput, symbol);
    if (!decision.allowed) continue;

    const sweptLevels: LiquidityLevel[] = levels
      .filter((l) => l.status === "swept")
      .map((l) => ({ kind: l.kind, price: l.price, status: "swept", sweptTime: l.sweptTime }));
    const result = evaluate(m5, m15, sweptLevels, hourDir, DEFAULT_PARAMS);

    if (result.outcome === "watching" && result.layer === 2) rejectedNoLiq++;
    if (result.outcome === "rejected") {
      if (result.reason?.includes("无顺方向")) rejectedNoTarget++;
      else if (result.reason?.includes("盈亏比")) rejectedRR++;
    }
    if (result.outcome !== "signal" || !result.signal) continue;

    // 信号幂等（同一扫荡水平+MSS 时间只推一次）
    const sig = result.signal;
    const signalNo = `${symbol}_${sig.sweepLevel}_${sig.mssTime}_${sig.direction}`;
    if (trades.some((t) => t.signalNo === signalNo)) continue;

    // 开仓（触发蜡烛收盘价 + 滑点）
    const entry = t_ = c.close * (sig.direction === "long" ? 1 + SLIPPAGE : 1 - SLIPPAGE);
    const qty = Math.floor((MARGIN_USD * LEVERAGE / entry) * 1e4) / 1e4;
    if (qty <= 0) continue;
    trades.push({ signalNo, symbol, direction: sig.direction, entry, stop: sig.stopRef, tp: sig.takeProfitRef, rr: sig.rr, qty, openTime: c.openTime });
  }

  // 汇总
  const done = trades.filter((t) => t.exitTime !== undefined);
  const wins = done.filter((t) => t.result === "tp");
  const losses = done.filter((t) => t.result === "stop");
  const totalPnl = done.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const openCount = trades.length - done.length;

  console.log(`\n========== 回测报告：${symbol} 近 ${days} 天 ==========`);
  console.log(`信号总数: ${trades.length}（已平仓 ${done.length}，未平仓 ${openCount}）`);
  console.log(`止盈: ${wins.length} | 止损: ${losses.length} | 胜率: ${done.length ? (wins.length / done.length * 100).toFixed(1) : "-"}%`);
  console.log(`总盈亏: ${totalPnl.toFixed(2)} USDT（每笔 5U 保证金 100x）`);
  if (wins.length) console.log(`平均盈利: ${(wins.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) / wins.length).toFixed(2)} USDT`);
  if (losses.length) console.log(`平均亏损: ${(losses.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) / losses.length).toFixed(2)} USDT`);
  console.log(`拒绝统计: 等扫荡 ${rejectedNoLiq} | 盈亏比不足 ${rejectedRR} | 无流动性目标 ${rejectedNoTarget}`);
  console.log("\n--- 交易明细 ---");
  for (const t of done) {
    console.log(`${new Date(t.openTime).toISOString().slice(0, 16)} ${t.direction.toUpperCase()} 入${t.entry.toFixed(1)} 损${t.stop.toFixed(1)} 盈${t.tp.toFixed(1)} RR${t.rr.toFixed(2)} → ${t.result} ${(t.pnlUsd ?? 0).toFixed(2)}U`);
  }
  if (openCount) {
    console.log("--- 未平仓 ---");
    for (const t of trades.filter((t) => t.exitTime === undefined)) {
      console.log(`${new Date(t.openTime).toISOString().slice(0, 16)} ${t.direction.toUpperCase()} 入${t.entry.toFixed(1)} 损${t.stop.toFixed(1)} 盈${t.tp.toFixed(1)} RR${t.rr.toFixed(2)}`);
    }
  }
  // 手工抽验数据导出（PRD M1 验收要求）
  const fs = await import("fs");
  fs.writeFileSync(`backtest/${symbol}-trades.json`, JSON.stringify(trades, null, 2));
  fs.writeFileSync(`backtest/${symbol}-summary.json`, JSON.stringify({
    symbol, days, signalCount: trades.length, closed: done.length,
    tp: wins.length, stop: losses.length,
    winRate: done.length ? wins.length / done.length : null,
    totalPnl, rejectedNoLiq, rejectedRR, rejectedNoTarget,
    generatedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`\n明细已写 backtest/${symbol}-trades.json / ${symbol}-summary.json（供手工抽验）`);
}

// 修复 TS 严格模式小问题：entry 赋值表达式笔误保护
let t_: number | undefined;

const symbol = (process.argv[2] ?? "BTC").toUpperCase();
const days = parseInt(process.argv[3] ?? "14", 10);
runBacktest(symbol, Number.isNaN(days) ? 14 : days).catch((e) => { console.error(e); process.exit(1); });
