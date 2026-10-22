
import type { Candle } from "./convex/indicators";
import { swingPoints } from "./convex/indicators";
const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
async function fetchK(c: string, iv: string, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = []; let f = from;
  while (f < to) {
    const t2 = Math.min(f + 1000*1800*1000, to);
    const r = await (globalThis as any).fetch(`${host}?contract=${c}&interval=${iv}&from=${Math.floor(f/1000)}&to=${Math.floor(t2/1000)}`).then((x:any)=>x.json());
    for (const k of r ?? []) out.push({ openTime:+k.t*1000, open:+k.o, high:+k.h, low:+k.l, close:+k.c, volume:+k.v });
    f = t2;
  }
  return out;
}
const m30 = await fetchK("BTC_USDT", "30m", Date.now()-60*86400000, Date.now());
let inWin = 0, out = 0;
for (const c of m30) {
  const h = new Date(c.openTime + 8*3600000).getUTCHours();
  if ((h >= 20) || (h < 10)) inWin++; else out++;
}
console.log({ 时段内蜡烛: inWin, 时段外: out, 比例: (inWin/m30.length*100).toFixed(0)+'%' });
