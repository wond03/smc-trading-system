// 探针 13：验证 MSS 语义假设——lastMSS 应该找「逆趋势确认的转势」，但引擎里要的是
// 「顺方向的 MSS」= 在扳机（扫荡/背离）后，结构沿顺方向确认的破位（MSS 顺扳机方向）。
// 查尔斯口径：扫荡杀空头流动性 → 结构转多确认（顺方向 MSS）→ 回踩 FVG 进场。
// 所以正确的 MSS 定义：扳机之后，最新结构事件的方向 = 顺方向。
// 用「扳机后第一根顺方向收盘穿越逆扳机方向的摆动点」来实现。
import { swingPoints, bosEvents } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

/** 顺方向 MSS：自 sinceTime 起，第一根收盘穿越「逆方向最近摆动点」的蜡烛 */
export function mssAfter(
  candles: Candle[],
  sinceTime: number,
  direction: "up" | "down",
  n = 6,
): { direction: "up" | "down"; time: number; level: number } | null {
  const sinceIdx = candles.findIndex((c) => c.openTime >= sinceTime);
  if (sinceIdx < 0) return null;
  // 摆动点池：在 sinceTime 之前成形且在其后未被穿越过的逆方向摆动点
  const opposite = direction === "up" ? "low" : "high"; // 顺向上需收破的是摆动低点？不：向上 MSS = 收盘破最近摆动高点
  // 修正：向上结构确认 = 收盘上穿最近摆动高点（阻力），向下 = 收盘下穿最近摆动低点
  const targetKind = direction === "up" ? "high" : "low";
  const swings = swingPoints(candles.slice(0, Math.max(sinceIdx, n + 1)), n)
    .filter((s) => s.kind === targetKind);
  const pool = [...swings].reverse(); // 最近的优先
  for (let i = sinceIdx; i < candles.length; i++) {
    const c = candles[i]!;
    for (const s of pool) {
      // 摆动点须在 i 之前成形（index + n <= i）
      if (s.index + n > i) continue;
      if (direction === "up" && c.close > s.price) return { direction, time: c.openTime, level: s.price };
      if (direction === "down" && c.close < s.price) return { direction, time: c.openTime, level: s.price };
    }
  }
  return null;
}

async function main() {
  const url = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=BTC_USDT&interval=30m&limit=300";
  const rows = (await (await fetch(url)).json()) as any[];
  const cs: Candle[] = rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
  const evs = bosEvents(cs, 6);
  const dir = evs[evs.length - 1]!.direction;
  const since = cs[cs.length - 20]!.openTime; // 假设扳机在 20 根前
  const m = mssAfter(cs, since, dir, 6);
  console.log("dir:", dir, "mssAfter:", m ? { time: new Date(m.time).toISOString().slice(5, 16), level: m.level.toFixed(1) } : null);
}
main().catch(e => { console.error(e); process.exit(1); });
