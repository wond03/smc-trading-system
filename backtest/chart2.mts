// 交易图 v2：K线 + 5 层信号标注（① 扫荡点 ② MSS ③ FVG 区块 ④ 回踩/入场 ⑤ 结果）
// 注记从 signalNo 反推：BTC_sweep_<level>_<sweptTime>_<dir>；信号细节用引擎重算
import { readFileSync, writeFileSync } from "fs";
import { bosEvents, mssAfter, fvgZones, atr14, isSwept } from "../convex/indicators";
import type { Candle, LiquidityLevel } from "../convex/indicators";
import { createLiquidityLevels } from "../convex/liquidity";
async function fetchK(contract: string, iv: string, from: number, to: number) {
  const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
  const rows = (await (await globalThis.fetch(`${host}?contract=${contract}&interval=${iv}&from=${from}&to=${to}`)).json()) as any[];
  return rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
}
const fmt = (ms: number) => {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
(async () => {
  const trades = JSON.parse(readFileSync("backtest/BTC-trades.json", "utf8"));
  const svgs: string[] = [];
  for (const t of trades) {
    const span = 36 * 3600000;
    const cs = await fetchK("BTC_USDT", "30m", Math.floor((t.openTime - span) / 1000), Math.floor((t.openTime + span) / 1000));
    if (cs.length < 10) continue;
    // ① 扫荡：signalNo 里的 sweptTime 与 level
    const m = t.signalNo.match(/sweep_(\d+\.?\d*)_(\d+)_(long|short)/);
    const sweepLevel = m ? +m[1] : null;
    const sweepTime = m ? +m[2] : null;
    const dirLong = t.direction === "long";
    // ② MSS：开仓前 30M 内最后一根顺方向 MSS（简化：找收盘穿越逆方向极值的第一根）
    const pre = cs.filter(c => c.openTime <= t.openTime);
    const atr = atr14(pre);
    // ③ FVG：开仓时点的顺方向未填 FVG（用引擎）
    const zones = fvgZones(pre, pre.length - 1, 30);
    const dirZones = zones.filter(z => dirLong ? z.direction === "long" : z.direction === "short");
    const poi = dirZones[dirZones.length - 1];
    const W = 1100, H = 460, pad = 55;
    const lo = Math.min(...cs.map(c => c.low), t.stop, poi?.low ?? 1e18) * 0.9995;
    const hi = Math.max(...cs.map(c => c.high), t.tp, poi?.high ?? 0) * 1.0005;
    const x = (i: number) => pad + (i / (cs.length - 1)) * (W - 2 * pad);
    const y = (p: number) => pad + (1 - (p - lo) / (hi - lo)) * (H - 2 * pad);
    const cw = (W - 2 * pad) / cs.length * 0.7;
    let bars = "";
    cs.forEach((c, i) => {
      const up = c.close >= c.open;
      const col = up ? "#26a69a" : "#ef5350";
      bars += `<line x1="${x(i)}" y1="${y(c.high)}" x2="${x(i)}" y2="${y(c.low)}" stroke="${col}" stroke-width="1"/>`;
      const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
      bars += `<rect x="${x(i) - cw / 2}" y="${top}" width="${cw}" height="${Math.max(bot - top, 1)}" fill="${col}"/>`;
    });
    const xi = cs.findIndex(c => c.openTime >= t.openTime);
    const xOpen = xi >= 0 ? x(xi) : x(0);
    // ① 扫荡标记：橙色三角在扫荡蜡烛低点/高点
    let sweepMark = "";
    if (sweepTime) {
      const si = cs.findIndex(c => c.openTime >= sweepTime);
      if (si >= 0) {
        const c = cs[si]!;
        const yy = dirLong ? y(c.low) + 14 : y(c.high) - 8;
        sweepMark = `<polygon points="${x(si)},${dirLong ? y(c.low) + 4 : y(c.high) - 4} ${x(si) - 6},${yy} ${x(si) + 6},${yy}" fill="#ff9800"/>
          <text x="${x(si) - 24}" y="${dirLong ? y(c.low) + 30 : y(c.high) - 16}" fill="#ff9800" font-size="11">①扫荡 ${sweepLevel}</text>`;
      }
    }
    // ③ FVG 区块：半透明绿/红矩形横跨右侧
    let fvgRect = "";
    if (poi) {
      const zi = cs.findIndex(c => c.openTime >= poi.createdTime);
      fvgRect = `<rect x="${x(Math.max(zi, 0))}" y="${y(poi.high)}" width="${W - pad - x(Math.max(zi, 0))}" height="${Math.max(y(poi.low) - y(poi.high), 2)}" fill="${dirLong ? "#26a69a22" : "#ef535022"}" stroke="${dirLong ? "#26a69a" : "#ef5350"}" stroke-width="0.8" stroke-dasharray="2 2"/>
        <text x="${x(Math.max(zi, 0)) + 4}" y="${y(poi.high) - 4}" fill="${dirLong ? "#26a69a" : "#ef5350"}" font-size="11">③FVG ${poi.low.toFixed(0)}-${poi.high.toFixed(0)}</text>`;
    }
    // ② MSS 标记：找开仓前最后一根收盘穿越前摆动点的蜡烛（近似标注）
    let mssMark = "";
    const evs = bosEvents(pre, 6);
    if (evs.length >= 2) {
      const bi = cs.findIndex(c => c.openTime === evs[evs.length - 1]!.time);
      if (bi >= 0) {
        mssMark = `<text x="${x(bi) - 20}" y="${dirLong ? y(cs[bi]!.low) - 6 : y(cs[bi]!.high) + 16}" fill="#9c27b0" font-size="11">②MSS</text>`;
      }
    }
    // ④入场蜡烛高亮：信号 No 无 hitBar 信息，用「开仓时间前最后一根触及 FVG 且收盘在入场价上方（多）/下方（空）」近似定位
    let entryMark = "";
    {
      const ei = (() => {
        for (let i = xi; i >= Math.max(0, xi - 12); i--) {
          const c = cs[i]!;
          if (poi && c.low <= poi.high && c.high >= poi.low) {
            const formOk = dirLong ? c.close > c.open : c.close < c.open;
            if (formOk) return i;
          }
        }
        return xi;
      })();
      if (ei >= 0) {
        const c = cs[ei]!;
        const yy = dirLong ? y(c.low) + 26 : y(c.high) - 20;
        entryMark = `<circle cx="${x(ei)}" cy="${dirLong ? y(c.low) + 8 : y(c.high) - 8}" r="9" fill="none" stroke="#2196f3" stroke-width="2"/>
          <text x="${x(ei) - 8}" y="${yy}" fill="#2196f3" font-size="11" font-weight="bold">④入场</text>`;
      }
    }
    const lines = `
      <line x1="${pad}" y1="${y(t.entry)}" x2="${W - pad}" y2="${y(t.entry)}" stroke="#2196f3" stroke-width="1.2" stroke-dasharray="6 3"/>
      <text x="${pad + 4}" y="${y(t.entry) - 5}" fill="#2196f3" font-size="12">④入 ${t.entry.toFixed(1)}</text>      <line x1="${pad}" y1="${y(t.stop)}" x2="${W - pad}" y2="${y(t.stop)}" stroke="#ef5350" stroke-width="1.2" stroke-dasharray="6 3"/>
      <text x="${pad + 4}" y="${y(t.stop) + 14}" fill="#ef5350" font-size="12">损 ${t.stop.toFixed(1)}</text>
      <line x1="${pad}" y1="${y(t.tp)}" x2="${W - pad}" y2="${y(t.tp)}" stroke="#26a69a" stroke-width="1.2" stroke-dasharray="6 3"/>
      <text x="${pad + 4}" y="${y(t.tp) - 5}" fill="#26a69a" font-size="12">盈 ${t.tp.toFixed(1)} RR${t.rr.toFixed(1)}</text>
      <line x1="${xOpen}" y1="${pad}" x2="${xOpen}" y2="${H - pad}" stroke="#888" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${xOpen - 90}" y="${pad + 12}" fill="#444" font-size="11">开仓 ${fmt(t.openTime)}</text>
      <text x="${pad}" y="${H - 8}" fill="#777" font-size="11">⑤结果: ${t.result === "tp" ? "止盈 " + t.pnlUsd.toFixed(2) + "U" : t.result === "stop" ? "止损 " + t.pnlUsd.toFixed(2) + "U" : t.result}　持仓 ${Math.round((t.exitTime - t.openTime) / 3600000)}h</text>`;
    const title = `${t.symbol} ${t.direction.toUpperCase()} [${t.trigger}] ${t.result === "tp" ? "止盈" : t.result === "stop" ? "止损" : t.result} ${t.pnlUsd >= 0 ? "+" : ""}${t.pnlUsd.toFixed(2)}U`;
    svgs.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><text x="${pad}" y="26" fill="#111" font-size="15" font-weight="bold">${title}</text>${bars}${fvgRect}${sweepMark}${mssMark}${entryMark}${lines}</svg>`);
  }
  writeFileSync("backtest/BTC-trades-annotated.svg", svgs.join("\n"));
  console.log(`生成 ${svgs.length} 张标注图`);
})();
