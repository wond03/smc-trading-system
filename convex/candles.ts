// Gate.io 公开行情采集（Convex action）。只存已收盘蜡烛；完整性校验失败 → 标记异常并告警（PRD 模块一）。
// 注意：crons.ts / signalEngine 等 Convex 函数在 `npx convex dev` 首次运行时生成 _generated 后才能通过类型检查。
// 本文件为部署版实现；本机 tsc 只检查纯函数层（tsconfig include 列表）。

import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Gate.io 合约映射（PRD：比特币永续 + 黄金合约）
const GATE_SYMBOLS: Record<string, string> = {
  BTC: "BTC_USDT",
  XAU: "XAU_USDT", // 部署时按 Gate 实际黄金合约代码校正
};

const INTERVAL_MS: Record<string, number> = {
  "4h": 14400000, "30m": 1800000,
};

export const fetchAndStore = internalAction({
  args: { symbol: v.string(), intervals: v.array(v.string()) },
  handler: async (ctx, { symbol, intervals }) => {
    for (const interval of intervals) {
      const contract = GATE_SYMBOLS[symbol]!;
      const url = `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${contract}&interval=${interval === "1d" ? "1d" : interval}&limit=200`;
      // Gate 的 K 线接口：
      const klineUrl = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${interval}&limit=200`;
      const res = await fetch(klineUrl);
      if (!res.ok) {
        await ctx.runMutation(internal.records.logDataAnomaly, {
          symbol, detail: { kind: "kline_fetch_failed", interval, status: res.status },
        });
        continue;
      }
      type Row = { t: number; o: string; h: string; l: string; c: string; v?: string };
      const rows = (await res.json()) as Row[];
      // 完整性校验：时间序列无缺口（允许最后一根未收盘被剔除）
      const ms = INTERVAL_MS[interval]!;
      const now = Date.now();
      const closed = rows.filter((r) => r.t * 1000 + ms <= now); // 只认已收盘
      closed.sort((a, b) => a.t - b.t);
      const gaps: number[] = [];
      for (let i = 1; i < closed.length; i++) {
        if (closed[i]!.t - closed[i - 1]!.t !== ms / 1000) gaps.push(closed[i]!.t);
      }
      if (gaps.length > 0) {
        await ctx.runMutation(internal.records.logDataAnomaly, {
          symbol, detail: { kind: "candle_gap", interval, gaps },
        });
        continue; // 异常：不用旧数据硬算（PRD 约束）
      }
      await ctx.runMutation(internal.candles.upsertBatch, {
        symbol, interval,
        candles: closed.map((r) => ({
          openTime: r.t * 1000,
          open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c),
          volume: Number(r.v ?? 0),
        })),
      });
      void url;
    }
  },
});

export const upsertBatch = internalMutation({
  args: {
    symbol: v.string(), interval: v.string(),
    candles: v.array(v.object({
      openTime: v.number(), open: v.number(), high: v.number(),
      low: v.number(), close: v.number(), volume: v.number(),
    })),
  },
  handler: async (ctx, { symbol, interval, candles }) => {
    for (const c of candles) {
      const existing = await ctx.db
        .query("candles")
        .withIndex("by_symbol_interval_time", (q) =>
          q.eq("symbol", symbol).eq("interval", interval).eq("openTime", c.openTime))
        .first();
      if (!existing) await ctx.db.insert("candles", { symbol, interval, ...c });
    }
  },
});

export const list = internalQuery({
  args: { symbol: v.string(), interval: v.string(), take: v.number() },
  handler: async (ctx, { symbol, interval, take }) => {
    const rows = await ctx.db
      .query("candles")
      .withIndex("by_symbol_interval_time", (q) => q.eq("symbol", symbol).eq("interval", interval))
      .order("desc")
      .take(take);
    return rows.reverse();
  },
});
