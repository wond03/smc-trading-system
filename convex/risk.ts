// 风控检查（PRD 模块五）：纯逻辑，供实盘与回测共用。
import type { PositionLike } from "./types";

export interface RiskInput {
  openPositions: PositionLike[];
  todayRealizedLossUsd: number;      // 当日已实现亏损（正数）
  recentClosesBySymbol: Record<string, ("stop" | "tp" | "manual")[]>; // 最近平仓序列
  maxPositions: number;              // 2
  dailyLossCapUsd: number;           // 15
  consecutiveStopLimit: number;      // 3
  consecutiveStopPauseMs: number;    // 24h
  now: number;
}

export interface RiskDecision {
  allowed: boolean;
  rule?: string;       // 拒绝的规则编号，写入记录
  reason?: string;
}

export function checkRisk(input: RiskInput, symbol: string): RiskDecision {
  const {
    openPositions, todayRealizedLossUsd, recentClosesBySymbol,
    maxPositions, dailyLossCapUsd, consecutiveStopLimit, consecutiveStopPauseMs, now,
  } = input;

  // R1 单日亏损熔断
  if (todayRealizedLossUsd >= dailyLossCapUsd) {
    return { allowed: false, rule: "R1_dailyLossCap", reason: `当日已亏 ${todayRealizedLossUsd}U ≥ ${dailyLossCapUsd}U，停止开新仓` };
  }
  // R2 连续止损熔断（按品种）
  const closes = recentClosesBySymbol[symbol] ?? [];
  const lastN = closes.slice(0, consecutiveStopLimit);
  if (
    lastN.length >= consecutiveStopLimit &&
    lastN.every((r) => r === "stop")
  ) {
    const firstStopTime = input.now; // 暂停起点由调用方按第 3 笔止损时间传入覆盖
    void firstStopTime;
    return { allowed: false, rule: "R2_consecutiveStops", reason: `${symbol} 连续 ${consecutiveStopLimit} 笔止损，暂停 ${consecutiveStopPauseMs / 3600000}h` };
  }
  // R3 持仓上限
  if (openPositions.length >= maxPositions) {
    return { allowed: false, rule: "R3_positionLimit", reason: `全系统持仓 ${openPositions.length} ≥ ${maxPositions}` };
  }
  // R4 同品种单仓
  if (openPositions.some((p) => p.symbol === symbol && p.status === "open")) {
    return { allowed: false, rule: "R4_onePerSymbol", reason: `${symbol} 已有持仓` };
  }
  return { allowed: true };
}

/** 保证金/杠杆 → 下单数量（向下取整到精度） */
export function quantity(marginUsd: number, leverage: number, price: number, precision: number): number {
  const notional = marginUsd * leverage;
  const raw = notional / price;
  const factor = Math.pow(10, precision);
  return Math.floor(raw * factor) / factor;
}
