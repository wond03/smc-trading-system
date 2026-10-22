
import type { Candle } from "./convex/indicators";
import { swingPoints, chochAfter } from "./convex/indicators";
const cs: Candle[] = [];
let p = 100;
for (let i = 0; i < 50; i++) { p -= 1; cs.push({ openTime: i*1000, open: p+1, high: p+1.5, low: p-1, close: p }); }
cs.push({ openTime: 50000, open: 51, high: 52, low: 46, close: 52 });
for (let i = 51; i < 70; i++) { p += 1.5; cs.push({ openTime: i*1000, open: p-1, high: p+0.5, low: p-1.5, close: p }); }
const sinceIdx = cs.findIndex(c => c.openTime >= 50000);
console.log("sinceIdx", sinceIdx);
const seg = cs.slice(sinceIdx);
let best = null as any;
for (let i = 0; i < seg.length; i++) if (!best || seg[i].low < best.price) best = { index: sinceIdx + i, price: seg[i].low };
console.log("best", best);
const swings = swingPoints(cs.slice(0, sinceIdx), 6);
const refHigh = swings.filter(s => s.kind === "high").pop();
console.log("refHigh", refHigh);
console.log("best<refHigh?", refHigh ? best.price < refHigh.price : "no ref");
for (let i = best.index + 1; i < cs.length - 1; i++) {
  if (cs[i].close > best.price && cs[i+1].close > best.price) { console.log("确认 at", i); break; }
}
