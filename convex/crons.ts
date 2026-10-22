import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 扫描调度（Q24：30M 收线 2 次/小时，其余分钟做托管/数据更新，跳过信号判定在 runner 时段过滤内自然发生）
crons.interval("scan every minute", { minutes: 1 }, internal.scanner.scan, {});
crons.hourly("usage check", { minuteUTC: 2 }, internal.usage.checkUsage, {});

// 每日小结（每日 00:05 UTC）
crons.daily("daily summary", { hourUTC: 0, minuteUTC: 5 }, internal.reports.daily, {});

// 每周周报（周一 00:15 UTC）
crons.weekly("weekly report", { dayOfWeek: "monday", hourUTC: 0, minuteUTC: 15 }, internal.reports.weekly, {});

export default crons;
