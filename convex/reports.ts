// 日报 / 周报（PRD 模块六）：统计并发电报。
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

async function summarize(ctx: any, sinceMs: number, title: string) {
  const signals = (await ctx.runQuery(internal.reportsStats.signalsSince, { sinceMs })) as any[];
  const positions = (await ctx.runQuery(internal.reportsStats.positionsSince, { sinceMs })) as any[];
  const riskEvents = (await ctx.runQuery(internal.reportsStats.riskEventsSince, { sinceMs })) as any[];
  const closed = positions.filter((p: any) => p.status === "closed");
  const wins = closed.filter((p: any) => (p.pnlUsd ?? 0) > 0).length;
  const pnl = closed.reduce((s: number, p: any) => s + (p.pnlUsd ?? 0), 0);
  const text = [
    `📊 ${title}`,
    `信号: ${signals.length} | 开仓: ${positions.length} | 平仓: ${closed.length}`,
    `胜率: ${closed.length ? ((wins / closed.length) * 100).toFixed(0) + "%" : "N/A"} | 盈亏: ${pnl.toFixed(2)}U`,
    `风控触发: ${riskEvents.length} 次`,
  ].join("\n");
  await ctx.runAction(internal.notify.send, { level: "position", text });
}

export const daily = internalAction({
  args: {},
  handler: async (ctx) => summarize(ctx, Date.now() - 86400000, "每日小结"),
});

export const weekly = internalAction({
  args: {},
  handler: async (ctx) => summarize(ctx, Date.now() - 7 * 86400000, "每周周报"),
});

export const signalsSince = {
  args: { sinceMs: v.number() },
  handler: async (ctx: any, { sinceMs }: { sinceMs: number }) => {
    const all = await ctx.db.query("signals").collect();
    return all.filter((s: any) => s.createdTime >= sinceMs);
  },
};
