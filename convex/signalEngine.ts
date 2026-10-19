// 五层信号判断引擎（PRD 第 10 节口径，Q1–Q3 裁决已融入）。
// 纯函数，无 Convex 依赖——回测与实盘同一套（PRD 底线 1）。

import type { Candle } from "./indicators";
import { swingPoints, lastBOS, lastMSS, atr14, orderBlock, fvg, isSwept } from "./indicators";

export interface LiquidityLevel {
  kind: string;
  price: number;
  status: "untouched" | "swept" | "broken";
  sweptTime?: number;
}

export interface FiveLayerResult {
  outcome: "signal" | "rejected" | "watching";
  layer: number;                    // 停在第几层
  reason?: string;                  // 拒绝/等待原因
  signal?: {
    direction: "long" | "short";
    poiLow: number;
    poiHigh: number;
    poiHasFvg: boolean;             // 可信度加权（Q3）
    entryRef: number;
    stopRef: number;
    takeProfitRef: number;
    rr: number;
    sweepLevel: number;
    sweepTime: number;
    mssTime: number;
    triggerKind: string;
  };
}

export interface EngineParams {
  minRR: number;          // 最低盈亏比门槛（Q2：1.5）
  stopBufferATR: number;  // 止损缓冲（0.2 ATR）
  swingAtrMult: number;   // 位移蜡烛阈值（1.5 ATR）
}

export const DEFAULT_PARAMS: EngineParams = {
  minRR: 1.5,             // Q2：理想 2.0，最低 1.5
  stopBufferATR: 0.2,
  swingAtrMult: 1.5,
};

/**
 * 五层判断。
 * 输入：各周期已收盘蜡烛 + 一小时流动性候选。
 * direction 由调用方（日线+一小时同向检查）传入，层 1 已在上面完成。
 */
export function evaluate(
  candles5m: Candle[],
  candles15m: Candle[],
  hourlyLiquidity: LiquidityLevel[],
  hourDirection: "up" | "down",
  params: EngineParams = DEFAULT_PARAMS,
): FiveLayerResult {
  // —— 第 2 层：流动性扫荡确认（Q1：提高可信度）——
  const sweptCandidates = hourlyLiquidity.filter((l) => l.status === "swept");
  if (sweptCandidates.length === 0) {
    return { outcome: "watching", layer: 2, reason: "等待流动性扫荡" };
  }
  // 取最近被扫荡的水平
  const swept = sweptCandidates.reduce((a, b) =>
    (b.sweptTime ?? 0) > (a.sweptTime ?? 0) ? b : a,
  );

  // 扫荡后必须出现顺新方向的 MSS（第 3 层）
  const sweepDirection: "up" | "down" =
    swept.price > (hourDirection === "up" ? Number.MAX_SAFE_INTEGER : swept.price)
      ? "up"
      : hourDirection === "up" ? "up" : "down";
  const expectedMssDirection = hourDirection === "up" ? "up" : "down";
  const mss = lastMSS(candles5m, expectedMssDirection === "up" ? "down" : "up");
  if (!mss || mss.direction !== expectedMssDirection) {
    return { outcome: "watching", layer: 3, reason: "扫荡后等待 5m MSS" };
  }
  if (mss.time < (swept.sweptTime ?? 0)) {
    return { outcome: "watching", layer: 3, reason: "MSS 早于扫荡，无效" };
  }

  // —— 第 4 层：定位 POI（MSS 位移留下的 OB，FVG 重叠做可信度加权 Q3）——
  const atr5 = atr14(candles5m);
  if (Number.isNaN(atr5)) {
    return { outcome: "watching", layer: 4, reason: "5m 蜡烛不足" };
  }
  // 找 MSS 附近的位移蜡烛与其 OB
  let poi: { low: number; high: number; hasFvg: boolean } | null = null;
  for (let i = candles5m.length - 1; i >= Math.max(2, candles5m.length - 20); i--) {
    const ob = orderBlock(candles5m, i);
    if (!ob) continue;
    const obDirectionOk =
      (expectedMssDirection === "up" && ob.direction === "long") ||
      (expectedMssDirection === "down" && ob.direction === "short");
    if (!obDirectionOk) continue;
    const gap = fvg(candles5m, i);
    const fvgOverlap =
      gap !== null &&
      gap.direction === ob.direction &&
      gap.low <= ob.high &&
      gap.high >= ob.low;
    poi = { low: ob.low, high: ob.high, hasFvg: fvgOverlap };
    break;
  }
  if (!poi) {
    return { outcome: "watching", layer: 4, reason: "MSS 位移未形成 POI" };
  }

  // —— 第 5 层：回踩 POI + 触发形态 ——
  const last5 = candles5m[candles5m.length - 1]!;
  const inPoi = last5.low <= poi.high && last5.high >= poi.low;
  if (!inPoi) {
    return { outcome: "watching", layer: 5, reason: "等待回踩 POI" };
  }
  // 触发：反向扫荡收回 / 小型 CHoCH / 吞没
  const triggerKind = detectTrigger(candles5m, expectedMssDirection, poi);
  if (!triggerKind) {
    return { outcome: "watching", layer: 5, reason: "POI 内等待触发形态" };
  }

  // —— 入场 / 止损 / 止盈 / 盈亏比 ——
  const direction = expectedMssDirection === "up" ? "long" : "short";
  const entryRef = direction === "long" ? poi.high : poi.low;
  const stopBuffer = params.stopBufferATR * atr5;
  const stopRef = direction === "long" ? poi.low - stopBuffer : poi.high + stopBuffer;
  const risk = Math.abs(entryRef - stopRef);

  // 止盈：候选流动性中，顺方向最近且达到门槛的（Q5 一笔全仓）
  const directionCandidates = hourlyLiquidity
    .filter((l) => l.status !== "broken")
    .map((l) => l.price)
    .filter((p) => (direction === "long" ? p > entryRef : p < entryRef))
    .sort((a, b) =>
      direction === "long" ? a - b : b - a, // 离入场最近优先
    );
  if (directionCandidates.length === 0) {
    return { outcome: "rejected", layer: 5, reason: "无顺方向流动性目标" };
  }
  const takeProfitRef = directionCandidates[0]!;
  const rr = Math.abs(takeProfitRef - entryRef) / risk;

  // 盈亏比门槛（Q2）
  if (rr < params.minRR) {
    return {
      outcome: "rejected",
      layer: 5,
      reason: `盈亏比 ${rr.toFixed(2)} < ${params.minRR}`,
    };
  }

  return {
    outcome: "signal",
    layer: 5,
    signal: {
      direction,
      poiLow: poi.low,
      poiHigh: poi.high,
      poiHasFvg: poi.hasFvg,
      entryRef,
      stopRef,
      takeProfitRef,
      rr,
      sweepLevel: swept.price,
      sweepTime: swept.sweptTime ?? 0,
      mssTime: mss.time,
      triggerKind,
    },
  };
}

/** 触发形态：反向扫荡收回 / 小型 CHoCH / 吞没 */
function detectTrigger(
  candles: Candle[],
  direction: "up" | "down",
  poi: { low: number; high: number },
): string | null {
  const c = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  // 吞没
  if (direction === "up" && c.close > c.open && c.close > prev!.high && c.open <= prev!.close)
    return "engulfing";
  if (direction === "down" && c.close < c.open && c.close < prev!.low && c.open >= prev!.close)
    return "engulfing";
  // 反向扫荡收回：影线刺破 POI 远端但收盘收回
  if (direction === "up" && c.low < poi.low && c.close > poi.low) return "sweepReversal";
  if (direction === "down" && c.high > poi.high && c.close < poi.high) return "sweepReversal";
  // 小型 CHoCH：收盘越过最近逆方向摆动点（简化：前一根高点/低点）
  if (direction === "up" && c.close > prev!.high) return "choch";
  if (direction === "down" && c.close < prev!.low) return "choch";
  return null;
}
