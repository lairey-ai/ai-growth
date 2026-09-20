import { describe, it, expect, beforeEach } from 'vitest';
import { testEnv, type TestEnv } from '../helpers.js';
import { ensureProfile, updateProfile } from '../../src/core/profile.js';
import { createGoalDraft, confirmGoal, createStagePlan, activateGoal } from '../../src/core/goals.js';
import { growthStatus } from '../../src/core/status.js';

/**
 * growth_status 的「下一步该做什么」必须跟得上目标的流程。
 *
 * 这个字段是 Agent Handoff（SPEC §27）的关键：一个新 Agent 读它就知道该干嘛。
 *
 * 🔴 真机上踩过的坑（这组用例就是为它写的）：
 *   用户访谈做完了、目标也 CONFIRMED 了，但 status 仍然回 DISCUSS_GOAL ——
 *   因为判断只看 getActiveGoals()（仅 ACTIVE），DRAFT/CONFIRMED 都被当成"没有目标"。
 *   结果用户被卡在"目标明明有了，系统却说去聊目标"。
 *
 * 前半程有四种状态，必须各给各的下一步，不能笼统归成一句"去聊目标"：
 *   草稿待确认 → 排阶段 → 激活 → 每日计划
 */
describe('growth_status：下一步建议要跟得上目标流程', () => {
  let env: TestEnv;
  beforeEach(() => { env = testEnv(); });

  function profileDone() {
    ensureProfile(env.ctx);
    updateProfile(env.ctx, { onboardingStatus: 'COMPLETED' });
  }

  function draftGoal() {
    return createGoalDraft(env.ctx, {
      title: '目标', why: 'w', desiredOutcome: 'o', successCriteria: ['c'],
    });
  }

  function planStages(goalId: string) {
    createStagePlan(env.ctx, {
      goalId,
      stages: [
        { title: 'S1', objective: 'o1', plannedStartDate: '2026-09-01', plannedEndDate: '2026-09-30' },
      ],
    });
  }

  it('一个目标都没有 → DISCUSS_GOAL', () => {
    profileDone();
    expect(growthStatus(env.ctx).suggestedNextOperation).toBe('DISCUSS_GOAL');
  });

  it('只有草稿目标 → CONFIRM_GOAL（先确认，否则后面做什么都不作数）', () => {
    profileDone();
    draftGoal();
    expect(growthStatus(env.ctx).suggestedNextOperation).toBe('CONFIRM_GOAL');
  });

  it('★ 目标已确认、但还没排阶段 → CREATE_STAGE_PLAN（真机卡住用户的就是这个）', () => {
    profileDone();
    const g = draftGoal();
    confirmGoal(env.ctx, g.id);
    const s = growthStatus(env.ctx);
    // 字段语义保持不变：CONFIRMED ≠ ACTIVE，所以计数仍是 0
    expect(s.activeGoalCount).toBe(0);
    // 但「下一步」必须是排阶段，绝不能再回一句"去聊目标"
    expect(s.suggestedNextOperation).toBe('CREATE_STAGE_PLAN');
  });

  it('阶段排好了、但目标还没激活 → ACTIVATE_GOAL', () => {
    profileDone();
    const g = draftGoal();
    confirmGoal(env.ctx, g.id);
    planStages(g.id);
    expect(growthStatus(env.ctx).suggestedNextOperation).toBe('ACTIVATE_GOAL');
  });

  it('ACTIVE 目标 + 有阶段 + 今天还没有计划 → RUN_DAILY_PLANNING', () => {
    profileDone();
    const g = draftGoal();
    confirmGoal(env.ctx, g.id);
    planStages(g.id);
    activateGoal(env.ctx, g.id);
    expect(growthStatus(env.ctx).suggestedNextOperation).toBe('RUN_DAILY_PLANNING');
  });

  it('走完流程后 activeGoalCount 才为 1（字段语义不变）', () => {
    profileDone();
    const g = draftGoal();
    confirmGoal(env.ctx, g.id);
    planStages(g.id);
    activateGoal(env.ctx, g.id);
    expect(growthStatus(env.ctx).activeGoalCount).toBe(1);
  });
});
