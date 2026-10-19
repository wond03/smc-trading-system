// 信号执行编排：五层判断 → 风控 → 开仓 → 挂止损/止盈 → 记录 → 推送。
// 时间过滤（PRD 10.4）：伦敦开盘后 1-4h、纽约开盘后 1-3h；周五收盘前 4h 禁开新仓。

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Candle } from "./indicators";
import { lastBOS, lastMSS } from "./indicators";
import { evaluate, DEFAULT_PARAMS } from "./signalEngine";
import { checkRisk, quantity } from "./risk";
import { makeRequestKey, openMarket, placeStop, placeTakeProfit, emergencyClose } from "./weex";

const MARGIN_USD = 5;
const LEVERAGE = 100;
const QTY_PRECISION: Record<string, number> = { BTC: 4, XAU: 2 }; // 部署时按交易所精度校正

/** 伦敦/纽约时段窗口（UTC 小时），部署时按实际冬/夏令时校正 */
function inTradingWindow(nowMs: number): boolean {
  const d = new Date(nowMs);
  const h = d.getUTCHours();
  const london = h >= 8 && h < 12;      // 伦敦开盘 08:00 UTC 后 1-4h（约）
  const ny = h >= 14 && h < 18;         // 纽约开盘后 1-3h（约）
  return london || ny;
}

export const runForSymbol = internalAction({
  args: { symbol: v.string() },
  handler: async (ctx, { symbol }) => {
    const now = Date.now();

    // —— 时段过滤 ——
    const d = new Date(now);
    const fridayLate = d.getUTCDay() === 5 && d.getUTCHours() >= 20;
    if (!inTradingWindow(now) || fridayLate) {
      await ctx.runMutation(internal.records.logScan, {
        scanTime: now, symbol, outcome: "watching",
        layerResults: { layer: 0, reason: fridayLate ? "周五收盘前4小时" : "时段外" },
      });
      return;
    }

    // —— 取已收盘蜡烛 ——
    const m5 = (await loadCandles(ctx, symbol, "5m", 300))!;
    const m15 = (await loadCandles(ctx, symbol, "15m", 200))!;
    const h1 = (await loadCandles(ctx, symbol, "1h", 200))!;
    const d1 = (await loadCandles(ctx, symbol, "1d", 30))!;
    if (!m5 || !m15 || !h1 || !d1 || m5.length < 50 || d1.length < 3) {
      await ctx.runMutation(internal.records.logDataAnomaly, {
        symbol, detail: { kind: "insufficient_candles" },
      });
      return;
    }

    // —— 第 1 层：日线 + 一小时同向 ——
    const dailyMss = lastMSS(d1, "up"); // 日线 MSS 方向（简化：以最近 BOS 方向为准）
    const bos = lastBOS(h1);
    const dailyDir = dailyMss?.direction ?? (d1[d1.length - 1]!.close > d1[d1.length - 2]!.close ? "up" : "down");
    const hourDir = bos?.direction;
    if (!hourDir || hourDir !== dailyDir) {
      await ctx.runMutation(internal.records.logScan, {
        scanTime: now, symbol, outcome: "watching",
        layerResults: { layer: 1, dailyDir, hourDir, reason: "日线与一小时方向矛盾" },
      });
      return;
    }

    // —— 第 2-5 层：信号引擎 ——
    const liquidity = (await ctx.runQuery(internal.liquidity.listSwept, { symbol })) as {
      kind: string; price: number; status: "swept"; sweptTime?: number;
    }[];
    const result = evaluate(m5, m15, liquidity, hourDir, DEFAULT_PARAMS);

    // 判断链路落表（PRD 7.2：每次扫描产出结论即写）
    await ctx.runMutation(internal.records.logScan, {
      scanTime: now, symbol,
      outcome: result.outcome === "signal" ? "signal" : result.outcome,
      layerResults: {
        layer: result.layer, dailyDir, hourDir, reason: result.reason,
        sweptLevels: liquidity.map((l) => l.price),
        signal: result.signal ?? null,
      },
    });

    if (result.outcome !== "signal" || !result.signal) return;
    const sig = result.signal;

    // —— 信号幂等：同一扫荡水平 + POI 只推一次 ——
    const signalNo = `${symbol}_${sig.sweepLevel}_${sig.mssTime}_${sig.direction}`;
    const dup = await ctx.runQuery(internal.records.findSignal, { signalNo });
    if (dup) return;

    // —— 风控 ——
    const riskInput = await collectRiskInput(ctx, symbol, now);
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

    // —— 开仓（幂等：requestKey）——
    const price = m5[m5.length - 1]!.close;
    const qty = quantity(MARGIN_USD, LEVERAGE, price, QTY_PRECISION[symbol] ?? 2);
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
          `📈 ${symbol} ${sig.direction === "long" ? "做多" : "做空"}`,
          `POI: ${sig.poiLow} - ${sig.poiHigh}${sig.poiHasFvg ? "（含FVG重叠）" : ""}`,
          `入场参考: ${sig.entryRef}`,
          `止损: ${sig.stopRef}`,
          `止盈: ${sig.takeProfitRef}`,
          `盈亏比: ${sig.rr.toFixed(2)}`,
          `触发: ${sig.triggerKind} | 扫荡位: ${sig.sweepLevel}`,
          `已市价开仓 ${qty}（5U×100x 逐仓）`,
        ].join("\n"),
      });
    }
  },
});

async function loadCandles(ctx: any, symbol: string, interval: string, take: number): Promise<Candle[] | null> {
  const rows = await ctx.runQuery(internal.candles.list, { symbol, interval, take });
  return rows as Candle[];
}

async function collectRiskInput(ctx: any, symbol: string, now: number) {
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
    maxPositions: 2, dailyLossCapUsd: 15,
    consecutiveStopLimit: 3, consecutiveStopPauseMs: 24 * 3600000,
    now,
  };
}
