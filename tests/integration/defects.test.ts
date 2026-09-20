import { describe, it, expect, beforeEach } from 'vitest';
import { testEnv, type TestEnv } from '../helpers.js';
import { ensureProfile, updateProfile, todayIn } from '../../src/core/profile.js';
import { createGoalDraft, confirmGoal, createStagePlan, activateGoal, listStages, getStage } from '../../src/core/goals.js';
import { createAction, getAction, createTodayPlan } from '../../src/core/actions.js';
import { runDailyRollover } from '../../src/core/rollover.js';
import { resolveReplan } from '../../src/core/replan.js';
import { addEvidence, listEvidence, createAssessment, submitAssessment } from '../../src/core/evidence.js';
import { syncPassport, type PassportSyncAdapter } from '../../src/passport/sync.js';
import { listSyncJobs } from '../../src/passport/state.js';
import { startOfDateKey, localDateKey, addDays } from '../../src/shared/time.js';

function bootstrap(env: TestEnv) {
  const { ctx } = env;
  ensureProfile(ctx);
  updateProfile(ctx, { onboardingStatus: 'COMPLETED' });
  const g = createGoalDraft(ctx, { title: '主线', why: 'w', desiredOutcome: 'o', successCriteria: ['c'] });
  confirmGoal(ctx, g.id);
  createStagePlan(ctx, {
    goalId: g.id,
    stages: [
      { title: 'S1', objective: 's1', plannedStartDate: '2026-09-01', plannedEndDate: '2026-09-10' },
      { title: 'S2', objective: 's2', plannedStartDate: '2026-09-11', plannedEndDate: '2026-09-20' },
      { title: 'S3', objective: 's3', plannedStartDate: '2026-09-21', plannedEndDate: '2026-09-30' },
    ],
  });
  activateGoal(ctx, g.id);
  return g.id;
}

describe('缺陷 E：shiftStagesFrom 不得破坏已完成/已跳过阶段的历史', () => {
  let env: TestEnv;
  let goalId: string;
  beforeEach(() => { env = testEnv(); goalId = bootstrap(env); });

  it('已 COMPLETED 的阶段：日期与状态都不能被顺延改写', () => {
    const { ctx } = env;
    const stages = listStages(ctx, goalId);
    // S1 已完成，但仍挂着一个未完成的主线任务（真实会出现：阶段收尾任务拖到次日）
    ctx.db.prepare(`UPDATE stages SET status='COMPLETED' WHERE id=?`).run(stages[0].id);

    const main = createAction(ctx, {
      title: 'S1 的收尾任务', kind: 'MAIN_QUEST', dateKey: addDays(todayIn(ctx), -1),
      whyToday: 'w', estimatedMinutes: 60, completionCriteria: 'c', basisStageId: stages[0].id,
    });
    runDailyRollover(ctx, todayIn(ctx));
    resolveReplan(ctx, { actionId: main.id, resolution: 'DELAY_STAGE', reason: '落后了', delayDays: 3 });

    const after = listStages(ctx, goalId);
    // S1 是历史，必须原封不动（日期 + 状态）
    expect(after[0].status).toBe('COMPLETED');
    expect(after[0].plannedStartDate).toBe('2026-09-01');
    expect(after[0].plannedEndDate).toBe('2026-09-10');
    // S2 / S3 顺延
    expect(after[1].plannedEndDate).toBe('2026-09-23');
    expect(after[2].plannedEndDate).toBe('2026-10-03');
  });

  it('已 SKIPPED 的阶段也不应被改成 DELAYED', () => {
    const { ctx } = env;
    const stages = listStages(ctx, goalId);
    ctx.db.prepare(`UPDATE stages SET status='SKIPPED' WHERE id=?`).run(stages[0].id);

    const main = createAction(ctx, {
      title: 'm', kind: 'MAIN_QUEST', dateKey: addDays(todayIn(ctx), -1),
      whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c', basisStageId: stages[0].id,
    });
    runDailyRollover(ctx, todayIn(ctx));
    resolveReplan(ctx, { actionId: main.id, resolution: 'DELAY_STAGE', reason: 'r', delayDays: 2 });

    expect(getStage(ctx, stages[0].id)!.status).toBe('SKIPPED');
    expect(getStage(ctx, stages[0].id)!.plannedEndDate).toBe('2026-09-10');
  });

  it('ACTIVE 阶段顺延后仍是 ACTIVE（不能丢失"当前阶段"信号）', () => {
    const { ctx } = env;
    const stages = listStages(ctx, goalId);
    ctx.db.prepare(`UPDATE stages SET status='ACTIVE' WHERE id=?`).run(stages[0].id);

    const main = createAction(ctx, {
      title: 'm', kind: 'MAIN_QUEST', dateKey: addDays(todayIn(ctx), -1),
      whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c', basisStageId: stages[0].id,
    });
    runDailyRollover(ctx, todayIn(ctx));
    resolveReplan(ctx, { actionId: main.id, resolution: 'DELAY_STAGE', reason: 'r', delayDays: 1 });

    const s1 = getStage(ctx, stages[0].id)!;
    expect(s1.status).toBe('ACTIVE');
    expect(s1.plannedEndDate).toBe('2026-09-11');
  });
});

describe('缺陷 G：startOfDateKey 必须对所有时区正确（含负偏移）', () => {
  it('Asia/Shanghai（+8）', () => {
    const d = startOfDateKey('2026-09-19', 'Asia/Shanghai');
    expect(d.toISOString()).toBe('2026-09-18T16:00:00.000Z');
    expect(localDateKey(d, 'Asia/Shanghai')).toBe('2026-09-19');
  });

  it('America/New_York（负偏移）', () => {
    const d = startOfDateKey('2026-09-19', 'America/New_York');
    expect(localDateKey(d, 'America/New_York')).toBe('2026-09-19');
    // 纽约 9 月为 EDT (−4)
    expect(d.toISOString()).toBe('2026-09-19T04:00:00.000Z');
  });

  it('Europe/London（夏令时 +1）', () => {
    const d = startOfDateKey('2026-09-19', 'Europe/London');
    expect(localDateKey(d, 'Europe/London')).toBe('2026-09-19');
    expect(d.toISOString()).toBe('2026-09-18T23:00:00.000Z');
  });

  it('UTC', () => {
    const d = startOfDateKey('2026-09-19', 'UTC');
    expect(d.toISOString()).toBe('2026-09-19T00:00:00.000Z');
  });

  it('所有时区都满足：起点 <= 该 key 的任意时刻', () => {
    for (const tz of ['Asia/Shanghai', 'America/New_York', 'Europe/London', 'UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
      const start = startOfDateKey('2026-09-19', tz);
      const mid = startOfDateKey('2026-09-20', tz);
      expect(localDateKey(start, tz)).toBe('2026-09-19');
      expect(start.getTime()).toBeLessThan(mid.getTime());
      expect(mid.getTime() - start.getTime()).toBeGreaterThanOrEqual(23 * 3600_000);
      expect(mid.getTime() - start.getTime()).toBeLessThanOrEqual(25 * 3600_000);
    }
  });
});

describe('缺陷 F：listEvidence 的时间过滤必须按"证据产生时间"而非 action 日期', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); bootstrap(env); });

  it('跨天完成的旧 action：今天记录的证据应算作今天的证据', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const oldAction = createAction(ctx, {
      title: '昨天做的主线', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c',
    });
    // 证据在"今天"记录（action 属于昨天）
    const ev = addEvidence(ctx, { actionId: oldAction.id, type: 'GIT', content: 'commit today' });

    const todayEvidence = listEvidence(ctx, { sinceDateKey: today });
    expect(todayEvidence.map((e) => e.id)).toContain(ev.id);
  });

  it('不挂 action 的独立证据（如评估、反思）也必须按时间过滤', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    // 先造一条"很久以前"的独立证据
    const old = addEvidence(ctx, { type: 'REFLECTION', content: '很久以前的反思' });
    ctx.db.prepare('UPDATE evidence SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 30 * 86400_000).toISOString(), old.id);

    const todayEvidence = listEvidence(ctx, { sinceDateKey: today });
    expect(todayEvidence.map((e) => e.id)).not.toContain(old.id);
  });

  it('评估产生的 QUIZ 证据能被时间过滤正确纳入', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const a = createAssessment(ctx, { topic: 'Tool Calling', method: 'quiz' });
    submitAssessment(ctx, { id: a.id, passed: true, level: 'APPLY' });

    const todayEvidence = listEvidence(ctx, { sinceDateKey: today });
    expect(todayEvidence.some((e) => e.type === 'QUIZ')).toBe(true);
  });
});

describe('缺陷 K：对尚未确认计划的 DRAFT 任务操作不应报状态机错误', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); bootstrap(env); });

  it('直接完成 DRAFT 任务：自动提升为 PLANNED 并完成（用户操作即认可）', async () => {
    const { ctx } = env;
    const { createTodayPlan } = await import('../../src/core/actions.js');
    const { actions } = createTodayPlan(ctx, {
      mainQuest: { title: 'm', whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' },
      dailyActions: [{ title: 'd', basis: 'b' }],
    });
    const daily = actions.find((a) => a.kind === 'DAILY')!;
    expect(daily.status).toBe('DRAFT');

    const { completeAction } = await import('../../src/core/actions.js');
    const done = completeAction(ctx, daily.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeTruthy();
  });

  it('DRAFT 任务可跳过 / 可延期 / 可开始', async () => {
    const { ctx } = env;
    const { createTodayPlan, skipAction, delayAction, startAction } = await import('../../src/core/actions.js');
    const { actions } = createTodayPlan(ctx, {
      dailyActions: [{ title: 'a', basis: 'b' }, { title: 'b', basis: 'b' }],
    });
    const [d1, d2] = actions;

    expect(skipAction(ctx, d1.id, '不想做').status).toBe('SKIPPED');
    expect(delayAction(ctx, d2.id, '晚点').status).toBe('DELAYED');

    const standalone = createAction(ctx, { title: 'c', kind: 'DAILY' });
    expect(startAction(ctx, standalone.id).status).toBe('IN_PROGRESS');
  });

  it('DRAFT 任务完成时仍会取消其提醒', async () => {
    const { ctx } = env;
    const { createTodayPlan, completeAction } = await import('../../src/core/actions.js');
    const { createReminder, getReminder } = await import('../../src/reminder/service.js');

    const { actions } = createTodayPlan(ctx, { dailyActions: [{ title: 'd', basis: 'b' }] });
    const d = actions[0];
    const rem = createReminder(ctx, { actionId: d.id, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });

    completeAction(ctx, d.id);
    expect(getReminder(ctx, rem.id)!.status).toBe('CANCELLED');
  });
});

describe('缺陷 L：核心原则必须有结构性强制，不能只靠文档约定', () => {
  it('未完成 Onboarding 时 plan_today 必须返回 ONBOARDING_REQUIRED', () => {
    const env = testEnv();
    const { ctx } = env;
    // 完全没有 Profile
    let code = '';
    try {
      createTodayPlan(ctx, { dailyActions: [{ title: '随便来个任务' }] });
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    expect(code).toBe('ONBOARDING_REQUIRED');
  });

  it('Onboarding 仅 IN_PROGRESS 时同样拒绝', () => {
    const env = testEnv();
    const { ctx } = env;
    ensureProfile(ctx);
    updateProfile(ctx, { onboardingStatus: 'IN_PROGRESS' });
    expect(() => createTodayPlan(ctx, { dailyActions: [{ title: 'x' }] }))
      .toThrow(/Onboarding must be COMPLETED/);
  });

  it('有 Pending Replan 时不得创建新 Main Quest（REPLAN_REQUIRED）', () => {
    const env = testEnv();
    bootstrap(env);
    const { ctx } = env;
    const today = todayIn(ctx);
    const main = createAction(ctx, {
      title: '昨天没做完的主线', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 60, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);
    expect(getAction(ctx, main.id)!.status).toBe('PENDING_REPLAN');

    let code = '';
    try {
      createTodayPlan(ctx, {
        mainQuest: { title: '新主线', whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' },
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    expect(code).toBe('REPLAN_REQUIRED');
  });

  it('但有 Pending Replan 时仍允许只创建 Daily（Recovery Day 不该被堵死）', () => {
    const env = testEnv();
    bootstrap(env);
    const { ctx } = env;
    const today = todayIn(ctx);
    createAction(ctx, {
      title: 'm', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);

    const res = createTodayPlan(ctx, { dailyActions: [{ title: '散步', basis: '用户确认的运动方向' }] });
    expect(res.actions).toHaveLength(1);
  });
});

describe('缺陷 H：sync job 的 attempts 应表示"同步尝试次数"，不因状态变更重复累加', () => {
  it('一次成功同步后 attempts === 1', async () => {
    const env = testEnv();
    bootstrap(env);
    const { ctx } = env;
    const okAdapter: PassportSyncAdapter = { name: 'ok', async sync() { return true; } };

    await syncPassport(ctx, okAdapter);
    const jobs = listSyncJobs(ctx);
    expect(jobs[0].status).toBe('DONE');
    expect(jobs[0].attempts).toBe(1);
  });

  it('一次失败同步后 attempts === 1，重试后 === 2', async () => {
    const env = testEnv();
    bootstrap(env);
    const { ctx } = env;
    let calls = 0;
    const flaky: PassportSyncAdapter = {
      name: 'flaky',
      async sync() { calls++; return calls > 1; },
    };

    await syncPassport(ctx, flaky);
    expect(listSyncJobs(ctx)[0].attempts).toBe(1);

    const { retryPendingSyncs } = await import('../../src/passport/sync.js');
    await retryPendingSyncs(ctx, flaky);
    expect(listSyncJobs(ctx)[0].attempts).toBe(2);
    expect(listSyncJobs(ctx)[0].status).toBe('DONE');
  });
});
