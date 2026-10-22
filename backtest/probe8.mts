// 探针 8：MSS 判定逐层诊断——为什么当前 30M 蜡烛上 MSS 全部为 null
import { bosEvents, lastMSS, swingPoints } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));

  const evs = bosEvents(cs, 6);
  const trend = evs[evs.length - 1]!.direction;
  console.log("trend:", trend);
  const swings = swingPoints(cs.slice(0, -1), 6);
  const opposite = trend === "up" ? "high" : "low";
  const cands = swings.filter((s) => s.kind === opposite && s.index < cs.length - 7);
  const nearest = cands[cands.length - 1];
  const c = cs[cs.length - 1]!;
  console.log("nearest opposite swing:", nearest && { kind: nearest.kind, idx: nearest.index, price: nearest.price.toFixed(1), bar: cs[nearest.index]!.openTime });
  console.log("last candle close:", c.close.toFixed(1), "openTime:", new Date(c.openTime).toISOString());
  if (nearest) {
    console.log("条件: trend up 时 c.close < level ? ", trend === "up", c.close < nearest.price);
    console.log("条件: trend down 时 c.close > level ?", trend === "down", c.close > nearest.price);
  }
  // 回看：最近 60 根里有多少根曾满足 MSS 条件
  let count = 0;
  for (let i = cs.length - 60; i < cs.length; i++) {
    const win = cs.slice(0, i + 1);
    const m = lastMSS(win, trend === "up" ? "down" : "up", 6);
    if (m && m.time === cs[i]!.openTime) count++;
  }
  console.log("最近 60 根 MSS(对当前 trend) 触发次数:", count);
}
main().catch(e => { console.error(e); process.exit(1); });
