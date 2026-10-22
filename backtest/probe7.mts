// 探针：诊断新口径零信号瓶颈（裁决记录 §3-3：先探针后调参）
import { bosEvents, lastMSS, detectDivergence, fvgZones, atr14 } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  console.log("bars", cs.length);

  const evs = bosEvents(cs, 6);
  console.log("BOS events (窗口6):", evs.length);
  console.log("  last 3:", evs.slice(-3).map(e => ({ d: e.direction, t: new Date(e.time).toISOString().slice(5, 16), lvl: e.level.toFixed(1) })));

  const mssUp = lastMSS(cs, "down", 6);  // 期望转多
  const mssDown = lastMSS(cs, "up", 6);  // 期望转空
  console.log("MSS(期望up):", mssUp);
  console.log("MSS(期望down):", mssDown);

  const div = detectDivergence(cs, 6);
  console.log("divergence:", div);

  const zones = fvgZones(cs, cs.length - 1, 30);
  console.log("未填 FVG:", zones.length, zones.slice(-2).map(z => ({ d: z.direction, lo: z.low.toFixed(1), hi: z.high.toFixed(1), age: cs.length - 1 - z.createdIndex })));

  // 逐层计数：最近 200 根里 MSS 出现次数
  let mssCount = 0;
  for (let i = 100; i < cs.length; i++) {
    const win = cs.slice(0, i + 1);
    const m = lastMSS(win, "up", 6);
    if (m && m.time === cs[i]!.openTime) mssCount++;
  }
  console.log("最近", cs.length - 100, "根中 MSS 确认次数:", mssCount);
}
main().catch(e => { console.error(e); process.exit(1); });
