// 探针 11：回测主循环内 MSS 失败的逐根诊断
import { bosEvents, lastMSS, detectDivergence } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  // 模拟回测：在有扳机的时间点检查 MSS 链路
  let checked = 0, mssNull = 0, mssWrongDir = 0, mssTooOld = 0, mssOk = 0;
  for (let i = 100; i < cs.length; i++) {
    const win = cs.slice(Math.max(0, i - 299), i + 1);
    if (win.length < 40) continue;
    const evs = bosEvents(win, 6);
    if (!evs.length) continue;
    const dir = evs[evs.length - 1]!.direction;
    const div = detectDivergence(win, 6);
    const divOk = div !== null && div.direction === (dir === "up" ? "long" : "short");
    // 用一个假的「最近扫荡」= 6 根前的摆动点（模拟扫荡刚发生）
    const triggerTime = divOk ? div!.time : cs[i - 6]!.openTime;
    checked++;
    const mss = lastMSS(win, dir === "up" ? "down" : "up", 6);
    if (!mss) { mssNull++; continue; }
    if (mss.direction !== dir) { mssWrongDir++; continue; }
    if (mss.time < triggerTime) { mssTooOld++; continue; }
    mssOk++;
  }
  console.log({ checked, mssNull, mssWrongDir, mssTooOld, mssOk });
}
main().catch(e => { console.error(e); process.exit(1); });
