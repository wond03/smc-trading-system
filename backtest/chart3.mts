// 做单图 v3：结构故事版（方案 v2 定稿）
// 叙事：流动性地图（✕已抓/⭕目标+身份）→ 结构段落折线+「转」→ FVG回踩+确认 → 止损逻辑 → 目标路径+持仓管理
// 布局：主图30M + 右侧价位列 + 底部结果行；简易画法结构线；无4H语境条
import { readFileSync, writeFileSync } from "fs";
import { swingPoints, fvgZones, atr14, bosEvents } from "../convex/indicators";
import type { Candle } from "../convex/indicators";

async function fetchK(contract: string, iv: string, from: number, to: number) {
  const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
  const rows = (await (await globalThis.fetch(`${host}?contract=${contract}&interval=${iv}&from=${from}&to=${to}`)).json()) as any[];
  return rows.map((r: any) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
}
const fmt = (ms: number) => {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const KIND_NAME: Record<string, string> = {
  prevDayHigh: "昨日高点", prevDayLow: "昨日低点",
  asiaHigh: "亚盘高点", asiaLow: "亚盘低点",
  swingHigh: "前高", swingLow: "前低",
};

(async () => {
  const trades = JSON.parse(readFileSync("backtest/BTC-trades.json", "utf8"));
  const svgs: string[] = [];
  for (const t of trades) {
    const span = 36 * 3600000;
    const cs = await fetchK("BTC_USDT", "30m", Math.floor((t.openTime - span) / 1000), Math.floor((t.openTime + span) / 1000));
    if (cs.length < 10) continue;
    const dirLong = t.direction === "long";
    const pre = cs.filter(c => c.openTime <= t.openTime);
    const atr = atr14(pre);
    const m = t.signalNo.match(/sweep_(\d+\.?\d*)_(\d+)_(long|short)/);
    const sweepLevel = m ? +m[1] : null;

    // —— 流动性地图：识别 pre 里各水平身份 + 状态（✕已抓 / ⭕目标）——
    const pd = pre.slice(-48); // 昨日 = 开仓前 24h
    const yesterday = pre.slice(-96, -48);
    const asia = pre.slice(-96, -48); // 简化：亚盘=北京 8-14 点，取开仓前一日
    const levels: { price: number; kind: string; taken: boolean }[] = [];
    if (yesterday.length >= 20) {
      levels.push({ price: Math.max(...yesterday.map(c => c.high)), kind: "prevDayHigh", taken: false });
      levels.push({ price: Math.min(...yesterday.map(c => c.low)), kind: "prevDayLow", taken: false });
    }
    const sw = swingPoints(pre, 6);
    const lastSwingLow = sw.filter(s => s.kind === "low").slice(-2);
    const lastSwingHigh = sw.filter(s => s.kind === "high").slice(-2);
    // 已抓的流动性：开仓前被穿过的水平（✕）
    for (const l of levels) l.taken = dirLong ? l.price < t.entry : l.price > t.entry;
    for (const s of lastSwingLow) {
      const taken = pre.some(c => c.openTime > (sw.find(x=>x.price===s.price)?.index ?? 0) && c.low < s.price);
      levels.push({ price: s.price, kind: "swingLow", taken });
    }
    for (const s of lastSwingHigh) {
      const taken = pre.some(c => c.high > s.price);
      levels.push({ price: s.price, kind: "swingHigh", taken });
    }
    // 去重：价格接近的合并（<0.1×ATR）
    const uniq: typeof levels = [];
    for (const l of levels.sort((a, b) => a.price - b.price)) {
      if (!uniq.some(u => Math.abs(u.price - l.price) < atr * 0.1)) uniq.push(l);
    }

    // —— 结构折线（简易画法）：最近 4 个收线回头摆动点连线 ——
    const pivots = [...lastSwingLow, ...lastSwingHigh].sort((a, b) => a.index - b.index).slice(-4);

    // FVG
    const zones = fvgZones(pre, pre.length - 1, 30);
    const dirZones = zones.filter(z => dirLong ? z.direction === "long" : z.direction === "short");
    const poi = dirZones[dirZones.length - 1];

    // —— 画布 ——
    const W = 1180, H = 520, padL = 15, padR = 210, padT = 30, padB = 55;
    const plotW = W - padL - padR;
    const lo = Math.min(...cs.map(c => c.low), t.stop, ...uniq.map(l => l.price)) * 0.9993;
    const hi = Math.max(...cs.map(c => c.high), t.tp, ...uniq.map(l => l.price)) * 1.0007;
    const x = (i: number) => padL + (i / (cs.length - 1)) * plotW;
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB);
    const cw = plotW / cs.length * 0.7;

    let bars = "";
    cs.forEach((c, i) => {
      const up = c.close >= c.open;
      const col = up ? "#26a69a" : "#ef5350";
      bars += `<line x1="${x(i)}" y1="${y(c.high)}" x2="${x(i)}" y2="${y(c.low)}" stroke="${col}" stroke-width="1"/>`;
      const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
      bars += `<rect x="${x(i) - cw / 2}" y="${top}" width="${cw}" height="${Math.max(bot - top, 1)}" fill="${col}"/>`;
    });

    // —— ① 流动性地图：✕ 已抓 / ⭕ 目标，带身份文字（右侧列）——
    let liq = "";
    for (const l of uniq) {
      const yy = y(l.price);
      const name = KIND_NAME[l.kind] ?? l.kind;
      const color = l.taken ? "#e91e63" : "#7b1fa2";
      const mark = l.taken ? `✕` : `◎`;
      liq += `<line x1="${padL}" y1="${yy}" x2="${padL + plotW}" y2="${yy}" stroke="${color}" stroke-width="0.7" stroke-dasharray="1 4" opacity="0.6"/>
        <text x="${padL + plotW + 8}" y="${yy + 4}" fill="${color}" font-size="12" font-weight="bold">${mark} ${name} ${l.price.toFixed(0)}${l.taken ? "（已抓）" : "（目标）"}</text>`;
    }
    // 扫荡点：橙色圈在扫荡蜡烛
    let sweepMark = "";
    if (sweepLevel) {
      const si = cs.findIndex(c => c.openTime <= t.openTime && (dirLong ? c.low <= sweepLevel : c.high >= sweepLevel));
      if (si >= 0) {
        const c = cs[si]!;
        sweepMark = `<circle cx="${x(si)}" cy="${dirLong ? y(c.low) : y(c.high)}" r="10" fill="none" stroke="#ff9800" stroke-width="2"/>
          <text x="${x(si) + 12}" y="${dirLong ? y(c.low) + 4 : y(c.high) + 4}" fill="#ff9800" font-size="11" font-weight="bold">抓流动性↓（挂单被吃，反转燃料）</text>`;
      }
    }

    // —— ② 结构折线 + 转 ——
    let struct = "";
    let turnMark = "";
    if (pivots.length >= 2) {
      const pts = pivots.map(s => `${x(s.index)},${y(s.price)}`).join(" ");
      struct = `<polyline points="${pts}" fill="none" stroke="#555" stroke-width="1.5" stroke-dasharray="5 3"/>`;
      const lastP = pivots[pivots.length - 1]!;
      turnMark = `<text x="${x(lastP.index) + 8}" y="${y(lastP.price) - 8}" fill="#9c27b0" font-size="12" font-weight="bold">转（收线回头根）</text>`;
    }

    // 开仓竖线 x 位置（提前定义供 FVG 区块使用）
    const xi = cs.findIndex(c => c.openTime >= t.openTime);
    const xOpen0 = xi >= 0 ? x(xi) : x(0);

    // —— ③ FVG 区 + 确认文字 ——
    let fvgRect = "";
    if (poi) {
      const zi = cs.findIndex(c => c.openTime >= poi.createdTime);
      fvgRect = `<rect x="${x(Math.max(zi, 0))}" y="${y(poi.high)}" width="${xOpen0 - x(Math.max(zi, 0))}" height="${Math.max(y(poi.low) - y(poi.high), 2)}" fill="#26a69a22" stroke="#26a69a" stroke-width="0.8"/>
        <text x="${x(Math.max(zi, 0)) + 4}" y="${y(poi.low) + 14}" fill="#26a69a" font-size="11">FVG 回踩区（影线触及+踩住确认）</text>`;
    }

    const entryCircle = `<circle cx="${xOpen0}" cy="${y(t.entry)}" r="9" fill="none" stroke="#2196f3" stroke-width="2.5"/>`;

    // —— ④⑤ 价位线（右侧列内嵌逻辑说明）——
    const priceLines = `
      <line x1="${padL}" y1="${y(t.entry)}" x2="${padL + plotW}" y2="${y(t.entry)}" stroke="#2196f3" stroke-width="1.2" stroke-dasharray="6 3"/>
      <line x1="${padL}" y1="${y(t.stop)}" x2="${padL + plotW}" y2="${y(t.stop)}" stroke="#ef5350" stroke-width="1.2" stroke-dasharray="6 3"/>
      <line x1="${padL}" y1="${y(t.tp)}" x2="${padL + plotW}" y2="${y(t.tp)}" stroke="#26a69a" stroke-width="1.2" stroke-dasharray="6 3"/>
      <text x="${padL + plotW + 8}" y="${y(t.entry) + 4}" fill="#2196f3" font-size="12" font-weight="bold">④入场 ${t.entry.toFixed(1)}（FVG 边缘挂单）</text>
      <text x="${padL + plotW + 8}" y="${y(t.stop) + 4}" fill="#ef5350" font-size="12" font-weight="bold">④损 ${t.stop.toFixed(1)}（背离低点/主力区下方，价格不会回来）</text>
      <text x="${padL + plotW + 8}" y="${y(t.tp) + 4}" fill="#26a69a" font-size="12" font-weight="bold">⑤目标 ${t.tp.toFixed(1)}（要去抓的流动性）RR${t.rr.toFixed(1)}</text>
      <line x1="${xOpen0}" y1="${padT}" x2="${xOpen0}" y2="${H - padB}" stroke="#888" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${xOpen0 - 85}" y="${padT + 12}" fill="#444" font-size="11">开仓 ${fmt(t.openTime)}</text>
      <text x="${padL}" y="${H - 30}" fill="#555" font-size="12" font-weight="bold">⑤路径：抓下方流动性✕ → 转确认 → 回踩FVG入场 → 去抓${dirLong ? "上方" : "下方"}流动性◎ ｜ 结果：${t.result === "tp" ? "止盈 " + t.pnlUsd.toFixed(2) + "U" : t.result === "stop" ? "止损 " + t.pnlUsd.toFixed(2) + "U" : t.result}　持仓 ${Math.round((t.exitTime - t.openTime) / 3600000)}h</text>
      <text x="${padL}" y="${H - 12}" fill="#999" font-size="10">周期 30M ｜ 止损=背离低点下方（高成交量区）｜ 打掉即错不拉损</text>`;
    const title = `${t.symbol} ${t.direction.toUpperCase()} [${t.trigger}] ${t.result === "tp" ? "止盈" : t.result === "stop" ? "止损" : t.result} ${t.pnlUsd >= 0 ? "+" : ""}${t.pnlUsd.toFixed(2)}U`;
    svgs.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><text x="${padL}" y="22" fill="#111" font-size="15" font-weight="bold">${title}</text>${bars}${fvgRect}${struct}${turnMark}${liq}${sweepMark}${entryCircle}${priceLines}</svg>`);
  }
  writeFileSync("backtest/BTC-story.svg", svgs.join("\n"));
  console.log(`生成 ${svgs.length} 张结构故事图`);
})();
