# 交接文档（HANDOFF）

> 更新：2026-10-22 ｜ 本文档是系统侧交接的唯一入口。新会话/新工具从这里接上全部状态。
> 交易思路侧（口径调研、Q12 依据、森林查尔斯材料）在 **wond03/carels-smc-notes**：`HANDOFF.md` + `docs/口径差异对照表.md` + `docs/Q12议题清单_更新版.md`。两仓库职责：**思路看 notes，实现看本仓库**，口径不在此复制。

## 一、当前状态（一句话）

PRD **v1.0 已裁决待开发**：Q1–Q25 全部落档（v0.8 落 Q12–Q22，v0.9 落 Q23/Q24，v1.0 终止旧观察期与口径冻结），新口径直接进入**实现与对照回测**阶段。

## 二、必读文件（按顺序）

| 文件 | 内容 |
|---|---|
| `SMC交易系统-PRD.md`（v1.0） | 唯一权威需求文档；§10 五层口径已按 Q12–Q24 全部更新，§6.2 裁决表含依据 |
| `docs/裁决记录_Q12_2026-10-22.md` | Q12–Q24 逐条裁决 + **对现有代码的改动清单**（§2 表格）+ 连带影响 |
| `docs/参考资料/` | SMC_05~11 视频核验材料（含森林查尔斯 3 篇实盘核验，作裁决引文备份；权威源仍在 notes 仓库） |

## 三、Q12–Q24 裁决摘要（细节以 PRD §10 与裁决记录为准）

1. **BOS**：连续两根收盘有效突破；摆动点取「收线回头」根（按收盘价序列，不取插针）——**Q12，地基**
2. **大小级别冲突**：方案 A（查尔斯式）——小级别转多成立可做小级别顺势单（降级），禁挂大级别逆向 FVG 单——**Q13**
3. **入场**：右侧确认后 + 限价挂回踩；确认前不埋伏；第一段错过不追——**Q14**
4. **单量**：取消每日 2–3 单硬上限，改**单笔 ≤2% + 并发 ≤2 张**兜底——**Q15**
5. **止损** = 背离低点下方；>0.2% 不做；不拉损——**Q16**
6. **FVG 生命周期**：影线填完即失效 + 本级别 30 根 K 超期失效——**Q17**
7. **时段**：仅北京时间 20:00–24:00 开新仓；周五收盘前 4h 禁开——**Q18**
8. **周期**：**4H 定方向 + 30M 执行**，停采 1d/1h/15m/5m；摆动窗口 4H=3 根、30M=6 根——**Q19/Q24**
9. **背离**：一期新增，可替代扫荡作扳机分支；背离单半仓；跨品种背离仅加分——**Q20/Q22（裁决记录 §3-2）**
10. **IDM 不实现；OB 降参考区不进 POI；PD 软过滤**——**Q21**
11. **移保本确认**：30M 收盘确认（5M 作废）——**Q23**
12. **旧观察期与口径冻结终止**——**Q25**，新口径进入实现与回测

## 四、下一步工作清单（裁决记录 §3/§4）

1. **出代码 backlog**：按裁决记录 §2 改动表拆 issue（indicators.ts 摆动点/BOS、FVG 状态机、scanner 周期、signalEngine 入参、crons 频率、backtest 取数）
2. **对照回测**：新旧 BOS 口径并排跑同一 14 天 BTC/XAU（当前 14 天回测 0 信号），用信号数与质量决定切换
3. **5m/15m 历史数据不再入库**，旧回测结果作废，历史样本全部重跑
4. 背离模块：+1 指标模块 +1 扳机分支（15M 背离、前后/结构位背离按时段切换），补登 PRD §3.1

## 五、运维要点（Convex / Weex / TG）

- **Convex**：`crons.ts` 是保留文件名（默认导出 Crons 对象）；`"use node"` 传染规则；`convex/tsconfig.json` 需 `"types":["node"]`；`npx convex dev --once` 推送、`npx convex run <file>:<fn> '<json>'` 实弹验证、cron 部署后查表时间戳确认在跑
- **免费额度**：per-minute 扫描 ≈40% 月额度；in-repo 用量监控（usage.ts）>45% 自动降频至 5 分钟并 TG 告警
- **Weex V3 模拟盘**（commit 555c4d6 已实弹验证）：域名 `https://api-sim.weex.com`（路径与实盘一致 /capi/v3/*）；HMAC-SHA256+Base64 签名 = timestamp+METHOD+path+body；下单 POST /order；止损止盈 POST /placeTpSlOrder（幂等键 clientAlgoId）；撤单 DELETE /algoOrder；orderId 19 位超 JS 精度须正则从原始响应提取；clientAlgoId 不含冒号
- **集成验证法**：临时 `drill.ts` internal action 逐操作实弹演练（open/stop/tp/close/cancel/rawCall），wrapper 与 drill 获胜请求逐字节一致；404 排查顺序：路径前缀→ID 字符集→字段类型
- **Telegram**：推送**无免责声明**后缀；日报须把数据异常（fetch 失败）与风控触发（R1–R4）**分开统计**；格式改动先实发一条验证
- **DB 清理**：`npx convex data` 无 delete；用 in-repo `maintenance.ts` internalMutation 按 id 数组批删
- **回测**：共享引擎（纯函数零 Convex import，PRD 底线）；零信号先跑 `backtest/probe*.mts` 状态机探针，勿先调参；验收证据在 `backtest/<SYM>-trades.json` / `-summary.json`

## 六、环境

- 平台：Hermes Agent；Convex 项目 `smc-trading-system`；部署/运维流程见 Hermes skill `convex-trading-bot-ops`（含登录、部署循环、全部坑位）
- 相关仓库：`wond03/market-alert`（旧半自动系统，Gate.io 价格警报→TG）、`wond03/market-alert-handbook`（业务框架文档）
- 安全：API 密钥只进 `npx convex env set`；`.env.local` 已 gitignore

> 本系统不构成投资建议。

## 上线记录（2026-10-22）
- 新口径引擎已部署 dev deployment `gregarious-goat-621`（project smc-sys），`npx convex dev --once` 推送成功，索引 12 个已建。
- WEEX 模拟盘凭据已 `convex env set`（值不入库）；TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID **尚未配置**（待用户提供）——signalRunner 里 TG 推送会抛错但不影响扫描链路（notify 失败仅记日志，需确认）。回测 A/B：新口径 60d BTC 1 单（+1.97U）/XAU 3 单（+8.85U，66.7% 胜率）；旧口径 14d 0-1 单（对照作废口径）。
- 扫描 cron 每分钟运行中，scanRecords 正常写入；20:00-24:00（北京）时段外全拒绝=Q18 预期。
- 回测成交价口径修正：入场=挂单价 entryRef（Q14），修复了旧实现「TP<entry」的方向 bug（probe19 定位）。
