// Weex 下单接口封装（Convex action 调用）。
// 设计要点（PRD 模块四 + Q9）：
// - 幂等：requestKey = signalNo + action + 价格，先查 orderLogs 防重复提交。
// - 止损必须真实提交（底线 2）；提交失败 → 立即市价平仓 + 告警。
// - 密钥从 Convex 环境变量读取（WEEX_API_KEY / WEEX_SECRET / WEEX_BASE_URL）。

export interface OrderResult {
  ok: boolean;
  orderId?: string;
  error?: string;
}

const DEFAULT_BASE = "https://api.weex.com"; // 部署时按 Weex 文档确认域名与路径

function authHeaders(): HeadersInit {
  // Convex 环境变量在 action 运行时可用
  const key = process.env.WEEX_API_KEY ?? "";
  const secret = process.env.WEEX_SECRET ?? "";
  if (!key || !secret) throw new Error("WEEX 凭据未配置（convex env set）");
  // TODO: 按 Weex 官方文档实现签名（HMAC）。部署前补齐。
  return { "X-API-KEY": key, "Content-Type": "application/json" };
}

async function call(path: string, body: unknown): Promise<OrderResult> {
  const base = process.env.WEEX_BASE_URL ?? DEFAULT_BASE;
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { orderId?: string; msg?: string };
    const orderId = typeof data.orderId === "string" ? data.orderId : undefined;
    if (!res.ok) return { ok: false, error: data.msg ?? `HTTP ${res.status}` };
    return orderId ? { ok: true, orderId } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function makeRequestKey(signalNo: string, action: string, price: number): string {
  return `${signalNo}:${action}:${price}`;
}

export async function openMarket(
  symbol: string, direction: "long" | "short", qty: number,
): Promise<OrderResult> {
  return call("/futures/order", {
    symbol, side: direction === "long" ? "buy" : "sell",
    type: "market", size: qty, lever: 100, marginMode: "isolated",
  });
}

export async function placeStop(
  symbol: string, direction: "long" | "short", qty: number, stopPrice: number,
): Promise<OrderResult> {
  // STOP_LOSS 条件单，触发后市价平仓
  return call("/futures/trigger-order", {
    symbol, side: direction === "long" ? "sell" : "buy",
    triggerType: "STOP_LOSS", triggerPrice: stopPrice, size: qty, type: "market",
  });
}

export async function placeTakeProfit(
  symbol: string, direction: "long" | "short", qty: number, tpPrice: number,
): Promise<OrderResult> {
  return call("/futures/trigger-order", {
    symbol, side: direction === "long" ? "sell" : "buy",
    triggerType: "TAKE_PROFIT", triggerPrice: tpPrice, size: qty, type: "market",
  });
}

/** 移保本：撤销旧止损单，提交新价（Q6：仅一次） */
export async function moveStop(
  symbol: string, direction: "long" | "short", qty: number, newStop: number,
  oldOrderId: string,
): Promise<OrderResult> {
  const cancel = await fetch(`${process.env.WEEX_BASE_URL ?? DEFAULT_BASE}/futures/trigger-order/${oldOrderId}/cancel`, {
    method: "POST", headers: authHeaders(),
  });
  if (!cancel.ok) return { ok: false, error: `撤旧止损失败 HTTP ${cancel.status}` };
  return placeStop(symbol, direction, qty, newStop);
}

/** 底线 2：止损提交失败 → 立即市价平仓 */
export async function emergencyClose(
  symbol: string, direction: "long" | "short", qty: number,
): Promise<OrderResult> {
  return call("/futures/order", {
    symbol, side: direction === "long" ? "sell" : "buy",
    type: "market", size: qty, reduceOnly: true,
  });
}
