// 探针 10：背离检测——历史出现频率统计（放宽为最近 5 组摆动点里找背离，而不是只看最近 2 个）
import { swingPoints, rsiSeries } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  const n = 6;
  const swings = swingPoints(cs, n);
  const rsi = rsiSeries(cs);
  const lows = swings.filter((s) => s.kind === "low");
  const highs = swings.filter((s) => s.kind === "high");

  let bullDiv = 0;
  for (let k = 1; k < lows.length; k++) {
    const p = lows[k - 1]!, q = lows[k]!;
    if (q.price < p.price && (rsi[q.index] ?? 0) > (rsi[p.index] ?? 100)) bullDiv++;
  }
  let bearDiv = 0;
  for (let k = 1; k < highs.length; k++) {
    const p = highs[k - 1]!, q = highs[k]!;
    if (q.price > p.price && (rsi[q.index] ?? 100) < (rsi[p.index] ?? 0)) bearDiv++;
  }
  console.log(`全程 bullDiv 次数: ${bullDiv} / ${lows.length - 1} 组低点对`);
  console.log(`全程 bearDiv 次数: ${bearDiv} / ${highs.length - 1} 组高点对`);
  // 最近一次背离距今多少根
  let lastDivIdx = -1;
  for (let k = 1; k < lows.length; k++) {
    const p = lows[k - 1]!, q = lows[k]!;
    if (q.price < p.price && (rsi[q.index] ?? 0) > (rsi[p.index] ?? 100)) lastDivIdx = q.index;
  }
  console.log("最近 bull 背离低点 bar:", lastDivIdx, "距今", cs.length - 1 - lastDivIdx, "根");
}
main().catch(e => { console.error(e); process.exit(1); });
