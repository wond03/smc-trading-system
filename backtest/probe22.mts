// 探针 22：MSS 层通过率——时段+同向+扳机成立后，MSS 失败多少（XAU 43 次瓶颈定位）
import { bosEvents, mssAfter, detectDivergence } from "../convex/indicators";
async function fetchK(sym: string, iv: string, n: number) {
  const map: Record<string,string> = { BTC: "BTC_USDT", XAU: "XAU_USDT" };
  const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
  const rows = (await (await globalThis.fetch(`${host}?contract=${map[sym]}&interval=${iv}&limit=${n}`)).json()) as any[];
  return rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
}
(async () => {
  for (const sym of ["BTC", "XAU"] as const) {
    const m30 = await fetchK(sym, "30m", 1000);
    const h4 = await fetchK(sym, "4h", 200);
    const bjHour = (t: number) => new Date(t + 8 * 3600000).getUTCHours();
    const bjDow = (t: number) => new Date(t + 8 * 3600000).getUTCDay();
    let trig = 0, mssOk = 0, mssFail = 0;
    for (let i = 100; i < m30.length; i++) {
      const c = m30[i]!;
      const h = bjHour(c.openTime), d = bjDow(c.openTime);
      if (!((h >= 20 && h < 24) || (h >= 8 && h < 10))) continue;
      if ((d === 6 && h >= 1) || d === 0) continue;
      const win = m30.slice(Math.max(0, i - 299), i + 1);
      const evs4h = bosEvents(h4, 3), evs30 = bosEvents(win, 6);
      if (!evs4h.length || !evs30.length) continue;
      const dir = evs30[evs30.length - 1]!.direction;
      if (evs4h[evs4h.length - 1]!.direction !== dir) continue;
      // 扳机近似：最近 30 根内有 BOS 事件且时间不重叠——用最后 BOS 时间做扳机代理
      const lastBos = evs30[evs30.length - 1]!;
      if (c.openTime - lastBos.time > 12 * 1800000) continue;
      trig++;
      const mss = mssAfter(win, lastBos.time, dir, 6);
      if (mss) mssOk++; else mssFail++;
    }
    console.log(sym, { 扳机成立: trig, MSS通过: mssOk, MSS失败: mssFail, 通过率: (mssOk / trig * 100).toFixed(0) + "%" });
  }
})();
