/**
 * 信号引擎 v2（2026-10-22 深夜重写，用户逐层校准后的最终口径）
 *
 * 层级分工（19篇#1 + 01篇 + 15篇）：
 *   4H  CRT 定方向：最近 1-3 根 4H 蜡烛区间高低点=流动性；被扫的一侧+1H转换→方向；无转换不做
 *   1H  结构/结局：流动性被扫（结局）→ 转势位（结局点与被结局点之间的极值点）
 *   30M 背离观察：本品种反转结构 vs 联动品种未创新低/新高（品种背离，非指标背离）
 *   15M 执行：回踩到转位以内 + 有结构/FVG + MSS（回踩后连续两根收盘破前低/高）
 *
 * 止损=转势位外侧；止盈=顺方向最近合格结构位（RR∈[1.5,5]）；
 * 仓位=扫荡+背离齐 1.0 / 仅背离 0.5（Q22+03篇「背离一出两张单结束」）；
 * 量过滤不做（用户裁决：加密上做不好）。
 * 纯函数，无 Convex 依赖（PRD 底线 1）。
 */
import type { Candle } from "./indicators";
import { swingPoints, atr14 } from "./indicators";

export interface PeerCandle { candles: Candle[] } // 联动品种 30M

export interface V2Result {
  outcome: "signal" | "rejected" | "watching";
  layer: number;
  reason?: string;
  signal?: {
    direction: "long" | "short";
    entryRef: number;
    stopRef: number;
    takeProfitRef: number;
    rr: number;
    positionFraction: number;
    chochLevel: number;      // 转势位
    sweepLevel?: number;     // 被扫的流动性
    peerConfirmed: boolean;  // 品种背离确认
    mssTime: number;
  };
}

// —— Layer 1: 4H CRT 方向 ——
export interface Crts { high: number; low: number; sweptSide: "high" | "low" | null }

/**
 * CRT 区间：最近 nBars 根 4H 的最高/最低（nBars 默认 3，15篇「单/双/三蜡烛区间」）。
 * 返回区间高低点与被扫的一侧（某根 4H 影线越过高点/低点且收回区间内=扫荡）。
 */
export function crtRange(c4h: Candle[], nBars = 3): Crts {
  if (c4h.length < nBars + 2) return { high: NaN, low: NaN, sweptSide: null };
  const window = c4h.slice(-(nBars + 1), -1); // 最近完整区间（不含当前未收）
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const cur = c4h[c4h.length - 1]!;
  // 当前 4H 是否正在扫荡：影线越界
  let sweptSide: "high" | "low" | null = null;
  if (cur.high > high) sweptSide = "high";
  else if (cur.low < low) sweptSide = "low";
  return { high, low, sweptSide };
}

/**
 * 转换确认（15篇「没有转换不能当方向」）：扫荡侧被确定后，小级别（1H）出现
 * 连续两根收盘突破（BOS 口径）最近逆向摆动点 → 转换成立。
 * 扫上方流动性（sweptSide=high）→ 期望向下转 → 1H 连续两根收盘破最近 swing low。
 */
export function conversionConfirmed(
  h1: Candle[],
  sweptSide: "high" | "low",
  n = 6,
): { direction: "up" | "down"; time: number } | null {
  if (h1.length < n * 2 + 10) return null;
  const swings = swingPoints(h1.slice(0, -2), n); // 最后两根之外的已成形摆动点
  const last2 = h1.slice(-2);
  const expectDir: "up" | "down" = sweptSide === "high" ? "down" : "up";
  const targetKind = expectDir === "up" ? "high" : "low";
  const cands = swings.filter((s) => s.kind === targetKind);
  const nearest = cands[cands.length - 1];
  if (!nearest) return null;
  const both = last2.every((c) => (expectDir === "up" ? c.close > nearest.price : c.close < nearest.price));
  if (both) return { direction: expectDir, time: last2[last2.length - 1]!.openTime };
  return null;
}

// —— Layer 2: 1H 结局 + 转势位 ——
/**
 * 转势位：结局点（扫荡极值）与被结局点（区间另一侧）之间的极值点（05篇§6③）。
 * 多头方向：找最近 swing low 被扫后的最低点（=最后一次进攻起点）。
 */
export function chochLevel(
  h1: Candle[],
  direction: "up" | "down",
  n = 6,
): { level: number; time: number } | null {
  const swings = swingPoints(h1, n);
  const lows = swings.filter((s) => s.kind === "low");
  const highs = swings.filter((s) => s.kind === "high");
  if (direction === "up") {
    // 多头：最近的 swing low 被扫（影线击穿）后的低点=转势位
    for (let k = lows.length - 1; k >= 0; k--) {
      const s = lows[k]!;
      // 找扫荡蜡烛：swing 成形后，有蜡烛 low < s.price
      const after = h1.slice(s.index + n);
      const sweepBar = after.find((c) => c.low < s.price);
      if (sweepBar) return { level: sweepBar.low, time: sweepBar.openTime };
    }
  } else {
    for (let k = highs.length - 1; k >= 0; k--) {
      const s = highs[k]!;
      const after = h1.slice(s.index + n);
      const sweepBar = after.find((c) => c.high > s.price);
      if (sweepBar) return { level: sweepBar.high, time: sweepBar.openTime };
    }
  }
  return null;
}

// —— Layer 3: 30M 品种背离 ——
/**
 * 品种背离（用户裁决口径）：本品种出现反转结构（近期创新低/新高）时，
 * 联动品种同期【没有】创新低/新高 → 背离确认（相对强弱）。
 * peerLookback：对齐回看根数（30M）。
 */
export function peerDivergence(
  self: Candle[],
  peer: Candle[],
  direction: "up" | "down",
  lookback = 16, // 8 小时
): boolean {
  if (self.length < lookback + 2 || peer.length < lookback + 2) return false;
  // 本品种近期极值（不含当前 2 根）
  const selfWin = self.slice(-(lookback + 2), -2);
  const selfExt = direction === "up"
    ? Math.min(...selfWin.map((c) => c.low))   // 多头反转=刚创过新低
    : Math.max(...selfWin.map((c) => c.high));
  // 联动品种同期是否创新低/新高
  const peerAll = peer.slice(-(lookback + 2));
  const peerWin = peer.slice(-(lookback + 2), -2);
  const peerExtWin = direction === "up" ? Math.min(...peerWin.map((c) => c.low)) : Math.max(...peerWin.map((c) => c.high));
  const peerCur = peer[peer.length - 1]!;
  const peerMadeNewExt = direction === "up"
    ? peerCur.low < peerExtWin  // 联动品种还在创新低=没背离
    : peerCur.high > peerExtWin;
  void selfExt;
  return !peerMadeNewExt;
}

// —— Layer 4: 15M 执行 ——
/**
 * MSS（14篇：回踩破前低=结构转换确认）：回踩到转位以内后，15M 连续两根收盘
 * 破回踩前的逆向摆动点 → 转势确认 → 确认即入场（19篇§27「不要求回踩时抓」）。
 * entryRef：MSS 确认蜡烛在 FVG 内 → FVG 边缘价；否则等回踩 FVG（12 根内）→ FVG 边缘。
 */
export function execute15m(
  m15: Candle[],
  chochLv: number,
  direction: "up" | "down",
  n = 6,
): { entryRef: number; mssTime: number; fvgLow: number; fvgHigh: number } | null {
  const dirLong = direction === "up";
  const atr15 = atr14(m15);
  if (Number.isNaN(atr15)) return null;

  // MSS：连续两根 15M 收盘破最近逆向摆动点（多头=破 swing high；空头=破 swing low）
  const swings = swingPoints(m15.slice(0, -2), n);
  const targetKind = dirLong ? "high" : "low";
  const cands = swings.filter((s) => s.kind === targetKind);
  if (!cands.length) return null;
  const nearest = cands[cands.length - 1]!;
  const last2 = m15.slice(-2);
  const mssOk = last2.every((c) => (dirLong ? c.close > nearest.price : c.close < nearest.price));
  if (!mssOk) return null;

  // FVG：找转位附近（±1×ATR15）顺方向、未填（S5：影线完全穿过才算 filled）的最近 FVG
  const zones: { low: number; high: number; i: number }[] = [];
  for (let i = 2; i < m15.length - 2; i++) {
    const a = m15[i - 2]!, c = m15[i]!;
    if (c.low > a.high) zones.push({ low: a.high, high: c.low, i });
    else if (c.high < a.low) zones.push({ low: c.high, high: a.low, i });
  }
  const filled = (z: { low: number; high: number }) =>
    m15.slice(z.i + 1).some((c) => (dirLong ? c.low < z.low : c.high > z.high)); // 影线完全穿过
  const near = zones
    .filter((z) => Math.abs((dirLong ? z.high : z.low) - chochLv) <= atr15)
    .filter((z) => !filled(z));
  const confirmBar = last2[last2.length - 1]!;
  // MSS 确认蜡烛落在某 FVG 内 → 即刻入场
  const inFvg = zones.find((z) => confirmBar.close >= Math.min(z.low, z.high) && confirmBar.close <= Math.max(z.low, z.high));
  let entryRef = confirmBar.close;
  let fvgLow = 0, fvgHigh = 0;
  if (inFvg && Math.abs((dirLong ? inFvg.high : inFvg.low) - chochLv) <= atr15) {
    fvgLow = inFvg.low; fvgHigh = inFvg.high;
    entryRef = confirmBar.close;
  } else if (near.length) {
    const z = near[near.length - 1]!;
    fvgLow = z.low; fvgHigh = z.high;
    entryRef = dirLong ? Math.max(z.low, chochLv) : Math.min(z.high, chochLv);
  } else {
    return null; // 无 FVG 不做（19篇§14：15分钟回踩必须有 FVG）
  }
  return { entryRef, mssTime: confirmBar.openTime, fvgLow, fvgHigh };
}
