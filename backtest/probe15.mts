// 探针 15：FVG「无顺方向」的诊断——扳机为空时（win 长度/边界）看 FVG 方向分布
// 关键疑点：30M 上 strict FVG（影线不重叠）本身稀少；MSS 蜡烛常「吃掉」刚形成的 FVG（影线触及即 filled）。
import { bosEvents, mssAfter, fvgZones } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  const bjHour = (t: number) => new Date(t + 8 * 3600000).getUTCHours();
  let noFvg = 0, fvgWrongDir = 0, fvgOk = 0;
  for (let i = 100; i < cs.length; i++) {
    const c = cs[i]!;
    if (bjHour(c.openTime) < 20 || bjHour(c.openTime) >= 24) continue;
    const win = cs.slice(Math.max(0, i - 299), i + 1);
    if (win.length < 40) continue;
    const evs = bosEvents(win, 6);
    if (!evs.length) continue;
    const dir = evs[evs.length - 1]!.direction;
    const triggerTime = cs[i - 6]!.openTime;
    const mss = mssAfter(win, triggerTime, dir, 6);
    if (!mss) continue;
    const zones = fvgZones(win, win.length - 1, 30);
    if (!zones.length) { noFvg++; continue; }
    const dirZones = zones.filter((z) => (dir === "up" ? z.direction === "long" : z.direction === "short"));
    if (!dirZones.length) { fvgWrongDir++; continue; }
    fvgOk++;
  }
  console.log({ MSS蜡烛: noFvg + fvgWrongDir + fvgOk, 完全无FVG: noFvg, FVG方向不符: fvgWrongDir, FVG方向匹配: fvgOk });
}
main().catch(e => { console.error(e); process.exit(1); });
