// 探针 12：MSS direction 语义诊断——runner 的调用方式 vs lastMSS 的实际行为
// runner 期望：lastMSS(win, 反方向) 返回顺方向(=dir)的 MSS。
// lastMSS 实现：先取 BOS trend（=dir，因为 runner 的第 1 层用同一个 win 的最新 BOS），
// 然后要求最新蜡烛收盘穿越逆 trend 摆动点 → 返回与 trend 相反的 direction。
// 即 lastMSS 永远返回「逆当前趋势」的方向 —— 与 runner 期望的「顺方向」永远相反！
import { bosEvents, lastMSS } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=300";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  const evs = bosEvents(cs, 6);
  const dir = evs[evs.length - 1]!.direction;
  console.log("BOS dir:", dir);
  // runner 调用：lastMSS(win, dir === "up" ? "down" : "up")，期望 mss.direction === dir
  const mss = lastMSS(cs, dir === "up" ? "down" : "up", 6);
  console.log("lastMSS result:", mss ? { direction: mss.direction, time: new Date(mss.time).toISOString().slice(5, 16), level: mss.level.toFixed(1) } : null);
  console.log("runner 期望 direction === dir:", dir, "→ 实际:", mss?.direction, "匹配:", mss?.direction === dir);
}
main().catch(e => { console.error(e); process.exit(1); });
