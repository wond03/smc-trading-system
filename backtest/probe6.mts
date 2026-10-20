// 探针6：回测内层分布诊断——每次 evaluate 停在哪一层
import { readFileSync } from "fs";
const t = JSON.parse(readFileSync("backtest/BTC-trades.json", "utf8"));
console.log("trades:", t.length);
// layer 分布需要回测脚本输出；直接在 backtest.ts 加统计更好——临时脚本：
import { swingPoints, lastBOS, lastMSS, atr14, type Candle } from "../convex/indicators";
import { evaluate, DEFAULT_PARAMS, type LiquidityLevel } from "../convex/signalEngine";

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

function resample(m5: Candle[], mult: number): Candle[] {
  const bucketMs = 5 * 60000 * mult;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of m5) {
    const b = Math.floor(c.openTime / bucketMs) * bucketMs;
    if (!cur || cur.openTime !== b) { if (cur) out.push(cur); cur = { openTime: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; }
    else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume; }
  }
  if (cur) out.push(cur);
  return out;
}

const to = Date.now(), from = to - 14 * 86400000;
const m5All = await fetchC("BTC", from - 7 * 86400000, to);
const layerCount: Record<number, number> = {};
let layer1 = 0;
let sweptEver = 0;

interface Level { id: string; kind: string; price: number; status: "untouched" | "swept" | "broken"; sweptTime?: number; }
const levels: Level[] = [];
// 逐小时生成水平（对齐回测主循环）
for (let i = 0; i < m5All.length; i++) {
  const c = m5All[i]!;
  if (c.openTime < from) continue;
  const atrBuf = 0.1 * atr14(m5All.slice(Math.max(0, i - 299), i + 1));
  for (const lvl of levels) {
    if (lvl.status === "swept") continue;
    const swept = lvl.price > c.close ? c.low < lvl.price && c.close > lvl.price : c.high > lvl.price && c.close < lvl.price;
    const broken = lvl.price > c.close ? c.close < lvl.price - atrBuf : c.close > lvl.price + atrBuf;
    if (lvl.status === "untouched") {
      if (swept) { lvl.status = "swept"; lvl.sweptTime = c.openTime; }
      else if (broken) lvl.status = "broken";
    } else if (lvl.status === "broken") {
      const backInside = lvl.price > c.close ? c.close > lvl.price - atrBuf : c.close < lvl.price + atrBuf;
      if (backInside) { lvl.status = "swept"; lvl.sweptTime = c.openTime; }
    }
  }
  if (c.openTime % 3600000 < 300000) {
    const m5 = m5All.slice(Math.max(0, i - 299), i + 1);
    const h1 = resample(m5, 12);
    const swings = swingPoints(h1).slice(-10);
    for (const s of swings) {
      const id = `h1_${s.kind}_${h1[s.index]!.openTime}`;
      if (!levels.some((l) => l.id === id)) {
        levels.push({ id, kind: s.kind === "high" ? "swingHigh" : "swingLow", price: s.price, status: "untouched" });
      }
    }
  }
  // 每 30 分钟统计一次 evaluate 层分布
  if (i % 6 === 0) {
    const m5 = m5All.slice(Math.max(0, i - 299), i + 1);
    const m15 = resample(m5, 3);
    const h1 = resample(m5, 12);
    const d1 = resample(m5, 288);
    if (m5.length < 50 || d1.length < 3) continue;
    const dailyMss = lastMSS(d1, "up");
    const bos = lastBOS(h1);
    const dailyDir = dailyMss?.direction ?? (d1[d1.length - 1]!.close > d1[d1.length - 2]!.close ? "up" : "down");
    const hourDir = bos?.direction;
    if (!hourDir || hourDir !== dailyDir) { layer1++; continue; }
    const sweptLevels: LiquidityLevel[] = levels.filter((l) => l.status === "swept").map((l) => ({ kind: l.kind, price: l.price, status: "swept", sweptTime: l.sweptTime }));
    const r = evaluate(m5, m15, sweptLevels, hourDir, DEFAULT_PARAMS);
    layerCount[r.layer] = (layerCount[r.layer] ?? 0) + 1;
    if (r.outcome === "signal") sweptEver++;
  }
}
console.log("层1拒绝（方向矛盾）:", layer1);
console.log("层分布:", JSON.stringify(layerCount));
console.log("信号:", sweptEver);
console.log("水平总数:", levels.length, "swept:", levels.filter(l => l.status === "swept").length, "broken:", levels.filter(l => l.status === "broken").length, "untouched:", levels.filter(l => l.status === "untouched").length);
