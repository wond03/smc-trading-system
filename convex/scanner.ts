// 定时任务入口：每分钟扫描。
// Q9 对策：状态锁 + 幂等防重复；先跑幂等性保护，数据异常直接跳过（不用旧数据硬算）。
// 注意：cron 调度定义在 crons.config.ts（默认导出 Crons 对象），本文件只放被调度的函数。

import { internalMutation, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const SYMBOLS = ["BTC", "XAU"] as const;
const SCANNED_INTERVALS = ["1d", "1h", "15m", "5m"] as const;

// 扫描锁：同一时刻只允许一轮扫描进行（防定时任务重叠导致重复下单，Q9-②）
export const acquireScanLock = internalMutation({
  args: { scanId: v.string() },
  handler: async (ctx, { scanId }) => {
    const existing = await ctx.db
      .query("scanLocks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .first();
    if (existing) return false;
    await ctx.db.insert("scanLocks", { scanId, active: true, time: Date.now() });
    return true;
  },
});

export const releaseScanLock = internalMutation({
  args: { scanId: v.string() },
  handler: async (ctx, { scanId }) => {
    const lock = await ctx.db
      .query("scanLocks")
      .withIndex("by_scanId", (q) => q.eq("scanId", scanId))
      .first();
    if (lock) await ctx.db.patch(lock._id, { active: false });
  },
});

/** 主扫描入口，由 cron 每分钟调度 */
export const scan = internalAction({
  args: {},
  handler: async (ctx) => {
    // Q9 对策③：降频状态时 5 次触发只执行 1 次（分钟取模）
    const throttled = await ctx.runQuery(internal.usage.isThrottled, {});
    if (throttled && new Date().getMinutes() % 5 !== 0) return;

    const scanId = `scan_${Date.now()}`;
    const got = await ctx.runMutation(internal.scanner.acquireScanLock, { scanId });
    if (!got) return; // 上一轮未结束，跳过本轮（只认收盘蜡烛，跳过不影响正确性）

    try {
      for (const symbol of SYMBOLS) {
        // 1. 拉行情（Gate.io 公开接口）+ 完整性校验
        await ctx.runAction(internal.candles.fetchAndStore, { symbol, intervals: [...SCANNED_INTERVALS] });
        // 2. 更新流动性地图
        await ctx.runMutation(internal.liquidity.updateLevels, { symbol });
        // 3. 托管检查（移保本，Q6）
        await ctx.runAction(internal.custody.checkOpenPositions, { symbol });
        // 4. 五层判断 + 风控 + 下单（同一信号引擎）
        await ctx.runAction(internal.signalRunner.runForSymbol, { symbol });
      }
    } finally {
      await ctx.runMutation(internal.scanner.releaseScanLock, { scanId });
    }
  },
});
