// 一次性演练 action：验证 Weex 签名与下单参数（演练完删除或保留作运维工具）。
"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { openMarket, emergencyClose, placeStop, placeTakeProfit, moveStop, rawCall } from "./weex";

export const drill = internalAction({
  args: { step: v.string() },
  handler: async (_ctx, { step }) => {
    if (step === "open") {
      const r = await openMarket("BTC", "long", 0.0001);
      console.log("openMarket:", JSON.stringify(r));
      return r;
    }
    if (step === "close") {
      const r = await emergencyClose("BTC", "long", 0.0001);
      console.log("emergencyClose:", JSON.stringify(r));
      return r;
    }
    if (step === "stop") {
      const r = await placeStop("BTC", "long", 0.0001, 70000);
      console.log("placeStop:", JSON.stringify(r));
      return r;
    }
    if (step === "tp") {
      const r = await placeTakeProfit("BTC", "long", 0.0001, 90000);
      console.log("placeTakeProfit:", JSON.stringify(r));
      return r;
    }
    if (step === "debugSimSymbols") {
      return await rawCall("GET", "/capi/v3/sim/market/apiTradingSymbols");
    }
    if (step === "debugSimProducts") {
      return await rawCall("GET", "/capi/v3/sim/market/products");
    }
    if (step === "debugStop") {
      return await rawCall("POST", "/capi/v3/order", {
        symbol: "BTCUSDT", side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
        triggerPrice: "70000", quantity: "0.0001", reduceOnly: true,
        clientAlgoId: "drill-stop-003", newClientOrderId: "drill-stop-003",
      });
    }
    if (step === "debugTp") {
      return await rawCall("POST", "/capi/v3/algoOrder", {
        symbol: "BTCUSDT", side: "SELL", positionSide: "LONG", type: "TAKE_PROFIT_MARKET",
        triggerPrice: "90000", quantity: "0.0001", reduceOnly: true, timeInForce: "GTC",
        clientAlgoId: "try-tp-" + Date.now(), newClientOrderId: "try-tp-" + Date.now(),
      });
    }
    if (step === "debugClose") {
      return await rawCall("POST", "/capi/v3/order", {
        symbol: "BTCUSDT", side: "SELL", positionSide: "LONG", type: "MARKET",
        quantity: "0.0001", reduceOnly: true, newClientOrderId: "drill-close-001",
      });
    }
    if (step === "debugTryA") {
      // 普通订单端点 + 条件类型
      return await rawCall("POST", "/capi/v3/order", {
        symbol: "BTCUSDT", side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
        stopPrice: "70000", quantity: "0.0001", reduceOnly: true,
        newClientOrderId: "try-a-001",
      });
    }
    if (step === "debugTryB") {
      // algoOrder 用 execPrice 而非 triggerPrice？
      return await rawCall("POST", "/capi/v3/algoOrder", {
        symbol: "BTCUSDT", side: "SELL", positionSide: "LONG", type: "STOP_MARKET",
        triggerPrice: "70000", quantity: "0.0001", reduceOnly: true,
        newClientOrderId: "try-b-003", clientAlgoId: "try-b-003",
      });
    }
    if (step === "debugTryC") {
      // 用 placeTpSlOrder
      return await rawCall("POST", "/capi/v3/placeTpSlOrder", {
        symbol: "BTCUSDT", positionSide: "LONG",
        slTriggerPrice: "70000", tpTriggerPrice: "90000",
        newClientOrderId: "try-c-002", clientAlgoId: "try-c-002",
      });
    }
    if (step === "debugCancel") {
      return await rawCall("DELETE", "/capi/v3/algoOrder?orderId=807234136245797594");
    }
    if (step === "debugTpSlStop") {
      return await rawCall("POST", "/capi/v3/placeTpSlOrder", {
        symbol: "BTCUSDT", clientAlgoId: "tplsl-stop-001", planType: "STOP_LOSS",
        triggerPrice: "70000", quantity: "0.0001", positionSide: "LONG", reduceOnly: true,
      });
    }
    if (step === "debugTpSlTp") {
      return await rawCall("POST", "/capi/v3/placeTpSlOrder", {
        symbol: "BTCUSDT", clientAlgoId: "tplsl-tp-001", planType: "TAKE_PROFIT",
        triggerPrice: "90000", quantity: "0.0001", positionSide: "LONG", reduceOnly: true,
      });
    }
    if (step === "debugCancel2") {
      return await rawCall("DELETE", "/capi/v3/algoOrder?orderId=807299674259063600");
    }
    if (step === "debugCancel3") {
      return await rawCall("DELETE", "/capi/v3/algoOrder?orderId=807299681133527800");
    }
    if (step === "debugList") {
      return await rawCall("GET", "/capi/v3/algoOrders?symbol=BTCUSDT&page=1&limit=20");
    }
    if (step === "debugListOpen") {
      return await rawCall("GET", "/capi/v3/openAlgoOrders?symbol=BTCUSDT&page=1&limit=20");
    }
    if (step === "debugPositions") {
      return await rawCall("GET", "/capi/v3/position/allPosition");
    }
    if (step === "debugCancelAlgo") {
      return await rawCall("DELETE", "/capi/v3/algoOrder?orderId=807304086239052506");
    }
    if (step === "debugOpenRaw") {
      return await rawCall("POST", "/capi/v3/order", {
        symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", type: "MARKET",
        quantity: "0.0001", leverage: 100, marginCoin: "USDT",
        newClientOrderId: "BTC" + Date.now() + "open",
      });
    }
    if (step === "debugCallVsRaw") {
      const r1 = await openMarket("BTC", "long", 0.0001);
      const r2 = await rawCall("POST", "/capi/v3/order", {
        symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", type: "MARKET",
        quantity: "0.0001", leverage: 100, marginCoin: "USDT",
        newClientOrderId: "BTC" + Date.now() + "open",
      });
      return { viaCall: r1, viaRaw: r2 };
    }
    if (step === "debugMoveStop") {
      const s1 = await placeStop("BTC", "long", 0.0001, 70000);
      if (!s1.ok) return { stage: "placeStop", r: s1 };
      const m = await moveStop("BTC", "long", 0.0001, 72000, s1.orderId!);
      return { stage: "moveStop", placed: s1, moved: m };
    }
    if (step === "debugSim") {
      return await rawCall("POST", "/capi/v3/order", {
        symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", type: "MARKET",
        quantity: "0.0001", leverage: "100", marginCoin: "USDT", newClientOrderId: "drill-sim-001",
      });
    }
    if (step === "debugLive") {
      return await rawCall("POST", "/capi/v3/order", {
        symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", type: "MARKET",
        quantity: "0.0001", leverage: "100", marginCoin: "USDT", newClientOrderId: "drill-live-001",
      });
    }
    throw new Error(`unknown step: ${step}`);
  },
});
