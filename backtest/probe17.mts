// 探针 17：30M strict FVG 本身稀少度的量化——回测期 30 天里每小时段窗口内
// 「MSS 后 12 根内」存在顺方向未填 FVG 的比例
import { fvgZones, mssAfter, bosEvents } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  const bjHour = (t: number) => new Date(t + 8 * 3600000).getUTCHours();
  // 用更宽的统计：MSS 蜡烛后 12 根内，任一根时点存在顺方向未填 FVG 的比例
  let mssCount = 0, hasFvgIn12 = 0;
  for (let i = 100; i < cs.length - 12; i++) {
    const win = cs.slice(Math.max(0, i - 299), i + 1);
    if (win.length < 40) continue;
    const evs = bosEvents(win, 6);
    if (!evs.length) continue;
    const dir = evs[evs.length - 1]!.direction;
    const mss = mssAfter(win, cs[i - 12]!.openTime, dir, 6);
    if (!mss) continue;
    mssCount++;
    let found = false;
    for (let j = i; j <= i + 12 && j < cs.length; j++) {
      const w = cs.slice(Math.max(0, j - 299), j + 1);
      const zones = fvgZones(w, w.length - 1, 30);
      if (zones.some((z) => (dir === "up" ? z.direction === "long" : z.direction === "short"))) { found = true; break; }
    }
    if (found) hasFvgIn12++;
  }
  console.log({ MSS事件: mssCount, 后12根内出现顺方向未填FVG: hasFvgIn12, 比例: (hasFvgIn12 / Math.max(1, mssCount) * 100).toFixed(1) + "%" });
}
main().catch(e => { console.error(e); process.exit(1); });
