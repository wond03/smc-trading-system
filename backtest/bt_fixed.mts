// 回测 v2：按用户校准后的四层口径（4H CRT 方向 / 1H 转势位 / 30M 品种背离 / 15M 执行）
import { writeFileSync } from "fs";
import type { Candle } from "../convex/indicators";
import { atr14 } from "../convex/indicators";
import { crtRange, conversionConfirmed, chochLevel, peerDivergence, execute15m } from "../convex/signalEngineV2";

const HOST = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
async function fetchK(contract: string, iv: string, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let f = from;
  while (f < to) {
    const t2 = Math.min(f + 1000 * 1800 * 1000, to);
    const u = `${HOST}?contract=${contract}&interval=${iv}&from=${Math.floor(f / 1000)}&to=${Math.floor(t2 / 1000)}`;
    const r: any = await (globalThis as any).fetch(u).then((x: any) => x.json());
    for (const k of r ?? []) out.push({ openTime: +k.t * 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
    f = t2;
  }
  return out;
}

const PEER: Record<string, string> = { BTC_USDT: "NAS100_USDT", XAU_USDT: "XAG_USDT" };

interface Trade {
  signalNo: string; direction: "long" | "short";
  entry: number; stop: number; tp: number; rr: number;
  openTime: number; exitTime?: number; result?: "tp" | "stop"; pnlUsd?: number;
  peerConfirmed: boolean; positionFraction: number;
}

async function runBacktest(symbolKey: "BTC" | "XAU", days: number) {
  const symbol = symbolKey === "XAU" ? "XAU_USDT" : "BTC_USDT";
  const peerSym = PEER[symbol];
  const to = 1792711134593; // 固定窗口
  const from = to - days * 86400000;

  console.log(`[v2] 拉取 ${symbol} + 联动 ${peerSym}，${days} 天…`);
  // 15M 为主周期，4H/1H/30M 从 15M 聚合（保证时间对齐）
  const m15 = await fetchK(symbol, "15m", from, to);
  const peer15 = await fetchK(peerSym, "15m", from, to);
  console.log(`15M ${m15.length} 根 / 联动 ${peer15.length} 根`);

  const AGG: Record<string, number> = { "4h": 16, "1h": 4, "30m": 2 };
  function aggregate(src: Candle[], bars: number): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i + bars <= src.length; i += bars) {
      const w = src.slice(i, i + bars);
      out.push({
        openTime: w[0]!.openTime,
        open: w[0]!.open, close: w[w.length - 1]!.close,
        high: Math.max(...w.map((c) => c.high)),
        low: Math.min(...w.map((c) => c.low)),
        volume: w.reduce((s, c) => s + c.volume, 0),
      });
    }
    return out;
  }

  const trades: Trade[] = [];
  const rrLog: string[] = [];
  const stats = { crt: 0, conv: 0, choch: 0, mss: 0, rr: 0, dup: 0, final: 0, peerOk: 0 };

  // 主循环：每根 15M 蜡烛收盘评估
  for (let i = 200; i < m15.length; i++) {
    const cur = m15[i]!;
    const hist15 = m15.slice(0, i + 1);
    const h4 = aggregate(hist15, 16);
    const h1 = aggregate(hist15, 4);
    const m30 = aggregate(hist15, 2);
    // 联动品种对齐到当前时间
    const peerHist = peer15.filter((c) => c.openTime <= cur.openTime);
    if (peerHist.length < 100) continue;

    // L1: 4H CRT
    const crt = crtRange(h4, 3);
    if (!crt.sweptSide) continue;
    stats.crt++;
    const conv = conversionConfirmed(h1, crt.sweptSide, 6);
    if (!conv) continue;
    stats.conv++;
    const direction = conv.direction;
    const dirLong = direction === "up";

    // L2: 转势位（1H）
    const ch = chochLevel(h1, direction, 6);
    if (!ch) continue;
    stats.choch++;

    // L3: 30M 品种背离
    const peerOk = peerDivergence(m30, aggregate(peerHist, 2), direction, 16);
    if (peerOk) stats.peerOk++;
    // 无背离不拒单（半仓走起），只影响仓位

    // L4: 15M 执行
    const ex = execute15m(hist15, ch.level, direction, 6);
    if (!ex) continue;
    stats.mss++;

    const atr15 = atr14(hist15);
    const entryRef = ex.entryRef;
    const stopRef = dirLong ? ch.level - 0.2 * atr15 : ch.level + 0.2 * atr15;
    const risk = Math.abs(entryRef - stopRef);
    if (risk < 1e-9 || risk > 4 * atr15) continue;

    // 止盈：顺方向最近合格结构位（1H swing 序列，RR∈[1.5,5]带内取最近）
    const { swingPoints } = await import("../convex/indicators");
    const sp = swingPoints(h1, 4).map((s) => s.price);
    const hi = Math.max(...h1.slice(-40).map((c) => c.high));
    const lo = Math.min(...h1.slice(-40).map((c) => c.low));
    const targets = [...sp, hi, lo].filter((p) => (dirLong ? p > entryRef : p < entryRef))
      .map((p) => ({ p, rr: Math.abs(p - entryRef) / risk }))
      .filter((x) => x.rr >= 1.5 && x.rr <= 5)
      .sort((a, b) => (dirLong ? a.p - b.p : b.p - a.p));
    if (!targets.length) { stats.rr++; rrLog.push(`${new Date(cur.openTime+8*3600000).toISOString().slice(5,16)} ${direction} entry=${entryRef.toFixed(1)} stop=${stopRef.toFixed(1)} risk=${risk.toFixed(0)} hi=${hi.toFixed(1)} lo=${lo.toFixed(1)}`); continue; }
    const tp = targets[0]!.p;
    const rr = targets[0]!.rr;

    // 幂等：同方向同 MSS 时间只做一次
    const signalNo = `sweep_${ch.level}_${ex.mssTime}_${dirLong ? "long" : "short"}`;
    if (trades.some((t) => t.signalNo === signalNo)) { stats.dup++; continue; }
    // setup 级幂等：同方向+转势位（±0.3×ATR15）只做一次（「背离一出两张单结束」）
    const dupSetup = trades.find((t) => t.direction === direction && Math.abs(t.stop - stopRef) < 0.3 * atr15);
    if (dupSetup) { stats.dup++; continue; }

    const positionFraction = 1.0; // 品种背离层已砍（用户裁决：实现不了）
    stats.final++;

    // 模拟成交：入场=entryRef（挂单）或确认收盘；逐 15M 推进找出场
    const entry = entryRef;
    let result: "tp" | "stop" | undefined;
    let exitTime: number | undefined;
    for (let j = i + 1; j < Math.min(i + 96 * 2, m15.length); j++) { // 最长 48h
      const c = m15[j]!;
      if (dirLong ? c.low <= stopRef : c.high >= stopRef) { result = "stop"; exitTime = c.openTime; break; }
      if (dirLong ? c.high >= tp : c.low <= tp) { result = "tp"; exitTime = c.openTime; break; }
    }
    // 5U 保证金 100x 逐仓：pnl = 价差/entry * 5 * 100 * positionFraction
    const pnl = result ? ((dirLong ? (result === "tp" ? tp - entry : stopRef - entry) : (result === "tp" ? entry - tp : entry - stopRef)) / entry) * 500 * positionFraction : 0;
    trades.push({ signalNo, direction, entry, stop: stopRef, tp, rr, openTime: cur.openTime, exitTime, result, pnlUsd: pnl, peerConfirmed: peerOk, positionFraction });
  }

  if (rrLog.length) console.log("RR 砍掉样本(前10):\n" + rrLog.slice(0, 10).join("\n"));
  console.log("WROTE", process.cwd());console.log("TRADES_JSON_START" + JSON.stringify(trades.map(t => ({...t, symbol: symbolKey, trigger: "CRT扫荡+MSS"}))) + "TRADES_JSON_END");
  // 报告
  console.log(`\n========== v2 回测：${symbolKey} 近 ${days} 天 ==========`);
  console.log(`漏斗: CRT扫荡 ${stats.crt} → 1H转换 ${stats.conv} → 转势位 ${stats.choch} → 15M MSS ${stats.mss} → RR合格 ${stats.final - 0} → 开仓 ${stats.final}`);
  const done = trades.filter((t) => t.result);
  const wins = done.filter((t) => t.result === "tp");
  const total = done.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  console.log(`信号: ${done.length} | 止盈 ${wins.length} 止损 ${done.length - wins.length} | 胜率 ${(wins.length / done.length * 100).toFixed(1)}% | 总盈亏 ${total.toFixed(2)}U`);
  const peerYes = done.filter((t) => t.peerConfirmed);
  console.log(`品种背离确认单: ${peerYes.length}（胜 ${(peerYes.filter((t) => t.result === "tp")).length}）| 无确认半仓单: ${done.length - peerYes.length}（胜 ${((done.filter((t) => !t.peerConfirmed)).filter((t) => t.result === "tp")).length}）`);
  const d = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(5, 16).replace("T", " ");
  for (const t of done) {
    console.log(`${d(t.openTime)} ${t.direction.toUpperCase()} 入${t.entry.toFixed(1)} 损${t.stop.toFixed(1)} 盈${t.tp.toFixed(1)} RR${t.rr.toFixed(2)} → ${t.result} ${(t.pnlUsd ?? 0).toFixed(2)}U`);
  }
}

const key = (process.argv[2] ?? "BTC").toUpperCase() as "BTC" | "XAU";
const days = parseInt(process.argv[3] ?? "60", 10);
runBacktest(key, Number.isNaN(days) ? 60 : days).catch((e) => { console.error(e); process.exit(1); });
