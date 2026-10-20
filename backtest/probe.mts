import type { Candle } from "../convex/indicators";
import { swingPoints } from "../convex/indicators";

const CONTRACT: Record<string, string> = { BTC: "BTC_USDT", XAU: "XAU_USDT" };
async function fetchCandles(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
  const contract = CONTRACT[symbol] ?? CONTRACT["BTC"]!;
  const out: Candle[] = [];
  let cursorTo = Math.floor(to / 1000);
  while (cursorTo * 1000 > from) {
    const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${interval}&from=${cursorTo - 1500 * 300}&to=${cursorTo}`;
    const res = await fetch(url);
    const rows = (await res.json()) as any[];
    if (rows.length === 0) break;
    for (const r of rows) out.push({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v });
    const minT = Math.min(...rows.map((r) => r.t));
    if (minT * 1000 <= from || rows.length < 1000) break;
    cursorTo = minT - 1;
  }
  const map = new Map<number, Candle>();
  for (const c of out) map.set(c.openTime, c);
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

const to = Date.now(), from = to - 14 * 86400000;
const m5 = await fetchCandles("XAU", "5m", from - 7*86400000, to);
console.log("candles:", m5.length);
// 模拟 buildLevels + 状态机，统计每类水平的 swept/broken 比例
const h1: Candle[] = [];
for (const c of m5) {
  const b = Math.floor(c.openTime / 3600000) * 3600000;
  const last = h1[h1.length - 1];
  if (!last || last.openTime !== b) h1.push({ openTime: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
  else { last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; }
}
const swings = swingPoints(h1).slice(-10);
console.log("h1 swings:", swings.map(s => `${s.kind}:${s.price.toFixed(0)}`).join(", "));
// 用最后 7 天 5m 检查每个 swing 是否被扫/破
let swept = 0, broken = 0, untouched = 0;
for (const s of swings) {
  const lvl = s.price;
  let st: string = "untouched";
  for (const c of m5.filter(c => c.openTime >= from)) {
    if (st !== "untouched") continue;
    const isSwept = lvl > c.close ? (c.low < lvl && c.close > lvl) : (c.high > lvl && c.close < lvl);
    const isBroken = lvl > c.close ? c.close < lvl : c.close > lvl;
    if (isSwept) st = "swept"; else if (isBroken) st = "broken";
  }
  if (st === "swept") swept++; else if (st === "broken") broken++; else untouched++;
}
console.log(`swing levels: swept=${swept} broken=${broken} untouched=${untouched}`);
