// 电报三级推送（PRD 模块六）：signal / position / alert。
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const TAGS: Record<string, string> = { signal: "📡", position: "🔄", alert: "🚨" };

export const send = internalAction({
  args: { level: v.union(v.literal("signal"), v.literal("position"), v.literal("alert")), text: v.string() },
  handler: async (_ctx, { level, text }) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) throw new Error("TELEGRAM 凭据未配置（convex env set）");
    const body = {
      chat_id: chatId,
      text: `${TAGS[level]} ${text}\n\n⚠️ 不构成投资建议`,
    };
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // 推送失败记录（PRD：失败率月度统计，过高单独告警——部署版加计数）
      console.error(`telegram send failed: ${res.status}`);
    }
  },
});
