// 探针5：追踪单个水平的完整触碰序列——第一次触碰时蜡烛到底长什么样
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
    const bucket = Math.floor(c.openTime / 3600000) * 3600000;
    const last = h1[h1.length - 1];
    if (!last || last.openTime !== bucket) h1.push({ openTime: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
  }
  const s = swingPoints(h1).slice(-3)[0]!;
  const lvl = s.price;
  const created = h1[s.index]!.openTime;
  console.log(`${sym} 水平: ${s.kind} ${lvl.toFixed(1)} (h1 ${new Date(created).toISOString()})`);
  let shown = 0;
  for (const c of m5) {
    if (c.openTime <= created + 3 * 3600000) continue;
    // 触碰 = 影线触及水平 ± 0.05%
    const touched = Math.abs(c.high - lvl) < lvl * 5e-4 || Math.abs(c.low - lvl) < lvl * 5e-4 ||
      (c.low < lvl && c.high > lvl);
    if (touched && shown < 5) {
      shown++;
      const up = c.high > lvl && c.close < lvl;
      const dn = c.low < lvl && c.close > lvl;
      const br = lvl > c.close ? c.close < lvl : c.close > lvl;
      console.log(`  触碰 ${new Date(c.openTime).toISOString().slice(5, 16)} O${c.open.toFixed(1)} H${c.high.toFixed(1)} L${c.low.toFixed(1)} C${c.close.toFixed(1)} → ${up ? "上扫收回" : dn ? "下扫收回" : br ? "收盘破位" : "触及未穿"}`);
    }
  }
  if (shown === 0) console.log("  10 天内从未被 5m 触碰（±0.05%）");
}

await main("BTC");
await main("XAU");
