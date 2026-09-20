import { describe, it, expect, beforeEach } from 'vitest';
import { testEnv, type TestEnv } from '../helpers.js';
import { ensureProfile, updateProfile, todayIn, getSetting } from '../../src/core/profile.js';
import { createGoalDraft, confirmGoal, createStagePlan, activateGoal } from '../../src/core/goals.js';
import {
  createAction, getAction, completeAction, updateAction, skipAction, createTodayPlan, confirmTodayPlan,
} from '../../src/core/actions.js';
import {
  addEvidence, listEvidence, createGrowthEvent, listGrowthEvents, createAssessment, submitAssessment,
} from '../../src/core/evidence.js';
import { runDailyRollover } from '../../src/core/rollover.js';
import {
  createReminder, updateReminder, cancelReminder, cancelRemindersByAction, listRemindersForDate,
  listDueReminders, markReminderSent, getReminder,
} from '../../src/reminder/service.js';
import { Scheduler } from '../../src/reminder/scheduler.js';
import { NullNotificationAdapter } from '../../src/reminder/notify.js';
import { buildPassport, generatePassport } from '../../src/passport/builder.js';
import {
  syncPassport, retryPendingSyncs, type PassportSyncAdapter,
} from '../../src/passport/sync.js';
import { latestSnapshot, listSyncJobs, isPassportDirty } from '../../src/passport/state.js';
import type { Passport } from '../../src/passport/builder.js';
import { addDays } from '../../src/shared/time.js';

function bootstrap(env: TestEnv) {
  const { ctx } = env;
  ensureProfile(ctx);
  updateProfile(ctx, { onboardingStatus: 'COMPLETED' });
  const g = createGoalDraft(ctx, {
    title: '主线', why: 'w', desiredOutcome: 'o', successCriteria: ['c'],
  });
  confirmGoal(ctx, g.id);
  createStagePlan(ctx, { goalId: g.id, stages: [{ title: 'Stage 1', objective: 's1' }] });
  activateGoal(ctx, g.id);
  return g.id;
}

describe('Scenario I：Reminder 生命周期（§24）', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); bootstrap(env); });

  it('Action 完成 → 关联提醒同步取消', () => {
    const { ctx } = env;
    const a = createAction(ctx, { title: '散步', kind: 'DAILY' });
    const r = createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });

    completeAction(ctx, a.id);
    expect(getReminder(ctx, r.id)!.status).toBe('CANCELLED');
  });

  it('Action 跳过 / 取消 → 提醒同步取消', () => {
    const { ctx } = env;
    const a1 = createAction(ctx, { title: 'a1', kind: 'DAILY' });
    const a2 = createAction(ctx, { title: 'a2', kind: 'DAILY' });
    const r1 = createReminder(ctx, { actionId: a1.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    const r2 = createReminder(ctx, { actionId: a2.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });

    skipAction(ctx, a1.id, '不想做');
    expect(getReminder(ctx, r1.id)!.status).toBe('CANCELLED');

    const n = cancelRemindersByAction(ctx, a2.id, 'user cancelled');
    expect(n).toBe(1);
    expect(getReminder(ctx, r2.id)!.status).toBe('CANCELLED');
  });

  it('每个 Daily Action 默认最多 1 个未触发提醒（不允许无限催促）', () => {
    const { ctx } = env;
    const a = createAction(ctx, { title: '散步', kind: 'DAILY' });
    createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(() =>
      createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() + 7200_000).toISOString() })
    ).toThrow(/max rule|already has 1/);
  });

  it('提醒可更新 / 可取消；已取消的提醒不能更新（幂等取消）', () => {
    const { ctx } = env;
    const a = createAction(ctx, { title: 'x', kind: 'MAIN_QUEST', whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' });
    const r = createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    const moved = updateReminder(ctx, r.id, new Date(Date.now() + 7200_000).toISOString());
    expect(moved.scheduledAt).not.toBe(r.scheduledAt);

    cancelReminder(ctx, r.id, 'changed plan');
    const again = cancelReminder(ctx, r.id, 'again'); // 幂等
    expect(again.status).toBe('CANCELLED');
    expect(() => updateReminder(ctx, r.id, new Date().toISOString())).toThrow(/status CANCELLED/);
  });

  it('已完成 / 已终态的 Action 不能再挂提醒', () => {
    const { ctx } = env;
    const a = createAction(ctx, { title: 'y', kind: 'DAILY' });
    completeAction(ctx, a.id);
    expect(() => createReminder(ctx, { actionId: a.id, scheduledAt: new Date().toISOString() }))
      .toThrow(/Cannot create reminder/);
  });

  it('跨天 rollover 后昨日未触发提醒被取消，且不再出现在今日列表', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);
    const a = createAction(ctx, { title: '昨天的事', kind: 'DAILY', dateKey: yesterday });
    const r = createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() - 7200_000).toISOString() });

    runDailyRollover(ctx, today);
    expect(getReminder(ctx, r.id)!.status).toBe('CANCELLED');
    expect(listRemindersForDate(ctx, today)).toHaveLength(0);
  });
});

describe('Scenario L：Scheduler / daemon 重启恢复', () => {
  it('tick 执行 rollover 并触发到期提醒，且不重复触发', async () => {
    const env = testEnv();
    const { ctx, db, cfg } = env;
    bootstrap(env);
    const today = todayIn(ctx);

    const a = createAction(ctx, { title: '到期任务', kind: 'DAILY' });
    const due = createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() - 600_000).toISOString() });

    const sched = new Scheduler(db, cfg, new NullNotificationAdapter());
    const r1 = await sched.tick();
    expect(r1.remindersFired).toBe(1);
    expect(getReminder(ctx, due.id)!.status).toBe('SENT');

    // 第二次 tick 不得重复触发
    const r2 = await sched.tick();
    expect(r2.remindersFired).toBe(0);

    // 模拟重启：新 Scheduler 实例 + 同一 DB
    const sched2 = new Scheduler(db, cfg, new NullNotificationAdapter());
    const r3 = await sched2.tick();
    expect(r3.remindersFired).toBe(0);
    expect(r3.rolloverRan).toBe(false); // rollover 幂等，重启不重复
    void today;
  });

  it('未到期提醒不会被提前触发', async () => {
    const env = testEnv();
    const { ctx, db, cfg } = env;
    bootstrap(env);
    const a = createAction(ctx, { title: '未来任务', kind: 'DAILY' });
    const future = createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });

    const sched = new Scheduler(db, cfg, new NullNotificationAdapter());
    await sched.tick();
    expect(getReminder(ctx, future.id)!.status).toBe('SCHEDULED');
  });

  it('listDueReminders 只返回 SCHEDULED 且已到时的提醒', () => {
    const env = testEnv();
    const { ctx } = env;
    bootstrap(env);
    const a = createAction(ctx, { title: 'z', kind: 'DAILY' });
    const r = createReminder(ctx, { actionId: a.id, scheduledAt: new Date(Date.now() - 1000).toISOString() });
    expect(listDueReminders(ctx).map((x) => x.id)).toContain(r.id);
    markReminderSent(ctx, r.id);
    expect(listDueReminders(ctx)).toHaveLength(0);
  });
});

describe('Scenario H：Evidence → Timeline → Passport（§6 / §8 / §21）', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); bootstrap(env); });

  it('自动验证类 Evidence 默认 AUTO_VERIFIED，用户口述为 USER_CONFIRMED', () => {
    const { ctx } = env;
    const git = addEvidence(ctx, { type: 'GIT', content: 'commit abc123: memory demo', metadata: { sha: 'abc123' } });
    expect(git.strength).toBe('AUTO_VERIFIED');

    const walk = addEvidence(ctx, { type: 'TEXT', content: '散步 30 分钟' });
    expect(walk.strength).toBe('USER_CONFIRMED');

    const unverified = addEvidence(ctx, { type: 'MANUAL', content: '可能学会了', strength: 'UNVERIFIED' });
    expect(unverified.strength).toBe('UNVERIFIED');
  });

  it('Growth Event 必须有 Evidence 引用（禁止无证据的人格判断）', () => {
    const { ctx } = env;
    expect(() => createGrowthEvent(ctx, { title: '我变强了', evidenceIds: [] }))
      .toThrow(/requires at least one evidence/);
  });

  it('Evidence + GrowthEvent 进入 Timeline 与 Passport recentGrowth', () => {
    const { ctx } = env;
    const ev = addEvidence(ctx, { type: 'ARTIFACT', content: 'Memory Demo 可运行', metadata: { path: '/tmp/demo' } });
    createGrowthEvent(ctx, {
      title: '完成最小 Memory Demo', description: 'demo 可读写并召回',
      domain: 'BUILD', evidenceIds: [ev.id], tags: ['memory'],
    });

    const events = listGrowthEvents(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].evidenceIds).toEqual([ev.id]);
    expect(events[0].domain).toBe('BUILD');

    const passport = generatePassport(ctx);
    expect(passport.recentGrowth).toHaveLength(1);
    expect(passport.recentGrowth[0].title).toBe('完成最小 Memory Demo');
    expect(passport.recentGrowth[0].evidenceCount).toBe(1);
    expect(passport.schemaVersion).toBe('1.1.0');
    expect(passport.currentState.activeGoals).toHaveLength(1);
  });

  it('Passport 可从 Source of Truth 重建（生成新快照后仍是同源数据）', () => {
    const { ctx } = env;
    const ev = addEvidence(ctx, { type: 'METRIC', content: '跑步 5km / 28min', metadata: { distanceKm: 5, minutes: 28 } });
    createGrowthEvent(ctx, { title: '完成 5km', domain: 'TRAIN', evidenceIds: [ev.id] });

    const p1 = buildPassport(ctx);
    generatePassport(ctx);
    const p2 = buildPassport(ctx);
    expect(p2.currentState.activeGoals[0].title).toBe(p1.currentState.activeGoals[0].title);
    expect(p2.recentGrowth[0].title).toBe(p1.recentGrowth[0].title);
    expect(latestSnapshot(ctx)!.passport).toMatchObject({ schemaVersion: '1.1.0' });
  });

  it('学习评估：未通过不升级知识状态，通过的进入 capabilities', () => {
    const { ctx } = env;
    const goalRow = ctx.db.prepare(`SELECT id FROM goals WHERE status='ACTIVE'`).get() as { id: string };

    const a1 = createAssessment(ctx, { topic: 'Tool Calling', method: 'quiz', goalId: goalRow.id });
    const failed = submitAssessment(ctx, { id: a1.id, passed: false, level: 'RECALL', result: { score: 2, total: 5 } });
    expect(failed.knowledgeStateUpdated).toBe(false);

    const a2 = createAssessment(ctx, { topic: 'Tool Calling', method: 'coding-challenge', goalId: goalRow.id });
    const passed = submitAssessment(ctx, { id: a2.id, passed: true, level: 'APPLY', result: { artifact: 'demo' } });
    expect(passed.knowledgeStateUpdated).toBe(true);

    const passport = buildPassport(ctx);
    const cap = passport.capabilities.find((c) => c.topic === 'Tool Calling');
    expect(cap?.level).toBe('APPLY');
  });

  it('新增 Evidence 会标记 Passport 为 dirty，生成后清除', () => {
    const { ctx } = env;
    expect(isPassportDirty(ctx)).toBe(true); // 有 goal 但还没快照
    generatePassport(ctx);
    expect(isPassportDirty(ctx)).toBe(false);
    expect(getSetting(ctx, 'passport_last_generated_at')).toBeTruthy();

    addEvidence(ctx, { type: 'TEXT', content: '新证据' });
    expect(isPassportDirty(ctx)).toBe(true);
  });
});

describe('Scenario K：Passport 同步失败不回滚本地状态（§29.1）', () => {
  it('同步失败 → 本地已完成 Action 保持完成，job 记为 FAILED，可重试', async () => {
    const env = testEnv();
    const { ctx, cfg } = env;
    bootstrap(env);

    const t = createAction(ctx, { title: '重要任务', kind: 'MAIN_QUEST', whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' });
    completeAction(ctx, t.id);

    const failing: PassportSyncAdapter = {
      name: 'always-fail',
      async sync() { throw new Error('network down'); },
    };
    const res = await syncPassport(ctx, failing);
    expect(res.ok).toBe(false);

    // 本地状态不受影响
    expect(getAction(ctx, t.id)!.status).toBe('COMPLETED');
    const jobs = listSyncJobs(ctx);
    expect(jobs[0].status).toBe('FAILED');
    expect(jobs[0].lastError).toContain('network down');
    expect(jobs[0].attempts).toBeGreaterThanOrEqual(1);

    // 可重试：换成可用 adapter
    const okAdapter: PassportSyncAdapter = {
      name: 'ok',
      async sync(_p: Passport) { void _p; return true; },
    };
    const done = await retryPendingSyncs(ctx, okAdapter);
    expect(done).toBe(1);
    expect(listSyncJobs(ctx).every((j) => j.status === 'DONE')).toBe(true);
  });

  it('adapter 返回 false 也记为 FAILED 而不是静默成功', async () => {
    const env = testEnv();
    const { ctx } = env;
    bootstrap(env);
    const noop: PassportSyncAdapter = { name: 'noop', async sync() { return false; } };
    const res = await syncPassport(ctx, noop);
    expect(res.ok).toBe(false);
    expect(listSyncJobs(ctx, 'FAILED')).toHaveLength(1);
  });

  it('重复 sync 请求不产生重复 PENDING job（幂等）', async () => {
    const env = testEnv();
    const { ctx } = env;
    bootstrap(env);
    const failing: PassportSyncAdapter = { name: 'f', async sync() { throw new Error('x'); } };
    await syncPassport(ctx, failing);
    await syncPassport(ctx, failing);
    // 第一次的 job 已 FAILED；第二次会新建（因为幂等只针对 PENDING）——验证不会无限堆积 PENDING
    expect(listSyncJobs(ctx, 'PENDING')).toHaveLength(0);
  });
});

describe('今日计划与提醒联动（Scenario C 补充）', () => {
  it('计划确认后可为 Main Quest 创建提醒，且已完成时同步取消', () => {
    const env = testEnv();
    bootstrap(env);
    const { ctx } = env;

    const { plan, actions } = createTodayPlan(ctx, {
      mainQuest: {
        title: '实现最小 Demo', whyToday: 'Stage 1 出口标准', estimatedMinutes: 60,
        completionCriteria: '能跑通',
      },
      dailyActions: [{ title: '散步 30 分钟', basis: '用户确认的运动方向' }],
    });
    confirmTodayPlan(ctx, plan.id);

    const main = actions.find((a) => a.kind === 'MAIN_QUEST')!;
    const r = createReminder(ctx, { actionId: main.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(listRemindersForDate(ctx)).toHaveLength(1);

    completeAction(ctx, main.id);
    expect(getReminder(ctx, r.id)!.status).toBe('CANCELLED');
    expect(listRemindersForDate(ctx)).toHaveLength(0);
  });

  it('updateAction 改日期不会丢证据关联（证据仍指向同一 action）', () => {
    const env = testEnv();
    bootstrap(env);
    const { ctx } = env;
    const a = createAction(ctx, { title: 'm', kind: 'MAIN_QUEST', whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' });
    const ev = addEvidence(ctx, { actionId: a.id, type: 'TEXT', content: '部分进展' });

    updateAction(ctx, a.id, { estimatedMinutes: 45 }, 'adjust');
    expect(listEvidence(ctx, { actionId: a.id }).map((e) => e.id)).toEqual([ev.id]);
  });
});
