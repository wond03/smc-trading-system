// 生成交易图：K线 + 入场/止损/止盈标记，输出 PNG（纯 JS 无依赖，手绘 PNG 太重 → 用 SVG 转 PNG 需要 lib；先输出 SVG + 尝试 sharp/canvas）
import { readFileSync, writeFileSync } from "fs";
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
  for (const t of trades.slice(0, 6)) {
    const span = 36 * 3600000; // 开仓前后各看一段
    const cs = await fetchK("BTC_USDT", "30m", Math.floor((t.openTime - span) / 1000), Math.floor((t.openTime + span) / 1000));
    if (cs.length < 5) continue;
    const W = 1100, H = 420, pad = 50;
    const lo = Math.min(...cs.map(c => c.low), t.stop) * 0.9995;
    const hi = Math.max(...cs.map(c => c.high), t.tp) * 1.0005;
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
    // 开仓竖线 + 三个价位横线
    const xi = cs.findIndex(c => c.openTime >= t.openTime);
    const xOpen = xi >= 0 ? x(xi) : x(0);
    const lines = `
      <line x1="${pad}" y1="${y(t.entry)}" x2="${W - pad}" y2="${y(t.entry)}" stroke="#2196f3" stroke-width="1.2" stroke-dasharray="6 3"/>
      <text x="${W - pad + 4}" y="${y(t.entry) + 4}" fill="#2196f3" font-size="12">入 ${t.entry.toFixed(1)}</text>
      <line x1="${pad}" y1="${y(t.stop)}" x2="${W - pad}" y2="${y(t.stop)}" stroke="#ef5350" stroke-width="1.2" stroke-dasharray="6 3"/>
      <text x="${W - pad + 4}" y="${y(t.stop) + 4}" fill="#ef5350" font-size="12">损 ${t.stop.toFixed(1)}</text>
      <line x1="${pad}" y1="${y(t.tp)}" x2="${W - pad}" y2="${y(t.tp)}" stroke="#26a69a" stroke-width="1.2" stroke-dasharray="6 3"/>
      <text x="${W - pad + 4}" y="${y(t.tp) + 4}" fill="#26a69a" font-size="12">盈 ${t.tp.toFixed(1)} RR${t.rr.toFixed(1)}</text>
      <line x1="${xOpen}" y1="${pad}" x2="${xOpen}" y2="${H - pad}" stroke="#999" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${xOpen + 4}" y="${pad + 12}" fill="#444" font-size="11">开仓 ${fmt(t.openTime)}</text>`;
    const title = `${t.symbol} ${t.direction.toUpperCase()} [${t.trigger}] ${t.result === "tp" ? "止盈" : t.result === "stop" ? "止损" : t.result} ${t.pnlUsd >= 0 ? "+" : ""}${t.pnlUsd.toFixed(2)}U`;
    svgs.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><text x="${pad}" y="26" fill="#fff" font-size="15" font-weight="bold">${title}</text>${bars}${lines}</svg>`);
  }
  writeFileSync("backtest/BTC-trades.svg", svgs.join("\n"));
  console.log(`生成 ${svgs.length} 张 SVG → backtest/BTC-trades.svg`);
})();
