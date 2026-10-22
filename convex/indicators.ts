// 技术结构计算：摆动点 / BOS / MSS / FVG 生命周期 / 背离 / ATR
// 纯函数，无 Convex 依赖——回测与实盘同一套（PRD 底线 1）。
// 口径来源：PRD §10（Q12–Q24 裁决后）+ carels-smc-notes 原文核对。
//   - 摆动点：取「收线回头」那根（Q12）——窗口内以收盘价定极值蜡烛，价位取其极值。
//     依据 transcripts logic2[39:41]（BOS 连续两根收盘）、x20241211（收线回头根）。
//   - BOS：连续两根收盘有效突破前结构点，单根不算（Q12）。
//   - FVG 生命周期：影线填完即失效 + 本级别 30 根 K 超期失效（Q17）。
//   - 背离：RSI14 常规背离，背离低点 = 止损参考（Q16/Q22）。

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 摆动点窗口（Q19/Q24 参数化）：4H 左右各 3 根、30M 左右各 6 根 */
export function swingWindow(interval: "4h" | "30m"): number {
  return interval === "4h" ? 3 : 6;
}

/**
 * 摆动点（Q12：收线回头根）。
 * 在 [i-n, i+n] 窗口内，收盘价最高/最低的那根即为摆动点蜡烛（它的收盘回头确认了转折），
 * 价位取该蜡烛的 high/low（保留插针深度供流动性判定用）。
 */
export function swingPoints(
  candles: Candle[],
  n = 6,
): { index: number; price: number; kind: "high" | "low" }[] {
  const out: { index: number; price: number; kind: "high" | "low" }[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j]!.close >= c.close) isHigh = false;
      if (candles[j]!.close <= c.close) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: c.high, kind: "high" });
    if (isLow) out.push({ index: i, price: c.low, kind: "low" });
  }
  return out;
}

export interface BosEvent {
  direction: "up" | "down";
  time: number;          // 第二根确认蜡烛 openTime
  level: number;         // 被突破的摆动点价位
}

/**
 * 全部 BOS 事件（Q12：连续两根收盘穿越同一摆动点）。
 * 扫描每根蜡烛收盘，若连续两根收盘都越过某摆动点价位（且摆动点已成形），
 * 在第二根确认 BOS。
 */
export function bosEvents(candles: Candle[], n = 6): BosEvent[] {
  const swings = swingPoints(candles, n);
  const events: BosEvent[] = [];
  // 摆动点在 index+n 之后才可见（需要右侧确认蜡烛）
  const visibleAt: { bar: number; level: number; kind: "high" | "low" }[] = [];
  for (const s of swings) visibleAt.push({ bar: s.index + n, level: s.price, kind: s.kind });
  visibleAt.sort((a, b) => a.bar - b.bar);

  let active: { level: number; kind: "high" | "low" } | null = null; // 最近一个未破摆动点
  let streak: { dir: "up" | "down"; level: number } | null = null;
  let vi = 0;
  for (let i = 0; i < candles.length; i++) {
    while (vi < visibleAt.length && visibleAt[vi]!.bar <= i) {
      const v = visibleAt[vi]!;
      if (!active || v.kind === "high") active = { level: v.level, kind: v.kind };
      if (v.kind === "low") active = { level: v.level, kind: v.kind };
      vi++;
    }
    const c = candles[i]!;
    if (active) {
      const up = c.close > active.level;
      const down = c.close < active.level;
      if (up || down) {
        const dir: "up" | "down" = up ? "up" : "down";
        if (streak && streak.dir === dir && streak.level === active.level) {
          events.push({ direction: dir, time: c.openTime, level: active.level });
          streak = null;
          active = null; // 突破后该摆动点失效，等下一个成形
        } else {
          streak = { dir, level: active.level };
        }
      } else {
        streak = null;
      }
    }
  }
  return events;
}

/** 最近一次 BOS（兼容旧接口名） */
export function lastBOS(candles: Candle[], n = 6): { direction: "up" | "down"; time: number } | null {
  const evs = bosEvents(candles, n);
  const last = evs[evs.length - 1];
  return last ? { direction: last.direction, time: last.time } : null;
}

/** MSS/CHoCH：BOS 方向相反的首次结构转换（收盘确认，单根即可，Q12 仅对 BOS 要求两根） */
export function lastMSS(
  candles: Candle[],
  priorTrend: "up" | "down",
  n = 6,
): { direction: "up" | "down"; time: number; level: number } | null {
  const evs = bosEvents(candles, n);
  const trend = evs.length ? evs[evs.length - 1]!.direction : priorTrend;
  // 逆趋势摆动点：上升趋势中最近摆动高点被收盘穿越 = 转多确认前的 MSS 参考
  // 简化口径（与旧版一致）：在最新一根蜡烛上检查是否收盘穿越最近逆方向摆动点
  const swings = swingPoints(candles.slice(0, -1), n);
  const c = candles[candles.length - 1]!;
  const opposite = trend === "up" ? "high" : "low";
  const candidates = swings.filter((s) => s.kind === opposite && s.index < candles.length - n - 1);
  const nearest = candidates[candidates.length - 1];
  if (!nearest) return null;
  if (trend === "up" && c.close < nearest.price)
    return { direction: "down", time: c.openTime, level: nearest.price };
  if (trend === "down" && c.close > nearest.price)
    return { direction: "up", time: c.openTime, level: nearest.price };
  return null;
}

/**
 * 顺方向 MSS（扳机后确认）：自 sinceTime 起，第一根收盘穿越「逆方向最近已成形摆动点」。
 * 语义：向上 MSS = 扳机后收盘上穿最近摆动高点；向下 = 收盘下穿最近摆动低点。
 * （probe11/12 证实旧 lastMSS 语义与本引擎期望相反，Q12 收盘确认标准保留。）
 */
export function mssAfter(
  candles: Candle[],
  sinceTime: number,
  direction: "up" | "down",
  n = 6,
): { direction: "up" | "down"; time: number; level: number } | null {
  const sinceIdx = candles.findIndex((c) => c.openTime >= sinceTime);
  if (sinceIdx < 0) return null;
  const targetKind = direction === "up" ? "high" : "low";
  const swings = swingPoints(candles.slice(0, Math.max(sinceIdx, n + 1)), n)
    .filter((s) => s.kind === targetKind)
    .reverse();
  for (let i = sinceIdx; i < candles.length; i++) {
    const c = candles[i]!;
    for (const s of swings) {
      if (s.index + n > i) continue; // 摆动点须已成形
      if (direction === "up" && c.close > s.price) return { direction, time: c.openTime, level: s.price };
      if (direction === "down" && c.close < s.price) return { direction, time: c.openTime, level: s.price };
    }
  }
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

export const FVG_MAX_AGE_BARS = 30; // Q17：本级别 30 根 K 超期失效

export interface FvgZone {
  low: number;
  high: number;
  direction: "long" | "short";
  createdIndex: number;
  createdTime: number;
  status: "open" | "filled"; // open=有效（未填、未超期）
}

/**
 * FVG 全量状态（Q17）：三根蜡烛 strict 定义（第 1 与第 3 根影线不重叠）；
 * 影线触及即「填完」失效；超 30 根失效。
 */
export function fvgZones(candles: Candle[], endIndex: number, maxAge = FVG_MAX_AGE_BARS): FvgZone[] {
  const zones: FvgZone[] = [];
  for (let i = 2; i <= endIndex; i++) {
    const a = candles[i - 2]!;
    const c = candles[i]!;
    let z: { low: number; high: number; direction: "long" | "short" } | null = null;
    if (c.low > a.high) z = { low: a.high, high: c.low, direction: "long" };
    else if (c.high < a.low) z = { low: c.high, high: a.low, direction: "short" };
    if (z) zones.push({ ...z, createdIndex: i, createdTime: c.openTime, status: "open" });
  }
  // 生命周期（S5，2026-10-22 裁决：影线【完全穿过】区间才算 filled——19 篇 #7「影线填完 FVG 即失效，
  // 未填完仍有效」；影线只碰到一半，剩余半截仍是有效入场区）：
  //   多头 FVG（low=前高, high=后低）：填完 = 某根影线 low <= z.low（下穿整个区间）
  //   空头 FVG：填完 = 某根影线 high >= z.high
  // createdIndex 距今 > maxAge → expired（不返回）
  for (const z of zones) {
    for (let i = z.createdIndex + 1; i <= endIndex; i++) {
      const c = candles[i]!;
      if (z.direction === "long" ? c.low <= z.low : c.high >= z.high) {
        z.status = "filled";
        break;
      }
    }
  }
  return zones.filter(
    (z) => z.status === "open" && endIndex - z.createdIndex <= maxAge,
  );
}

/** 兼容旧接口：最近一个指定方向的未填 FVG */
export function fvg(candles: Candle[], endIndex: number): {
  low: number; high: number; direction: "long" | "short";
} | null {
  const zones = fvgZones(candles, endIndex);
  const dirs = zones.filter((z) => z.direction === "long" || z.direction === "short");
  return dirs.length ? dirs[dirs.length - 1]! : null;
}

/** RSI14（背离用） */
export function rsi14(candles: Candle[]): number {
  if (candles.length < 15) return NaN;
  let gain = 0, loss = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = (gain / 14) / (loss / 14);
  return 100 - 100 / (1 + rs);
}

/** RSI 序列（背离检测用：逐根窗口计算） */
export function rsiSeries(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    out.push(i < 14 ? NaN : rsi14(candles.slice(0, i + 1)));
  }
  return out;
}

export interface Divergence {
  direction: "long" | "short";
  divergenceLow?: number;   // 多单止损参考：背离形成的那个低点（Q16）
  divergenceHigh?: number;  // 空单止损参考
  time: number;
}

/**
 * 常规背离检测（Q22 扳机分支；信号口径 09/12/13 篇：以背离为主）。
 * 看多：最近两个摆动低点，价格低点更低 + RSI 低点更高（向下杀流动性后的背离）。
 * 看空：镜像。返回背离低/高点作为止损参考。
 * 有效期：背离确认后 divValidBars 根内有效（信号是新鲜的——查尔斯「背离一出就开单」）。
 */
/**
 * 结构背离（查尔斯裸 K 口径，2026-10-22 裁决替换 RSI 代理）：
 * - 「前后背离」：价格创更低低点（更高高点），但新低/新高摆动点的收线回头动能弱化——
 *   量化为：新极值摆动点的回头根（收线反向蜡烛）实体幅度 < 前一极值摆动点的回头根实体幅度
 * - 「结构位背离」：低点出现在结构位（前摆动点水平附近 ±0.25×ATR）且拐头，作为同义分支
 * - CVD 佐证一期不做（数据源未接）；时效=事件失效制（见 signalEngine 扳机失效逻辑）
 */
export function detectDivergence(
  candles: Candle[],
  n = 6,
  divValidBars = 12,
): Divergence | null {
  if (candles.length < n * 2 + 20) return null;
  const swings = swingPoints(candles, n);
  const lows = swings.filter((s) => s.kind === "low");
  const highs = swings.filter((s) => s.kind === "high");
  const confirmBar = candles.length - 1;

  // 回头根动能：摆动点成形后第一根收线反向蜡烛的实体大小（收线回头根，Q12 口径）
  const reversalBody = (idx: number, dir: "up" | "down"): number => {
    for (let i = idx + 1; i < candles.length && i <= idx + n; i++) {
      const c = candles[i]!;
      if (dir === "up" && c.close > c.open) return c.close - c.open; // 下跌摆动点后的阳线回头
      if (dir === "down" && c.close < c.open) return c.open - c.close;
    }
    return 0;
  };

  // 低位背离：价格更低低点 + 回头动能弱化（前后背离）；或结构位背离（贴近前低水平拐头）
  for (let k = lows.length - 1; k >= 1; k--) {
    const p = lows[k - 1]!, q = lows[k]!;
    const matureBar = q.index + n;
    if (confirmBar - matureBar > divValidBars) return null; // 最近的背离已过期，不回溯
    if (confirmBar < matureBar) continue; // 尚未成形
    const bodyP = reversalBody(p.index, "up");
    const bodyQ = reversalBody(q.index, "up");
    const frontalDiv = q.price < p.price && bodyQ > 0 && bodyQ < bodyP; // 前后背离
    const structuralDiv = Math.abs(q.price - p.price) / (p.price || 1) < 0.002 && q.price <= p.price; // 结构位背离（等低点附近拐头）
    if (frontalDiv || structuralDiv) {
      const lowCandle = candles[q.index]!;
      return { direction: "long", divergenceLow: lowCandle.low, time: candles[matureBar]!.openTime };
    }
    break; // 只看最近一组不成立即退出（不回溯更老的对，避免「远古背离」触发）
  }
  for (let k = highs.length - 1; k >= 1; k--) {
    const p = highs[k - 1]!, q = highs[k]!;
    const matureBar = q.index + n;
    if (confirmBar - matureBar > divValidBars) return null;
    if (confirmBar < matureBar) continue;
    const bodyP = reversalBody(p.index, "down");
    const bodyQ = reversalBody(q.index, "down");
    const frontalDiv = q.price > p.price && bodyQ > 0 && bodyQ < bodyP;
    const structuralDiv = Math.abs(q.price - p.price) / (p.price || 1) < 0.002 && q.price >= p.price;
    if (frontalDiv || structuralDiv) {
      const highCandle = candles[q.index]!;
      return { direction: "short", divergenceHigh: highCandle.high, time: candles[matureBar]!.openTime };
    }
    break;
  }
  return null;
}

/** 扫荡判定：影线穿越水平且收盘收回内侧 */
export function isSwept(candle: Candle, level: number): boolean {
  const sweptUp = candle.high > level && candle.close < level;
  const sweptDown = candle.low < level && candle.close > level;
  return sweptUp || sweptDown;
}
