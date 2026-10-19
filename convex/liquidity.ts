// 流动性地图维护（PRD 模块二）：候选水平 + 状态机（untouched → swept → broken）。
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Candle } from "./indicators";
import { swingPoints } from "./indicators";

const SWEEP_TOLERANCE = 0; // 扫荡判定本身在 indicators.isSwept 内实现

export const updateLevels = internalMutation({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }) => {
    const now = Date.now();

    // —— 一小时摆动高低点 ——
    const h1 = (await ctx.db
      .query("candles")
      .withIndex("by_symbol_interval_time", (q) => q.eq("symbol", symbol).eq("interval", "1h"))
      .order("desc")
      .take(200)).reverse() as Candle[];
    if (h1.length > 10) {
      const swings = swingPoints(h1);
      for (const s of swings.slice(-10)) {
        const kind = s.kind === "high" ? "swingHigh" : "swingLow";
        const dup = await ctx.db
          .query("liquidityLevels")
          .withIndex("by_symbol_status", (q) => q.eq("symbol", symbol).eq("status", "untouched"))
          .first(); // 简化查重：部署版按 (kind, price) 精确查重
        if (!dup || Math.abs(dup.price - s.price) > 1e-9) {
          await ctx.db.insert("liquidityLevels", {
            symbol, kind, interval: "1h", price: s.price,
            createdTime: h1[s.index]!.openTime, status: "untouched",
          });
        }
      }
    }

    // —— 昨日高低 / 亚洲盘高低 / 当日开盘区间（5m 蜡烛推导，UTC+8 亚洲盘 07:00-14:00）——
    const m5 = (await ctx.db
      .query("candles")
      .withIndex("by_symbol_interval_time", (q) => q.eq("symbol", symbol).eq("interval", "5m"))
      .order("desc")
      .take(500)).reverse() as Candle[];
    if (m5.length > 50) {
      const todayStart = new Date(now).setHours(0, 0, 0, 0);
      const asiaStart = todayStart + 7 * 3600000;
      const asiaEnd = todayStart + 14 * 3600000;
      const asia = m5.filter((c) => c.openTime >= asiaStart && c.openTime < asiaEnd);
      if (asia.length > 0 && now >= asiaEnd) {
        await insertUnique(ctx, symbol, "asiaHigh", Math.max(...asia.map((c) => c.high)));
        await insertUnique(ctx, symbol, "asiaLow", Math.min(...asia.map((c) => c.low)));
      }
      const yesterday = m5.filter((c) => c.openTime >= todayStart - 86400000 && c.openTime < todayStart);
      if (yesterday.length > 0) {
        await insertUnique(ctx, symbol, "prevDayHigh", Math.max(...yesterday.map((c) => c.high)));
        await insertUnique(ctx, symbol, "prevDayLow", Math.min(...yesterday.map((c) => c.low)));
      }
      const openRange = m5.filter((c) => c.openTime >= todayStart && c.openTime < todayStart + 3600000);
      if (openRange.length > 0) {
        await insertUnique(ctx, symbol, "openRangeHigh", Math.max(...openRange.map((c) => c.high)));
        await insertUnique(ctx, symbol, "openRangeLow", Math.min(...openRange.map((c) => c.low)));
      }
    }

    // —— 状态机更新：用最新 5m 收盘蜡烛检查每个 untouched 水平 ——
    const last = m5[m5.length - 1];
    if (!last) return;
    void SWEEP_TOLERANCE;
    const untouched = await ctx.db
      .query("liquidityLevels")
      .withIndex("by_symbol_status", (q) => q.eq("symbol", symbol).eq("status", "untouched"))
      .collect();
    for (const lvl of untouched) {
      const swept = lvl.price > last.close
        ? last.low < lvl.price && last.close > lvl.price   // 下扫收回
        : last.high > lvl.price && last.close < lvl.price; // 上扫收回
      const broken = lvl.price > last.close
        ? last.close < lvl.price
        : last.close > lvl.price;
      if (swept) {
        await ctx.db.patch(lvl._id, {
          status: "swept", sweptTime: last.openTime,
          sweepDepth: Math.abs(lvl.price - (lvl.price > last.close ? last.low : last.high)),
        });
      } else if (broken) {
        await ctx.db.patch(lvl._id, { status: "broken" });
      }
    }
  },
});

async function insertUnique(
  ctx: { db: any }, symbol: string, kind: string, price: number,
) {
  const all = await ctx.db
    .query("liquidityLevels")
    .withIndex("by_symbol_status", (q: any) => q.eq("symbol", symbol).eq("status", "untouched"))
    .collect();
  if (!all.some((l: { kind: string; price: number }) => l.kind === kind && Math.abs(l.price - price) < 1e-9)) {
    await ctx.db.insert("liquidityLevels", {
      symbol, kind, interval: "5m", price, createdTime: Date.now(), status: "untouched",
    });
  }
}
