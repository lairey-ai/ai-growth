# IMPLEMENTATION_PLAN — AI Growth V1.1

> 依据 `AI_Growth_V1.1_FULL_SPEC.md`（V1.1 冻结补充规范优先级高于前文）。
> 状态标记：✅ 完成 / ⚠️ 部分 / ❌ 未做

产品定位：**Agent-native、Local-first 的个人成长执行系统**。
交付目标：用户**明早可以开始真实使用**，而不是脚手架或 Demo。

---

## Phase 1 — Core + DB ✅

**交付**
- SQLite schema（18 张表）+ 版本化 migration runner（`_migrations` 记录已应用版本）
- Action / Goal 状态机（附录 B），非法转换抛 `INVALID_STATE`
- 领域服务：profile / directions / goals / stages / actions / dailyPlan / evidence / assessment /
  growthEvent / lifeContext / memory / metrics
- timezone 感知的 `localDateKey`（不按 UTC 截断）

**验收**
- ✅ 可创建 Profile / Goal / Stage / Action
- ✅ Daily Action 次日自动 `EXPIRED`
- ✅ Main Quest 次日进入 `PENDING_REPLAN`
- ✅ rollover 幂等（`system_state.last_rollover_date`）
- ✅ 单测覆盖：状态机 12 项 + timezone 4 项

**关键决策**
- 用 `better-sqlite3`（同步 API、无 codegen）替代 Prisma/Drizzle：本地常驻 daemon 场景下无生成步骤、无引擎进程，启动更快、故障面更小。
- `PLANNED → COMPLETED` 判定为**合法**：`IN_PROGRESS` 是可选中间态。否则用户说「做完了」会被要求先点「开始」，违反 §21「低风险任务允许一句话确认」。（该规则由测试锁定）

---

## Phase 2 — Planner + Strategy + Evidence ✅

**交付**
- `createTodayPlan` 结构约束：Main ≤ 1、Daily 0~2、Main 必须含 `whyToday` / `estimatedMinutes` / `completionCriteria`
- Replan Engine 5 种解法：`CONTINUE` / `ADJUST` / `SPLIT` / `DELAY_STAGE` / `CANCEL`，含 Stage 窗口顺延
- TaskFeedback 8 种原因 + 近 14 天反馈聚合
- Evidence 4 档强度（`AUTO_VERIFIED` / `USER_CONFIRMED` / `AGENT_OBSERVED` / `UNVERIFIED`），按类型自动判定
- 学习验收 5 级（`EXPOSURE` → `REAL_WORLD_EVIDENCE`）；未通过不升级知识状态
- LifeContext（`BUSY` / `RECOVERY` / `TRAVEL` / `FOCUS` / `CUSTOM`）+ 到期自动失效
- GrowthEvent 强制要求 evidenceIds（拒绝无证据的人格判断）
- 本地指标：Completion Rate（MAIN / DAILY 分开）、Replan Rate、Modification Rate、Feedback 分布、Reminder 响应

**验收**
- ✅ 30 天学习 Goal 能生成 Stage Plan（只到 Stage，不预生成每日任务）
- ✅ 每天只动态创建当天计划
- ✅ 延期后可重排 Stage
- ✅ Quiz / Practical Evidence 可记录并区分强度

**关键决策**
- **Core 强制规则，MCP 层不重复声明**：曾在 zod 上写 `.max(2)` / `.min(1)`，导致违规返回协议级错误而非结构化 `ToolResult`，违反 §14。已改为规则只由 Core 单点强制。
- 指标分母口径统一为「窗口内所有非 DRAFT 的 action」，避免分母漏掉 `PLANNED` 导致完成率虚高。

---

## Phase 3 — MCP + Skill ✅

**交付**
- MCP Server（stdio），**63 个 tools**，统一 `ToolResult<T> = { ok, data?, error?{code,message,retryable}, suggestedNextOperation? }`
- 错误码：`ONBOARDING_REQUIRED` / `CONFIRMATION_REQUIRED` / `REPLAN_REQUIRED` / `INVALID_STATE` / `NOT_FOUND` / `VALIDATION_ERROR` / `ALREADY_EXISTS` / `INTERNAL`
- `growth_status` 返回 `suggestedNextOperation`，驱动 Agent Handoff（§27）
- `SKILL.md`：On load 10 步、During work、Daily actions、Human authority、错误恢复
- 版本化 Prompts（`src/core/prompts/index.ts`，8 个 v1 prompt）

**验收**
- ✅ 新 Agent 加载 Skill 后可调 `growth_status`
- ✅ 无 Profile 时主动进入 Onboarding
- ✅ 有 Active Goal 时可继续当天流程
- ✅ E2E 通过真实 MCP 协议验证 16 项（含 tool 列举、错误契约、Handoff）

---

## Phase 4 — Scheduler + Reminder + Daemon ✅

**交付**
- Reminder 生命周期：与 Action 绑定，Action 完成/跳过/取消/过期 → 自动取消未触发提醒（幂等）
- `AdaptiveReminderPolicy` 最低规则：每个 Daily 默认最多 1 个未触发提醒
- Scheduler：30s tick → rollover（幂等）→ 触发到期提醒 → 清理过期 LifeContext；10min 重试 Passport 同步
- 通知 Adapter：macOS 本地通知（osascript）/ `null`，可替换
- Daemon：文件日志 + `uncaughtException` 兜底 + SIGTERM 优雅退出
- launchd：`RunAtLoad` + `KeepAlive`，安装脚本负责生成/加载 plist

**验收**
- ✅ 重启 Mac 后 daemon 自动恢复
- ✅ MCP 能正常连接
- ✅ Reminder 可恢复且不重复
- ✅ 第二天旧 Daily 提醒被取消

**关键决策**
- 提醒先落状态（`SENT`）再发通知：通知失败不回滚状态，避免 daemon 重启后重复轰炸。

---

## Phase 5 — Passport ✅

**交付**
- Passport Builder：从 DB + Memory 重建压缩快照（identity / currentState / capabilities / recentGrowth / planningHints）
- `dirty` 标记：Evidence、GrowthEvent、Daily Review、计划生成后置脏；生成后清除
- `PassportSyncAdapter` 接口 + `LocalJsonPassportAdapter`
- Sync job 重试队列（PENDING / RUNNING / DONE / FAILED + attempts + lastError）

**验收**
- ✅ 可从 Source of Truth 重建
- ✅ 每日关键更新后可同步
- ✅ Sync failure 不影响 Growth DB

**关键决策**
- 「取每个 topic 最近一次评估」的排序改为 `updated_at DESC, rowid DESC`：`created_at` 在批量写入时会撞同一毫秒，排序不确定会让 Passport 取到旧结果。

---

## Phase 6 — Web UI ✅

**交付**
- 单页应用（无构建步骤）+ HTTP API（`/api/today`、`/api/goals`、`/api/timeline`、`/api/passport`、`/api/settings`、`/api/rollover`、`/api/metrics`、`/api/health`）
- Today 页遵循 **Progress First, Tasks Second**
- Goals（Stage Timeline）、Timeline（Growth Events + Evidence）、Passport、Settings

**验收**
- ✅ 可观察并可修改状态（完成 / 跳过 / 延期走同一 Core Service）
- ✅ 不使用虚假成长分数
- ✅ 显示 `Stage 3 / 6` 类可核对进度

---

## Phase 7 — Integration Tests ✅

**交付**：118 个测试（unit 16 / integration 78 / e2e 24），10 个测试文件，覆盖规范 §33 全部 Scenario A–L。

| 场景 | 覆盖位置 |
|---|---|
| A 全新安装 → Onboarding | integration + e2e |
| B 30 天学习 Goal（why/outcome/criteria）→ Stage Plan | integration + e2e |
| C 正常 Daily Planning（含结构性拒绝） | integration + e2e |
| D 用户认为任务不合理 → Feedback → 自主替换 | integration + e2e |
| E Daily 跨天未完成 → EXPIRED + 提醒取消 + 不 clone | integration |
| E' **Daily 在 IN_PROGRESS / DELAYED 状态跨天** | integration（`rolloverEdgeCases`） |
| F Main 跨天未完成 → Replan（5 种解法） | integration |
| F' **Main 连续多天未处理（rollover 不得崩）** | integration |
| G Busy Week → LifeContext 降负荷 + 到期确认 | integration + e2e |
| H Evidence → Growth Event → Passport | integration + e2e |
| I Reminder 生命周期 | integration + e2e |
| J Agent Handoff | integration + e2e |
| K Passport Sync 失败不影响本地 | integration + e2e |
| L 重启恢复 / rollover 幂等 | integration |
| **运行时冒烟（对 dist 产物）** | e2e（`distRuntime`） |

**验收**
- ✅ unit / integration / e2e 全通过（117 通过 / 1 条件跳过）
- ✅ typecheck 通过
- ✅ 死代码扫描 0 处
- ✅ production build 通过
- ✅ `doctor.sh` 19 ✓ / 0 ✗

**测试分层说明**：测试默认读 `src/`，用户运行 `dist/`。这个盲区曾导致 118 个测试全绿而运行时 schema 是坏的
（缺陷 #7）。因此补充 `tests/e2e/distRuntime.test.ts`：直接 spawn 编译产物并按 MCP 协议调用工具，
同时断言 `dist` 与 `src` 逐字节一致、无套娃目录。

---

## Phase 8 — 缺陷修复（第二轮主动排查）✅

第一轮 4 个缺陷由开发期测试发现；第二轮主动审计又找出 9 个，其中 3 个致命：

| 类别 | 缺陷 |
|---|---|
| 🔴 致命 | `IN_PROGRESS`/`DELAYED` 无法 `EXPIRED` → rollover 崩溃并整体回滚，系统永久卡死 |
| 🔴 致命 | `PENDING_REPLAN → PENDING_REPLAN` 非法 → Main 连续多天未处理时 rollover 每天崩 |
| 🔴 致命 | 构建不可重入（`cp -R` 套娃）→ `dist` migration 陈旧 → 真实 DB schema 错误 |
| 🔴 高 | API 静态资源 MIME 未使用 → `.js` 以 `text/html` 返回，浏览器拒绝执行，Web UI 白屏 |
| 🟠 中 | `shiftStagesFrom` 破坏 COMPLETED/SKIPPED 阶段的日期与状态 |
| 🟠 中 | `startOfDateKey` 对负 UTC 偏移时区抛错 |
| 🟠 中 | `listEvidence` 按 action 日期而非证据时间过滤 |
| 🟠 中 | `ONBOARDING_REQUIRED` / `REPLAN_REQUIRED` 定义却从未抛出（核心原则只靠文档） |
| 🟡 低 | sync attempts 重复累加；metrics 分母含未确认计划；DRAFT 任务无法操作 |

**加固**：构建幂等化 + doctor 新增「dist 与 src 一致性 / 套娃目录」检查 + dist 运行时冒烟测试 +
Replan 决策级审计 + Web UI 加载自动 rollover + API 按错误码返回 4xx + 死代码清零。

---

## Phase 9 — 脚本 + 文档 ✅

**交付**
- `scripts/install.sh`（8 步：检查 → 依赖 → 构建 → 迁移 → launchd → MCP 片段 → Skill 说明 → doctor）
- `scripts/doctor.sh`（9 类检查，逐项 ✓/✗ 并给修复命令）
- `scripts/uninstall.sh`（默认保留数据；`--purge` 需输入 yes）
- `scripts/reset-dev-data.sh`（改名备份而非删除；检测到真实数据需 `--force`；打印回滚命令）
- `README.md` / `IMPLEMENTATION_PLAN.md` / `PRODUCT_SPEC.md` / `DELIVERY_REPORT.md` / `SKILL.md` / `.env.example`

**验收**
- ✅ `./scripts/install.sh` 一条命令可用
- ✅ `doctor.sh` 全绿
- ✅ 不要求用户每次重启手工 `npm run mcp`

---

## 尚未完成 / 有意不做

| 项 | 说明 |
|---|---|
| 外部 AI Passport API | 接口未定 → 已实现 `PassportSyncAdapter` 接口 + local-json；接入只需实现接口 |
| daemon 内 LLM 自动规划 | V1 规划智能由外部 Agent 承担（SPEC §20 优先路径）；prompts 已版本化备用 |
| 六维属性 / EXP / RPG / 排行榜 / 云端账号 / 多人协作 | V1 明确不做（§16.3），不阻塞上线 |
| 秒级精确提醒 | 当前 30s 轮询粒度，够用；如需精确可接系统级定时器 |
| Windows / Linux 常驻 | launchd 仅 macOS；Linux 需换 systemd unit |
