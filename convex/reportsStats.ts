// 报表统计查询（供 reports.ts 调用）
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const signalsSince = internalQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }) => {
    const all = await ctx.db.query("signals").collect();
    return all.filter((s) => s.createdTime >= sinceMs);
  },
});

export const positionsSince = internalQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }) => {
    const all = await ctx.db.query("positions").collect();
    return all.filter((p) => p.openedTime >= sinceMs);
  },
});

export const riskEventsSince = internalQuery({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }) => {
    const all = await ctx.db.query("riskEvents").collect();
    return all.filter((e) => e.triggeredTime >= sinceMs);
  },
});
