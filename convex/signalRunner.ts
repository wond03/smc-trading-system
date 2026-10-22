"use node";
// 信号执行编排：五层判断 → 风控 → 开仓 → 挂止损/止盈 → 记录 → 推送。
// 时段过滤（Q18）：仅北京时间 20:00–24:00 开新仓；周五收盘前 4h 禁开。
// 周期（Q19/Q24）：4H 定方向 + 30M 执行。

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Candle } from "./indicators";
import { lastBOS, lastMSS } from "./indicators";
import { evaluate, DEFAULT_PARAMS } from "./signalEngine";
import { checkRisk, quantity } from "./risk";
import { makeRequestKey } from "./weexKeys";
import { openMarket, placeStop, placeTakeProfit, emergencyClose } from "./weex";

const MARGIN_USD = 5;
const LEVERAGE = 100;
const QTY_PRECISION: Record<string, number> = { BTC: 4, XAU: 2 }; // 部署时按交易所精度校正
const MAX_RISK_PCT = 0.02;      // Q15：单笔风险 ≤2%（以保证金口径的止损距离约束）
const MAX_CONCURRENT = 2;       // Q15：并发持仓 ≤2 张

/**
 * 时段过滤（Q18 + 2026-10-22 补充裁决）：
 * - 北京时间 20:00–24:00（纽约盘上午）+ 08:00–10:00（亚洲盘）
 * - 周五停开按纽约时间：纽约周五 13:00（=北京周六 01:00，收盘前 4h）起至周末全程禁开新仓
 */
function inTradingWindow(nowMs: number): boolean {
  const bj = new Date(nowMs + 8 * 3600000);
  const hour = bj.getUTCHours();
  const dow = bj.getUTCDay(); // 北京视角
  // 纽约周五 13:00 = 北京周六 01:00。北京周六 01:00 起到周日全程禁开
  if (dow === 6 && bj.getUTCHours() >= 1) return false;
  if (dow === 0) return false;
  if (dow === 6 && bj.getUTCHours() < 1) return hour >= 20; // 北京周五 20-24 实为纽约周五上午，允许
  return (hour >= 20 && hour < 24) || (hour >= 8 && hour < 10);
}

export const runForSymbol = internalAction({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }) => {
    const now = Date.now();

    // —— 时段过滤 ——
    if (!inTradingWindow(now)) {
      await ctx.runMutation(internal.records.logScan, {
        scanTime: now, symbol, outcome: "watching",
        layerResults: { layer: 0, reason: "时段外" },
      });
      return;
    }

    // —— 取已收盘蜡烛（Q19/Q24：4H + 30M）——
    const m30 = (await loadCandles(ctx, symbol, "30m", 300))!;
    const h4 = (await loadCandles(ctx, symbol, "4h", 200))!;
    if (!m30 || !h4 || m30.length < 50 || h4.length < 15) {
      await ctx.runMutation(internal.records.logDataAnomaly, {
        symbol, detail: { kind: "insufficient_candles" },
      });
      return;
    }

    // —— 第 1 层：4H 方向 + 30M 同向（Q13 方案 A：冲突时不挂大级别逆向单，直接跳过本轮）——
    const bos4h = lastBOS(h4, 3);          // 4H 摆动窗口 = 3 根
    const bos30 = lastBOS(m30, 6);         // 30M 摆动窗口 = 6 根
    const dir4h = bos4h?.direction;
    const dir30 = bos30?.direction;
    if (!dir4h || !dir30 || dir4h !== dir30) {
      await ctx.runMutation(internal.records.logScan, {
        scanTime: now, symbol, outcome: "watching",
        layerResults: { layer: 1, dailyDir: dir4h, hourDir: dir30, reason: "4H 与 30M 方向矛盾（Q13：不逆向）" },
      });
      return;
    }

    // —— 第 2-5 层：信号引擎（30M 执行 + 4H 流动性）——
    const liquidity = (await ctx.runQuery(internal.records.listSwept, { symbol })) as {
      kind: string; price: number; status: "swept"; sweptTime?: number;
    }[];
    const result = evaluate(m30, h4, liquidity, dir30, false, DEFAULT_PARAMS);

    // 判断链路落表（PRD 7.2：每次扫描产出结论即写）
    await ctx.runMutation(internal.records.logScan, {
      scanTime: now, symbol,
      outcome: result.outcome === "signal" ? "signal" : result.outcome,
      layerResults: {
        layer: result.layer, dailyDir: dir4h, hourDir: dir30, reason: result.reason,
        sweptLevels: liquidity.map((l) => l.price),
        signal: result.signal ?? null,
      },
    });

    if (result.outcome !== "signal" || !result.signal) return;
    const sig = result.signal;

    // —— 信号幂等：扳机位 + MSS 时间 + 方向 只推一次 ——
    const trigRef = sig.sweepLevel ?? sig.divergenceLow ?? sig.divergenceHigh ?? 0;
    const signalNo = `${symbol}_${sig.trigger}_${trigRef}_${sig.mssTime}_${sig.direction}`;
    const dup = await ctx.runQuery(internal.records.findSignal, { signalNo });
    if (dup) return;

    // —— 风控（Q15：并发 ≤2 张由 maxPositions 承担；单笔 ≤2% 由数量缩放承担）——
    const riskInput = await collectRiskInput(ctx, symbol, now, MAX_CONCURRENT);
    const decision = checkRisk(riskInput, symbol);
    if (!decision.allowed) {
      await ctx.runMutation(internal.records.logRiskEvent, {
        rule: decision.rule!, symbol, detail: { reason: decision.reason, signalNo },
      });
      await ctx.runAction(internal.notify.send, {
        level: "alert",
        text: `⛔ 风控拒绝 ${symbol} 信号：${decision.rule} — ${decision.reason}`,
      });
      return;
    }

    // —— 写信号记录 ——
    await ctx.runMutation(internal.records.insertSignal, { signalNo, symbol, ...sig, createdTime: now });

    // —— 开仓（幂等：requestKey；Q22 半仓分级；Q14 语义：以 entryRef 挂单价为风险基准）——
    // 实盘执行：市价开仓 + 限价挂单等回踩由托管层跟进（一期简化：市价成交价≈收盘价，
    // 风险计算用 entryRef 与 stopRef，与回测同一口径）
    const price = m30[m30.length - 1]!.close;
    const entryRef = sig.entryRef;
    const marginUsed = MARGIN_USD * (sig.positionFraction ?? 1);
    // Q15：止损距离超保证金 2% 风险时缩数量到 2% 以内（以挂单价为基准，与回测一致）
    const stopDistPct = Math.abs(entryRef - sig.stopRef) / entryRef;
    const marginByRisk = stopDistPct > MAX_RISK_PCT ? MARGIN_USD * (MAX_RISK_PCT / stopDistPct) : marginUsed;
    const effectiveMargin = Math.min(marginUsed, marginByRisk);
    const qty = quantity(effectiveMargin, LEVERAGE, price, QTY_PRECISION[symbol] ?? 2);
    const openKey = makeRequestKey(signalNo, "open", price);
    if (!(await ctx.runQuery(internal.records.requestKeyExists, { requestKey: openKey }))) {
      await ctx.runMutation(internal.records.logOrder, {
        signalNo, action: "open", requestKey: openKey, status: "submitted", time: now,
      });
      const opened = await openMarket(symbol, sig.direction, qty);
      await ctx.runMutation(internal.records.logOrder, {
        signalNo, action: "open", requestKey: openKey,
        status: opened.ok ? "ok" : "failed", exchangeOrderId: opened.orderId,
        error: opened.error, time: Date.now(),
      });
      if (!opened.ok) {
        await ctx.runAction(internal.notify.send, {
          level: "alert", text: `❌ ${symbol} 开仓失败：${opened.error}`,
        });
        return;
      }

      // —— 挂止损（底线 2：必须真实提交；失败 → 紧急平仓）——
      const stopKey = makeRequestKey(signalNo, "stopOrder", sig.stopRef);
      const stop = await placeStop(symbol, sig.direction, qty, sig.stopRef);
      await ctx.runMutation(internal.records.logOrder, {
        signalNo, action: "stopOrder", requestKey: stopKey,
        status: stop.ok ? "ok" : "failed", exchangeOrderId: stop.orderId,
        error: stop.error, time: Date.now(),
      });
      if (!stop.ok) {
        const closed = await emergencyClose(symbol, sig.direction, qty);
        await ctx.runAction(internal.notify.send, {
          level: "alert",
          text: `🚨 ${symbol} 止损提交失败已紧急平仓：平仓${closed.ok ? "成功" : "也失败，人工介入！"}`,
        });
        return;
      }

      // —— 挂一笔全仓止盈（Q5）——
      const tpKey = makeRequestKey(signalNo, "tpOrder", sig.takeProfitRef);
      const tp = await placeTakeProfit(symbol, sig.direction, qty, sig.takeProfitRef);
      await ctx.runMutation(internal.records.logOrder, {
        signalNo, action: "tpOrder", requestKey: tpKey,
        status: tp.ok ? "ok" : "failed", exchangeOrderId: tp.orderId,
        error: tp.error, time: Date.now(),
      });

      // —— 建持仓记录 ——
      await ctx.runMutation(internal.records.insertPosition, {
        signalNo, symbol, direction: sig.direction,
        entryPrice: price, stopPrice: sig.stopRef,
        takeProfitPrice: sig.takeProfitRef, openedTime: now,
        exchangeStopOrderId: stop.orderId,
      });

      // —— 电报信号推送 ——
      await ctx.runAction(internal.notify.send, {
        level: "signal",
        text: [
          `📈 ${symbol} ${sig.direction === "long" ? "做多" : "做空"}（${sig.trigger === "sweep" ? "扫荡" : "背离"}扳机${sig.positionFraction < 1 ? "·半仓" : ""}）`,
          `POI: ${sig.poiLow} - ${sig.poiHigh}`,
          `入场参考: ${sig.entryRef}`,
          `止损: ${sig.stopRef}`,
          `止盈: ${sig.takeProfitRef}`,
          `盈亏比: ${sig.rr.toFixed(2)}`,
          `触发: ${sig.triggerKind}`,
          `已市价开仓 ${qty}（${effectiveMargin}U×100x 逐仓）`,
        ].join("\n"),
      });
    }
  },
});

async function loadCandles(ctx: any, symbol: string, interval: string, take: number): Promise<Candle[] | null> {
  const rows = await ctx.runQuery(internal.candles.list, { symbol, interval, take });
  return rows as Candle[];
}

async function collectRiskInput(ctx: any, symbol: string, now: number, maxPositions: number) {
  const openPositions = (await ctx.runQuery(internal.records.listOpenPositions)) as {
    symbol: string; status: string;
  }[];
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const { todayLoss, closesBySymbol } = (await ctx.runQuery(internal.records.riskSnapshot, {
    todayStart,
  })) as { todayLoss: number; closesBySymbol: Record<string, ("stop" | "tp" | "manual")[]> };
  void symbol;
  return {
    openPositions, todayRealizedLossUsd: todayLoss,
    recentClosesBySymbol: closesBySymbol,
    maxPositions, dailyLossCapUsd: 15,
    consecutiveStopLimit: 3, consecutiveStopPauseMs: 24 * 3600000,
    now,
  };
}
