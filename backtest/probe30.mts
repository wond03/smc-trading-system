
import type { Candle } from "../convex/indicators";
import { swingPoints, mssAfter, atr14, fvgZones } from "../convex/indicators";
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
const risks: number[] = [];
let lastKey = "";
for (let i = 200; i < m30.length; i++) {
  const hist = m30.slice(0, i+1);
  const swings = swingPoints(hist.slice(0, i-2), 6);
  const c1 = hist[i-1]!;
  let trigDir: "up"|"down"|null = null;
  for (const s of swings.filter(s=>s.kind==="low")) if (c1.low < s.price && c1.close > s.price) trigDir = "up";
  for (const s of swings.filter(s=>s.kind==="high")) if (c1.high > s.price && c1.close < s.price && !trigDir) trigDir = "down";
  if (!trigDir) continue;
  const mss = mssAfter(hist, c1.openTime, trigDir, 6);
  if (!mss) continue;
  const key = `${trigDir}_${Math.floor(i/12)}`;
  if (key === lastKey) continue; lastKey = key;
  const atr = atr14(hist);
  const seg = hist.filter(c => c.openTime >= c1.openTime);
  const ext = trigDir === "up" ? Math.min(...seg.map(c=>c.low)) : Math.max(...seg.map(c=>c.high));
  const zones = fvgZones(hist, hist.length-1, 30);
  const dirLong = trigDir === "up";
  const list = zones.filter(z => dirLong ? z.direction==="long" : z.direction==="short");
  if (!list.length) continue;
  const z = list[list.length-1]!;
  const entry = dirLong ? z.high : z.low;
  const stop = dirLong ? ext - 0.2*atr : ext + 0.2*atr;
  risks.push(Math.abs(entry - stop)/atr);
}
risks.sort((a,b)=>a-b);
const q=(p:number)=>risks[Math.floor(risks.length*p)]?.toFixed(2);
console.log({ n: risks.length, P25:q(.25), P50:q(.5), P75:q(.75), P90:q(.9) });
