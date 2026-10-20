"use node";
// Weex 合约 API 封装（V3，模拟盘 /capi/v3/sim/）。
// 签名规范（官方文档）：ACCESS-SIGN = Base64(HMAC-SHA256(SecretKey, timestamp+METHOD+requestPath+body))
// 四头：ACCESS-KEY / ACCESS-SIGN / ACCESS-PASSPHRASE / ACCESS-TIMESTAMP（毫秒，误差 ≤30s）。
// 底线 2：止损必须真实提交；提交失败 → 立即市价平仓 + 告警。

import { createHmac } from "node:crypto";

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  error?: string;
}

const BASE = "https://api-contract.weex.com";
const SIM_PREFIX = "/capi/v3/sim"; // 模拟盘前缀；实盘部署时改为空串

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 未配置（npx convex env set ${name}）`);
  return v;
}

function headers(method: string, path: string, bodyStr: string): Record<string, string> {
  const ts = Date.now().toString();
  const message = ts + method.toUpperCase() + path + bodyStr; // 无 queryString 时省略 ?query
  const sign = createHmac("sha256", env("WEEX_SECRET")).update(message).digest("base64");
  return {
    "ACCESS-KEY": env("WEEX_API_KEY"),
    "ACCESS-SIGN": sign,
    "ACCESS-PASSPHRASE": env("WEEX_PASSPHRASE"),
    "ACCESS-TIMESTAMP": ts,
    "Content-Type": "application/json",
  };
}

async function call(method: "POST" | "GET" | "DELETE", path: string, body?: unknown): Promise<OrderResult> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(method, path, bodyStr),
      body: bodyStr === "" ? undefined : bodyStr,
    });
    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    if (!res.ok || data.success === false) {
      return { ok: false, error: data.msg ?? data.message ?? text.slice(0, 200) };
    }
    const orderId = typeof data.data?.orderId === "string" ? data.data.orderId
      : typeof data.data?.clientOid === "string" ? data.data.clientOid
      : undefined;
    return orderId ? { ok: true, orderId } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function clientOrderId(seed: string, action: string): string {
  // Weex 要求 newClientOrderId 1-36 字符，受限字符集
  return `${seed}:${action}`.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 36);
}

/** 市价开仓（5U×100x 逐仓） */
export async function openMarket(
  symbol: string, direction: "long" | "short", qty: number,
): Promise<OrderResult> {
  return call("POST", `${SIM_PREFIX}/order`, {
    symbol: symbol === "BTC" ? "BTCUSDT" : "XAUUSDT",
    side: direction === "long" ? "BUY" : "SELL",
    positionSide: direction === "long" ? "LONG" : "SHORT",
    type: "MARKET",
    quantity: String(qty),
    leverage: 100,
    marginCoin: "USDT",
    newClientOrderId: clientOrderId(symbol + Date.now(), "open"),
  });
}

/** 止损条件单（STOP_LOSS，触发后市价平仓） */
export async function placeStop(
  symbol: string, direction: "long" | "short", qty: number, stopPrice: number,
): Promise<OrderResult> {
  return call("POST", `${SIM_PREFIX}/order`, {
    symbol: symbol === "BTC" ? "BTCUSDT" : "XAUUSDT",
    side: direction === "long" ? "SELL" : "BUY",
    positionSide: direction === "long" ? "LONG" : "SHORT",
    type: "STOP_LOSS", // 部署演练时按 Weex 条件单实际 type 取值校正
    triggerPrice: String(stopPrice),
    triggerType: "CONTRACT_PRICE",
    quantity: String(qty),
    newClientOrderId: clientOrderId(symbol + Date.now(), "stop"),
  });
}

/** 一笔全仓止盈（TAKE_PROFIT） */
export async function placeTakeProfit(
  symbol: string, direction: "long" | "short", qty: number, tpPrice: number,
): Promise<OrderResult> {
  return call("POST", `${SIM_PREFIX}/order`, {
    symbol: symbol === "BTC" ? "BTCUSDT" : "XAUUSDT",
    side: direction === "long" ? "SELL" : "BUY",
    positionSide: direction === "long" ? "LONG" : "SHORT",
    type: "TAKE_PROFIT",
    triggerPrice: String(tpPrice),
    triggerType: "CONTRACT_PRICE",
    quantity: String(qty),
    newClientOrderId: clientOrderId(symbol + Date.now(), "tp"),
  });
}

/** 移保本（Q6 仅一次）：撤旧止损单 → 提交新价止损 */
export async function moveStop(
  symbol: string, direction: "long" | "short", qty: number, newStop: number,
  oldOrderId: string,
): Promise<OrderResult> {
  if (oldOrderId) {
    const cancel = await call("DELETE", `${SIM_PREFIX}/order?orderId=${encodeURIComponent(oldOrderId)}`);
    if (!cancel.ok) return { ok: false, error: `撤旧止损失败: ${cancel.error}` };
  }
  return placeStop(symbol, direction, qty, newStop);
}

/** 底线 2：止损提交失败 → 立即市价平仓 */
export async function emergencyClose(
  symbol: string, direction: "long" | "short", qty: number,
): Promise<OrderResult> {
  return call("POST", `${SIM_PREFIX}/order`, {
    symbol: symbol === "BTC" ? "BTCUSDT" : "XAUUSDT",
    side: direction === "long" ? "SELL" : "BUY",
    positionSide: direction === "long" ? "LONG" : "SHORT",
    type: "MARKET",
    quantity: String(qty),
    reduceOnly: true,
    newClientOrderId: clientOrderId(symbol + Date.now(), "emg"),
  });
}
