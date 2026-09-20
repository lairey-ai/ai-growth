import { describe, it, expect } from 'vitest';
import { testEnv } from '../helpers.js';
import { createAction, getAction, startAction, delayAction } from '../../src/core/actions.js';
import { runDailyRollover } from '../../src/core/rollover.js';
import { todayIn } from '../../src/core/profile.js';
import { addDays } from '../../src/shared/time.js';

/**
 * 回归测试：rollover 必须能处理"非 PLANNED 的开放状态"。
 * 真实使用中用户会「开始做但没做完」(IN_PROGRESS) 或「主动延期」(DELAYED)，
 * 这些 action 次日同样必须被正确终结，且不能让 rollover 抛异常。
 */
describe('回归：rollover 处理 IN_PROGRESS / DELAYED 的跨天 action', () => {
  it('IN_PROGRESS 的 Daily（开始了没做完）次日应 EXPIRED', () => {
    const env = testEnv();
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const a = createAction(ctx, { title: '写了一半的活', kind: 'DAILY', dateKey: yesterday });
    startAction(ctx, a.id); // PLANNED → IN_PROGRESS
    expect(getAction(ctx, a.id)!.status).toBe('IN_PROGRESS');

    runDailyRollover(ctx, today);
    expect(getAction(ctx, a.id)!.status).toBe('EXPIRED');
  });

  it('DELAYED 的 Daily 次日应 EXPIRED', () => {
    const env = testEnv();
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const a = createAction(ctx, { title: '被延期的散步', kind: 'DAILY', dateKey: yesterday });
    delayAction(ctx, a.id, '今天太忙');
    expect(getAction(ctx, a.id)!.status).toBe('DELAYED');

    runDailyRollover(ctx, today);
    expect(getAction(ctx, a.id)!.status).toBe('EXPIRED');
  });

  it('IN_PROGRESS 的 Main Quest 次日应 PENDING_REPLAN', () => {
    const env = testEnv();
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const a = createAction(ctx, {
      title: '做了一半的主线', kind: 'MAIN_QUEST', dateKey: yesterday,
      whyToday: 'w', estimatedMinutes: 60, completionCriteria: 'c',
    });
    startAction(ctx, a.id);

    runDailyRollover(ctx, today);
    expect(getAction(ctx, a.id)!.status).toBe('PENDING_REPLAN');
  });

  it('已 PENDING_REPLAN 的 Main Quest 再次跨天不得让 rollover 崩（连续多天未处理）', () => {
    const env = testEnv();
    const { ctx } = env;
    const today = todayIn(ctx);
    const d1 = addDays(today, -3);
    const d2 = addDays(today, -2);
    const d3 = addDays(today, -1);

    const a = createAction(ctx, {
      title: '一直没处理的主线', kind: 'MAIN_QUEST', dateKey: d1,
      whyToday: 'w', estimatedMinutes: 60, completionCriteria: 'c',
    });

    // D2 第一次 rollover → PENDING_REPLAN
    expect(() => runDailyRollover(ctx, d2)).not.toThrow();
    expect(getAction(ctx, a.id)!.status).toBe('PENDING_REPLAN');

    // D3 rollover：该 action 仍在开放集合中且已是 PENDING_REPLAN
    expect(() => runDailyRollover(ctx, d3)).not.toThrow();
    expect(getAction(ctx, a.id)!.status).toBe('PENDING_REPLAN');

    // 今天 rollover：仍不能崩
    expect(() => runDailyRollover(ctx, today)).not.toThrow();
    expect(getAction(ctx, a.id)!.status).toBe('PENDING_REPLAN');
  });

  it('混合状态的昨日任务：rollover 一次全部正确处理，不因单个异常整体回滚', () => {
    const env = testEnv();
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const dailyPlanned = createAction(ctx, { title: 'd1', kind: 'DAILY', dateKey: yesterday });
    const dailyInProgress = createAction(ctx, { title: 'd2', kind: 'DAILY', dateKey: yesterday });
    startAction(ctx, dailyInProgress.id);
    const dailyDelayed = createAction(ctx, { title: 'd3', kind: 'DAILY', dateKey: yesterday });
    delayAction(ctx, dailyDelayed.id, 'later');
    const mainInProgress = createAction(ctx, {
      title: 'm1', kind: 'MAIN_QUEST', dateKey: yesterday,
      whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c',
    });
    startAction(ctx, mainInProgress.id);

    const r = runDailyRollover(ctx, today);

    expect(getAction(ctx, dailyPlanned.id)!.status).toBe('EXPIRED');
    expect(getAction(ctx, dailyInProgress.id)!.status).toBe('EXPIRED');
    expect(getAction(ctx, dailyDelayed.id)!.status).toBe('EXPIRED');
    expect(getAction(ctx, mainInProgress.id)!.status).toBe('PENDING_REPLAN');
    expect(r.expiredDailyActionIds).toHaveLength(3);
    expect(r.pendingReplanMainQuestIds).toHaveLength(1);
  });
});
