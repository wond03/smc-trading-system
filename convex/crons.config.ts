import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 每分钟扫描（PRD 模块三：每分钟调度，实际信号最多每 5 分钟一次，Q9 额度紧张时可降频到 5 分钟）
crons.interval("scan every minute", { minutes: 1 }, internal.crons.scan, {});

// 每日小结（每日 00:05 UTC）
crons.daily("daily summary", { hourUTC: 0, minuteUTC: 5 }, internal.reports.daily, {});

// 每周周报（周一 00:15 UTC）
crons.weekly("weekly report", { dayOfWeek: "monday", hourUTC: 0, minuteUTC: 15 }, internal.reports.weekly, {});

export default crons;
