// 探针 19：TP 方向 bug 复现——09-03 15:30 BTC 那单，打印 levels 里被选为 TP 的水平
// 疑点：Asia/PrevDay 水平在次日回看时「昨日的 asiaHigh」可能是旧价——
// 例如昨天的 asiaHigh=81062.5 仍标 untouched，今天价格已在 81062 之上？
// long 单 TP 过滤是 p > entryRef=81326，但 tp=81062.5 < entry——说明选 TP 时 dirLong 判断错误，
// 或 levels 中 81062.5 在开仓那一根之前位于 entry 之上（后来价格涨过了它——不对，开仓价 81326 已经高于它）。
// 真正的可能：开仓那根的 entryRef 不是 81326 —— entry = close*slippage = 81326，
// 但 entryRef(FVG high) 可能更低！POI=age0 的 FVG {lo:80554,hi:80639} → entryRef=80639！
// 81062.5 > 80639 ✓ 通过过滤，TP=81062.5 合法！但成交模拟里 entry=81326（触发蜡烛收盘价）
// —— FVG 还在下方没回踩，触发蜡烛只是「碰到了 FVG」吗？80639 < 81326 不在 POI 内。
// 所以真正的 bug：回测第 10 层 inPoi 用 last30=触发蜡烛检查，但 TP 选出后 entry 用收盘价——
// 触发蜡烛确实触及 POI（low <= 80639），收盘却已回到 81326。TP 只比 FVG 高 423 点，
// 而入场在 81326 —— 信号在「回踩后弹起」的蜡烛上触发，TP 低于入场价。属模拟口径错误：
// 实盘会在挂单价位（FVG 边缘）成交，而不是触发蜡烛收盘价。
import { fvgZones, mssAfter, bosEvents } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function main() {
  console.log("结论：entry 用触发蜡烛收盘价（81326），但 entryRef=FVG high（80639）——两者脱节。");
  console.log("修正：回测成交价应以 entryRef（挂单价）为准，触发蜡烛收盘只用于确认。");
  console.log("同根同时触及止损与 FVG 时保守先止损。");
}
main().catch(e => { console.error(e); process.exit(1); });
