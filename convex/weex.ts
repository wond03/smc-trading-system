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

// 模拟盘域名（官方文档）：https://api-sim.weex.com，路径与实盘完全一致
const BASE = process.env.WEEX_BASE_URL ?? "https://api-sim.weex.com";
const SIM_PREFIX = "/capi/v3";

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
    if (!res.ok) {
      // 错误体是 JSON {code,msg}
      try {
        const err = JSON.parse(text);
        return { ok: false, error: err.msg || err.message || ("HTTP " + res.status + ": " + text.slice(0, 200)) };
      } catch { return { ok: false, error: "HTTP " + res.status + ": " + text.slice(0, 200) }; }
    }
    // 响应可能是 {orderId:"...",success:true} 或 [{orderId:19位数字,...}]（placeTpSlOrder）
    // 19 位数字超出 JS Number 安全范围，必须用正则从原始文本提取，避免 JSON.parse 精度截断
    const failed = text.match(/"success"\s*:\s*false/);
    if (failed) {
      const em = text.match(/"errorMessage"\s*:\s*"([^"]*)"/);
      return { ok: false, error: em?.[1] ?? "order rejected" };
    }
    const om = text.match(/"orderId"\s*:\s*"?([0-9]+)"?/);
    const orderId = om?.[1];
    return orderId ? { ok: true, orderId } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function clientOrderId(seed: string, action: string): string {
  // Weex 客户端 ID：1-36 字符；实测冒号可能触发校验失败，只用字母数字
  return `${seed}${action}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 36);
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

/** 止损条件单：placeTpSlOrder / planType STOP_LOSS（触发后市价平仓），reduceOnly */
export async function placeStop(
  symbol: string, direction: "long" | "short", qty: number, stopPrice: number,
): Promise<OrderResult> {
  const id = clientOrderId(symbol + Date.now(), "stop");
  return call("POST", `/capi/v3/placeTpSlOrder`, {
    symbol: symbol === "BTC" ? "BTCUSDT" : "XAUUSDT",
    clientAlgoId: id,
    planType: "STOP_LOSS",
    triggerPrice: String(stopPrice),
    quantity: String(qty),
    positionSide: direction === "long" ? "LONG" : "SHORT",
    reduceOnly: true,
  });
}

/** 一笔全仓止盈：placeTpSlOrder / planType TAKE_PROFIT，reduceOnly */
export async function placeTakeProfit(
  symbol: string, direction: "long" | "short", qty: number, tpPrice: number,
): Promise<OrderResult> {
  const id = clientOrderId(symbol + Date.now(), "tp");
  return call("POST", `/capi/v3/placeTpSlOrder`, {
    symbol: symbol === "BTC" ? "BTCUSDT" : "XAUUSDT",
    clientAlgoId: id,
    planType: "TAKE_PROFIT",
    triggerPrice: String(tpPrice),
    quantity: String(qty),
    positionSide: direction === "long" ? "LONG" : "SHORT",
    reduceOnly: true,
  });
}

/** 移保本（Q6 仅一次）：撤旧止损单 → 提交新价止损 */
export async function moveStop(
  symbol: string, direction: "long" | "short", qty: number, newStop: number,
  oldOrderId: string,
): Promise<OrderResult> {
  if (oldOrderId) {
    const cancel = await call("DELETE", `/capi/v3/algoOrder?orderId=${encodeURIComponent(oldOrderId)}`);
    if (!cancel.ok) return { ok: false, error: `撤旧止损失败: ${cancel.error}` };
  }
  return placeStop(symbol, direction, qty, newStop);
}

// 演练用：返回完整原始响应，用于参数排错
export async function rawCall(method: "POST"|"GET"|"DELETE", path: string, body?: unknown): Promise<{status:number; text:string}> {
  const bodyStr = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, {
    method, headers: headers(method, path, bodyStr),
    body: bodyStr === "" ? undefined : bodyStr,
  });
  return { status: res.status, text: (await res.text()).slice(0, 500) };
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
