// 探针 18b：复现 BTC 09-03 那单的 TP 方向 bug（用回测同款分页取数）
import { bosEvents, mssAfter, fvgZones } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function fetchCandles(from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursorTo = Math.floor(to / 1000);
  while (cursorTo * 1000 > from) {
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&from=${cursorTo - 1000 * 1800}&to=${cursorTo}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const rows = (await res.json()) as any[];
    if (!rows.length) break;
    for (const r of rows) out.push({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v });
    const minT = Math.min(...rows.map((r) => r.t));
    if (minT * 1000 <= from || rows.length < 1000) break;
    cursorTo = minT - 1;
  }
  const map = new Map<number, Candle>();
  for (const c of out) map.set(c.openTime, c);
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

async function main() {
  const to = Date.parse("2026-09-04T00:00:00Z");
  const cs = await fetchCandles(to - 20 * 86400000, to);
  const target = Date.parse("2026-09-03T15:30:00Z");
  const idx = cs.findIndex((c) => c.openTime >= target);
  console.log("signal bar:", new Date(cs[idx]!.openTime).toISOString());
  const win = cs.slice(Math.max(0, idx - 299), idx + 1);
  const evs = bosEvents(win, 6);
  const dir = evs[evs.length - 1]!.direction;
  console.log("dir:", dir);
  const mss = mssAfter(win, cs[idx - 12]!.openTime, dir, 6);
  console.log("mss:", mss && { time: new Date(mss.time).toISOString(), level: mss.level.toFixed(1) });
  const zones = fvgZones(win, win.length - 1, 30);
  const dirZones = zones.filter((z) => (dir === "up" ? z.direction === "long" : z.direction === "short"));
  console.log("dirZones:", dirZones.map((z) => ({ lo: z.low.toFixed(1), hi: z.high.toFixed(1), age: win.length - 1 - z.createdIndex })));
}
main().catch(e => { console.error(e); process.exit(1); });
