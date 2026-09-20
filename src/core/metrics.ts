import type { CoreContext } from './context.js';
import { todayIn, resolveTimezone } from './profile.js';
import { localDateKey } from '../shared/time.js';

export interface GrowthMetrics {
  windowDays: number;
  completionRate: { main: number | null; daily: number | null };
  replanRate: number | null; // MAIN 需要重排的比例
  modificationRate: number | null; // plan 确认前被修改的比例（用 task_feedback 近似 + audit 计数）
  skipFeedbackDistribution: Record<string, number>;
  reminderResponse: { sent: number; followedByCompletion: number };
  acceptedSuggestionRate: number | null; // 计划未经修改即确认的比例
}

/** 本地指标（§30）。用于 Planner 改善，不是给用户打分。 */
export function computeMetrics(ctx: CoreContext, windowDays = 14): GrowthMetrics {
  const tz = resolveTimezone(ctx);
  const since = localDateKey(new Date(Date.now() - windowDays * 86400_000), tz);

  const count = (sql: string, ...params: unknown[]): number =>
    (ctx.db.prepare(sql).get(...params) as { n: number }).n;

  // 分母口径：窗口内所有"已实际排入计划"的 action（排除 DRAFT 草稿），
  // 分子：COMPLETED。MAIN 与 DAILY 使用同一口径，保证可比。
  const plannedFilter = `date_key >= ? AND deleted_at IS NULL AND status != 'DRAFT'`;

  const mainTotal = count(`SELECT COUNT(*) AS n FROM actions WHERE kind='MAIN_QUEST' AND ${plannedFilter}`, since);
  const mainDone = count(
    `SELECT COUNT(*) AS n FROM actions WHERE kind='MAIN_QUEST' AND ${plannedFilter} AND status='COMPLETED'`, since);
  const mainReplan = count(
    `SELECT COUNT(*) AS n FROM actions WHERE kind='MAIN_QUEST' AND ${plannedFilter}
     AND status IN ('PENDING_REPLAN','DELAYED')`, since);

  const dailyTotal = count(`SELECT COUNT(*) AS n FROM actions WHERE kind='DAILY' AND ${plannedFilter}`, since);
  const dailyDone = count(
    `SELECT COUNT(*) AS n FROM actions WHERE kind='DAILY' AND ${plannedFilter} AND status='COMPLETED'`, since);

  const feedbackRows = ctx.db
    .prepare(
      `SELECT tf.reason AS reason, COUNT(*) AS n FROM task_feedback tf
       JOIN actions a ON a.id = tf.action_id WHERE a.date_key >= ? GROUP BY tf.reason`
    )
    .all(since) as { reason: string; n: number }[];
  const skipFeedbackDistribution: Record<string, number> = {};
  for (const r of feedbackRows) skipFeedbackDistribution[r.reason] = r.n;

  // Accepted Suggestion Rate / Modification Rate 的分母必须是「已确认的计划」——
  // 尚未确认的计划不构成一次"用户是否接受 AI 建议"的样本，计入会稀释比例。
  const plansConfirmed = count(
    `SELECT COUNT(*) AS n FROM daily_plans WHERE date_key >= ? AND confirmed_at IS NOT NULL`, since);
  const plansConfirmedUnmodified = count(
    `SELECT COUNT(*) AS n FROM daily_plans p WHERE p.date_key >= ? AND p.confirmed_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM audit_log al WHERE al.entity_type='action'
       AND al.created_at < p.confirmed_at
       AND al.created_at > p.created_at
       AND al.reason LIKE 'agent update%'
     )`, since);
  const acceptedSuggestionRate = plansConfirmed > 0 ? plansConfirmedUnmodified / plansConfirmed : null;
  const modificationRate = acceptedSuggestionRate === null ? null : 1 - acceptedSuggestionRate;

  const sent = count(`SELECT COUNT(*) AS n FROM reminders WHERE status='SENT' AND fired_at >= ?`,
    new Date(Date.now() - windowDays * 86400_000).toISOString());
  const followed = count(
    `SELECT COUNT(*) AS n FROM reminders r JOIN actions a ON a.id = r.action_id
     WHERE r.status='SENT' AND r.fired_at >= ? AND a.status='COMPLETED'`,
    new Date(Date.now() - windowDays * 86400_000).toISOString());

  return {
    windowDays,
    completionRate: {
      main: mainTotal > 0 ? mainDone / mainTotal : null,
      daily: dailyTotal > 0 ? dailyDone / dailyTotal : null,
    },
    replanRate: mainTotal > 0 ? mainReplan / mainTotal : null,
    modificationRate,
    skipFeedbackDistribution,
    reminderResponse: { sent, followedByCompletion: followed },
    acceptedSuggestionRate,
  };
}

/** Planner 上下文打包：给 Agent 生成 Daily Plan 用的全部结构化输入（§10） */
export function plannerContext(ctx: CoreContext) {
  const today = todayIn(ctx);
  const yesterdayKeyRow = ctx.db
    .prepare(`SELECT MAX(date_key) AS k FROM actions WHERE date_key < ?`)
    .get(today) as { k: string | null };
  const yesterday = yesterdayKeyRow.k;
  const tz = resolveTimezone(ctx);
  return {
    today,
    timezone: tz,
    yesterdayActions: yesterday
      ? (ctx.db.prepare(`SELECT id, kind, title, status, date_key FROM actions WHERE date_key=? ORDER BY kind DESC`).all(yesterday) as Record<string, string>[])
      : [],
    recentEvidence: ctx.db
      .prepare(`SELECT id, type, strength, content, created_at FROM evidence ORDER BY created_at DESC LIMIT 10`)
      .all(),
    recentFeedback: ctx.db
      .prepare(`SELECT tf.reason, tf.comment, a.title FROM task_feedback tf JOIN actions a ON a.id=tf.action_id ORDER BY tf.created_at DESC LIMIT 10`)
      .all(),
    metrics: computeMetrics(ctx, 14),
  };
}
