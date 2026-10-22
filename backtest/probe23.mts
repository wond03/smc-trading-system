// probe23：拒绝漏斗逐层拆解——265 次扫荡到底死在哪一层
import { readFileSync } from "fs";
import type { Candle } from "../convex/indicators";
import { swingPoints, bosEvents, mssAfter, chochAfter, atr14, fvgZones } from "../convex/indicators";

const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
async function fetchK(contract: string, iv: string, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let f = from;
  while (f < to) {
    const t2 = Math.min(f + 1000 * 1800 * 1000, to);
    const u = `${host}?contract=${contract}&interval=${iv}&from=${Math.floor(f/1000)}&to=${Math.floor(t2/1000)}`;
    const r = await (globalThis as any).fetch(u).then((x: any) => x.json());
    for (const k of r ?? []) out.push({ openTime: +k.t * 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
    f = t2;
  }
  return out;
}

const sym = (process.argv[2] ?? "BTC") === "XAU" ? "XAU_USDT" : "BTC_USDT";
const days = 60;
const to = Date.now();
const from = to - days * 86400000;
const m30 = await fetchK(sym, "30m", from, to);
console.log(`K线 ${m30.length} 根`);

// 逐根重演：统计每层通过率
let sweepEvents = 0, mssOk = 0, chochOk = 0, fvgPathOk = 0;
let mssFailDirWrong = 0;
for (let i = 200; i < m30.length; i++) {
  const hist = m30.slice(0, i + 1);
  // 模拟扫荡扳机：最近 3 根内有影线刺穿 swing low 且收回（多头）
  const swings = swingPoints(hist.slice(0, -3), 6);
  const lows = swings.filter(s => s.kind === "low");
  const highs = swings.filter(s => s.kind === "high");
  let trigDir: "up" | "down" | null = null;
  const c0 = hist[i]!, c1 = hist[i-1]!;
  for (const s of lows) if (c1.low < s.price && c1.close > s.price) trigDir = "up";
  for (const s of highs) if (c1.high > s.price && c1.close < s.price) trigDir = trigDir ?? "down";
  if (!trigDir) continue;
  sweepEvents++;
  // MSS
  const mss = mssAfter(hist, c1.openTime, trigDir, 6);
  if (!mss) continue;
  mssOk++;
  // CHOCH
  const ch = chochAfter(hist, c1.openTime, trigDir, 6);
  if (!ch) continue;
  chochOk++;
  // FVG 路径
  const atr = atr14(hist);
  const zones = fvgZones(hist, hist.length - 1, 30);
  const dirLong = trigDir === "up";
  const chochLv = dirLong ? ch.pivotLow : ch.pivotHigh;
  const onPath = zones.filter(z => (dirLong ? z.direction === "long" : z.direction === "short"))
    .filter(z => {
      const edge = dirLong ? z.high : z.low;
      return dirLong ? edge >= chochLv && edge - chochLv <= atr : edge <= chochLv && chochLv - edge <= atr;
    });
  if (onPath.length) fvgPathOk++;
}
console.log({ 扫荡事件: sweepEvents, MSS通过: mssOk, 转势位通过: chochOk, FVG路径通过: fvgPathOk });
