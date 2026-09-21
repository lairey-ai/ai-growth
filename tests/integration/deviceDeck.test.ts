import { describe, it, expect, beforeEach } from 'vitest';
import { testEnv, type TestEnv } from '../helpers.js';
import { ensureProfile, updateProfile, todayIn } from '../../src/core/profile.js';
import { createGoalDraft, confirmGoal, createStagePlan, activateGoal } from '../../src/core/goals.js';
import { createAction, cancelAction, skipAction, createTodayPlan, confirmTodayPlan } from '../../src/core/actions.js';
import { buildCardState, buildDeck } from '../../src/device/deck.js';

/**
 * 设备牌组只该收录「用户今天还能动手做」的条目。
 *
 * 🔴 真机上踩过：反复调整当天计划会留下 CANCELLED 的旧行，牌组把旧的也排进去，
 *   于是"今天应该有 2 件"在设备上变成 5 条；更糟的是卡片提示写着「确定 = 完成」，
 *   而取消/跳过的条目按下去会被状态机拒绝（用户只看到"操作失败"）。
 */
describe('设备牌组：终态条目不得进牌', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = testEnv();
    const { ctx } = env;
    ensureProfile(ctx);
    updateProfile(ctx, { onboardingStatus: 'COMPLETED' });
    const g = createGoalDraft(ctx, { title: '目标', why: 'w', desiredOutcome: 'o', successCriteria: ['c'] });
    confirmGoal(ctx, g.id);
    createStagePlan(ctx, {
      goalId: g.id,
      stages: [{ title: 'S1', objective: 'o', plannedStartDate: '2026-09-01', plannedEndDate: '2026-09-30' }],
    });
    activateGoal(ctx, g.id);
  });

  // 按真实 API 建计划：createTodayPlan 自己创建任务（getTodayPlan 只在有计划时才返回任务）
  function planTwo() {
    const { ctx } = env;
    const today = todayIn(ctx);
    createTodayPlan(ctx, {
      mainQuest: { title: '主线', kind: 'MAIN_QUEST', dateKey: today,
        whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' },
      dailyActions: [{ title: '小事', kind: 'DAILY', dateKey: today }],
    });
    confirmTodayPlan(ctx);
  }

  it('正常情况：2 件任务 → 总览 + 2 张任务卡 = 3 张', () => {
    planTwo();
    const st = buildCardState(env.ctx);
    expect(st.total).toBe(2);
    expect(buildDeck(st).length).toBe(3);
  });

  it('★ 已取消的任务不进牌组（真机上"应该有 2 件却显示 5 条"就是它）', () => {
    planTwo();
    // 模拟"反复调整当天计划"：旧条目被取消，同样内容的新条目才是有效的
    const today = todayIn(env.ctx);
    for (const a of [
      createAction(env.ctx, { title: '主线（旧）', kind: 'MAIN_QUEST', dateKey: today,
        whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' }),
      createAction(env.ctx, { title: '小事（旧）', kind: 'DAILY', dateKey: today }),
      createAction(env.ctx, { title: '小事（更旧）', kind: 'DAILY', dateKey: today }),
    ]) cancelAction(env.ctx, a.id, '调整计划');

    const st = buildCardState(env.ctx);
    expect(st.items.every((i) => i.status !== 'CANCELLED')).toBe(true);
    expect(st.total).toBe(2);                 // 只剩 2 件有效的
    expect(buildDeck(st).length).toBe(3);     // 总览 + 2 张
  });

  it('已跳过的任务也不进牌组（否则按确定会被状态机拒绝）', () => {
    planTwo();
    const today = todayIn(env.ctx);
    const skipped = createAction(env.ctx, { title: '跳过的', kind: 'DAILY', dateKey: today });
    skipAction(env.ctx, skipped.id, '今天不做');
    const st = buildCardState(env.ctx);
    expect(st.items.some((i) => i.status === 'SKIPPED')).toBe(false);
    expect(st.total).toBe(2);
  });
});
