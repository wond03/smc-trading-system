
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
// MSS 后 12 根内：回踩最深到转位的距离分布（多头：min low vs 扫荡极值）
const depths: number[] = [];
let touchedFvg = 0, total = 0;
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
  const mssIdx = hist.findIndex(c => c.openTime === mss.time);
  if (mssIdx < 0) continue;
  const key = `${trigDir}_${Math.floor(i/12)}`;
  if (key === lastKey) continue;
  lastKey = key;
  const atr = atr14(hist);
  const seg = hist.filter(c => c.openTime >= c1.openTime && c.openTime <= mss.time);
  const ext = trigDir === "up" ? Math.min(...seg.map(c=>c.low)) : Math.max(...seg.map(c=>c.high));
  const win = hist.slice(mssIdx, mssIdx + 13);
  if (win.length < 2) continue;
  total++;
  const retrace = trigDir === "up" ? Math.min(...win.map(c=>c.low)) : Math.max(...win.map(c=>c.high));
  const d = trigDir === "up" ? (retrace - ext)/atr : (ext - retrace)/atr;
  depths.push(Math.max(0, d));
  const zones = fvgZones(hist, hist.length-1, 30);
  const dirLong = trigDir === "up";
  const z = zones.filter(zz => dirLong ? zz.direction==="long" : zz.direction==="short").pop();
  if (z && win.some(c => c.low <= z.high && c.high >= z.low)) touchedFvg++;
}
depths.sort((a,b)=>a-b);
const q=(p:number)=>depths[Math.floor(depths.length*p)]?.toFixed(2);
console.log({ setup: total, '回踩到转位0ATR内': depths.filter(d=>d<=0.25).length, '0.5内': depths.filter(d=>d<=0.5).length, '1内': depths.filter(d=>d<=1).length, P50:q(.5), P75:q(.75), '触及FVG': touchedFvg });
