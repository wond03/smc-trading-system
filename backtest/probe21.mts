// 探针 21：触发形态通过率——时段内、4H/30M 同向、有FVG、回踩中，形态判定失败多少
import { bosEvents, fvgZones, atr14 } from "../convex/indicators";
async function fetchKlines(sym: string, iv: string, n: number) {
  const map: Record<string,string> = { BTC: "BTC_USDT" };
  const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
  const rows = (await (await globalThis.fetch(`${host}?contract=${map[sym]}&interval=${iv}&limit=${n}`)).json()) as any[];
  return rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
}
(async () => {
  const m30 = await fetchKlines("BTC", "30m", 1000);
  const h4 = await fetchKlines("BTC", "4h", 200);
  const bjHour = (t: number) => new Date(t + 8 * 3600000).getUTCHours();
  let touch = 0, formOk = 0, engulfFail = 0;
  for (let i = 100; i < m30.length; i++) {
    const c = m30[i]!;
    const h = bjHour(c.openTime);
    if (!((h >= 20 && h < 24) || (h >= 8 && h < 10))) continue;
    const win = m30.slice(Math.max(0, i - 299), i + 1);
    const evs4h = bosEvents(h4, 3), evs30 = bosEvents(win, 6);
    if (!evs4h.length || !evs30.length) continue;
    const dir = evs30[evs30.length - 1]!.direction;
    if (evs4h[evs4h.length - 1]!.direction !== dir) continue;
    const zones = fvgZones(win, win.length - 1, 30).filter(z => dir === "up" ? z.direction === "long" : z.direction === "short");
    if (!zones.length) continue;
    const poi = zones[zones.length - 1]!;
    const last = win[win.length - 1]!;
    const inPoi = last.low <= poi.high && last.high >= poi.low;
    if (!inPoi) continue;
    touch++;
    const prev = win[win.length - 2]!;
    const ok = dir === "up"
      ? (last.close > last.open && last.close > prev.high) || (last.low < poi.low && last.close > poi.low) || (last.close > prev.high && last.close > last.open)
      : (last.close < last.open && last.close < prev.low) || (last.high > poi.high && last.close < poi.high) || (last.close < prev.low && last.close < last.open);
    if (ok) formOk++;
  }
  console.log({ 回踩中: touch, 形态通过: formOk, 通过率: (formOk / touch * 100).toFixed(1) + "%" });
})();
