// 探针：统计 h1 摆动水平在 5m 上出现"影线扫荡收回"的频率（isSwept 口径 vs broken 口径）
import { swingPoints, type Candle } from "../convex/indicators";

async function fetchC(sym: string, from: number, to: number): Promise<Candle[]> {
  const contract = sym === "XAU" ? "XAU_USDT" : "BTC_USDT";
  const out: Candle[] = [];
  let cursorTo = Math.floor(to / 1000);
  while (cursorTo * 1000 > from) {
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=5m&from=${cursorTo - 1500 * 300}&to=${cursorTo}`;
    const rows = (await (await fetch(url)).json()) as { t: number; o: string; h: string; l: string; c: string }[];
    if (!rows.length) break;
    for (const r of rows) out.push({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: 0 });
    const minT = Math.min(...rows.map((r) => r.t));
    if (minT * 1000 <= from || rows.length < 1000) break;
    cursorTo = minT - 1;
  }
  const m = new Map<number, Candle>();
  for (const c of out) m.set(c.openTime, c);
  return [...m.values()].sort((a, b) => a.openTime - b.openTime);
}

async function main(sym: string) {
  const to = Date.now();
  const from = to - 10 * 86400000;
  const m5 = await fetchC(sym, from, to);
  const h1: Candle[] = [];
  for (const c of m5) {
    const b = Math.floor(c.openTime / 3600000) * 3600000;
    const last = h1[h1.length - 1];
    if (!last || last.openTime !== b) h1.push({ openTime: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
  }
  const swings = swingPoints(h1).slice(-30);
  let sweptCount = 0, brokenFirst = 0, never = 0;
  for (const s of swings) {
    const lvl = s.price;
    const created = h1[s.index]!.openTime + 3 * 3600000; // 摆动点确认（右 3 根）
    let st: "swept" | "broken" | "never" = "never";
    for (const c of m5) {
      if (c.openTime <= created) continue;
      const up = c.high > lvl && c.close < lvl;
      const dn = c.low < lvl && c.close > lvl;
      if (up || dn) { st = "swept"; break; }
      const br = lvl > c.close ? c.close < lvl : c.close > lvl;
      if (br) { st = "broken"; break; }
    }
    if (st === "swept") sweptCount++;
    else if (st === "broken") brokenFirst++;
    else never++;
  }
  console.log(`${sym}: 30 个 h1 摆动水平 → 影线扫荡收回 ${sweptCount} | 直接破位 ${brokenFirst} | 从未触碰 ${never}`);
}

await main("BTC");
await main("XAU");
