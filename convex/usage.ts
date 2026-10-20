// 用量监控与自动降频（Q9 对策③，PRD 7.2）。
// 原理：无 Dashboard API，用 scanRecords 写入速率反推函数调用量。
// 每小时自检：最近 1h 扫描记录数 × 每次扫描的函数调用系数 ≈ 用量。
// 超阈值 → 将 cron 从 1 分钟降到 5 分钟（幂等：已降频则跳过）+ TG 告警（每次降频只发一次）。
import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// 估算系数：每次 scan（2 品种）≈ 10 次函数调用（action+mutation+query 往返）
const CALLS_PER_SCAN = 10;
// Convex 免费层函数调用 100 万/月。安全线 45%（观察期速率下留裕量）
const MONTHLY_LIMIT = 1_000_000;
const SAFE_RATIO = 0.45;
// 降频判定：推算月化用量超过安全线 → 5 分钟扫描
// scanRecords 表含每次扫描 1 条/品种，可用作速率计
export const checkUsage = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // 最近 1 小时的扫描记录数（两品种合计）
    const hourlyRows: { symbol: string }[] = await ctx.runQuery(internal.usage.recentScanCount, { since: now - 3600000 });
    const scansPerHour = hourlyRows.length / 2; // 每品种各 1 条
    const callsPerMonth = scansPerHour * 24 * 30 * CALLS_PER_SCAN;
    const ratio = callsPerMonth / MONTHLY_LIMIT;

    if (ratio > SAFE_RATIO) {
      const already = await ctx.runMutation(internal.usage.throttleCron, { enable: true });
      if (!already) {
        await ctx.runAction(internal.notify.send, {
          level: "alert",
          text: `⚠️ 用量告警：推算月函数调用 ${Math.round(callsPerMonth / 1000)}k（安全线 ${MONTHLY_LIMIT * SAFE_RATIO / 1000}k），已自动降频为 5 分钟/次扫描`,
        });
      }
    } else if (ratio < SAFE_RATIO * 0.6) {
      // 回落到安全区 → 恢复 1 分钟
      const wasThrottled = await ctx.runMutation(internal.usage.throttleCron, { enable: false });
      if (wasThrottled) {
        await ctx.runAction(internal.notify.send, {
          level: "alert",
          text: `✅ 用量回落（推算 ${Math.round(callsPerMonth / 1000)}k/月），已恢复 1 分钟/次扫描`,
        });
      }
    }
    return { scansPerHour, callsPerMonth: Math.round(callsPerMonth), ratio: Number(ratio.toFixed(3)), monthLimit: MONTHLY_LIMIT };
  },
});

export const recentScanCount = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    return await ctx.db
      .query("scanRecords")
      .withIndex("by_scanTime", (q) => q.gte("scanTime", since))
      .take(500);
  },
});

// 降频开关：true=改 5 分钟（重建 cron），false=恢复 1 分钟
// 返回值：操作前的状态（true=原本就是 5 分钟），用于判断是否首次切换
export const throttleCron = internalMutation({
  args: { enable: v.boolean() },
  handler: async (ctx, { enable }) => {
    const row = await ctx.db
      .query("usageState")
      .withIndex("by_key", (q) => q.eq("key", "throttled"))
      .first();
    const was = row?.value ?? false;
    if (was !== enable) {
      if (row) await ctx.db.patch(row._id, { value: enable });
      else await ctx.db.insert("usageState", { key: "throttled", value: enable, updatedAt: Date.now() });
    }
    return was;
  },
});

// cron 读取当前节流状态（降频时 scanner.scan 自己跳过 4/5 的触发）
export const isThrottled = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("usageState")
      .withIndex("by_key", (q) => q.eq("key", "throttled"))
      .first();
    return row?.value ?? false;
  },
});
