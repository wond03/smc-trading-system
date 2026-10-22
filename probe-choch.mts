
import type { Candle } from "./convex/indicators";
import { chochAfter } from "./convex/indicators";
// 构造：下跌→扫荡低点→转上
const cs: Candle[] = [];
let p = 100;
for (let i = 0; i < 50; i++) { p -= 1; cs.push({ openTime: i*1000, open: p+1, high: p+1.5, low: p-1, close: p }); }
// 扫荡 + 反转
cs.push({ openTime: 50000, open: 51, high: 52, low: 46, close: 52 });  // 大影线扫荡
for (let i = 51; i < 70; i++) { p += 1.5; cs.push({ openTime: i*1000, open: p-1, high: p+0.5, low: p-1.5, close: p }); }
const ch = chochAfter(cs, 50000, "up", 6);
console.log("choch:", ch);
