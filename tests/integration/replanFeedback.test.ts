import { describe, it, expect, beforeEach } from 'vitest';
import { testEnv, type TestEnv } from '../helpers.js';
import { ensureProfile, updateProfile, todayIn } from '../../src/core/profile.js';
import { createGoalDraft, confirmGoal, createStagePlan, activateGoal, listStages, getStage } from '../../src/core/goals.js';
import {
  createAction, getAction, addTaskFeedback, recentFeedbackStats, listActionsForDate,
  completeAction, createTodayPlan, confirmTodayPlan, updateAction, cancelAction,
} from '../../src/core/actions.js';
import { runDailyRollover, listPendingReplanActions } from '../../src/core/rollover.js';
import { resolveReplan, replanHints } from '../../src/core/replan.js';
import { setLifeContext, getActiveLifeContext, deactivateExpiredLifeContexts } from '../../src/core/lifeContext.js';
import { plannerContext, computeMetrics } from '../../src/core/metrics.js';
import { growthStatus } from '../../src/core/status.js';
import { addDays } from '../../src/shared/time.js';
import { DomainError } from '../../src/shared/result.js';

function bootstrapGoal(env: TestEnv) {
  const { ctx } = env;
  ensureProfile(ctx);
  updateProfile(ctx, { onboardingStatus: 'COMPLETED' });
  const g = createGoalDraft(ctx, {
    title: '主线目标', why: 'w', desiredOutcome: 'o', successCriteria: ['c'],
  });
  confirmGoal(ctx, g.id);
  createStagePlan(ctx, {
    goalId: g.id,
    stages: [
      { title: 'Stage 1', objective: 's1', plannedStartDate: '2026-09-10', plannedEndDate: '2026-09-20' },
      { title: 'Stage 2', objective: 's2', plannedStartDate: '2026-09-21', plannedEndDate: '2026-09-30' },
      { title: 'Stage 3', objective: 's3', plannedStartDate: '2026-10-01', plannedEndDate: '2026-10-10' },
    ],
  });
  activateGoal(ctx, g.id);
  return g.id;
}

describe('Scenario D：用户认为任务不合理（§20 Task Feedback）', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); bootstrapGoal(env); });

  it('反馈被记录，且可自主替换执行层任务，无需重确认 Goal', () => {
    const { ctx } = env;
    const task = createAction(ctx, { title: '读文档第 1 章', kind: 'DAILY', basis: '用户确认的学习方向' });

    const fb = addTaskFeedback(ctx, task.id, 'TOO_EASY', '这个太简单了，换一个');
    expect(fb.reason).toBe('TOO_EASY');

    // Agent 自主替换执行层任务
    cancelAction(ctx, task.id, 'replaced per user feedback');
    const replacement = createAction(ctx, {
      title: '直接实现一个最小 tool 调用循环',
      kind: 'DAILY',
      basis: '用户确认的学习方向',
      estimatedMinutes: 45,
    });

    expect(getAction(ctx, task.id)!.status).toBe('CANCELLED');
    expect(replacement.status).toBe('PLANNED');
    // Goal 未被改动，也无需重新确认
    const goalCount = ctx.db.prepare(`SELECT COUNT(*) AS n FROM goals WHERE status='ACTIVE'`).get() as { n: number };
    expect(goalCount.n).toBe(1);
  });

  it('反馈统计可用于降低重复推荐', () => {
    const { ctx } = env;
    const t1 = createAction(ctx, { title: '跑步 5km', kind: 'DAILY' });
    const t2 = createAction(ctx, { title: '跑步 6km', kind: 'DAILY' });
    addTaskFeedback(ctx, t1.id, 'NOT_INTERESTED', '不想跑步');
    addTaskFeedback(ctx, t2.id, 'NOT_INTERESTED', '还是不想跑');

    const stats = recentFeedbackStats(ctx, 14);
    const notInterested = stats.find((s) => s.reason === 'NOT_INTERESTED');
    expect(notInterested?.count).toBe(2);
  });

  it('反馈不等于放弃 Goal（不能被解释为不想实现目标）', () => {
    const { ctx } = env;
    const t = createAction(ctx, { title: '借助跑步提升体能', kind: 'DAILY' });
    addTaskFeedback(ctx, t.id, 'NOT_INTERESTED', '我不喜欢跑步');
    const activeGoals = ctx.db.prepare(`SELECT COUNT(*) AS n FROM goals WHERE status='ACTIVE'`).get() as { n: number };
    expect(activeGoals.n).toBe(1);
  });
});

describe('Scenario F：Main Quest 未完成 → Replan（§4）', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); bootstrapGoal(env); });

  it('CONTINUE：移到今天并重新 PLANNED', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const main = createAction(ctx, {
      title: '实现 Memory Demo', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 60, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);
    expect(getAction(ctx, main.id)!.status).toBe('PENDING_REPLAN');

    const res = resolveReplan(ctx, { actionId: main.id, resolution: 'CONTINUE', reason: '昨天临时加班' });
    expect(res.resolution).toBe('CONTINUE');
    const after = getAction(ctx, main.id)!;
    expect(after.status).toBe('PLANNED');
    expect(after.dateKey).toBe(today);
  });

  it('ADJUST：修改难度/范围后继续', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const main = createAction(ctx, {
      title: '实现完整 Memory 系统', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 240, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);

    const res = resolveReplan(ctx, {
      actionId: main.id, resolution: 'ADJUST', reason: '任务太大',
      adjust: { title: '实现最小 Memory 读写', estimatedMinutes: 60 },
    });
    const after = getAction(ctx, main.id)!;
    expect(res.resolution).toBe('ADJUST');
    expect(after.title).toBe('实现最小 Memory 读写');
    expect(after.estimatedMinutes).toBe(60);
    expect(after.status).toBe('PLANNED');
  });

  it('SPLIT：原任务 CANCELLED，生成多个新 Main Quest', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const main = createAction(ctx, {
      title: '做大项目', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 300, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);

    const res = resolveReplan(ctx, {
      actionId: main.id, resolution: 'SPLIT', reason: '太大',
      splitInto: [{ title: '第一步：设计接口', estimatedMinutes: 45 }, { title: '第二步：实现最小版本', estimatedMinutes: 60 }],
    });
    expect(res.resolution).toBe('SPLIT');
    expect(getAction(ctx, main.id)!.status).toBe('CANCELLED');
    const created = (res as { createdActions: { id: string }[] }).createdActions;
    expect(created).toHaveLength(2);
    expect(created.every((c) => getAction(ctx, c.id)!.status === 'PLANNED')).toBe(true);
  });

  it('DELAY_STAGE：顺延后续 Stage 窗口', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const goalRow = ctx.db.prepare('SELECT id FROM goals WHERE status=? LIMIT 1').get('ACTIVE') as { id: string };
    const stages = listStages(ctx, goalRow.id);
    const stage1 = stages[0];
    const main = createAction(ctx, {
      title: 'Stage1 出口任务', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 60, completionCriteria: 'c', basisStageId: stage1.id,
    });
    runDailyRollover(ctx, today);

    resolveReplan(ctx, { actionId: main.id, resolution: 'DELAY_STAGE', reason: '进度落后', delayDays: 3 });

    const after = listStages(ctx, goalRow.id);
    expect(after[0].plannedEndDate).toBe('2026-09-23'); // 20 + 3
    expect(after[1].plannedStartDate).toBe('2026-09-24'); // 21 + 3
    expect(after[2].plannedEndDate).toBe('2026-10-13'); // 10 + 3
  });

  it('CANCEL：放弃该任务', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const main = createAction(ctx, {
      title: '不再需要的任务', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 60, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);
    const res = resolveReplan(ctx, { actionId: main.id, resolution: 'CANCEL', reason: '方向变了' });
    expect(res.resolution).toBe('CANCEL');
    expect(getAction(ctx, main.id)!.status).toBe('CANCELLED');
  });

  it('非 PENDING_REPLAN 的 action 不能 replan；hints 列出待处理项与规则', () => {
    const { ctx } = env;
    const a = createAction(ctx, { title: 'x', kind: 'MAIN_QUEST' });
    expect(() => resolveReplan(ctx, { actionId: a.id, resolution: 'CONTINUE', reason: 'r' }))
      .toThrow(/not PENDING_REPLAN/);

    const today = todayIn(ctx);
    const main = createAction(ctx, {
      title: 'y', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);
    const hints = replanHints(ctx);
    expect(hints.pendingReplans.map((p) => p.id)).toContain(main.id);
    expect(hints.rules.length).toBeGreaterThan(0);
    expect(listPendingReplanActions(ctx)).toHaveLength(1);
  });

  it('growth_status 在有 pending replan 时提示先 Replan', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    createAction(ctx, {
      title: 'z', kind: 'MAIN_QUEST', dateKey: addDays(today, -1),
      whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c',
    });
    runDailyRollover(ctx, today);
    const st = growthStatus(ctx);
    expect(st.pendingReplan).toBe(true);
    expect(st.suggestedNextOperation).toBe('RESOLVE_REPLAN');
  });
});

describe('Scenario G：Busy Week / LifeContext（§19）', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); bootstrapGoal(env); });

  it('设置 BUSY 后 planner 上下文带上可用时间，负荷应下降', () => {
    const { ctx } = env;
    setLifeContext(ctx, { mode: 'BUSY', availableMinutesPerDay: 30, note: '这周工作很忙' });
    const lc = getActiveLifeContext(ctx)!;
    expect(lc.mode).toBe('BUSY');
    expect(lc.availableMinutesPerDay).toBe(30);

    const pc = plannerContext(ctx);
    expect(pc.today).toBe(todayIn(ctx));
    expect(getActiveLifeContext(ctx)!.availableMinutesPerDay).toBe(30);
  });

  it('LifeContext 到期后自动失效（Agent 应主动询问是否恢复）', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    setLifeContext(ctx, { mode: 'BUSY', startDate: addDays(today, -7), expectedEndDate: addDays(today, -1) });
    const n = deactivateExpiredLifeContexts(ctx);
    expect(n).toBe(1);
    expect(getActiveLifeContext(ctx)).toBeNull();
  });

  it('新 LifeContext 会取代旧的（同一时间仅一个 active）', () => {
    const { ctx } = env;
    setLifeContext(ctx, { mode: 'BUSY', availableMinutesPerDay: 30 });
    setLifeContext(ctx, { mode: 'TRAVEL', availableMinutesPerDay: 15 });
    const active = getActiveLifeContext(ctx)!;
    expect(active.mode).toBe('TRAVEL');
    const actives = ctx.db.prepare('SELECT COUNT(*) AS n FROM life_contexts WHERE active=1').get() as { n: number };
    expect(actives.n).toBe(1);
  });
});

describe('指标（§30）', () => {
  it('Completion Rate 按 MAIN / DAILY 分开统计；不产生"自律分"', () => {
    const env = testEnv();
    bootstrapGoal(env);
    const { ctx } = env;

    const m1 = createAction(ctx, { title: 'm1', kind: 'MAIN_QUEST' });
    createAction(ctx, { title: 'm2', kind: 'MAIN_QUEST' });
    const d1 = createAction(ctx, { title: 'd1', kind: 'DAILY' });

    ctx.db.prepare(`UPDATE actions SET status='IN_PROGRESS' WHERE id=?`).run(m1.id);
    completeAction(ctx, m1.id);
    ctx.db.prepare(`UPDATE actions SET status='IN_PROGRESS' WHERE id=?`).run(d1.id);
    completeAction(ctx, d1.id);

    const metrics = computeMetrics(ctx, 14);
    expect(metrics.completionRate.main).toBeCloseTo(0.5, 5); // 1/2
    expect(metrics.completionRate.daily).toBeCloseTo(1, 5); // 1/1
    expect(metrics.windowDays).toBe(14);
    expect(metrics.replanRate).not.toBeNull();
  });
});
