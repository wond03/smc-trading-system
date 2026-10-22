
// 做单图 v4：修 v3 的布局问题
// 1) 右侧标签防重叠：按 y 排序，最小间距 18px，自动上下推开
// 2) 文字改短，右列宽度加到 260px，长说明移到底部
// 3) 特殊符号 ✕◎⊠ 换成文字（已抓/目标/被吃）
// 4) 编号统一：流动性无编号，入场=④，路径+结果=⑤
import { readFileSync, writeFileSync } from "fs";
import { swingPoints, fvgZones, atr14 } from "../convex/indicators";

async function fetchK(contract, iv, from, to) {
  const host = "https://api.gateio.ws/api/v4/futures/usdt/candlesticks";
  const rows = await (await globalThis.fetch(`${host}?contract=${contract}&interval=${iv}&from=${from}&to=${to}`)).json();
  return rows.map((r) => ({ openTime: r.t * 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
}
const fmt = (ms) => {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const KIND_NAME = { prevDayHigh: "昨日高", prevDayLow: "昨日低", asiaHigh: "亚盘高", asiaLow: "亚盘低", swingHigh: "前高", swingLow: "前低" };

(async () => {
  const trades = JSON.parse(readFileSync("backtest/BTC-trades.json", "utf8"));
  const svgs = [];
  for (const t of trades) {
    const span = 36 * 3600000;
    const cs = await fetchK("BTC_USDT", "30m", Math.floor((t.openTime - span) / 1000), Math.floor((t.openTime + span) / 1000));
    if (cs.length < 10) continue;
    const dirLong = t.direction === "long";
    const pre = cs.filter(c => c.openTime <= t.openTime);
    const atr = atr14(pre);
    const m = t.signalNo.match(/sweep_(\d+\.?\d*)_(\d+)_(long|short)/);
    const sweepLevel = m ? +m[1] : null;

    // 流动性水平（去重后）
    const yesterday = pre.slice(-96, -48);
    const levels = [];
    if (yesterday.length >= 20) {
      levels.push({ price: Math.max(...yesterday.map(c => c.high)), kind: "prevDayHigh", taken: false });
      levels.push({ price: Math.min(...yesterday.map(c => c.low)), kind: "prevDayLow", taken: false });
    }
    const sw = swingPoints(pre, 6);
    for (const s of sw.filter(s => s.kind === "low").slice(-2)) levels.push({ price: s.price, kind: "swingLow", taken: pre.some(c => c.low < s.price) });
    for (const s of sw.filter(s => s.kind === "high").slice(-2)) levels.push({ price: s.price, kind: "swingHigh", taken: pre.some(c => c.high > s.price) });
    const uniq = [];
    for (const l of levels.sort((a, b) => a.price - b.price))
      if (!uniq.some(u => Math.abs(u.price - l.price) < atr * 0.15)) uniq.push(l);

    // 结构折线（最近4摆动点）
    const pivots = [...sw.filter(s => s.kind === "low").slice(-2), ...sw.filter(s => s.kind === "high").slice(-2)].sort((a, b) => a.index - b.index).slice(-4);
    // FVG
    const zones = fvgZones(pre, pre.length - 1, 30);
    const poi = zones.filter(z => dirLong ? z.direction === "long" : z.direction === "short").slice(-1)[0];

    // —— 画布 ——
    const W = 1240, H = 600, padL = 15, padR = 270, padT = 30, padB = 60;
    const plotW = W - padL - padR;
    const allPrices = [...cs.map(c => c.low), ...cs.map(c => c.high), t.stop, t.tp, ...uniq.map(l => l.price)];
    const lo = Math.min(...allPrices) * 0.9993, hi = Math.max(...allPrices) * 1.0007;
    const x = (i) => padL + (i / (cs.length - 1)) * plotW;
    const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB);
    const cw = plotW / cs.length * 0.7;
    const xi = cs.findIndex(c => c.openTime >= t.openTime);
    const xOpen = xi >= 0 ? x(xi) : x(0);

    // K线
    let bars = "";
    cs.forEach((c, i) => {
      const col = c.close >= c.open ? "#26a69a" : "#ef5350";
      bars += `<line x1="${x(i)}" y1="${y(c.high)}" x2="${x(i)}" y2="${y(c.low)}" stroke="${col}" stroke-width="1"/>`;
      bars += `<rect x="${x(i) - cw/2}" y="${y(Math.max(c.open, c.close))}" width="${cw}" height="${Math.max(y(Math.min(c.open, c.close)) - y(Math.max(c.open, c.close)), 1)}" fill="${col}"/>`;
    });

    // —— 右侧标签防重叠布局 ——
    // 收集所有右列标签 {y, color, text}，按 y 排序后强制最小间距
    const labels = [];
    for (const l of uniq) {
      const dirHint = dirLong ? (l.price < t.entry ? "↓已抓" : "↑目标") : (l.price > t.entry ? "↑已抓" : "↓目标");
      labels.push({ py: l.price, text: `${KIND_NAME[l.kind]} ${l.price.toFixed(0)} ${dirHint}`, color: dirHint.includes("已抓") ? "#e91e63" : "#7b1fa2", line: true, dash: true });
    }
    labels.push({ py: t.tp, text: `目标 ${t.tp.toFixed(0)} RR${t.rr.toFixed(1)}`, color: "#26a69a", line: true, dash: true, bold: true });
    labels.push({ py: t.entry, text: `入场 ${t.entry.toFixed(0)}（FVG边缘挂单）`, color: "#2196f3", line: true, dash: true, bold: true });
    labels.push({ py: t.stop, text: `止损 ${t.stop.toFixed(0)}（背离低点下方）`, color: "#ef5350", line: true, dash: true, bold: true });
    labels.sort((a, b) => b.py - a.py); // 价格从高到低 → 屏幕 y 从小到大
    // 像素级防碰撞：文字 y 与线条 y 分离，线条用真实价格，文字推开 + 引导线连接
    const MIN_GAP = 20;
    for (const l of labels) l.textY = y(l.py); // 初始文字位置=价格位置
    for (let i = 1; i < labels.length; i++) {
      const prev = labels[i-1], cur = labels[i];
      const prevBottom = prev.textY + 12, curTop = cur.textY - 4;
      if (curTop < prevBottom) cur.textY = prevBottom + 4;
    }
    // 底部溢出：整体上移文字
    const maxTextY = Math.max(...labels.map(l => l.textY));
    const overflow = maxTextY - (H - padB - 20);
    if (overflow > 0) for (const l of labels) l.textY -= overflow;
    // 顶部溢出：整体下移
    const minTextY = Math.min(...labels.map(l => l.textY));
    if (minTextY < padT + 10) for (const l of labels) l.textY += padT + 10 - minTextY;

    let rightCol = "";
    for (const l of labels) {
      const lineY = y(l.py);
      if (l.line) rightCol += `<line x1="${padL}" y1="${lineY}" x2="${padL + plotW}" y2="${lineY}" stroke="${l.color}" stroke-width="${l.bold ? 1.2 : 0.7}" stroke-dasharray="${l.bold ? "6 3" : "1 4"}" opacity="${l.bold ? 1 : 0.55}"/>`;
      // 引导线：从线条右端连到文字位置（错开时可见）
      if (Math.abs(l.textY - lineY) > 3)
        rightCol += `<line x1="${padL + plotW}" y1="${lineY}" x2="${padL + plotW + 6}" y2="${l.textY - 3}" stroke="${l.color}" stroke-width="0.8"/>`;
      rightCol += `<text x="${padL + plotW + 10}" y="${l.textY + 4}" fill="${l.color}" font-size="12" ${l.bold ? 'font-weight="bold"' : ""}>${l.text}</text>`;
    }

    // 结构折线 + 转
    let struct = "", turnMark = "";
    if (pivots.length >= 2) {
      struct = `<polyline points="${pivots.map(s => `${x(s.index)},${y(s.price)}`).join(" ")}" fill="none" stroke="#555" stroke-width="1.5" stroke-dasharray="5 3"/>`;
      const lp = pivots[pivots.length - 1];
      turnMark = `<text x="${x(lp.index) + 8}" y="${y(lp.price) - 10}" fill="#9c27b0" font-size="12" font-weight="bold">转（收线回头）</text>`;
    }

    // FVG（画到开仓竖线为止）
    let fvgRect = "";
    if (poi) {
      const zi = cs.findIndex(c => c.openTime >= poi.createdTime);
      fvgRect = `<rect x="${x(Math.max(zi,0))}" y="${y(poi.high)}" width="${Math.max(xOpen - x(Math.max(zi,0)), 2)}" height="${Math.max(y(poi.low) - y(poi.high), 2)}" fill="#26a69a30" stroke="#26a69a" stroke-width="0.8"/>`;
    }

    // 扫荡点（开仓前最后一根触及 sweepLevel 的蜡烛）
    let sweepMark = "";
    if (sweepLevel) {
      const si = cs.findIndex(c => c.openTime <= t.openTime && (dirLong ? c.low <= sweepLevel : c.high >= sweepLevel));
      if (si >= 0) {
        const c = cs[si];
        sweepMark = `<circle cx="${x(si)}" cy="${dirLong ? y(c.low) : y(c.high)}" r="10" fill="none" stroke="#ff9800" stroke-width="2"/>
          <text x="${Math.max(x(si) - 30, padL)}" y="${dirLong ? y(c.low) + 26 : y(c.high) - 16}" fill="#ff9800" font-size="11" font-weight="bold">扫荡（挂单被吃）</text>`;
      }
    }

    // 开仓竖线 + 入场圈 + 底部
    const result = t.result === "tp" ? `止盈 ${t.pnlUsd.toFixed(2)}U` : t.result === "stop" ? `止损 ${t.pnlUsd.toFixed(2)}U` : t.result;
    const bottom = `
      <line x1="${xOpen}" y1="${padT}" x2="${xOpen}" y2="${H - padB}" stroke="#888" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${Math.max(xOpen - 85, padL)}" y="${padT + 12}" fill="#444" font-size="11">开仓 ${fmt(t.openTime)}</text>
      <circle cx="${xOpen}" cy="${y(t.entry)}" r="9" fill="none" stroke="#2196f3" stroke-width="2.5"/>
      <text x="${padL}" y="${H - 40}" fill="#555" font-size="12" font-weight="bold">路径：扫荡 → 转确认 → 回踩FVG入场 → 打目标流动性　|　结果：${result}　持仓 ${Math.round((t.exitTime - t.openTime) / 3600000)}h</text>
      <text x="${padL}" y="${H - 20}" fill="#999" font-size="10">周期 30M ｜ 打掉即错，不拉损</text>`;
    const title = `${t.symbol} ${t.direction.toUpperCase()} [${t.trigger}] ${result}`;
    svgs.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><text x="${padL}" y="22" fill="#111" font-size="15" font-weight="bold">${title}</text>${bars}${fvgRect}${struct}${turnMark}${sweepMark}${rightCol}${bottom}</svg>`);
  }
  writeFileSync("backtest/BTC-story4.svg", svgs.join("\n"));
  console.log(`生成 ${svgs.length} 张 v4`);
})();
