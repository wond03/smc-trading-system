// 探针：不同破位缓冲下，h1 摆动水平的 swept/broken/untouched 分布
import { swingPoints, atr14, type Candle } from "../convex/indicators";

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

async function probe(sym: string, bufMults: number[]) {
  const to = Date.now();
  const from = to - 10 * 86400000;
  const m5 = await fetchC(sym, from, to);
  // 逐根推进时算 ATR，模拟真实流
  const atrs: number[] = m5.map((_, i) => atr14(m5.slice(Math.max(0, i - 299), i + 1)));

  const results: Record<number, { swept: number; broken: number; never: number }> = {};
  for (const b of bufMults) results[b] = { swept: 0, broken: 0, never: 0 };

  const h1: Candle[] = [];
  for (const c of m5) {
    const bucket = Math.floor(c.openTime / 3600000) * 3600000;
    const last = h1[h1.length - 1];
    if (!last || last.openTime !== bucket) h1.push({ openTime: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
  }
  const swings = swingPoints(h1).slice(-20);
  const m5From = m5.findIndex((c) => c.openTime >= from);

  for (const s of swings) {
    const lvl = s.price;
    const created = h1[s.index]!.openTime;
    for (const b of bufMults) {
      let st: "swept" | "broken" | "never" = "never";
      for (let i = m5From; i < m5.length; i++) {
        const c = m5[i]!;
        if (c.openTime <= created + 3 * 3600000) continue;
        const atrBuf = b * (atrs[i] ?? 0);
        const up = c.high > lvl && c.close < lvl;
        const dn = c.low < lvl && c.close > lvl;
        if (up || dn) { st = "swept"; break; }
        const br = lvl > c.close ? c.close < lvl - atrBuf : c.close > lvl + atrBuf;
        if (br) { st = "broken"; break; }
      }
      results[b]![st]++;
    }
  }
  const parts = bufMults.map((b) => `${b}×ATR: swept=${results[b]!.swept} broken=${results[b]!.broken} never=${results[b]!.never}`);
  console.log(`${sym}（20 个 h1 摆动水平）: ${parts.join(" | ")}`);
}

await probe("BTC", [0.1, 0.25, 0.5, 1.0]);
await probe("XAU", [0.1, 0.25, 0.5, 1.0]);
