import type { CoreContext } from '../core/context.js';
import { writeAudit } from '../core/context.js';
import { newId, ts } from '../shared/util.js';
import { DomainError, ErrorCodes } from '../shared/result.js';
import { todayIn } from '../core/profile.js';
import type { Reminder } from '../core/types.js';

type ReminderRow = {
  id: string; action_id: string; scheduled_at: string; status: string;
  channel: string; fired_at: string | null; cancelled_at: string | null;
  created_at: string; updated_at: string;
};

function rowToReminder(r: ReminderRow): Reminder {
  return {
    id: r.id, actionId: r.action_id, scheduledAt: r.scheduled_at,
    status: r.status as Reminder['status'], channel: r.channel as Reminder['channel'],
    firedAt: r.fired_at ?? undefined, cancelledAt: r.cancelled_at ?? undefined,
  };
}

export interface CreateReminderInput {
  actionId: string;
  scheduledAt: string; // ISO timestamp
  channel?: Reminder['channel'];
  /** 跳过 "Daily 最多 1 次主动提醒" 约束（Main Quest 多提醒） */
  allowMultiple?: boolean;
}

/**
 * 提醒创建（V1.1 §24）：
 * - Reminder 与 Action 生命周期绑定
 * - 默认每个 DAILY action 最多 1 个未触发提醒
 */
export function createReminder(ctx: CoreContext, input: CreateReminderInput): Reminder {
  const action = ctx.db.prepare('SELECT id, date_key, status FROM actions WHERE id=?').get(input.actionId) as
    | { id: string; date_key: string; status: string }
    | undefined;
  if (!action) throw new DomainError(ErrorCodes.NOT_FOUND, `Action not found: ${input.actionId}`);
  if (['COMPLETED', 'SKIPPED', 'CANCELLED', 'EXPIRED'].includes(action.status)) {
    throw new DomainError(ErrorCodes.INVALID_STATE, `Cannot create reminder for action in status ${action.status}`);
  }
  const kind = ctx.db.prepare('SELECT kind FROM actions WHERE id=?').get(input.actionId) as { kind: string };
  if (kind.kind === 'DAILY' && !input.allowMultiple) {
    const existing = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM reminders WHERE action_id=? AND status='SCHEDULED'`)
      .get(input.actionId) as { n: number };
    if (existing.n >= 1) {
      throw new DomainError(
        ErrorCodes.INVALID_STATE,
        'Daily action already has 1 scheduled reminder (V1.1 §24 max rule). Pass allowMultiple or update the existing one.'
      );
    }
  }
  const id = newId();
  const now = ts();
  ctx.db
    .prepare(
      `INSERT INTO reminders (id, action_id, scheduled_at, status, channel, created_at, updated_at)
       VALUES (?,?,?,'SCHEDULED',?,?,?)`
    )
    .run(id, input.actionId, input.scheduledAt, input.channel ?? 'LOCAL_NOTIFICATION', now, now);
  const rem = getReminder(ctx, id)!;
  writeAudit(ctx, { entityType: 'reminder', entityId: id, after: rem, reason: 'create reminder' });
  return rem;
}

export function getReminder(ctx: CoreContext, id: string): Reminder | null {
  const row = ctx.db.prepare('SELECT * FROM reminders WHERE id=?').get(id) as ReminderRow | undefined;
  return row ? rowToReminder(row) : null;
}

export function updateReminder(ctx: CoreContext, id: string, scheduledAt: string): Reminder {
  const before = getReminder(ctx, id);
  if (!before) throw new DomainError(ErrorCodes.NOT_FOUND, `Reminder not found: ${id}`);
  if (before.status !== 'SCHEDULED')
    throw new DomainError(ErrorCodes.INVALID_STATE, `Cannot update reminder in status ${before.status}`);
  ctx.db.prepare('UPDATE reminders SET scheduled_at=?, updated_at=? WHERE id=?').run(scheduledAt, ts(), id);
  return getReminder(ctx, id)!;
}

export function cancelReminder(ctx: CoreContext, id: string, reason = 'cancelled'): Reminder {
  const before = getReminder(ctx, id);
  if (!before) throw new DomainError(ErrorCodes.NOT_FOUND, `Reminder not found: ${id}`);
  if (before.status !== 'SCHEDULED') return before; // 幂等
  ctx.db
    .prepare(`UPDATE reminders SET status='CANCELLED', cancelled_at=?, updated_at=? WHERE id=?`)
    .run(ts(), ts(), id);
  const after = getReminder(ctx, id)!;
  writeAudit(ctx, { entityType: 'reminder', entityId: id, before, after, reason });
  return after;
}

/** 取消某 action 全部未触发提醒（幂等） */
export function cancelRemindersByAction(ctx: CoreContext, actionId: string, reason: string): number {
  const now = ts();
  const res = ctx.db
    .prepare(`UPDATE reminders SET status='CANCELLED', cancelled_at=?, updated_at=? WHERE action_id=? AND status='SCHEDULED'`)
    .run(now, now, actionId);
  if (res.changes > 0) {
    writeAudit(ctx, { entityType: 'reminder', entityId: actionId, after: { cancelled: res.changes }, reason });
  }
  return res.changes;
}

export function listRemindersForDate(ctx: CoreContext, dateKey?: string): Reminder[] {
  const key = dateKey ?? todayIn(ctx);
  // dateKey 是自然日；scheduled_at 是 ISO。取 [key 00:00, key+1 00:00) 区间在 tz 下的提醒
  const rows = ctx.db
    .prepare(
      `SELECT r.* FROM reminders r JOIN actions a ON a.id = r.action_id
       WHERE a.date_key = ? AND r.status != 'CANCELLED' ORDER BY r.scheduled_at`
    )
    .all(key) as ReminderRow[];
  return rows.map(rowToReminder);
}

/** 到期待触发提醒（Scheduler 轮询用，幂等：SCHEDULED 且 scheduled_at <= now） */
export function listDueReminders(ctx: CoreContext, nowIsoStr = ts()): Reminder[] {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM reminders WHERE status='SCHEDULED' AND scheduled_at <= ?
       ORDER BY scheduled_at LIMIT 50`
    )
    .all(nowIsoStr) as ReminderRow[];
  return rows.map(rowToReminder);
}

export function markReminderSent(ctx: CoreContext, id: string, firedAt?: string): Reminder {
  ctx.db
    .prepare(`UPDATE reminders SET status='SENT', fired_at=?, updated_at=? WHERE id=? AND status='SCHEDULED'`)
    .run(firedAt ?? ts(), ts(), id);
  return getReminder(ctx, id)!;
}
