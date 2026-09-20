import type { CoreContext } from './context.js';
import { setSystemState, lastRolloverDate, todayIn } from './profile.js';
import { listOpenActionsBefore, expireActionInternal, markPendingReplanInternal } from './actions.js';
import { cancelRemindersByAction } from '../reminder/service.js';
import type { RolloverResult } from './rolloverTypes.js';

/**
 * Daily Rollover（§11 / §23.4）。必须幂等。
 *
 * 当检测日期从 D1 进入 D2：
 * 1. D1 未完成 DAILY → EXPIRED，取消未触发提醒
 * 2. D1 未完成 MAIN → PENDING_REPLAN，取消未触发提醒
 * 3. 不 clone 昨日任务到今天（Agent 在 daily planning 时按今天上下文重新创建）
 *
 * 幂等分两层：日期级（last_rollover_date）与 action 级（已是目标状态则跳过）。
 * 后者不可省：若某个 MAIN 连续多天未被 replan，它每天都会出现在开放集合中，
 * 而 `PENDING_REPLAN → PENDING_REPLAN` 是非法转换 —— 会抛错导致整个事务回滚，
 * 把系统永久卡在无法 rollover 的状态。
 */
export function runDailyRollover(ctx: CoreContext, todayArg?: string): RolloverResult {
  const today = todayArg ?? todayIn(ctx);
  const last = lastRolloverDate(ctx);
  if (last === today) {
    return { today, alreadyRan: true, expiredDailyActionIds: [], pendingReplanMainQuestIds: [], cancelledReminderCount: 0 };
  }

  const openBefore = listOpenActionsBefore(ctx, today);
  const expiredDailyActionIds: string[] = [];
  const pendingReplanMainQuestIds: string[] = [];
  let cancelledReminderCount = 0;

  const tx = ctx.db.transaction(() => {
    for (const action of openBefore) {
      if (action.kind === 'DAILY') {
        expireActionInternal(ctx, action.id);
        expiredDailyActionIds.push(action.id);
      } else if (action.status === 'PENDING_REPLAN') {
        // 已在等待 Replan：不再重复转换状态，只兜底清理提醒（action 级幂等）
        cancelledReminderCount += cancelRemindersByAction(ctx, action.id, 'daily rollover (already pending replan)');
        continue;
      } else {
        markPendingReplanInternal(ctx, action.id);
        pendingReplanMainQuestIds.push(action.id);
      }
      // rollover 专用：昨日未触发提醒一律取消（即使 action 状态已终态也兜底清理）
      cancelledReminderCount += cancelRemindersByAction(ctx, action.id, 'daily rollover');
    }
    setSystemState(ctx, 'last_rollover_date', today);
  });
  tx();

  return {
    today,
    alreadyRan: false,
    expiredDailyActionIds,
    pendingReplanMainQuestIds,
    cancelledReminderCount,
  };
}

/** 是否有等待处理的 Replan（growth_status / Agent Handoff 用） */
export function hasPendingReplan(ctx: CoreContext): boolean {
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM actions WHERE status='PENDING_REPLAN' AND deleted_at IS NULL`)
    .get() as { n: number };
  return row.n > 0;
}

export function listPendingReplanActions(ctx: CoreContext) {
  const rows = ctx.db
    .prepare(`SELECT * FROM actions WHERE status='PENDING_REPLAN' AND deleted_at IS NULL ORDER BY date_key`)
    .all() as { id: string; title: string; kind: string; date_key: string; goal_id?: string }[];
  return rows;
}
