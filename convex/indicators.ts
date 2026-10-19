// 技术结构计算：摆动点 / BOS / MSS / OB / FVG / ATR
// 纯函数，无 Convex 依赖——回测与实盘同一套（PRD 底线 1）。
// 口径全部来自 PRD 第 10.1 节。

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const SWING_N = 3; // 摆动点：左右各 3 根

/** 摆动点（需要左右各 SWING_N 根已收盘蜡烛） */
export function swingPoints(
  candles: Candle[],
): { index: number; price: number; kind: "high" | "low" }[] {
  const out: { index: number; price: number; kind: "high" | "low" }[] = [];
  for (let i = SWING_N; i < candles.length - SWING_N; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - SWING_N; j <= i + SWING_N; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= c.high) isHigh = false;
      if (candles[j]!.low <= c.low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: c.high, kind: "high" });
    if (isLow) out.push({ index: i, price: c.low, kind: "low" });
  }
  return out;
}

/** 最近一次 BOS：收盘穿越最近一个顺趋势摆动点 */
export function lastBOS(candles: Candle[]): { direction: "up" | "down"; time: number } | null {
  const swings = swingPoints(candles.slice(0, -1)); // 排除最新一根已确认的，避免用到尚未成形的
  let lastHigh: { price: number; index: number } | null = null;
  let lastLow: { price: number; index: number } | null = null;
  let last: { direction: "up" | "down"; time: number } | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (lastHigh && c.close > lastHigh.price) {
      last = { direction: "up", time: c.openTime };
      lastHigh = null;
    }
    if (lastLow && c.close < lastLow.price) {
      last = { direction: "down", time: c.openTime };
      lastLow = null;
    }
    // 更新最近摆动点（摆动点在 index 确认时才可见）
    for (const s of swings) {
      if (s.index === i - SWING_N) {
        if (s.kind === "high") lastHigh = { price: s.price, index: s.index };
        else lastLow = { price: s.price, index: s.index };
      }
    }
  }
  return last;
}

/** MSS/CHoCH：收盘穿越最近一个逆趋势摆动点。direction 为新方向。 */
export function lastMSS(
  candles: Candle[],
  priorTrend: "up" | "down",
): { direction: "up" | "down"; time: number } | null {
  const bos = lastBOS(candles);
  const trend = bos?.direction ?? priorTrend;
  const swings = swingPoints(candles.slice(0, -1));
  const c = candles[candles.length - 1]!;
  // 逆趋势摆动点：上升趋势中找最近摆动高点，收盘上穿 = bullish MSS
  const candidates =
    trend === "up"
      ? swings.filter((s) => s.kind === "high" && s.index < candles.length - SWING_N - 1)
      : swings.filter((s) => s.kind === "low" && s.index < candles.length - SWING_N - 1);
  const nearest = candidates[candidates.length - 1];
  if (!nearest) return null;
  if (trend === "up" && c.close > nearest.price)
    return { direction: "up", time: c.openTime };
  if (trend === "down" && c.close < nearest.price)
    return { direction: "down", time: c.openTime };
  return null;
}

/** ATR14 */
export function atr14(candles: Candle[]): number {
  if (candles.length < 15) return NaN;
  let sum = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  return sum / 14;
}

/** 强位移蜡烛判定：长度 >= 1.5 * ATR14 */
export function isDisplacement(candle: Candle, atr: number): boolean {
  return candle.high - candle.low >= 1.5 * atr;
}

/** 订单块：强位移蜡烛之前最后一根反向蜡烛的范围 */
export function orderBlock(candles: Candle[], displacementIndex: number): {
  low: number; high: number; direction: "long" | "short";
} | null {
  const disp = candles[displacementIndex]!;
  const atr = atr14(candles.slice(0, displacementIndex + 1));
  if (!isDisplacement(disp, atr)) return null;
  const bullish = disp.close > disp.open;
  for (let i = displacementIndex - 1; i >= 0; i--) {
    const c = candles[i]!;
    if (bullish && c.close < c.open) return { low: c.low, high: c.high, direction: "long" };
    if (!bullish && c.close > c.open) return { low: c.low, high: c.high, direction: "short" };
  }
  return null;
}

/** 公允价值缺口：三根蜡烛，第 1 与第 3 根影线不重叠 */
export function fvg(candles: Candle[], endIndex: number): {
  low: number; high: number; direction: "long" | "short";
} | null {
  if (endIndex < 2) return null;
  const a = candles[endIndex - 2]!;
  const c = candles[endIndex]!;
  if (c.low > a.high) return { low: a.high, high: c.low, direction: "long" }; // 看涨 FVG
  if (c.high < a.low) return { low: c.high, high: a.low, direction: "short" }; // 看跌 FVG
  return null;
}

/** 扫荡判定：影线穿越水平且收盘收回内侧 */
export function isSwept(candle: Candle, level: number): boolean {
  const crossed = candle.high > level || candle.low < level;
  const closedInside = candle.close <= level && candle.close >= level - Math.abs(level) * 0; // 收盘回到水平内侧
  // 影线穿越：上扫 = high > level 且 close < level；下扫 = low < level 且 close > level
  const sweptUp = candle.high > level && candle.close < level;
  const sweptDown = candle.low < level && candle.close > level;
  return (sweptUp || sweptDown) && crossed;
}
