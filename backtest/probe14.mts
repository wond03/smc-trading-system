// 探针 14：FVG 层诊断——回测里 39 个扳机点中 17 个无 FVG，看剩下 22 个走到哪
// 以及 FVG POI 与「回踩」的时序关系：MSS 后 FVG 是否已存在（MSS 蜡烛自身创造的 FVG 应算）
import { bosEvents, mssAfter, fvgZones, detectDivergence, atr14 } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  const bjHour = (t: number) => new Date(t + 8 * 3600000).getUTCHours();
  let noFvg = 0, noTouch = 0, hasZone = 0;
  for (let i = 100; i < cs.length; i++) {
    const c = cs[i]!;
    if (bjHour(c.openTime) < 20 || bjHour(c.openTime) >= 24) continue;
    const win = cs.slice(Math.max(0, i - 299), i + 1);
    if (win.length < 40) continue;
    const evs = bosEvents(win, 6);
    if (!evs.length) continue;
    const dir = evs[evs.length - 1]!.direction;
    // 简化扳机：假设 6 根前有扫荡
    const triggerTime = cs[i - 6]!.openTime;
    const mss = mssAfter(win, triggerTime, dir, 6);
    if (!mss || mss.time !== c.openTime) continue; // MSS 确认蜡烛
    const zones = fvgZones(win, win.length - 1, 30);
    const dirZones = zones.filter((z) => (dir === "up" ? z.direction === "long" : z.direction === "short"));
    if (!dirZones.length) { noFvg++; continue; }
    const poi = dirZones[dirZones.length - 1]!;
    const inPoi = c.low <= poi.high && c.high >= poi.low;
    if (!inPoi) { noTouch++; continue; }
    hasZone++;
  }
  console.log({ MSS蜡烛数: noFvg + noTouch + hasZone, 无顺方向FVG: noFvg, FVG未回踩: noTouch, 全通过: hasZone });
}
main().catch(e => { console.error(e); process.exit(1); });
