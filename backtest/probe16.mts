// 探针 16：Q17 生命周期口径检查——「影线触及即失效」过严？
// 查尔斯原话（19 篇 #7）：「影线填完 FVG 即失效（未填完仍有效）」。
// 「填完」= 影线穿过整个区间（多单 FVG：low <= zone.low；空单：high >= zone.high），
// 不是「触及边缘就失效」。当前实现把「刚碰到下沿」也算填完 → POI 被误杀。
import { fvgZones, mssAfter, bosEvents } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=1000";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  // 对比两种口径下的未填 FVG 数量
  const strictTouch = fvgZones(cs, cs.length - 1, 30);
  // 手动按「填完」口径重算
  const zones: any[] = [];
  for (let i = 2; i <= cs.length - 1; i++) {
    const a = cs[i - 2]!, c = cs[i]!;
    if (c.low > a.high) zones.push({ low: a.high, high: c.low, direction: "long", createdIndex: i });
    else if (c.high < a.low) zones.push({ low: c.high, high: a.low, direction: "short", createdIndex: i });
  }
  const openFillComplete = zones.filter((z) => {
    if (cs.length - 1 - z.createdIndex > 30) return false;
    for (let i = z.createdIndex + 1; i <= cs.length - 1; i++) {
      const c = cs[i]!;
      const fullyFilled = z.direction === "long" ? c.low <= z.low : c.high >= z.high;
      if (fullyFilled) return false;
    }
    return true;
  });
  console.log("触及即失效口径 未填FVG:", strictTouch.length);
  console.log("填完才失效口径 未填FVG:", openFillComplete.length);
  console.log("差异 = 被误杀的 POI 数:", openFillComplete.length - strictTouch.length);
}
main().catch(e => { console.error(e); process.exit(1); });
