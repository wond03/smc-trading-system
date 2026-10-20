import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// 一次性清理工具：按 id 批量删除（清 10-20 XAU 400 错误期间的旧 dataAnomaly 记录）
export const purgeByIds = internalMutation({
  args: { table: v.string(), ids: v.array(v.string()) },
  handler: async (ctx, { table, ids }) => {
    let n = 0;
    for (const id of ids) {
      // @ts-expect-error 动态表名仅限运维清理用
      await ctx.db.delete(id);
      n++;
    }
    void table;
    return { deleted: n };
  },
});
