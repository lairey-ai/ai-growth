import { describe, it, expect, beforeEach } from 'vitest';
import { testEnv, type TestEnv } from '../helpers.js';
import { growthStatus, ensureProfile } from '../../src/core/status.js';
import { updateProfile, getProfile, todayIn } from '../../src/core/profile.js';
import {
  createGoalDraft, confirmGoal, activateGoal, createStagePlan, listStages, getGoal, getCurrentStage, listGoals,
} from '../../src/core/goals.js';
import { createTodayPlan, confirmTodayPlan, getTodayPlan, listActionsForDate } from '../../src/core/actions.js';
import { addDirection } from '../../src/core/directions.js';
import { makeCtx } from '../../src/mcp/ctx.js';
import { DomainError } from '../../src/shared/result.js';

describe('Scenario A：全新安装 → Onboarding 要求', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); });

  it('无 Profile 时 growth_status 提示需要 Onboarding，且不得创建随机任务', () => {
    const { ctx } = env;
    const st = growthStatus(ctx);
    expect(st.onboarding).toBe('NOT_STARTED');
    expect(st.suggestedNextOperation).toBe('START_ONBOARDING');
    expect(st.activeGoalCount).toBe(0);
    expect(st.todayPlanStatus).toBe('NOT_CREATED');
    // 空 DB：不应自动产生任何 action
    expect(listActionsForDate(ctx, todayIn(ctx))).toHaveLength(0);
  });

  it('Interview 未完成时状态为 IN_PROGRESS，完成后才 COMPLETED', () => {
    const { ctx } = env;
    ensureProfile(ctx);
    updateProfile(ctx, { onboardingStatus: 'IN_PROGRESS' });
    expect(growthStatus(ctx).onboarding).toBe('IN_PROGRESS');
    expect(growthStatus(ctx).suggestedNextOperation).toBe('CONTINUE_ONBOARDING');

    updateProfile(ctx, { onboardingStatus: 'COMPLETED', timePreferences: { preferredMainQuestWindow: '21:00' } });
    expect(growthStatus(ctx).onboarding).toBe('COMPLETED');
    expect(getProfile(ctx)!.timePreferences.preferredMainQuestWindow).toBe('21:00');
  });
});

describe('Scenario B：30 天学习 Goal 的完整建立流程', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); });

  it('Goal 必须包含 why / desiredOutcome / successCriteria', () => {
    const { ctx } = env;
    expect(() => createGoalDraft(ctx, { title: '学 Agent', why: '', desiredOutcome: 'x', successCriteria: ['y'] }))
      .toThrow(/must include why/);
    expect(() => createGoalDraft(ctx, { title: '学 Agent', why: 'w', desiredOutcome: '', successCriteria: ['y'] }))
      .toThrow(/desiredOutcome/);
    expect(() => createGoalDraft(ctx, { title: '学 Agent', why: 'w', desiredOutcome: 'o', successCriteria: [] }))
      .toThrow(/success criterion/);
  });

  it('DRAFT → CONFIRMED → ACTIVE，且只规划 Stage 不预生成每日任务', () => {
    const { ctx } = env;
    ensureProfile(ctx);
    updateProfile(ctx, { onboardingStatus: 'COMPLETED' });

    const goal = createGoalDraft(ctx, {
      title: '30 天掌握 Agent Engineering',
      why: '想独立做出能卖钱的 Agent 产品',
      desiredOutcome: '能独立设计并交付一个可运行的 Agent 应用',
      successCriteria: ['产出 1 个可运行 Agent 项目', '能解释 Tool Calling / Memory / MCP 原理'],
      targetDate: '2026-10-19',
      dailyTimeBudgetMinutes: 60,
    });
    expect(goal.status).toBe('DRAFT');

    // 未确认前不通过 growth_status 出现为活跃目标
    expect(growthStatus(ctx).activeGoalCount).toBe(0);

    const confirmed = confirmGoal(ctx, goal.id);
    expect(confirmed.status).toBe('CONFIRMED');

    const stages = createStagePlan(ctx, {
      goalId: goal.id,
      stages: [
        { title: 'Tool Calling 基础', objective: '理解并实现最小工具调用', exitCriteria: ['手写一个 tool 调用循环'] },
        { title: 'Memory', objective: '实现可读写的最小记忆', exitCriteria: ['demo 可持久化并召回'] },
        { title: 'MCP 集成', objective: '把能力暴露成 MCP tool', exitCriteria: ['外部 Agent 可调用'] },
      ],
    });
    expect(stages).toHaveLength(3);
    expect(stages[0].order).toBe(1);

    const active = activateGoal(ctx, goal.id);
    expect(active.status).toBe('ACTIVE');
    expect(growthStatus(ctx).activeGoalCount).toBe(1);
    expect(getCurrentStage(ctx, goal.id)!.title).toBe('Tool Calling 基础');

    // 关键：不预生成 30 天每日任务
    expect(listActionsForDate(ctx, todayIn(ctx))).toHaveLength(0);
    expect(growthStatus(ctx).suggestedNextOperation).toBe('RUN_DAILY_PLANNING');
  });

  it('重复创建 Stage Plan 被拒绝', () => {
    const { ctx } = env;
    const g = createGoalDraft(ctx, { title: 'g', why: 'w', desiredOutcome: 'o', successCriteria: ['c'] });
    createStagePlan(ctx, { goalId: g.id, stages: [{ title: 's1' }] });
    expect(() => createStagePlan(ctx, { goalId: g.id, stages: [{ title: 's2' }] }))
      .toThrow(DomainError);
  });
});

describe('Scenario C：正常 Daily Planning 的结构约束（§23）', () => {
  let env: TestEnv;
  let goalId: string;

  beforeEach(() => {
    env = testEnv();
    const { ctx } = env;
    ensureProfile(ctx);
    updateProfile(ctx, { onboardingStatus: 'COMPLETED' });
    const g = createGoalDraft(ctx, { title: '主线目标', why: 'w', desiredOutcome: 'o', successCriteria: ['c'] });
    confirmGoal(ctx, g.id);
    createStagePlan(ctx, { goalId: g.id, stages: [{ title: 'Stage 1', objective: 's1' }] });
    activateGoal(ctx, g.id);
    goalId = g.id;
    addDirection(ctx, { title: '保持运动习惯', domain: 'TRAIN', confirmed: true });
  });

  it('正常日：1 Main + 1~2 Daily，Main 必须含完成标准/预计耗时/whyToday', () => {
    const { ctx } = env;
    const { plan, actions } = createTodayPlan(ctx, {
      rationale: '继续 Stage 1 的最小可运行实现',
      mainQuest: {
        title: '实现最小 Tool Calling 循环',
        whyToday: 'Stage 1 的出口标准要求手写一次',
        estimatedMinutes: 60,
        completionCriteria: '本地跑通一次 tool 调用并打印结果',
        basisGoalId: goalId,
      },
      dailyActions: [{ title: '散步 30 分钟', basis: '用户确认的运动方向' }],
    });

    expect(plan.status).toBe('DRAFT');
    expect(actions.filter((a) => a.kind === 'MAIN_QUEST')).toHaveLength(1);
    expect(actions.filter((a) => a.kind === 'DAILY')).toHaveLength(1);

    const main = actions.find((a) => a.kind === 'MAIN_QUEST')!;
    expect(main.completionCriteria).toBeTruthy();
    expect(main.estimatedMinutes).toBe(60);
    expect(main.whyToday).toBeTruthy();

    const confirmed = confirmTodayPlan(ctx, plan.id);
    expect(confirmed.status).toBe('CONFIRMED');
    const after = getTodayPlan(ctx).actions;
    expect(after.every((a) => a.status === 'PLANNED')).toBe(true);
  });

  it('缺少完成标准 / 预计耗时 / whyToday 的 Main Quest 被拒绝', () => {
    const { ctx } = env;
    expect(() => createTodayPlan(ctx, {
      mainQuest: { title: 'x', whyToday: 'w', estimatedMinutes: 60, completionCriteria: '' },
    })).toThrow(/completion criteria/);

    expect(() => createTodayPlan(ctx, {
      mainQuest: { title: 'x', whyToday: 'w', estimatedMinutes: 0, completionCriteria: 'c' },
    })).toThrow(/estimated time/);

    expect(() => createTodayPlan(ctx, {
      mainQuest: { title: 'x', whyToday: '', estimatedMinutes: 60, completionCriteria: 'c' },
    })).toThrow(/whyToday/);
  });

  it('Daily 超过 2 个被拒绝；同一天重复建计划被拒绝', () => {
    const { ctx } = env;
    expect(() => createTodayPlan(ctx, {
      dailyActions: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    })).toThrow(/0~2/);

    createTodayPlan(ctx, { dailyActions: [{ title: 'a' }] });
    expect(() => createTodayPlan(ctx, { dailyActions: [{ title: 'b' }] })).toThrow(/already exists/);
  });

  it('可以有 Recovery Day：只有 Main 或只有 Daily 都允许', () => {
    const { ctx } = env;
    const { actions } = createTodayPlan(ctx, { dailyActions: [{ title: '休息' }] });
    expect(actions.filter((a) => a.kind === 'MAIN_QUEST')).toHaveLength(0);
    expect(actions.filter((a) => a.kind === 'DAILY')).toHaveLength(1);
  });
});

describe('Scenario J：Agent Handoff（§27）', () => {
  it('新 Agent 读取状态即可继续，不重复 Onboarding', () => {
    const env = testEnv();
    const { ctx, db, cfg } = env;
    ensureProfile(ctx);
    updateProfile(ctx, { onboardingStatus: 'COMPLETED' });
    const g = createGoalDraft(ctx, { title: '目标A', why: 'w', desiredOutcome: 'o', successCriteria: ['c'] });
    confirmGoal(ctx, g.id);
    createStagePlan(ctx, { goalId: g.id, stages: [{ title: 'Stage1' }, { title: 'Stage2' }] });
    activateGoal(ctx, g.id);

    // 新 Agent = 新 ctx（同一 DB）
    const fresh = makeCtx(db, cfg, 'other-agent');
    const st = growthStatus(fresh);
    expect(st.onboarding).toBe('COMPLETED');
    expect(st.activeGoalCount).toBe(1);
    expect(st.currentStageTitle).toBe('Stage1');
    expect(st.todayPlanStatus).toBe('NOT_CREATED');
    expect(st.suggestedNextOperation).toBe('RUN_DAILY_PLANNING');
  });

  it('已确认的 Goal 信息无需用户重复解释（可直接读取）', () => {
    const { ctx } = testEnv();
    const g = createGoalDraft(ctx, {
      title: '读透 X', why: '为了 Y', desiredOutcome: 'Z 能力', successCriteria: ['S1', 'S2'],
    });
    const loaded = getGoal(ctx, g.id)!;
    expect(loaded.why).toBe('为了 Y');
    expect(loaded.successCriteria).toEqual(['S1', 'S2']);
    expect(listGoals(ctx, ['DRAFT'])).toHaveLength(1);
    expect(listStages(ctx, g.id)).toHaveLength(0);
  });
});
