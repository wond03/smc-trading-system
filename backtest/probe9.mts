// 探针 9：背离检测诊断——为什么 30M 上 divergence 全程 0 次
import { swingPoints, rsiSeries } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  const n = 6;
  const swings = swingPoints(cs, n);
  const lows = swings.filter((s) => s.kind === "low");
  const highs = swings.filter((s) => s.kind === "high");
  console.log("swing lows:", lows.length, "swing highs:", highs.length);
  const rsi = rsiSeries(cs);
  // 最近 5 组相邻低点对，打印价格与 RSI 对比
  for (let k = Math.max(1, lows.length - 5); k < lows.length; k++) {
    const p = lows[k - 1]!, q = lows[k]!;
    const rp = rsi[p.index], rq = rsi[q.index];
    const cond = q.price < p.price && rq > rp;
    console.log(`低点对: ${p.price.toFixed(0)}(rsi ${rp?.toFixed(1)}) → ${q.price.toFixed(0)}(rsi ${rq?.toFixed(1)}) 更低+RSI更高=${cond}`);
  }
  for (let k = Math.max(1, highs.length - 5); k < highs.length; k++) {
    const p = highs[k - 1]!, q = highs[k]!;
    const rp = rsi[p.index], rq = rsi[q.index];
    const cond = q.price > p.price && rq < rp;
    console.log(`高点对: ${p.price.toFixed(0)}(rsi ${rp?.toFixed(1)}) → ${q.price.toFixed(0)}(rsi ${rq?.toFixed(1)}) 更高+RSI更低=${cond}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
