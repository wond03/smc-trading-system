import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// 全部表只追加（append-only）：纠正用更正条目，不修改旧行。
// 详见 PRD 第 7 节记录模块。

export default defineSchema({
  // 蜡烛缓存（Gate.io，只存已收盘蜡烛）
  candles: defineTable({
    symbol: v.string(),        // "BTC" | "XAU"
    interval: v.string(),      // "1d" | "1h" | "15m" | "5m"
    openTime: v.number(),      // ms
    open: v.number(),
    high: v.number(),
    low: v.number(),
    close: v.number(),
    volume: v.number(),
  })
    .index("by_symbol_interval_time", ["symbol", "interval", "openTime"]),

  // 流动性地图
  liquidityLevels: defineTable({
    symbol: v.string(),
    kind: v.string(),          // swingHigh | swingLow | prevDayHigh | prevDayLow | asiaHigh | asiaLow | openRangeHigh | openRangeLow | roundNumber
    interval: v.string(),      // 产生该水平的周期
    price: v.number(),
    createdTime: v.number(),
    status: v.string(),        // untouched | swept | broken
    sweptTime: v.optional(v.number()),
    sweepDepth: v.optional(v.number()), // 穿越深度
  })
    .index("by_symbol_status", ["symbol", "status"]),

  // 信号记录
  signals: defineTable({
    signalNo: v.string(),      // 幂等键
    symbol: v.string(),
    direction: v.string(),     // long | short
    poiLow: v.number(),
    poiHigh: v.number(),
    poiHasFvg: v.boolean(),    // OB+FVG 重叠（可信度加权，Q3）
    entryRef: v.number(),
    stopRef: v.number(),
    takeProfitRef: v.number(), // 一笔全仓止盈（Q5）
    rr: v.number(),            // 盈亏比
    sweepLevel: v.number(),    // 触发扫荡的流动性水平
    sweepTime: v.number(),
    mssTime: v.number(),
    triggerKind: v.string(),   // sweepReversal | choch | engulfing
    createdTime: v.number(),
  })
    .index("by_signalNo", ["signalNo"]),

  // 放弃的信号（含放弃原因，Q2/时段/风控）
  rejectedSignals: defineTable({
    symbol: v.string(),
    stage: v.string(),         // 第几层判断被拒
    reason: v.string(),
    detail: v.any(),
    scanTime: v.number(),
  }).index("by_scanTime", ["scanTime"]),

  // 订单与托管日志（每个动作一条，Q9 幂等键）
  orderLogs: defineTable({
    signalNo: v.string(),
    action: v.string(),        // open | stopOrder | tpOrder | moveStopToBreakeven | cancel | close
    requestKey: v.string(),    // 幂等键：signalNo + action + 目标价
    status: v.string(),        // submitted | ok | failed
    exchangeOrderId: v.optional(v.string()),
    oldPrice: v.optional(v.number()),
    newPrice: v.optional(v.number()),
    error: v.optional(v.string()),
    time: v.number(),
  }).index("by_requestKey", ["requestKey"]),

  // 持仓
  positions: defineTable({
    signalNo: v.string(),
    symbol: v.string(),
    direction: v.string(),
    entryPrice: v.number(),
    stopPrice: v.number(),
    takeProfitPrice: v.number(),
    stopMovedToBreakeven: v.boolean(), // Q6：仅一次
    status: v.string(),        // open | closed
    openedTime: v.number(),
    closedTime: v.optional(v.number()),
    pnlUsd: v.optional(v.number()),
  })
    .index("by_symbol_status", ["symbol", "status"])
    .index("by_signalNo", ["signalNo"]),

  // 风控事件
  riskEvents: defineTable({
    rule: v.string(),          // dailyLossCap | consecutiveStops | positionLimit | dataAnomaly
    symbol: v.optional(v.string()),
    detail: v.any(),
    triggeredTime: v.number(),
    resumeTime: v.optional(v.number()),
  }).index("by_rule", ["rule"]),

  // 判断链路记录（每次扫描产出结论即写，PRD 7.2）
  scanRecords: defineTable({
    scanTime: v.number(),
    symbol: v.string(),
    layerResults: v.any(),     // 五层各自结论与依据
    outcome: v.string(),       // signal | rejected | watching | skipped_dataAnomaly
  }).index("by_scanTime", ["scanTime"]),

  // 人工干预
  manualActions: defineTable({
    action: v.string(),
    target: v.string(),
    detail: v.any(),
    time: v.number(),
  }),

  // 扫描锁（Q9 幂等）
  scanLocks: defineTable({
    scanId: v.string(),
    active: v.boolean(),
    time: v.number(),
  })
    .index("by_active", ["active"])
    .index("by_scanId", ["scanId"]),
});
