# AI Growth V1 — Agent-Driven Personal Growth System

> 本文档用于直接交给 Coding Agent 从 0 开发。Agent 应按本文档实现，不应擅自改变核心产品规则。若实现细节存在冲突，以“核心原则”和“状态机”优先。

## 0. 产品目标

构建一个本地优先（Local-first）的 AI 驱动个人成长系统。它不是传统 Todo List，也不是虚构属性值 RPG。

系统通过 Agent 与用户沟通确定成长方向和阶段目标，动态生成每天少量、可执行的任务，记录真实 Evidence，并持续更新 Human Model / AI Passport。

核心循环：

Human → Interview → Direction → Goal → Stage Plan → Daily Plan → Action → Evidence → Reflection → Growth Event → Memory → AI Passport → Next Plan

核心原则：

1. AI 管路线，人决定目的地。
2. 第一次使用必须由 Agent 主动发起 Onboarding Interview，不允许直接生成任务。
3. Goal / 重要方向必须经用户确认。
4. 长期计划规划到 Stage；Daily Action 根据实际状态动态生成，不提前硬编码整个月每日任务。
5. 每天默认 2~3 个任务：1 个 Main Quest + 1~2 个 Daily Action；Agent 可根据用户情况建议调整，长期改变默认负荷需要用户确认。
6. AI 可自主修改、拆分、重排执行层任务；重大 Goal、Deadline、成长方向变化必须确认。
7. Daily Action 只来自用户明确认可过的成长方向、生活意图或客观约束，不能由 AI 自行定义“正确的人生”。
8. Daily Action 仅当天有效。进入下一自然日后，昨日未完成的 Daily Action 自动 EXPIRED，不得继续显示为待完成，也不得直接复制到今天；Agent 必须根据今天情况重新判断是否创建类似任务。
9. Main Quest 不同：未完成的 Main Quest 不自动作废，应进入 Replan，由 Agent 判断继续、拆分、调整或延期，并同步影响后续 Stage。
10. Passport 是当前 Human State 的压缩表达，不是 Source of Truth。Source of Truth 是 Growth DB + Memory。
11. Skill 负责告诉 Agent “什么时候做什么”；MCP 负责提供能力；Core 负责业务状态与规则。
12. 系统必须支持开机/登录后自动运行，不要求用户手动启动 MCP Server。

---

## 1. V1 使用体验

### 1.1 首次安装

Agent 加载 AI Growth Skill 后：

1. 调用 `growth_status`。
2. 如果不存在 Profile，Agent 主动开启 Interview。
3. 自然语言了解用户，而不是一次性问卷。
4. 至少确认：当前主要目标、期望结果、目标周期、每日可投入时间、当前水平、生活约束、希望改善的生活领域、任务负荷偏好。
5. Agent 生成 Profile + Goal Draft + Stage Plan Draft。
6. 展示摘要，让用户确认。
7. 确认后 Goal 进入 ACTIVE，生成 Day 1 Plan。

示例：

用户：“我想 30 天学会 Agent 开发。”

Agent 应继续沟通：最终希望达到什么程度、已有基础、每天投入多久、理论/实践偏好等。不能立即创建 30 天固定任务列表。

### 1.2 每日开始

Agent 每天第一次进入 Growth Flow 时：

1. 检测本地日期。
2. 执行 Daily Rollover。
3. 将昨日所有 `DAILY` 且未完成的 Action 标记 `EXPIRED`。
4. 检查昨日 Main Quest：如未完成，触发 Replan。
5. 读取 Active Goals / Current Stage / Recent Evidence / Recent Completion / User Constraints / Today Availability。
6. 必要时主动询问今天的特殊情况，例如：“今天大概能投入多久？”
7. 创建今天计划。
8. 默认：1 Main Quest + 1~2 Daily Actions。
9. 创建对应提醒。
10. 同步今日摘要到 Passport。

### 1.3 每日任务提醒

Agent 必须根据任务性质自动创建提醒，不要求用户逐条手工设置。

提醒规则：

- Main Quest：如果用户提供可执行时间，按该时间提醒；否则 Agent 可在 Daily Planning 中询问或使用用户已确认的默认时间窗口。
- Exercise / Family / Habit 等 Daily Action：根据用户已确认的时间偏好、日程和上下文安排。
- 不允许为了创建提醒擅自猜测非常具体的时间。如果没有足够信息，Agent 在规划时自然询问一次。
- 提醒记录必须属于 Action，可取消、更新、重排。
- Action 被修改/延期/删除/过期时，对应提醒必须同步修改或取消。
- 第二天 Daily Action 过期时，昨日相关未触发提醒一并取消。
- V1 至少实现本地 Scheduler；具体系统通知实现可使用 macOS Notification / Web Notification，封装为 Notification Adapter。

### 1.4 第二天处理规则（重要）

例：

昨天：
- Main Quest：完成 Agent Memory Demo — 未完成
- Daily：散步 30 分钟 — 未完成
- Daily：给父母打电话 — 未完成

今天 rollover 后：

- Memory Demo → `DELAYED` / `PENDING_REPLAN`，进入 Replan。
- 散步 → `EXPIRED`。
- 给父母打电话 → `EXPIRED`。

Agent 今天可以根据当前状态再次生成“散步 30 分钟”，但这是一个全新的 Action，有新的 ID，不能把昨日 Action 重新激活。

这保证 Daily Action 表达的是“今天最值得做什么”，而不是越来越长的欠债清单。

---

## 2. 任务模型

### 2.1 Action 类型

```ts
type ActionKind =
  | 'MAIN_QUEST'
  | 'DAILY';

type ActionDomain =
  | 'LEARN'
  | 'BUILD'
  | 'TRAIN'
  | 'HABIT'
  | 'CREATE'
  | 'RELATIONSHIP'
  | 'EXPLORE'
  | 'LIFE'
  | 'OTHER';

type ActionStatus =
  | 'DRAFT'
  | 'PLANNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'SKIPPED'
  | 'DELAYED'
  | 'PENDING_REPLAN'
  | 'EXPIRED'
  | 'CANCELLED';
```

### 2.2 Main Quest

来源于 Active Goal / Stage，是当天最重要的推进动作。

Main Quest 必须包含：

- 为什么今天做。
- 预计时间。
- 完成标准。
- Evidence 要求。
- Verification Strategy（若需要）。

Main Quest 未完成不会跨日作废，而是 Replan。

### 2.3 Daily Action

用于健康、关系、习惯、生活维护等，不一定直接属于主线 Goal。

Daily Action：

- 必须与用户认可过的 Direction / Intention 有依据关系。
- 通常 0~2 个。
- 当天有效。
- 未完成次日自动 EXPIRED。
- 不制造 streak guilt / EXP 惩罚。
- AI 可根据近期情况决定今天不生成 Daily Action。

---

## 3. Goal 与 Stage

```ts
type GoalStatus =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'ABANDONED';

interface Goal {
  id: string;
  title: string;
  motivation?: string;
  expectedOutcome: string;
  startDate?: string;
  targetDate?: string;
  status: GoalStatus;
  dailyTimeBudgetMinutes?: number;
  acceptanceCriteria: AcceptanceCriterion[];
  createdAt: string;
  updatedAt: string;
}

interface Stage {
  id: string;
  goalId: string;
  title: string;
  objective: string;
  order: number;
  plannedStartDate?: string;
  plannedEndDate?: string;
  status: 'PLANNED'|'ACTIVE'|'COMPLETED'|'DELAYED'|'SKIPPED';
  exitCriteria: AcceptanceCriterion[];
}
```

长期计划只需要明确 Stage、里程碑和验收，不要一次生成所有未来 Daily Action。

---

## 4. 动态 Replan Engine

触发条件：

- Main Quest 延期。
- Stage 关键验收失败。
- 用户可投入时间变化。
- 用户反馈任务过难/过易/不合理。
- Evidence 表明用户已经掌握计划中的内容。
- 连续任务完成率明显下降。
- 现实 Deadline / Constraints 变化。

Replan 优先级：

1. 先调整 Action。
2. 再调整 Stage 内部节奏。
3. 再使用计划缓冲时间。
4. 若影响 Goal Deadline / Scope，生成 Proposal 并让用户确认。

AI 自主权限：

- 修改任务描述。
- 拆分/合并任务。
- 调整难度。
- 修改 Evidence / Verification 方法。
- Stage 内任务重排。
- 小幅顺延 Stage，并告知用户。

必须确认：

- 改变 Goal Outcome。
- 放弃 Goal。
- 明显改变 Target Date。
- 明显改变学习/训练范围。
- 新增长期 Direction。
- 长期提高每日任务负荷。

---

## 5. Strategy Engine

不同成长类型不能使用统一的“点完成”。

### LEARN

流程：Current Level → Knowledge Gap → Learning Action → Verification → Evidence → Knowledge State Update。

Verification 可由 Agent 自主选择：

- Explain in own words
- Quiz
- Coding challenge
- Practical exercise
- Mini project
- Real project application

Knowledge State 建议：

`UNKNOWN → AWARE → UNDERSTANDING → APPLYING → PROFICIENT`

不要仅因阅读过内容就判定掌握。

### BUILD / CREATE

Evidence 优先：文件、代码、Git commit、截图、可运行 Artifact、发布结果。

### TRAIN

Evidence 优先使用客观 Metrics，例如 duration / distance / reps / weight / pace。

不得使用虚构的“健康 +3”。

### HABIT

看 Consistency，但不要因为中断而进行人格化负面评价。

### RELATIONSHIP / LIFE / EXPLORE

通常使用行动记录 + 简短 Reflection。敏感内容不要强迫用户记录详细隐私。

---

## 6. Evidence 与 Growth Event

```ts
interface Evidence {
  id: string;
  actionId?: string;
  type: 'TEXT'|'FILE'|'GIT'|'METRIC'|'QUIZ'|'ARTIFACT'|'REFLECTION'|'MANUAL';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface GrowthEvent {
  id: string;
  date: string;
  title: string;
  description: string;
  domain: ActionDomain;
  evidenceIds: string[];
  goalId?: string;
  stageId?: string;
  tags: string[];
}
```

Growth Event 只在有意义的真实行动/变化发生后创建。不要每次普通聊天都创建。

---

## 7. Profile / Memory / Human Model

Profile 保存用户明确确认的相对稳定信息：

- Growth Directions
- Active intentions
- Time preferences
- Task capacity preference
- Relevant constraints
- Learning preferences
- Reminder preferences

Memory 保存 Agent 为持续理解用户需要的上下文、决策、行为模式与近期变化。

不要把 AI 推断直接永久写成事实。行为模式等推断应包含 `confidence` 和 `evidenceRefs`，重要判断需要用户确认。

---

## 8. AI Passport

Passport 是可同步的当前 Human Model 快照。

建议结构：

```ts
interface Passport {
  version: string;
  generatedAt: string;
  currentChapter?: string;
  activeDirections: DirectionSummary[];
  activeGoals: GoalSummary[];
  currentStages: StageSummary[];
  recentEvidence: EvidenceSummary[];
  recentGrowthEvents: GrowthEventSummary[];
  knowledgeStates?: KnowledgeSummary[];
  trainingProgress?: MetricSummary[];
  currentFocus: string[];
  recentChanges: string[];
}
```

规则：

- Passport 可随时从 DB + Memory 重建。
- Passport 不保存唯一数据。
- 每日计划生成、Daily Review、重要 Evidence、Goal/Stage 变化后标记 Passport `dirty`。
- 通过 Sync Adapter 同步到外部 AI Passport 卡。
- 外部 AI Passport API 未确定时，先实现通用 `PassportSyncAdapter` 接口 + Local JSON Adapter。

---

## 9. Human Version

Human Version 不按天机械增加。

只有 Reflection Engine 判断存在“有意义的稳定变化”时生成 Version Proposal，例如：

- 完成重要 Stage / Goal。
- 能力从 UNDERSTANDING 进入 APPLYING。
- 产生重要 Artifact。
- 客观训练指标明显变化。
- 长期方向发生用户确认后的变化。

Version 内容必须引用 Evidence，不允许空洞评价。

---

## 10. Daily Planner

输入：

- Profile
- Active Goals
- Current Stages
- Yesterday Actions
- Recent Evidence
- Recent completion/delay data
- User time constraints
- Current date
- User-confirmed reminder preferences
- Recent workload

输出：

```ts
interface DailyPlan {
  id: string;
  date: string;
  mainQuest?: Action;
  dailyActions: Action[];
  rationale: string;
  createdAt: string;
  confirmedAt?: string;
}
```

默认约束：

- Main Quest <= 1。
- Daily Actions 0~2。
- 总数通常 2~3。
- 可以只有 Main Quest。
- 可以 Recovery Day。
- 创建后应让使用者确认；用户提出“不合理”时 Agent 应立即修改方案，直到确认。

---

## 11. Daily Rollover 状态机

每天首次运行或 daemon 检测日期变化时执行，必须幂等。

Pseudo:

```ts
async function rollover(today: LocalDate) {
  const last = await systemState.lastRolloverDate();
  if (last === today) return;

  const previousOpenActions = await actions.before(today).open();

  for (const action of previousOpenActions) {
    if (action.kind === 'DAILY') {
      await actions.expire(action.id);
      await reminders.cancelByAction(action.id);
    }

    if (action.kind === 'MAIN_QUEST') {
      await actions.markPendingReplan(action.id);
      await reminders.cancelByAction(action.id);
    }
  }

  await planner.flagReplanIfNeeded();
  await systemState.setLastRolloverDate(today);
}
```

不要将昨日 Daily Action 自动 clone 到今天。

---

## 12. Reminder / Scheduler

```ts
interface Reminder {
  id: string;
  actionId: string;
  scheduledAt: string;
  status: 'SCHEDULED'|'SENT'|'CANCELLED';
  channel: 'LOCAL_NOTIFICATION'|'WEB'|'OTHER';
}
```

提供：

- `createReminder`
- `updateReminder`
- `cancelReminder`
- `cancelByAction`
- `listTodayReminders`

Scheduler 应常驻运行，并在系统重启后恢复未过期提醒。

macOS V1 推荐：Node daemon + `launchd`。安装脚本负责创建/加载 plist；卸载脚本负责清理。

不得要求用户每次重启手工 `npm run mcp`。

---

## 13. Skill 规范

项目必须提供可被 Agent 安装/读取的 `SKILL.md`。

建议核心内容：

```md
# AI Growth Skill

You are connected to the user's AI Growth system.

Your job is not to maximize task count. Your job is to help the human make meaningful, evidence-backed progress toward directions they have chosen.

## On load

1. Call growth_status.
2. If onboarding is missing/incomplete, proactively continue onboarding before planning tasks.
3. If there is no active goal, discuss goals with the human; do not invent a major goal.
4. If a goal draft exists, continue planning and request confirmation.
5. Run/verify daily rollover.
6. If today's plan does not exist, start daily planning.
7. If a previous Main Quest is pending replan, resolve it before creating a new Main Quest.
8. Ask for missing situational information only when it materially affects today's plan.
9. Present today's plan and obtain confirmation.
10. Create/update reminders after plan confirmation.

## During work

- When meaningful work is completed, record Evidence.
- Modify unreasonable execution-level tasks autonomously when appropriate.
- If the human says a task is unreasonable, replan it rather than defending the task.
- Use the correct verification strategy for the task domain.
- Never mark learning as mastered solely because content was shown/read.

## Daily actions

- Daily Actions are valid only for their local calendar day.
- Never carry an incomplete Daily Action into the next day.
- A similar action may be newly created only after reassessing today's context.

## Human authority

Get explicit confirmation before changing major goals, meaningful deadlines, long-term directions, or persistent task capacity.

## End/update

After meaningful state changes, update memory/growth state and mark Passport for sync.
```

实际 `SKILL.md` 应扩充 Tool 使用说明、错误恢复与例子，但保持简洁，避免消耗过多 Agent Context。

---

## 14. MCP Tools

至少实现：

### System
- `growth_status()`
- `run_daily_rollover()`

### Profile
- `get_profile()`
- `update_profile()`

### Goal
- `list_goals()`
- `get_goal(goalId)`
- `create_goal_draft(input)`
- `confirm_goal(goalId)`
- `update_goal(input)`
- `pause_goal(goalId)`

### Plan / Stage
- `get_stage_plan(goalId)`
- `create_stage_plan(goalId, input)`
- `update_stage(input)`
- `replan(input)`

### Today / Action
- `get_today_plan()`
- `create_today_plan(input)`
- `confirm_today_plan(planId)`
- `create_action(input)`
- `update_action(input)`
- `complete_action(actionId, evidence?)`
- `delay_action(actionId, reason?)`
- `skip_action(actionId, reason?)`

### Evidence / Assessment
- `add_evidence(input)`
- `list_evidence(filters)`
- `create_assessment(input)`
- `submit_assessment(input)`

### Review
- `daily_review(input?)`
- `weekly_review(input?)`

### Reminder
- `list_reminders(date?)`
- `create_reminder(input)`
- `update_reminder(input)`
- `cancel_reminder(reminderId)`

### Passport
- `get_passport()`
- `rebuild_passport()`
- `sync_passport()`

所有 Tool 必须返回结构化 JSON，并提供清晰错误码，例如：`ONBOARDING_REQUIRED`, `CONFIRMATION_REQUIRED`, `REPLAN_REQUIRED`, `INVALID_STATE`。

---

## 15. Agent 主动沟通规则

Agent 必须主动沟通的场景：

1. First Run / Onboarding。
2. 创建长期 Goal 前信息不足。
3. Goal Draft / Stage Plan 需要确认。
4. 今日可投入时间等信息会明显影响 Daily Plan。
5. 今日 Plan 生成后等待确认。
6. Goal Outcome / Deadline 等重大调整。
7. 用户明确表示任务不合理。

Agent 不应反复询问已明确且仍有效的信息。

---

## 16. 数据库

V1 使用 SQLite。推荐 Prisma/Drizzle（二选一；优先选择 Agent 当前生态稳定方案）。

核心表：

- system_state
- profiles
- directions
- goals
- stages
- daily_plans
- actions
- evidence
- assessments
- growth_events
- memories
- reminders
- passports
- passport_sync_logs
- human_versions

所有核心记录包含 `id`, `created_at`, `updated_at`；需要软删除的对象增加 `deleted_at`。

时间处理：数据库保存 ISO timestamp；Daily Rollover 必须基于用户配置的本地 timezone 计算自然日，不能直接按 UTC 日期判断。

---

## 17. 推荐工程结构

```text
ai-growth/
├── apps/
│   ├── daemon/
│   └── web/
├── packages/
│   ├── core/
│   │   ├── profile/
│   │   ├── goals/
│   │   ├── stages/
│   │   ├── planning/
│   │   ├── actions/
│   │   ├── evidence/
│   │   ├── assessment/
│   │   ├── reflection/
│   │   ├── memory/
│   │   ├── passport/
│   │   └── reminders/
│   ├── db/
│   ├── mcp-server/
│   ├── skill/
│   ├── scheduler/
│   ├── passport-sync/
│   └── shared/
├── scripts/
│   ├── install-macos.sh
│   └── uninstall-macos.sh
├── docs/
└── README.md
```

推荐 TypeScript + Node.js，monorepo 可使用 pnpm workspace。

---

## 18. Web UI（V1）

不要过度开发 UI，但必须有可观察/修改状态的界面。

页面：

### Today
- Main Quest
- Daily Actions
- Reminder
- Complete / Skip / Request Replan

### Goals
- Active Goals
- Stage Timeline
- Delay / Progress

### Timeline
- Growth Events
- Evidence

### Learning
- Knowledge Map（有学习 Goal 时展示）
- Assessment history

### Passport
- Current Chapter
- Active Directions
- Active Goals
- Recent Evidence
- Recent Changes
- Last Sync

### Settings
- timezone
- default availability
- reminder preferences
- task capacity
- Passport Sync Adapter

---

## 19. Daily / Weekly Reflection

Daily Review 不要求长日记。

至少总结：

- Main Quest 是否完成。
- 关键 Evidence。
- 今日任务是否合理。
- 是否产生需要进入 Memory 的变化。
- 是否需要 Replan。

Weekly Review：

- Goal / Stage progress。
- Completion / Delay pattern。
- Knowledge / Training progress。
- 有 Evidence 支撑的变化。
- 下周 Stage 调整建议。
- 是否需要 Human Version Proposal。

不要生成没有 Evidence 的人格判断。

---

## 20. AI 调用抽象

Core 不绑定特定模型厂商。

```ts
interface AIProvider {
  generateStructured<T>(request: AIRequest<T>): Promise<T>;
}
```

所有 Planner / Reflection / Assessment Prompt 应版本化存放，例如：

```text
packages/core/prompts/
├── onboarding.v1.md
├── goal-planner.v1.md
├── stage-planner.v1.md
├── daily-planner.v1.md
├── replan.v1.md
├── assessment.v1.md
├── daily-review.v1.md
└── passport.v1.md
```

优先让外部 Agent 通过 Skill + MCP 承担对话智能；daemon 内部 AI Provider 用于后台可自动执行的结构化工作。两种路径应共享 Core 规则。

---

## 21. 安全与用户控制

- 所有本地数据默认保存在用户机器。
- 外部同步必须显式配置 Adapter。
- 用户可以查看、修改、删除 Profile / Goal / Action / Memory / Evidence。
- 不把 Agent 推断当作医学、心理或其他专业诊断。
- 对身体训练任务，V1 避免自动生成极端训练强度；用户报告不适/受伤时不继续自动加量。
- Reminder 必须可关闭。

---

## 22. 开发 Phase

### Phase 1 — Core + DB

完成 SQLite Schema、Repository、Goal/Stage/Action 状态机、Daily Rollover、单元测试。

验收：

- 可以创建 Profile / Goal / Stage / Action。
- Daily Action 次日自动 EXPIRED。
- Main Quest 次日进入 PENDING_REPLAN。
- rollover 幂等。

### Phase 2 — Planner + Strategy

完成 Daily Planner、Replan、LEARN/BUILD/TRAIN/RELATIONSHIP 等策略、Evidence、Assessment。

验收：

- 30 天学习 Goal 能生成 Stage Plan。
- 每天只动态创建当天计划。
- 延期后可以重排 Stage。
- Quiz / Practical Evidence 可记录。

### Phase 3 — MCP + Skill

实现 MCP Tools + `SKILL.md`。

验收：

- 一个新的兼容 Agent 加载 Skill 后，能调用 `growth_status`。
- 无 Profile 时主动进入 Onboarding。
- 有 Active Goal 时可以继续当天流程。
- 用户无需重复解释整个系统怎么使用。

### Phase 4 — Scheduler + Reminder + Daemon

完成常驻服务、Daily Rollover 定时检查、本地提醒、macOS launchd 安装。

验收：

- 重启 Mac 后 daemon 自动恢复。
- MCP 能正常连接。
- Reminder 可恢复。
- 第二天旧 Daily Action 提醒被取消。

### Phase 5 — Passport

实现 Passport Builder、Local JSON Sync Adapter、通用 Sync Adapter Interface。

验收：

- Passport 可从 Source of Truth 重建。
- 每日关键更新后可同步。
- Sync failure 不影响 Growth DB。

### Phase 6 — Web UI

实现 Today / Goals / Timeline / Passport / Settings。

### Phase 7 — Integration Tests

模拟至少以下完整流程：

1. 新用户安装 → Interview → 30 天学习 Goal → 确认 → Day 1。
2. Day 1 Main Quest 完成 → Evidence → Passport 更新。
3. Daily Exercise 未完成 → 第二天 EXPIRED → 提醒取消。
4. Main Quest 未完成 → 第二天 Replan → Stage 顺延。
5. 用户说任务不合理 → Agent 修改 → 用户确认。
6. 学习任务 → Quiz → 未通过 → 不升级 Knowledge State → 重新规划。
7. 重启 daemon → 状态和提醒恢复。
8. 换一个 Agent → 读取 Skill + MCP → 能从当前状态继续。

---

## 23. Agent 开发执行要求

Coding Agent 收到本文档后：

1. 先阅读全文。
2. 创建 `IMPLEMENTATION_PLAN.md`，按 Phase 拆解任务。
3. 创建数据库 Schema 和领域状态机，不要先写 UI。
4. 每完成一个 Phase，运行 tests / typecheck / lint。
5. 不允许用 mock 替代核心状态规则后宣称完成。
6. 对 AI Provider、Passport 外部 API、通知渠道等尚未确定的外部依赖，使用明确 Adapter Interface，不阻塞 Core。
7. 所有日期逻辑写测试，重点覆盖 timezone / midnight / restart / duplicate rollover。
8. 所有 AI 结构化输出使用 schema validation（例如 Zod）。
9. 所有状态变更必须通过 Core Service，不允许 MCP/Web 直接写 DB。
10. 在 README 中提供安装、启动、Skill 安装、MCP 配置、launchd 安装与卸载说明。

---

## 24. V1 Definition of Done

V1 完成的判断不是“页面都做出来”，而是以下体验真实跑通：

用户把 Skill/MCP 接入一个 Agent → Agent 主动了解用户 → 双方确定一个目标 → AI 创建 Stage Plan → 每天动态创建少量任务并提醒 → 用户完成或延期 → Evidence 被记录 → 第二天 Daily Action 自动作废、Main Quest 自动 Replan → 计划随现实变化 → Learning/Training 等使用不同验收策略 → Growth State 持续积累 → AI Passport 自动同步 → Mac 重启后系统仍可继续 → 换一个兼容 Agent 后仍能从 Passport/Growth State 继续推进。

如果上述链路未完整跑通，则 V1 未完成。

---

# V1.1 冻结补充规范（本节优先级高于前文）

> 目标：Claude Coding Agent 应在一次连续开发流程中，把项目做到“用户明早可以开始真实使用”的程度，而不是只完成脚手架或 Demo。除非遇到无法由本文档判断的破坏性产品决策，否则不要逐步停下来询问；应自行实现、测试、修复并继续推进。

## 16. V1.1 产品定位与非目标

### 16.1 一句话产品定义

AI Growth 是一个 **Agent-native、Local-first 的个人成长执行系统**：AI 先理解用户和用户认可的方向，与用户共同确定目标，然后维护阶段计划、每天给出少量下一步行动，随现实变化动态重排，并用真实 Evidence 形成可携带的 AI Passport。

它的价值不是“管理更多 Todo”，而是：

> 用户不用持续维护计划；AI 维护计划，人保留目标、选择和最终确认权。

### 16.2 V1 必须验证的核心假设

1. Agent 能通过首次访谈形成足够好的 Profile 和 Goal。
2. Agent 每天给出的 1 个 Main Quest + 少量 Daily Actions，大部分无需用户大改即可接受。
3. 未完成任务不会造成越来越长的债务列表：Daily 跨天作废，Main 自动进入 Replan。
4. AI 会根据反馈、可用时间和生活状态越来越会安排这个用户。
5. 用户能从 Timeline / Stage / Evidence 中感受到“我正在前进”，而不是依赖虚构属性值。
6. 换一个支持 Skill + MCP 的 Agent 后，能够读取当前状态继续推进。

### 16.3 V1 明确不做 / 不写死

以下能力允许预留接口，但不得阻塞 V1 上线：

- 六维属性、EXP、等级数值。
- 完整 RPG 装备/金币/宠物系统。
- 复杂 Knowledge Graph UI。
- 通用课程平台。
- AI 自动生成大型题库。
- 专业医疗/康复/营养训练指导。
- 强制量化“掌握度百分比”。
- 社交排名。
- 云端账号体系。
- 多人协作。

V1 可以在真实使用过程中按需要新增这些能力。

## 17. 用户控制权与 AI 权限模型

### 17.1 原则

**AI 管路线，人决定目的地。**

AI 不得通过任务暗中改变用户的人生方向。所有 Daily Action 必须能追溯到：

- 用户已确认的 Goal；或
- 用户已确认的生活意图；或
- 用户明确告诉系统的现实约束/偏好。

### 17.2 AI 可自主执行（无需逐次确认）

- 创建当天执行层任务。
- 修改任务文案、难度、预计时间。
- 拆分/合并执行层任务。
- 将 Main Quest 在阶段内合理顺延。
- Daily Action 在当天重新安排。
- 根据任务类型选择 Evidence 方式。
- 生成轻量 Quiz / Explain / Coding Challenge。
- 根据反馈减少当天任务数量。
- 取消已失效提醒。

### 17.3 AI 可调整但必须告知

- Stage 内任务顺序变化。
- Stage 小幅延期。
- 当天从 3 个任务降为 1~2 个。
- 学习方式或验收方式明显变化。
- 进入临时 Busy / Recovery 等模式（若由上下文推断，应先确认）。

### 17.4 必须用户确认

- 创建/删除长期 Goal。
- 改变 Goal 的 why / desired outcome / success criteria。
- 放弃 Goal。
- 明显改变总 Deadline。
- 长期增加默认每日负荷。
- 新增一个此前未被用户认可的生活成长方向。
- 将推断写成 Passport 的重要稳定事实。

## 18. Goal 必须包含 Why

Goal 最低结构：

```ts
interface Goal {
  id: string;
  title: string;
  why: string;
  desiredOutcome: string;
  successCriteria: string[];
  startDate: string;
  targetDate?: string;
  status: 'DRAFT' | 'CONFIRMED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';
  createdAt: string;
  updatedAt: string;
}
```

首次创建 Goal 时，Agent 至少要弄清：

- 为什么现在想做？
- 希望最后能做到什么，而不是“学完什么”？
- 时间周期。
- 每日/每周可投入资源。
- 当前基础。
- 什么证据代表成功。

例如“30 天学习 Agent”不能以“看完 30 天内容”为成功标准；若目标是独立开发 Agent，则实际可运行项目应成为主要 Evidence。

## 19. LifeContext：计划必须服从现实

增加：

```ts
interface LifeContext {
  id: string;
  mode: 'NORMAL' | 'BUSY' | 'RECOVERY' | 'TRAVEL' | 'FOCUS' | 'CUSTOM';
  availableMinutesPerDay?: number;
  startDate: string;
  expectedEndDate?: string;
  note?: string;
  confirmed: boolean;
}
```

用户可以自然语言说：

- “这周特别忙。”
- “明天只有半小时。”
- “我这几天在旅行。”
- “这周想冲刺这个项目。”

Planner 必须因此改变负荷，而不是机械维持旧计划。

临时 LifeContext 到期后，Agent 应主动确认是否恢复，而不是永久保留。

## 20. Task Feedback：系统必须学会怎么推动这个人

Action 支持反馈：

```ts
type TaskFeedbackReason =
  | 'NOT_INTERESTED'
  | 'BAD_TIMING'
  | 'TOO_HARD'
  | 'TOO_EASY'
  | 'ALREADY_DONE'
  | 'NOT_RELEVANT'
  | 'NO_TIME'
  | 'OTHER';

interface TaskFeedback {
  id: string;
  actionId: string;
  reason: TaskFeedbackReason;
  comment?: string;
  createdAt: string;
}
```

规则：

1. 用户说“这个任务不合理”“换一个”“今天不想跑”等，应优先转化为反馈，而不是只记 SKIPPED。
2. 相同类别连续被拒绝时，Planner 必须降低重复推荐概率。
3. 不得把“用户不喜欢某种执行方式”错误解释成“用户不想实现整个 Goal”。
4. Agent 应在必要时询问替代方式，例如跑步 → 散步/骑车/力量训练。

## 21. Evidence 强度

所有成长记录不要求同等证明强度。

```ts
type EvidenceStrength =
  | 'AUTO_VERIFIED'
  | 'USER_CONFIRMED'
  | 'AGENT_OBSERVED'
  | 'UNVERIFIED';
```

说明：

- `AUTO_VERIFIED`：Git、测试、文件、可验证工具输出、Quiz 结果等。
- `USER_CONFIRMED`：用户直接说已完成，如散步、联系家人。
- `AGENT_OBSERVED`：Agent 在当前工作流中观察到，但缺少外部强证明。
- `UNVERIFIED`：仅有推断，不能用于自动宣布完成关键目标。

Agent 不得为了“数据完整”要求用户为所有生活行为上传证据。低风险生活任务允许一句话确认，且支持“今天其他 Daily 都完成了”这类批量确认。

## 22. 学习类任务的 V1 验收模型

V1 不需要复杂 Knowledge Engine，但 Evidence 应支持以下语义等级：

1. `EXPOSURE`：接触/阅读过。
2. `RECALL`：能回答基本问题。
3. `EXPLAIN`：能用自己的话解释。
4. `APPLY`：能独立应用。
5. `REAL_WORLD_EVIDENCE`：真实项目/场景成功使用。

AI 可以自己教学和出题，但不得仅因为自己出的 Quiz 高分就宣称用户“完全掌握”。对于工程类技能，优先使用实际实现作为更强 Evidence。

## 23. Daily Plan 精确规则

### 23.1 默认结构

正常日默认：

- 1 个 `MAIN`。
- 1~2 个 `DAILY`。
- 总数通常 2~3 个。

这不是硬限制。Planner 可根据 LifeContext、近期完成率和当天可用时间降为 1 个；长期提高默认负荷必须征得用户同意。

### 23.2 Main Quest

必须：

- 对 Active Goal / Current Stage 有明确推进价值。
- 有完成标准。
- 有预计耗时。
- 尽量可在当天完成。
- 若过大，Agent 应拆成当天可完成的一步。

### 23.3 Daily Action

Daily Action 用于用户已认可的生活方向，例如活动、家庭联系、阅读、整理、休息等。

禁止：

- AI 根据刻板的“健康人生模板”擅自给所有人添加运动/社交/家庭任务。
- 因昨日 Daily 未完成而机械复制到今天。
- 形成跨天债务。

### 23.4 午夜/第二自然日 Rollover

当检测到日期从 D1 进入 D2：

1. D1 未完成 `DAILY` → `EXPIRED`。
2. 取消 D1 Daily 未触发 Reminder。
3. D1 Daily 不进入 D2 待办。
4. Planner 可以根据 D2 情况重新创建一个相似但全新的 Action；必须有新 ID。
5. D1 未完成 `MAIN` → `PENDING_REPLAN`。
6. Replanner 判断：继续、拆分、降难度、顺延或调整 Stage。
7. 若 Stage 延误影响后续计划，应重算阶段窗口。
8. 大幅改变最终 Goal Deadline 前必须确认。

必须用自动化测试覆盖跨午夜行为。

## 24. Reminder / Notification 策略

提醒不是固定闹钟列表，而是 `AdaptiveReminderPolicy`。

最低规则：

- 每个 Action 可有 0~N 个 Reminder。
- Reminder 与 Action 生命周期绑定。
- Action 更新/过期/取消时 Reminder 同步更新。
- 不允许无限催促。
- 默认每个普通 Daily Action 最多 1 次主动提醒；Main 可按用户确认策略设置合理提醒。
- 记录提醒触发时间与用户响应，用于未来调整推荐时间。
- 若系统不知道合适时间，Daily Planning 时询问用户一次，保存偏好。
- 支持用户关闭某类提醒或全部提醒。

V1 优先实现 macOS 本地通知；Notification Adapter 必须可替换。

## 25. 首页 / Today UX

UI 不应首先呈现“欠了多少任务”，而应 `Progress First, Tasks Second`。

建议 Today 页：

```text
当前主线：30 天掌握 Agent Engineering
Current Stage: Memory (Stage 3 / 6)

最近进展
✓ Tool Calling Demo
✓ MCP Tool 实际应用
● 正在进入 Memory 阶段

今天最重要的一步
🔥 Main Quest
实现最小 Agent Memory Demo
预计 60 min
完成标准：...

Daily
○ 散步 30 min
○ ...
```

禁止用没有可信计算依据的“72% 掌握度”。阶段进度优先显示 `Stage 3 / 6`、完成节点和 Evidence。

## 26. Passport 最终结构

Passport 是压缩状态，不得无限膨胀。

建议：

```ts
interface Passport {
  schemaVersion: string;
  generatedAt: string;
  identity: {
    displayName?: string;
    stablePreferences: string[];
  };
  currentState: {
    currentChapter?: string;
    activeGoals: PassportGoalSummary[];
    lifeContext?: string;
    currentFocus: string[];
  };
  capabilities: PassportCapabilityEvidence[];
  recentGrowth: PassportGrowthSummary[];
  planningHints: string[];
}
```

原则：

- 只放 Agent 接手当前用户真正需要的压缩信息。
- 完整历史保留在 Growth DB。
- Passport 必须可由 DB + Memory 重建。
- 同步失败不得破坏本地 Source of Truth。
- Sync Adapter 必须隔离外部 AI Passport API 细节。

## 27. Agent Handoff Protocol

V1 必须做到：另一个兼容 Agent 只要读取 Skill 并连接 MCP，就能判断当前该做什么。

`growth_status()` 最少返回：

```json
{
  "onboarding": "COMPLETED",
  "activeGoalCount": 1,
  "currentStage": "Memory",
  "todayPlanStatus": "NOT_CREATED",
  "pendingReplan": true,
  "lifeContext": "NORMAL",
  "passportLastUpdatedAt": "...",
  "suggestedNextOperation": "RUN_DAILY_PLANNING"
}
```

Skill 必须明确：

1. 无 Profile → 主动 Interview。
2. Interview 未完成 → 继续，不重复从头问。
3. 无 Active Goal → 与人讨论 Goal。
4. 有 Goal 无今日计划 → Daily Planning。
5. 有 Pending Replan → 先 Replan。
6. 用户正在做 Main → 优先帮助完成，而不是另开新任务。
7. Agent 观察到有效成果 → 提议/自动记录合适 Evidence。
8. 交互结束前，若状态有变化 → 持久化并触发 Passport Sync。

## 28. 推荐数据库实体

至少实现：

- `profiles`
- `directions`
- `goals`
- `stages`
- `daily_plans`
- `actions`
- `task_feedback`
- `evidence`
- `growth_events`
- `life_contexts`
- `reminders`
- `memories`
- `passport_snapshots`
- `sync_jobs`
- `settings`

所有表必须有 migration。时间统一存 ISO timestamp；“哪一天”的判断必须基于配置的本地 timezone，而不是 UTC 日期直接截断。

## 29. 可靠性要求

### 29.1 Local-first

- 无网络时 Core / DB / Today / Rollover 仍可工作。
- AI 调用不可用时，不得损坏状态。
- 外部 Passport 同步失败进入重试队列。

### 29.2 Idempotency

以下操作必须幂等：

- Daily Rollover。
- Passport Sync Job 创建。
- Reminder Cancel。
- 同一天重复启动 Agent。
- Daemon 重启恢复。

### 29.3 审计

对关键 AI 修改记录最小 Audit：

- 谁/什么触发。
- 修改前后。
- 原因。
- 时间。

用户应能知道“为什么这个任务被改了”。

## 30. 指标：验证 AI 是否越来越懂用户

V1 本地统计即可，不需要上传分析平台。

至少计算：

### Accepted Suggestion Rate

AI 初次提出的 Action 中，未经实质修改就被用户接受的比例。

### Completion Rate

按 MAIN / DAILY 分开统计。

### Replan Rate

Main Quest 需要重排的频率。

### Modification Rate

用户修改 AI 建议的频率。

### Skip / Feedback Distribution

为什么用户拒绝。

### Reminder Response

不同提醒时段的响应情况。

这些指标用于 Planner 改善，不得变成给用户打分的“自律分”。

## 31. 明早可用的强制交付物

Coding Agent 完成后，仓库必须至少包含：

```text
README.md
IMPLEMENTATION_PLAN.md
PRODUCT_SPEC.md              # 可复制本文档或保留链接
SKILL.md
.env.example
package.json
src/
  core/
  db/
  mcp/
  planner/
  reminder/
  passport/
  daemon/
  api/
  ui/                       # 若采用独立前端可调整目录
scripts/
  install.sh
  uninstall.sh
  doctor.sh
  reset-dev-data.sh
tests/
  unit/
  integration/
  e2e/
launchd/                    # macOS plist/template
```

并且必须提供一条尽量简单的安装路径，例如：

```bash
./scripts/install.sh
```

安装脚本至少完成：

1. 检查 Node/包管理器依赖。
2. 安装依赖。
3. 初始化 DB / migration。
4. 安装/生成 daemon 配置。
5. 启动服务。
6. 输出 MCP 配置片段或自动安装到目标 Agent（若安全且明确可做）。
7. 输出 Skill 安装/引用方式。
8. 运行 `doctor` 验证。

不得要求用户每次重启电脑后手工 `npm run mcp`。

## 32. Claude Coding Agent 执行要求

收到本文档后，Claude 应：

1. 先读取完整 SPEC。
2. 生成 `IMPLEMENTATION_PLAN.md`，列出阶段、依赖和验收项。
3. 检查当前仓库已有代码；有旧实现则优先迁移，不盲目重写。
4. 先实现 DB Schema + migration + Core 状态机。
5. 然后实现 Daily Rollover / Replan / Feedback / Evidence。
6. 再实现 MCP + Skill 所需接口。
7. 再实现 Daemon + Reminder。
8. 再实现 Passport + UI。
9. 编写测试，不得只手工点通。
10. 运行 lint/typecheck/test/build。
11. 自己修复失败项。
12. 运行端到端“首次用户 → 第二天 rollover”测试。
13. 最终生成 `DELIVERY_REPORT.md`。
14. 除非存在本文档无法决定的破坏性选择，否则不要每完成一步就等待用户确认；持续开发到验收通过。

不得以以下状态宣称完成：

- 只有 UI Mock。
- MCP Tools 只有空实现。
- Reminder 只写 TODO。
- Passport 只生成静态 JSON。
- 测试未运行。
- 电脑重启后服务无法恢复。

## 33. 强制端到端验收场景

### Scenario A — 全新安装

Given：空 DB。

When：Agent 第一次加载 Skill。

Then：

- `growth_status` 告知需要 Onboarding。
- Agent 主动开始自然语言 Interview。
- 不得直接创建随机 Daily Tasks。

### Scenario B — 创建 30 天学习目标

用户说：“我想 30 天学会 Agent 开发。”

Then：

- Agent 追问目标程度、基础、时间、实践偏好。
- 生成带 why / outcome / success criteria 的 Goal Draft。
- 生成 Stage Plan，不生成固定 30 天每日任务表。
- 用户确认后才 Active。

### Scenario C — 正常 Daily Planning

Given：Active Goal + Normal LifeContext。

Then：

- 创建 1 Main + 1~2 Daily（若上下文适合）。
- Main 有完成标准和预计耗时。
- Daily 来源可追溯到已确认方向。
- 自动创建合理提醒。

### Scenario D — 用户认为任务不合理

用户：“这个任务太简单了，换一个。”

Then：

- 记录 Task Feedback。
- AI 可自主替换执行层任务。
- 新任务保持对 Goal 的推进价值。
- 不要求重新确认整个 Goal。

### Scenario E — Daily 跨天未完成

Given：D1 Daily 未完成。

When：系统进入 D2。

Then：

- D1 Daily = EXPIRED。
- D1 Reminder 取消。
- D2 Today 不显示其为欠任务。
- 若 Planner 仍认为同类行动合适，应创建新 ID 的 D2 Action。

### Scenario F — Main 跨天未完成

Given：D1 Main 未完成。

When：进入 D2。

Then：

- Main 进入 PENDING_REPLAN。
- AI 根据原因和计划决定继续/拆分/延期。
- 必要时移动后续 Stage。
- 大幅延长最终 Deadline 前要求用户确认。

### Scenario G — Busy Week

用户：“这周工作很忙，每天最多 30 分钟。”

Then：

- 创建/更新临时 LifeContext。
- Planner 降低负荷。
- 不因为完成率下降而催促更多任务。
- 到期后询问是否恢复。

### Scenario H — Evidence

用户在 Agent 中完成代码实现。

Then：

- Agent 能记录 Artifact/测试/Git 等 Evidence。
- Evidence Strength 合理。
- Timeline 形成 Growth Event。
- Passport Recent Growth 可更新。

### Scenario I — Reminder 生命周期

修改、完成、取消、过期 Action 后：

- 旧 Reminder 不得继续触发。
- Daemon 重启不得产生重复 Reminder。

### Scenario J — Agent Handoff

Given：已有 Profile / Goal / Stage / Yesterday Evidence。

When：一个新 Agent 读取 Skill 并连接 MCP。

Then：

- 不重新做 Onboarding。
- 能读取当前状态。
- 能说清当前 Stage / 今日是否已有 Plan / 是否需要 Replan。
- 可以继续推进。

### Scenario K — Passport Sync Failure

Given：外部 AI Passport API 不可用。

Then：

- 本地状态正常提交。
- Sync Job 记录失败并可重试。
- 不回滚已完成 Action。

### Scenario L — 重启恢复

Given：服务正常安装。

When：模拟 daemon 重启/重新登录。

Then：

- DB 无损。
- 服务自动恢复。
- 不重复执行已完成 rollover。
- MCP 重新可用。

## 34. 明早首次真实测试脚本

开发完成后，用户明早第一次真实使用建议只做以下流程，不要预填测试数据：

1. 打开常用 Agent。
2. 让 Agent 加载 AI Growth Skill / 连接 MCP。
3. Agent 应主动发现这是首次使用并开始 Interview。
4. 用户用真实目标回答，不配合“测试答案”。
5. 观察 Agent 是否能形成合理 Goal Draft 和 Stage Plan。
6. 确认后生成真实 Day 1 Plan。
7. 检查任务数量是否让人愿意做，而不是“功能展示”。
8. 对至少一个任务故意提出修改，测试 Feedback + Replan。
9. 完成一个真实任务，检查 Evidence / Timeline / Passport。
10. 保留一个非关键 Daily 不完成，用于第二天验证 EXPIRED。

第一天重点不是测试所有按钮，而是回答：

> “如果我完全不维护 Todo，只和 Agent 沟通，我愿不愿意让它继续替我维护计划？”

## 35. 7 天 Beta 观察问题

每天结束记录极短反馈：

- 今天 AI 给的 Main Quest 是不是“我确实该做的下一步”？
- 哪个任务我改了？为什么？
- 有没有觉得 AI 在管教我？
- 有没有任务太多？
- 提醒烦不烦？
- 我是否感受到 Goal 在推进？证据是什么？
- 今天我有没有为了维护系统本身额外花很多时间？

第 7 天根据真实数据再决定是否增加 Knowledge Map / Quiz Engine / RPG / Human Version 等 V2 能力。

## 36. Definition of Done（最终完成标准）

V1.1 只有在以下全部满足时才算完成：

### Product

- [ ] 首次 Agent 自动访谈。
- [ ] Goal 经沟通和确认建立，并包含 why/outcome/success criteria。
- [ ] Stage Plan 可动态调整。
- [ ] Daily Plan 默认 1 Main + 1~2 Daily，且负荷可动态变化。
- [ ] Task 可修改、拒绝、反馈。
- [ ] Daily 第二天自动 EXPIRED，不形成债务。
- [ ] Main 未完成会 Replan。
- [ ] LifeContext 会影响规划。
- [ ] Evidence 可记录且区分强度。
- [ ] Timeline 能看到真实进展。
- [ ] Passport 可生成并同步/重试。
- [ ] Reminder 随 Action 生命周期更新。

### Agent-native

- [ ] SKILL.md 足以让新 Agent 判断下一步。
- [ ] MCP Tool 有真实实现。
- [ ] Agent Handoff 测试通过。
- [ ] 不要求用户每次重复解释 Goal。

### Reliability

- [ ] SQLite migration 正常。
- [ ] Rollover 幂等。
- [ ] Daemon 重启恢复。
- [ ] macOS 登录/重启后可自动运行。
- [ ] Reminder 不重复。
- [ ] Passport 外部同步失败不影响本地提交。

### Engineering

- [ ] Typecheck 通过。
- [ ] Lint 通过。
- [ ] Unit tests 通过。
- [ ] Integration tests 通过。
- [ ] 关键 E2E 场景通过。
- [ ] Production build 通过。
- [ ] `doctor.sh` 通过。
- [ ] README 包含安装、启动、Agent 接入、卸载、故障排查。

### UX

- [ ] 新用户无需阅读数据库/MCP 文档即可开始。
- [ ] Today 页面 Progress First。
- [ ] 用户可以用自然语言完成/修改/跳过任务。
- [ ] 不使用虚假成长分数。
- [ ] AI 能解释任务为何出现以及为何被调整。

## 37. 最终 DELIVERY_REPORT.md 必须包含

Claude 完成开发后必须输出：

```markdown
# Delivery Report

## Implemented
- ...

## Architecture
- ...

## How to Install
- exact commands

## How to Connect Agent
- exact Skill/MCP steps

## How to Start First Real Use
- exact steps

## Tests
- unit: pass/fail
- integration: pass/fail
- e2e: pass/fail
- build: pass/fail

## macOS Auto-start
- installed path
- status command

## Data Location
- DB path
- logs path
- config path

## Passport Sync
- implemented adapter
- configuration required

## Known Limitations
- only real remaining limitations; no hidden TODOs

## Tomorrow Morning Checklist
- 1...
- 2...
```

## 38. 最终指令给 Coding Agent

> 你不是在制作一个演示 Demo，而是在制作一个用户明天早上会开始真实使用的本地个人成长系统。优先保证核心闭环、状态一致性、跨天逻辑、Agent 接入和恢复能力。不要为了展示功能而生成大量任务。不要用虚构分数替代成长证据。不要让用户成为系统的管理员。系统应该替用户维护计划，而不是要求用户维护系统。
>
> 在实现过程中，若本文档已经给出明确规则，直接执行，不要重复询问。若某个外部集成（例如现有 AI Passport API）缺少必要接口信息，请实现清晰的 Adapter、Mock/Local implementation 和配置入口，使其不阻塞其余 V1 验收，并在 DELIVERY_REPORT 中准确列出需要用户补充的唯一信息。

---

# 附录 A：建议 MCP Tool Contract（V1）

至少提供：

- `growth_status()`
- `get_profile()`
- `update_profile_patch()`
- `get_active_goals()`
- `create_goal_draft()`
- `confirm_goal()`
- `update_goal()`
- `get_current_stage()`
- `get_today_plan()`
- `plan_today()`
- `replan()`
- `create_action()`
- `update_action()`
- `complete_action()`
- `skip_action()`
- `add_task_feedback()`
- `add_evidence()`
- `get_recent_growth()`
- `set_life_context()`
- `get_life_context()`
- `create_or_update_reminder()`
- `cancel_reminder()`
- `run_daily_rollover()`
- `generate_passport()`
- `sync_passport()`
- `get_passport()`

Tool 返回结构统一：

```ts
interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  suggestedNextOperation?: string;
}
```

Tool 应尽量 deterministic；需要 LLM 判断的规划逻辑可以由 Skill 驱动 Agent 调用 Core primitives，或封装 Planner Provider，但必须保证 Core 状态规则不依赖模型“记得遵守”。

# 附录 B：状态机最低要求

Action：

```text
DRAFT
  ↓
PLANNED
  ↓
ACTIVE
  ├──→ COMPLETED
  ├──→ SKIPPED
  ├──→ CANCELLED
  ├──→ EXPIRED          # DAILY only
  └──→ PENDING_REPLAN   # MAIN mainly
```

Goal：

```text
DRAFT → CONFIRMED → ACTIVE
                     ├→ PAUSED → ACTIVE
                     ├→ COMPLETED
                     └→ ABANDONED (human confirm)
```

不得允许非法状态转换静默发生。

# 附录 C：数据与隐私默认原则

- 默认 Local-first。
- 不把完整个人 Growth DB 自动发送到外部 Passport。
- Passport 只同步压缩后的必要字段。
- 日志不得默认打印完整敏感 Profile/Memory。
- 提供清晰的数据目录和备份方式。
- 删除/重置测试数据必须有显式脚本，不得误删用户真实数据。

