// 探针 20：日内频率瓶颈定位——MSS 后回踩距离分布 + FVG 等级分布
import { mssAfter, bosEvents, fvgZones, atr14, detectDivergence } from "../convex/indicators";
import type { Candle } from "../convex/indicators";
async function fetchKlines(sym: string, iv: string, n: number) {
  const map: Record<string,string> = { BTC: "BTC_USDT", XAU: "XAUUSDT" };
  const host = sym === "XAU" ? "https://api.gateio.ws/api/v4/delivery/usdt/candlesticks" : "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
  const rows = (await (await fetch(`${host}?contract=${map[sym]}&interval=${iv}&limit=${n}`)).json()) as any[];
  return rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
}
(async () => {
  const m30 = await fetchKlines("BTC", "30m", 1000);
  const h4 = await fetchKlines("BTC", "4h", 200);
  const bjHour = (t: number) => new Date(t + 8 * 3600000).getUTCHours();
  const bjDow = (t: number) => new Date(t + 8 * 3600000).getUTCDay();
  let dist: number[] = []; let fvgCount = 0; let checked = 0;
  for (let i = 100; i < m30.length; i++) {
    const c = m30[i]!;
    const h = bjHour(c.openTime), d = bjDow(c.openTime);
    if (!((h >= 20 && h < 24) || (h >= 8 && h < 10))) continue;
    if ((d === 6 && h >= 1) || d === 0) continue;
    const win = m30.slice(Math.max(0, i - 299), i + 1);
    const evs4h = bosEvents(h4, 3);
    if (!evs4h.length) continue;
    const dir4 = evs4h[evs4h.length - 1]!.direction;
    const evs30 = bosEvents(win, 6);
    if (!evs30.length) continue;
    const dir30 = evs30[evs30.length - 1]!.direction;
    if (dir4 !== dir30) continue;
    checked++;
    const zones = fvgZones(win, win.length - 1, 30);
    const dirZones = zones.filter(z => (dir30 === "up" ? z.direction === "long" : z.direction === "short"));
    if (dirZones.length) fvgCount++;
    // MSS 后最近价到顺方向 FVG 的距离（A longing: 距离近才有回踩机会）
    const last = win[win.length - 1]!;
    if (dirZones.length) {
      const poi = dirZones[dirZones.length - 1]!;
      const distATR = Math.abs(last.close - poi.high) / atr14(win);
      if (distATR < 3) dist.push(distATR);
    }
  }
  console.log({ 时段内蜡烛: checked, 有顺方向FVG: fvgCount, 回踩距离小于3ATR: dist.length, 全程比例: (dist.length/checked*100).toFixed(1) + "%" });
})();
