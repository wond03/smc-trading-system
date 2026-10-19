// 记录模块（PRD 第 7 节）：只追加写入。全部 insert，不做 update/delete（状态变更用新条目）。
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const logScan = internalMutation({
  args: {
    scanTime: v.number(), symbol: v.string(),
    outcome: v.string(), layerResults: v.any(),
  },
  handler: async (ctx, a) => { await ctx.db.insert("scanRecords", a); },
});

export const logDataAnomaly = internalMutation({
  args: { symbol: v.string(), detail: v.any() },
  handler: async (ctx, { symbol, detail }) => {
    await ctx.db.insert("riskEvents", {
      rule: "dataAnomaly", symbol, detail, triggeredTime: Date.now(),
    });
  },
});

export const logOrder = internalMutation({
  args: {
    signalNo: v.string(), action: v.string(), requestKey: v.string(),
    status: v.string(), exchangeOrderId: v.optional(v.string()),
    oldPrice: v.optional(v.number()), newPrice: v.optional(v.number()),
    error: v.optional(v.string()), time: v.number(),
  },
  handler: async (ctx, a) => { await ctx.db.insert("orderLogs", a); },
});

export const logRiskEvent = internalMutation({
  args: { rule: v.string(), symbol: v.optional(v.string()), detail: v.any() },
  handler: async (ctx, { rule, symbol, detail }) => {
    await ctx.db.insert("riskEvents", { rule, symbol, detail, triggeredTime: Date.now() });
  },
});

export const insertSignal = internalMutation({
  args: {
    signalNo: v.string(), symbol: v.string(), direction: v.string(),
    poiLow: v.number(), poiHigh: v.number(), poiHasFvg: v.boolean(),
    entryRef: v.number(), stopRef: v.number(), takeProfitRef: v.number(),
    rr: v.number(), sweepLevel: v.number(), sweepTime: v.number(),
    mssTime: v.number(), triggerKind: v.string(), createdTime: v.number(),
  },
  handler: async (ctx, a) => { await ctx.db.insert("signals", a); },
});

export const insertPosition = internalMutation({
  args: {
    signalNo: v.string(), symbol: v.string(), direction: v.string(),
    entryPrice: v.number(), stopPrice: v.number(), takeProfitPrice: v.number(),
    openedTime: v.number(), exchangeStopOrderId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await ctx.db.insert("positions", {
      signalNo: a.signalNo, symbol: a.symbol, direction: a.direction,
      entryPrice: a.entryPrice, stopPrice: a.stopPrice,
      takeProfitPrice: a.takeProfitPrice, stopMovedToBreakeven: false,
      status: "open", openedTime: a.openedTime,
    });
    void a.exchangeStopOrderId; // 部署版：与 positions 一起存（schema 可加字段）
  },
});

// —— 查询 ——
export const findSignal = internalQuery({
  args: { signalNo: v.string() },
  handler: async (ctx, { signalNo }) =>
    await ctx.db.query("signals").withIndex("by_signalNo", (q) => q.eq("signalNo", signalNo)).first(),
});

export const requestKeyExists = internalQuery({
  args: { requestKey: v.string() },
  handler: async (ctx, { requestKey }) =>
    !!(await ctx.db.query("orderLogs").withIndex("by_requestKey", (q) => q.eq("requestKey", requestKey)).first()),
});

export const listOpenPositions = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db.query("positions").withIndex("by_symbol_status", (q) => q.eq("status", "open")).collect(),
});

export const listOpenPositionsBySymbol = internalQuery({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }) =>
    await ctx.db.query("positions").withIndex("by_symbol_status", (q) => q.eq("symbol", symbol).eq("status", "open")).collect(),
});

export const riskSnapshot = internalQuery({
  args: { todayStart: v.number() },
  handler: async (ctx, { todayStart }) => {
    const positions = await ctx.db.query("positions").collect();
    const today = positions.filter((p) => (p.closedTime ?? 0) >= todayStart && p.status === "closed");
    const todayLoss = today.reduce((s, p) => s + Math.max(0, -(p.pnlUsd ?? 0)), 0);
    const closesBySymbol: Record<string, ("stop" | "tp" | "manual")[]> = {};
    for (const p of [...today].sort((a, b) => (b.closedTime ?? 0) - (a.closedTime ?? 0))) {
      // 结果类型从订单日志推断：有 stopOrder 成交记 stop；简化版以 pnl 判断
      const kind: "stop" | "tp" | "manual" = (p.pnlUsd ?? 0) < 0 ? "stop" : "tp";
      (closesBySymbol[p.symbol] ??= []).push(kind);
    }
    return { todayLoss, closesBySymbol };
  },
});

export const listSwept = internalQuery({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }) =>
    await ctx.db.query("liquidityLevels")
      .withIndex("by_symbol_status", (q) => q.eq("symbol", symbol).eq("status", "swept"))
      .collect(),
});
