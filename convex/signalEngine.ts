// 五层信号判断引擎（PRD §10，Q12–Q24 裁决后口径）。
// 纯函数，无 Convex 依赖——回测与实盘同一套（PRD 底线 1）。
//
// 口径变化（相对旧版，全部有裁决编号）：
//   Q12  摆动点=收线回头根；BOS=连续两根收盘（indicators 层实现）
//   Q13  大小级别冲突=方案 A（本引擎不挂大级别逆向单；方向由 runner 层 4H/30M 复核）
//   Q14  入场=右侧确认后挂回踩；触发形态在确认后判定
//   Q15  单量不设硬上限（runner/风控层做单笔≤2%+并发≤2）
//   Q16  止损=背离低点下方（背离扳机时）；FVG 扳机时=结构低点-0.2ATR
//   Q17  FVG 生命周期（影线填完即失效+30 根超期；POI 只认 FVG，Q21）
//   Q18  时段在 runner 层过滤
//   Q19/Q24 周期 4H+30M：candles4h 定方向、candles30m 执行
//   Q20  跨品种背离=加分项，由 runner 层传入 auxConfirmed
//   Q21  POI=FVG 独占；PD 软过滤=positioningDivisor
//   Q22  扳机二选一：扫荡或背离；背离单半仓（positionFraction=0.5）

import type { Candle } from "./indicators";
import {
  swingWindow, swingPoints, bosEvents, mssAfter, atr14, fvgZones,
  detectDivergence, isSwept, FVG_MAX_AGE_BARS,
  type Divergence,
} from "./indicators";

export interface LiquidityLevel {
  kind: string;
  price: number;
  status: "untouched" | "swept" | "broken";
  sweptTime?: number;
}

export interface FiveLayerResult {
  outcome: "signal" | "rejected" | "watching";
  layer: number;
  reason?: string;
  signal?: {
    direction: "long" | "short";
    trigger: "sweep" | "divergence";
    poiLow: number;
    poiHigh: number;
    entryRef: number;
    stopRef: number;
    takeProfitRef: number;
    rr: number;
    positionFraction: number;   // Q22：扫荡=1.0；背离=0.5
    sweepLevel?: number;
    sweepTime?: number;
    divergenceLow?: number;     // Q16：背离低点（记录用）
    divergenceHigh?: number;
    mssTime: number;
    triggerKind: string;
  };
}

export interface EngineParams {
  minRR: number;
  stopBufferATR: number;      // Q16：0.2%量级的缓冲（保留 ATR 口径，0.2*ATR 与旧版同形）
  fvgMaxAgeBars: number;      // Q17
  divergenceStopBufferATR: number;
}

export const DEFAULT_PARAMS: EngineParams = {
  minRR: 1.5,
  stopBufferATR: 0.2,
  fvgMaxAgeBars: FVG_MAX_AGE_BARS,
  divergenceStopBufferATR: 0.05,
};

const N30 = swingWindow("30m"); // 30M 摆动窗口 = 6

/**
 * 五层判断（4H+30M 口径）。
 * @param candles30m 30M 已收盘蜡烛（执行层）
 * @param candles4h  4H 已收盘蜡烛（方向层，runner 已做过第 1 层同向检查；此处用其流动性）
 * @param liquidity  30M/4H 流动性水平（runner 传入）
 * @param direction  第 1 层结论：4H 与 30M 同向方向
 * @param auxConfirmed Q20：跨品种背离辅助确认（加分项）
 */
export function evaluate(
  candles30m: Candle[],
  candles4h: Candle[],
  liquidity: LiquidityLevel[],
  direction: "up" | "down",
  auxConfirmed: boolean,
  params: EngineParams = DEFAULT_PARAMS,
): FiveLayerResult {
  const expected: "up" | "down" = direction;
  const dir: "long" | "short" = expected === "up" ? "long" : "short";
  const atr30 = atr14(candles30m);
  if (Number.isNaN(atr30) || candles30m.length < N30 * 2 + 20) {
    return { outcome: "watching", layer: 0, reason: "30M 蜡烛不足" };
  }
  // 扳机时效：扫荡/背离后 12 根 30M（6 小时）内 MSS 确认有效，超期视为过期
  const TRIGGER_VALID_BARS = 12;
  const nowBar = candles30m[candles30m.length - 1]!.openTime;

  // —— 第 2 层：扳机确认，二选一（裁决记录 §3-2：扫荡 或 背离）——
  // 2a. 流动性扫荡分支（只取新鲜的扫荡：12 根内）
  const sweptCandidates = liquidity
    .filter((l) => l.status === "swept")
    .filter((l) => nowBar - (l.sweptTime ?? 0) <= TRIGGER_VALID_BARS * 1800000);
  const swept = sweptCandidates.length
    ? sweptCandidates.reduce((a, b) => ((b.sweptTime ?? 0) > (a.sweptTime ?? 0) ? b : a))
    : null;

  // 2b. 背离分支（30M RSI 常规背离）
  const divergence = detectDivergence(candles30m, N30);
  const divergenceOk = divergence !== null && divergence.direction === dir;

  if (!swept && !divergenceOk) {
    return { outcome: "watching", layer: 2, reason: "无扫荡且无背离，等待扳机" };
  }
  const trigger: "sweep" | "divergence" = swept ? "sweep" : "divergence";
  const positionFraction = trigger === "sweep" ? 1.0 : 0.5; // Q22
  const triggerTime = trigger === "sweep" ? (swept!.sweptTime ?? 0) : (divergence!.time ?? 0);

  // —— 第 3 层：MSS 确认（Q12 收盘确认；顺方向 MSS，扳机之后）——
  const mss = mssAfter(candles30m, triggerTime, expected, N30);
  if (!mss) {
    return { outcome: "watching", layer: 3, reason: "扳机后等待 30M MSS 确认" };
  }

  // —— 第 4 层：POI = 未填 FVG 独占（Q21：OB 不进 POI；Q17 生命周期）——
  const zones = fvgZones(candles30m, candles30m.length - 1, params.fvgMaxAgeBars);
  const poiCandidates = zones.filter((z) =>
    dir === "long" ? z.direction === "long" : z.direction === "short",
  );
  if (poiCandidates.length === 0) {
    return { outcome: "watching", layer: 4, reason: "无有效 FVG 作为 POI" };
  }
  // 取最近的（MSS 之后形成优先）
  const poi = poiCandidates[poiCandidates.length - 1]!;

  // —— 第 5 层：回踩 POI + 触发形态（Q14：确认后挂回踩）——
  const last30 = candles30m[candles30m.length - 1]!;
  const inPoi = last30.low <= poi.high && last30.high >= poi.low;
  if (!inPoi) {
    return { outcome: "watching", layer: 5, reason: "等待回踩 FVG" };
  }
  const triggerKind = detectTrigger(candles30m, expected, poi);
  if (!triggerKind) {
    return { outcome: "watching", layer: 5, reason: "FVG 内等待触发形态" };
  }

  // —— 入场 / 止损 / 止盈 ——
  const entryRef = dir === "long" ? poi.high : poi.low;
  const stopBuffer = params.stopBufferATR * atr30;
  let stopRef: number;
  if (trigger === "divergence") {
    // Q16：止损=背离低点/高点下方（高主力区）
    const divLevel = dir === "long"
      ? (divergence!.divergenceLow ?? poi.low)
      : (divergence!.divergenceHigh ?? poi.high);
    const divBuffer = params.divergenceStopBufferATR * atr30;
    stopRef = dir === "long" ? divLevel - divBuffer : divLevel + divBuffer;
  } else {
    stopRef = dir === "long" ? poi.low - stopBuffer : poi.high + stopBuffer;
  }
  // 止损冗余保护：止损不应远于入场反向 3×缓冲之外（防背离低点过远，Q16 精神）
  const maxRisk = stopBuffer * 8;
  if (Math.abs(entryRef - stopRef) > maxRisk) {
    return { outcome: "rejected", layer: 5, reason: "止损距离超限（背离低点过远）" };
  }
  const risk = Math.abs(entryRef - stopRef);

  // 止盈：顺方向最近流动性（优先 4H 流动性，30M 补充）
  const targets = liquidity
    .filter((l) => l.status !== "broken")
    .map((l) => l.price)
    .filter((p) => (dir === "long" ? p > entryRef : p < entryRef))
    .sort((a, b) => (dir === "long" ? a - b : b - a));
  if (targets.length === 0) {
    return { outcome: "rejected", layer: 5, reason: "无顺方向流动性目标" };
  }
  const takeProfitRef = targets[0]!;
  const rr = Math.abs(takeProfitRef - entryRef) / risk;
  // Q20：跨品种背离辅助确认 → 盈亏比门槛松动一档（1.5→1.3），只加分不否决
  const effectiveMinRR = auxConfirmed ? params.minRR - 0.2 : params.minRR;
  if (rr < effectiveMinRR) {
    return { outcome: "rejected", layer: 5, reason: `盈亏比 ${rr.toFixed(2)} < ${effectiveMinRR}` };
  }

  return {
    outcome: "signal",
    layer: 5,
    signal: {
      direction: dir,
      trigger,
      poiLow: poi.low,
      poiHigh: poi.high,
      entryRef,
      stopRef,
      takeProfitRef,
      rr,
      positionFraction,
      sweepLevel: trigger === "sweep" ? swept!.price : undefined,
      sweepTime: trigger === "sweep" ? (swept!.sweptTime ?? 0) : undefined,
      divergenceLow: divergence?.divergenceLow,
      divergenceHigh: divergence?.divergenceHigh,
      mssTime: mss.time,
      triggerKind: trigger === "sweep" ? `sweep+${triggerKind}` : `divergence+${triggerKind}`,
    },
  };
}

/** 触发形态（Q14：确认后的右侧动作）：反包 / 包 FVG / 吞没 */
function detectTrigger(
  candles: Candle[],
  direction: "up" | "down",
  poi: { low: number; high: number },
): string | null {
  const c = candles[candles.length - 1]!;
  const prev = candles[candles.length - 2]!;
  // 反包（前一根反向蜡烛被本次收盘覆盖）＝ 查尔斯口径的「反包/包 FG」
  if (direction === "up" && c.close > c.open && c.close > prev!.high) return "engulf";
  if (direction === "down" && c.close < c.open && c.close < prev!.low) return "engulf";
  // 反向扫荡收回：影线刺破 POI 远端但收盘收回（扫荡扳机下的确认动作）
  if (direction === "up" && c.low < poi.low && c.close > poi.low) return "sweepReversal";
  if (direction === "down" && c.high > poi.high && c.close < poi.high) return "sweepReversal";
  // 小型结构确认：收盘越过前一根极值
  if (direction === "up" && c.close > prev!.high && c.close > c.open) return "choch";
  if (direction === "down" && c.close < prev!.low && c.close < c.open) return "choch";
  return null;
}

// re-export 供 runner/backtest 使用
export { swingPoints, bosEvents, isSwept };
export type { Divergence };
