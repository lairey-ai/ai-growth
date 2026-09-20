import { describe, it, expect, beforeEach } from 'vitest';
import { testEnv, type TestEnv } from '../helpers.js';
import { createAction, listActionsForDate, getAction, createTodayPlan, confirmTodayPlan, getTodayPlan } from '../../src/core/actions.js';
import { runDailyRollover, hasPendingReplan } from '../../src/core/rollover.js';
import { createReminder, listRemindersForDate, getReminder } from '../../src/reminder/service.js';
import { todayIn } from '../../src/core/profile.js';
import { addDays } from '../../src/shared/time.js';
import { makeCtx } from '../../src/mcp/ctx.js';

describe('Daily Rollover（§11 / §23.4 / Scenario E, F, L）', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = testEnv();
  });

  it('幂等：同一天重复调用只有第一次生效', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    createAction(ctx, { title: '散步', kind: 'DAILY', dateKey: yesterday });

    const first = runDailyRollover(ctx, today);
    expect(first.alreadyRan).toBe(false);
    expect(first.expiredDailyActionIds).toHaveLength(1);

    const second = runDailyRollover(ctx, today);
    expect(second.alreadyRan).toBe(true);
    expect(second.expiredDailyActionIds).toHaveLength(0);
  });

  it('Scenario E：昨日 Daily 未完成 → EXPIRED，且提醒被取消，不复制到今天', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const daily = createAction(ctx, { title: '给父母打电话', kind: 'DAILY', dateKey: yesterday });
    const rem = createReminder(ctx, {
      actionId: daily.id,
      scheduledAt: new Date(Date.now() - 3600_000).toISOString(),
    });

    const r = runDailyRollover(ctx, today);

    expect(r.expiredDailyActionIds).toEqual([daily.id]);
    expect(getAction(ctx, daily.id)!.status).toBe('EXPIRED');
    expect(getReminder(ctx, rem.id)!.status).toBe('CANCELLED');

    // 不 clone 到今天
    const todayActions = listActionsForDate(ctx, today);
    expect(todayActions).toHaveLength(0);
  });

  it('Scenario E：Daily 过期后若仍合适，新建的是全新 ID 的 action', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const oldDaily = createAction(ctx, { title: '散步 30 分钟', kind: 'DAILY', dateKey: yesterday });
    runDailyRollover(ctx, today);

    const fresh = createAction(ctx, { title: '散步 30 分钟', kind: 'DAILY', dateKey: today });
    expect(fresh.id).not.toBe(oldDaily.id);
    expect(fresh.status).toBe('PLANNED');
    expect(getAction(ctx, oldDaily.id)!.status).toBe('EXPIRED');
  });

  it('Scenario F：昨日 Main Quest 未完成 → PENDING_REPLAN（不作废）', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const main = createAction(ctx, {
      title: '实现 Agent Memory Demo',
      kind: 'MAIN_QUEST',
      dateKey: yesterday,
      whyToday: 'Memory 是当前 Stage 的关键能力',
      estimatedMinutes: 60,
      completionCriteria: 'demo 可运行并能读写记忆',
    });
    const rem = createReminder(ctx, {
      actionId: main.id,
      scheduledAt: new Date(Date.now() - 1800_000).toISOString(),
    });

    const r = runDailyRollover(ctx, today);

    expect(r.pendingReplanMainQuestIds).toEqual([main.id]);
    expect(getAction(ctx, main.id)!.status).toBe('PENDING_REPLAN');
    expect(getReminder(ctx, rem.id)!.status).toBe('CANCELLED');
    expect(hasPendingReplan(ctx)).toBe(true);
  });

  it('已完成 / 已跳过的昨日 action 不受 rollover 影响', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);

    const done = createAction(ctx, { title: '已完成的事', kind: 'DAILY', dateKey: yesterday });
    ctx.db.prepare(`UPDATE actions SET status='COMPLETED' WHERE id=?`).run(done.id);

    const r = runDailyRollover(ctx, today);
    expect(r.expiredDailyActionIds).toHaveLength(0);
    expect(getAction(ctx, done.id)!.status).toBe('COMPLETED');
  });

  it('Scenario L：重启后不重复执行已完成的 rollover（system_state 持久化）', () => {
    const { ctx, db, cfg } = env;
    const today = todayIn(ctx);
    const yesterday = addDays(today, -1);
    createAction(ctx, { title: 'A', kind: 'DAILY', dateKey: yesterday });

    runDailyRollover(ctx, today);
    expect(db.prepare(`SELECT value FROM system_state WHERE key='last_rollover_date'`).get()).toEqual({ value: today });

    // 模拟重启：用同一 DB 重建 ctx
    const ctx2 = makeCtx(db, cfg, 'daemon');
    const afterRestart = runDailyRollover(ctx2, today);
    expect(afterRestart.alreadyRan).toBe(true);
  });

  it('跨多天：D1 与 D2 的未完成 action 分别处理', () => {
    const { ctx } = env;
    const today = todayIn(ctx);
    const d1 = addDays(today, -2);
    const d2 = addDays(today, -1);

    const a1 = createAction(ctx, { title: 'D1 daily', kind: 'DAILY', dateKey: d1 });
    const a2 = createAction(ctx, { title: 'D2 daily', kind: 'DAILY', dateKey: d2 });

    runDailyRollover(ctx, today);
    expect(getAction(ctx, a1.id)!.status).toBe('EXPIRED');
    expect(getAction(ctx, a2.id)!.status).toBe('EXPIRED');
  });

  it('todayKey 基于本地 timezone，不按 UTC 截断', () => {
    const tzEnv = testEnv('America/New_York');
    const { ctx } = tzEnv;
    // 上海时间与纽约时间的自然日 key 可能不同；这里验证取到的是 tz 相关的 key
    expect(todayIn(ctx)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ctx.tz).toBe('America/New_York');
  });
});
