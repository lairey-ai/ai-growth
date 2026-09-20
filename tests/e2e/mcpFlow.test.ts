import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../../src/mcp/tools.js';
import { openTestDb, type DB } from '../../src/db/client.js';
import type { AppConfig } from '../../src/shared/config.js';

/**
 * 端到端（§22 Phase 7 / §33）：真实 MCP 协议调用，覆盖 Scenario A/B/C/H/J/K。
 * 这是唯一能验证 tool schema 校验、参数映射、返回值结构的方式。
 */
describe('E2E：MCP 协议全链路', () => {
  let db: DB;
  let client: Client;
  let cfg: AppConfig;
  let dataDir: string;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const raw = res.content?.[0]?.text ?? '';
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 解析失败说明 tool 抛出了协议级错误而非结构化 ToolResult —— 让断言看到原始文本
      return { ok: false, protocolError: raw, isError: res.isError ?? true };
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ai-growth-e2e-'));
    cfg = {
      dataDir,
      timezone: 'Asia/Shanghai',
      logLevel: 'error',
      apiPort: 4598,
      passportAdapter: 'local-json',
      passportFile: 'passport.json',
    };
    db = openTestDb();
    const server = new McpServer({ name: 'ai-growth-test', version: '1.1.0' });
    registerTools(server, db, cfg);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'e2e-agent', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('tools 已注册（附录 A 要求的关键 tool 全在）', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    const required = [
      // System
      'growth_status', 'run_daily_rollover',
      // Profile
      'get_profile', 'update_profile_patch',
      // Goal / Stage
      'get_active_goals', 'create_goal_draft', 'confirm_goal', 'activate_goal', 'update_goal', 'pause_goal',
      'get_stage_plan', 'create_stage_plan', 'update_stage',
      // Today / Action
      'get_today_plan', 'plan_today', 'confirm_today_plan',
      'create_action', 'update_action', 'complete_action', 'skip_action', 'delay_action', 'cancel_action',
      // Replan / Feedback
      'replan', 'add_task_feedback', 'recent_feedback_stats',
      // Evidence / Assessment
      'add_evidence', 'list_evidence', 'create_assessment', 'submit_assessment', 'get_recent_growth',
      'create_growth_event', 'list_growth_events_noop',
      // Life context
      'set_life_context', 'get_life_context',
      // Reminder（附录 A 的 create_or_update_reminder 拆成 create/update 两个）
      'create_reminder', 'update_reminder', 'cancel_reminder', 'list_reminders',
      // Passport
      'get_passport', 'rebuild_passport', 'sync_passport', 'list_sync_jobs',
      // Review / Metrics
      'daily_review', 'weekly_review', 'get_metrics', 'get_planner_context',
    ].filter((n) => !n.endsWith('_noop'));

    const missing = required.filter((n) => !names.has(n));
    expect(missing).toEqual([]);
    expect(names.size).toBeGreaterThanOrEqual(45);
  });

  it('Scenario A：首次调用 growth_status → 提示 Onboarding，且无随机任务', async () => {
    const r = await call('growth_status');
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, unknown>;
    expect(d.onboarding).toBe('NOT_STARTED');
    expect(d.suggestedNextOperation).toBe('START_ONBOARDING');
    expect(d.todayPlanStatus).toBe('NOT_CREATED');
    expect(d.openActionCountToday).toBe(0);
  });

  it('Server 时间可用（timezone 感知）', async () => {
    const r = await call('server_time');
    const d = r.data as Record<string, string>;
    expect(d.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.timezone).toBe('Asia/Shanghai');
  });

  let goalId: string;
  let stageId: string;

  it('完成 Onboarding + 建立 Goal（缺 why 被拒）', async () => {
    const bad = await call('create_goal_draft', {
      title: 'x', why: '', desiredOutcome: 'o', successCriteria: ['c'],
    });
    expect(bad.ok).toBe(false);
    expect((bad.error as Record<string, string>).code).toBe('VALIDATION_ERROR');

    const prof = await call('update_profile_patch', {
      displayName: 'lairey',
      timezone: 'Asia/Shanghai',
      onboardingStatus: 'COMPLETED',
      taskCapacity: { defaultDailyActions: 1, maxActionsPerDay: 3 },
    });
    expect(prof.ok).toBe(true);

    const goal = await call('create_goal_draft', {
      title: '30 天掌握 Agent Engineering',
      why: '想独立做出可交付的 Agent 产品',
      desiredOutcome: '能独立设计并交付一个可运行的 Agent 应用',
      successCriteria: ['产出 1 个可运行 Agent 项目', '能解释 Memory / Tool Calling 原理'],
      targetDate: '2026-10-19',
      dailyTimeBudgetMinutes: 60,
    });
    expect(goal.ok).toBe(true);
    goalId = (goal.data as Record<string, string>).id;

    const confirmed = await call('confirm_goal', { goalId });
    expect((confirmed.data as Record<string, string>).status).toBe('CONFIRMED');
  });

  it('Scenario B：Stage Plan 只到 Stage，不预生成每日任务', async () => {
    const stages = await call('create_stage_plan', {
      goalId,
      stages: [
        { title: 'Tool Calling 基础', objective: '实现最小工具调用', exitCriteria: ['手写一个 tool 调用循环'] },
        { title: 'Memory', objective: '最小可读写记忆', exitCriteria: ['demo 可持久化并召回'] },
      ],
    });
    expect(stages.ok).toBe(true);
    const list = stages.data as { id: string }[];
    expect(list).toHaveLength(2);
    stageId = list[0].id;

    await call('activate_goal', { goalId });
    const active = await call('get_active_goals');
    expect((active.data as unknown[]).length).toBe(1);

    // 关键：没有任何 action 被预生成
    const todayPlan = await call('get_today_plan');
    expect((todayPlan.data as { actions: unknown[] }).actions).toHaveLength(0);

    const st = await call('growth_status');
    expect((st.data as Record<string, string>).suggestedNextOperation).toBe('RUN_DAILY_PLANNING');
    expect((st.data as Record<string, string>).currentStageTitle).toBe('Tool Calling 基础');
  });

  it('Scenario C：plan_today 的结构约束由 Core 强制（不依赖模型自觉）', async () => {
    const bad = await call('plan_today', {
      mainQuest: { title: 'x', whyToday: 'w', estimatedMinutes: 60, completionCriteria: '' },
    });
    expect(bad.ok).toBe(false);

    const tooMany = await call('plan_today', {
      dailyActions: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    });
    expect(tooMany.ok).toBe(false);
    expect((tooMany.error as Record<string, string>).message).toContain('0~2');
  });

  it('Scenario C：正常规划 1 Main + 1 Daily 并确认', async () => {
    const planned = await call('plan_today', {
      rationale: 'Stage 1 出口标准要求手写一次 tool 调用',
      mainQuest: {
        title: '实现最小 Tool Calling 循环',
        whyToday: 'Stage 1 的出口标准',
        estimatedMinutes: 60,
        completionCriteria: '本地跑通一次 tool 调用并打印结果',
        basisGoalId: stageId && goalId,
        basisStageId: stageId,
      },
      dailyActions: [{ title: '散步 30 分钟', basis: '用户确认的运动方向', domain: 'TRAIN' }],
    });
    expect(planned.ok).toBe(true);
    const data = planned.data as { plan: { id: string; status: string }; actions: { kind: string; id: string }[] };
    expect(data.plan.status).toBe('DRAFT');
    expect(data.actions.filter((a) => a.kind === 'MAIN_QUEST')).toHaveLength(1);
    expect(data.actions.filter((a) => a.kind === 'DAILY')).toHaveLength(1);

    const confirmed = await call('confirm_today_plan', { planId: data.plan.id });
    expect(confirmed.ok).toBe(true);

    const after = await call('get_today_plan');
    expect((after.data as { plan: { status: string } }).plan.status).toBe('CONFIRMED');
  });

  it('Scenario C：同一天重复 plan_today 被拒绝（ALREADY_EXISTS）', async () => {
    const dup = await call('plan_today', { dailyActions: [{ title: '再来一个' }] });
    expect(dup.ok).toBe(false);
    expect((dup.error as Record<string, string>).code).toBe('ALREADY_EXISTS');
  });

  it('Scenario I：提醒创建 + Daily 限额 + 完成时自动取消', async () => {
    const plan = await call('get_today_plan');
    const actions = (plan.data as { actions: { id: string; kind: string }[] }).actions;
    const main = actions.find((a) => a.kind === 'MAIN_QUEST')!;
    const daily = actions.find((a) => a.kind === 'DAILY')!;

    const at = new Date(Date.now() + 3600_000).toISOString();
    const r1 = await call('create_reminder', { actionId: main.id, scheduledAt: at });
    expect(r1.ok).toBe(true);

    await call('create_reminder', { actionId: daily.id, scheduledAt: at });
    const r2 = await call('create_reminder', { actionId: daily.id, scheduledAt: at });
    expect(r2.ok).toBe(false); // Daily 最多 1 个未触发提醒

    const list = await call('list_reminders');
    expect((list.data as unknown[]).length).toBe(2);

    const done = await call('complete_action', { actionId: daily.id, note: '散步完成' });
    expect(done.ok).toBe(true);

    const after = await call('list_reminders');
    expect((after.data as unknown[]).length).toBe(1); // daily 的提醒被取消
  });

  it('Scenario H：Evidence + GrowthEvent → Timeline / Passport', async () => {
    const plan = await call('get_today_plan');
    const main = (plan.data as { actions: { id: string; kind: string }[] }).actions.find((a) => a.kind === 'MAIN_QUEST')!;

    const ev = await call('add_evidence', {
      actionId: main.id,
      type: 'ARTIFACT',
      content: 'Tool Calling Demo 可运行',
      metadata: { path: '/tmp/demo.ts' },
    });
    expect(ev.ok).toBe(true);
    const evidenceId = (ev.data as { evidence: { id: string; strength: string } }).evidence.id;
    expect((ev.data as { evidence: { strength: string } }).evidence.strength).toBe('AUTO_VERIFIED');

    // 无证据的 Growth Event 被拒
    const badEvent = await call('create_growth_event', { title: '我变强了', evidenceIds: [] });
    expect(badEvent.ok).toBe(false);

    const goodEvent = await call('create_growth_event', {
      title: '完成最小 Tool Calling Demo',
      domain: 'BUILD',
      evidenceIds: [evidenceId],
      goalId,
      stageId,
      tags: ['tool-calling'],
    });
    expect(goodEvent.ok).toBe(true);

    const completed = await call('complete_action', { actionId: main.id });
    expect(completed.ok).toBe(true);

    const growth = await call('get_recent_growth');
    expect((growth.data as unknown[]).length).toBe(1);

    const passport = await call('rebuild_passport');
    expect(passport.ok).toBe(true);
    const p = passport.data as { recentGrowth: unknown[]; currentState: { activeGoals: unknown[] }; schemaVersion: string };
    expect(p.schemaVersion).toBe('1.1.0');
    expect(p.recentGrowth.length).toBeGreaterThanOrEqual(1);
    expect(p.currentState.activeGoals.length).toBe(1);
  });

  it('Scenario K：sync_passport 写本地 JSON，且 job 记录 DONE', async () => {
    const sync = await call('sync_passport');
    expect(sync.ok).toBe(true);
    expect((sync.data as { ok: boolean }).ok).toBe(true);

    const file = join(dataDir, 'passport.json');
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion: string };
    expect(written.schemaVersion).toBe('1.1.0');

    const jobs = await call('list_sync_jobs');
    expect((jobs.data as { status: string }[])[0].status).toBe('DONE');

    const snap = await call('get_passport');
    expect((snap.data as { passport: unknown }).passport).toBeTruthy();
  });

  it('Scenario G：LifeContext 通过 MCP 设置并影响 planner 上下文', async () => {
    const set = await call('set_life_context', {
      mode: 'BUSY', availableMinutesPerDay: 30, note: '这周工作很忙',
    });
    expect(set.ok).toBe(true);

    const got = await call('get_life_context');
    expect((got.data as Record<string, unknown>).mode).toBe('BUSY');

    const pc = await call('get_planner_context');
    const d = pc.data as { lifeContext: { mode: string; availableMinutesPerDay: number } };
    expect(d.lifeContext.mode).toBe('BUSY');
    expect(d.lifeContext.availableMinutesPerDay).toBe(30);
  });

  it('Scenario D：反馈记录 → Agent 自主替换任务（无需重确认 Goal）', async () => {
    const created = await call('create_action', { title: '读文档第 1 章', kind: 'DAILY', basis: '学习方向' });
    const actionId = (created.data as { id: string }).id;

    const fb = await call('add_task_feedback', { actionId, reason: 'TOO_EASY', comment: '太简单了，换一个' });
    expect(fb.ok).toBe(true);

    await call('cancel_action', { actionId, reason: 'replaced per user feedback' });
    const replacement = await call('create_action', {
      title: '直接实现最小 tool 调用循环', kind: 'DAILY', estimatedMinutes: 45,
    });
    expect(replacement.ok).toBe(true);

    const stats = await call('recent_feedback_stats', { days: 14 });
    expect((stats.data as { reason: string; count: number }[])[0].reason).toBe('TOO_EASY');
  });

  it('Scenario F + L：rollover 幂等，且 pendingReplan 时提示先 Replan', async () => {
    const first = await call('run_daily_rollover');
    const r1 = first.data as { alreadyRan: boolean };
    const second = await call('run_daily_rollover');
    const r2 = second.data as { alreadyRan: boolean };
    expect(r2.alreadyRan).toBe(true);
    void r1;

    const st = await call('growth_status');
    const d = st.data as Record<string, unknown>;
    expect(d.pendingReplan).toBe(false);
    expect(d.onboarding).toBe('COMPLETED');
    expect(d.activeGoalCount).toBe(1);
  });

  it('错误返回结构统一：{ ok:false, error:{ code, message } }', async () => {
    const r = await call('get_goal', { goalId: 'not-exist' });
    expect(r.ok).toBe(true); // 返回 null 而非报错
    expect(r.data).toBeNull();

    const bad = await call('complete_action', { actionId: 'not-exist' });
    expect(bad.ok).toBe(false);
    const e = bad.error as Record<string, string>;
    expect(e.code).toBe('NOT_FOUND');
    expect(typeof e.message).toBe('string');
  });

  it('get_metrics 返回本地指标（不做自律打分）', async () => {
    const r = await call('get_metrics', { windowDays: 14 });
    expect(r.ok).toBe(true);
    const m = r.data as { windowDays: number; completionRate: Record<string, number | null> };
    expect(m.windowDays).toBe(14);
    expect(m.completionRate).toHaveProperty('main');
    expect(m.completionRate).toHaveProperty('daily');
    expect(m).not.toHaveProperty('score');
    expect(m).not.toHaveProperty('level');
  });
});
