// 探针4：检查水平生命周期——水平刚生成时是否已在该价位区间内（价格已越过水平）
// 疑点：h1 摆动点确认时（右 3 根已收盘），价格可能已经收盘越过该摆动价 → 第一检查就是 broken
import { swingPoints, atr14, type Candle } from "../convex/indicators";

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
  const swings = swingPoints(h1).slice(-20);

  let alreadyBeyond = 0, okStart = 0;
  for (const s of swings) {
    const lvl = s.price;
    // 摆动点确认时刻 = 该 h1 蜡烛收盘 + 右 3 根 h1 = 3 小时后。看 5m 序列在确认时刻的收盘
    const confirmTime = h1[s.index]!.openTime + 3 * 3600000 + 3600000;
    const cAtConfirm = m5.find((c) => c.openTime >= confirmTime - 300000 && c.openTime < confirmTime);
    if (!cAtConfirm) continue;
    // 摆动高点：确认时价格若已收盘越过高点 → 起始即 broken
    if (s.kind === "high" && cAtConfirm.close > lvl) alreadyBeyond++;
    else if (s.kind === "low" && cAtConfirm.close < lvl) alreadyBeyond++;
    else okStart++;
  }
  console.log(`${sym}: 摆动水平确认时价格已越过（起始即破位）${alreadyBeyond} / 正常 ${okStart} / 共 ${swings.length}`);
}

await main("BTC");
await main("XAU");
