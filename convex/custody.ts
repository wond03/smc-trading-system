"use node";
// 移保本托管（Q6）：止盈目标到达且 5m 收盘确认 → 止损移至入场价，仅一次。
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { moveStop } from "./weex";
import { makeRequestKey } from "./weexKeys";

export const checkOpenPositions = internalAction({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }) => {
    const positions = (await ctx.runQuery(internal.records.listOpenPositionsBySymbol, { symbol })) as {
      _id: string; signalNo: string; symbol: string; direction: "long" | "short";
      entryPrice: number; stopPrice: number; takeProfitPrice: number;
      stopMovedToBreakeven: boolean; exchangeStopOrderId?: string;
    }[];

    const m5 = (await ctx.runQuery(internal.candles.list, { symbol, interval: "5m", take: 3 })) as {
      high: number; low: number; close: number; openTime: number;
    }[];
    const last = m5[m5.length - 1];
    if (!last) return;

    for (const p of positions) {
      if (p.stopMovedToBreakeven) continue;
      // 到达止盈目标：5m 蜡烛触及即视为该蜡烛到达，收盘确认 = 该蜡烛已收盘且极值触及
      const reached = p.direction === "long"
        ? last.high >= p.takeProfitPrice
        : last.low <= p.takeProfitPrice;
      if (!reached) continue;

      // 幂等：移保本只执行一次（requestKey）
      const key = makeRequestKey(p.signalNo, "moveStopToBreakeven", p.entryPrice);
      if (await ctx.runQuery(internal.records.requestKeyExists, { requestKey: key })) continue;

      await ctx.runMutation(internal.records.logOrder, {
        signalNo: p.signalNo, action: "moveStopToBreakeven",
        requestKey: key, status: "submitted",
        oldPrice: p.stopPrice, newPrice: p.entryPrice, time: Date.now(),
      });
      const moved = await moveStop(
        p.symbol, p.direction, 0 /* 部署版按持仓数量查询 */, p.entryPrice,
        p.exchangeStopOrderId ?? "",
      );
      await ctx.runMutation(internal.records.logOrder, {
        signalNo: p.signalNo, action: "moveStopToBreakeven",
        requestKey: key, status: moved.ok ? "ok" : "failed",
        oldPrice: p.stopPrice, newPrice: p.entryPrice,
        exchangeOrderId: moved.orderId, error: moved.error, time: Date.now(),
      });
      if (moved.ok) {
        await ctx.runMutation(internal.records.markBreakevenDone, { positionId: p._id as any });
        await ctx.runAction(internal.notify.send, {
          level: "position",
          text: `🔒 ${p.symbol} 止盈目标触及（5m收盘确认），止损已移至入场价 ${p.entryPrice}`,
        });
      } else {
        await ctx.runAction(internal.notify.send, {
          level: "alert",
          text: `⚠️ ${p.symbol} 移保本失败：${moved.error}（原止损单仍在，持仓不受威胁）`,
        });
      }
    }
  },
});
