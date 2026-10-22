
import type { Candle } from "./convex/indicators";
import { swingPoints } from "./convex/indicators";
const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
async function fetchK(contract: string, iv: string, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let f = from;
  while (f < to) {
    const t2 = Math.min(f + 1000 * 1800 * 1000, to);
    const r = await (globalThis as any).fetch(`${host}?contract=${contract}&interval=${iv}&from=${Math.floor(f/1000)}&to=${Math.floor(t2/1000)}`).then((x: any) => x.json());
    for (const k of r ?? []) out.push({ openTime: +k.t * 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
    f = t2;
  }
  return out;
}
const m30 = await fetchK("BTC_USDT", "30m", Date.now() - 60*86400000, Date.now());
let noRef = 0, refButNoBest = 0, bestNotBeyond = 0, noConfirm = 0, ok = 0;
for (let i = 200; i < m30.length; i++) {
  const hist = m30.slice(0, i + 1);
  const swings = swingPoints(hist.slice(0, i - 2), 6);
  const c1 = hist[i-1]!;
  let trigDir: "up" | "down" | null = null;
  for (const s of swings.filter(s=>s.kind==="low")) if (c1.low < s.price && c1.close > s.price) trigDir = "up";
  for (const s of swings.filter(s=>s.kind==="high")) if (c1.high > s.price && c1.close < s.price) trigDir = trigDir ?? "down";
  if (!trigDir) continue;
  const sinceIdx = hist.findIndex(c => c.openTime >= c1.openTime);
  const seg = hist.slice(sinceIdx);
  if (trigDir === "up") {
    const refHigh = swings.filter(s => s.kind === "high").pop();
    if (!refHigh) { noRef++; continue; }
    let best: any = null;
    for (let j = 0; j < seg.length; j++) if (!best || seg[j].low < best.price) best = { index: sinceIdx + j, price: seg[j].low };
    if (best.price >= refHigh.price) { bestNotBeyond++; continue; }
    let found = false;
    for (let k = best.index + 1; k < hist.length - 1; k++) if (hist[k].close > best.price && hist[k+1].close > best.price) { found = true; break; }
    if (found) ok++; else noConfirm++;
  } else {
    const refLow = swings.filter(s => s.kind === "low").pop();
    if (!refLow) { noRef++; continue; }
    let best: any = null;
    for (let j = 0; j < seg.length; j++) if (!best || seg[j].high > best.price) best = { index: sinceIdx + j, price: seg[j].high };
    if (best.price <= refLow.price) { bestNotBeyond++; continue; }
    let found = false;
    for (let k = best.index + 1; k < hist.length - 1; k++) if (hist[k].close < best.price && hist[k+1].close < best.price) { found = true; break; }
    if (found) ok++; else noConfirm++;
  }
}
console.log({ ok, noRef, bestNotBeyond, noConfirm });
