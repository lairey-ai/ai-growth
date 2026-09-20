import type { CoreContext } from '../core/context.js';
import { newId, ts } from '../shared/util.js';
import { setSetting } from '../core/profile.js';

/** 标记 Passport dirty（§8：每日计划生成、Daily Review、重要 Evidence、Goal/Stage 变化后） */
export function flagPassportDirty(ctx: CoreContext, reason: string): void {
  const latest = ctx.db
    .prepare('SELECT id FROM passport_snapshots ORDER BY generated_at DESC LIMIT 1')
    .get() as { id: string } | undefined;
  if (latest) {
    ctx.db.prepare('UPDATE passport_snapshots SET dirty=1 WHERE id=?').run(latest.id);
  }
  setSetting(ctx, 'passport_dirty_reason', reason);
}

export function isPassportDirty(ctx: CoreContext): boolean {
  const latest = ctx.db
    .prepare('SELECT dirty FROM passport_snapshots ORDER BY generated_at DESC LIMIT 1')
    .get() as { dirty: number } | undefined;
  if (latest) return !!latest.dirty;
  // 尚无快照：若已有 growth 数据（evidence / growth event / goal），视为待生成
  const n = ctx.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM evidence) + (SELECT COUNT(*) FROM growth_events)
              + (SELECT COUNT(*) FROM goals WHERE deleted_at IS NULL) AS n`
    )
    .get() as { n: number };
  return n.n > 0;
}

export function saveSnapshot(ctx: CoreContext, passportJson: string): string {
  const id = newId();
  ctx.db
    .prepare('INSERT INTO passport_snapshots (id, passport, generated_at, dirty) VALUES (?,?,?,0)')
    .run(id, passportJson, ts());
  setSetting(ctx, 'passport_last_generated_at', ts());
  return id;
}

export function latestSnapshot(ctx: CoreContext): { id: string; passport: unknown; generatedAt: string; dirty: boolean } | null {
  const row = ctx.db
    .prepare('SELECT * FROM passport_snapshots ORDER BY generated_at DESC LIMIT 1')
    .get() as { id: string; passport: string; generated_at: string; dirty: number } | undefined;
  if (!row) return null;
  return { id: row.id, passport: JSON.parse(row.passport), generatedAt: row.generated_at, dirty: !!row.dirty };
}

// ---------- sync jobs（§29.1 失败进重试队列）----------

export function enqueueSyncJob(ctx: CoreContext, payload: Record<string, unknown>): string {
  // 幂等：已有 PENDING 同类 job 不重复创建
  const existing = ctx.db
    .prepare(`SELECT id FROM sync_jobs WHERE kind='PASSPORT_SYNC' AND status='PENDING'`)
    .get() as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId();
  const now = ts();
  ctx.db
    .prepare(`INSERT INTO sync_jobs (id, kind, payload, status, attempts, created_at, updated_at) VALUES (?,?,?,'PENDING',0,?,?)`)
    .run(id, 'PASSPORT_SYNC', JSON.stringify(payload), now, now);
  return id;
}

export function listSyncJobs(ctx: CoreContext, status?: string, limit = 20) {
  const rows = status
    ? ctx.db.prepare('SELECT * FROM sync_jobs WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : ctx.db.prepare('SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    status: r.status as string,
    attempts: r.attempts as number,
    lastError: (r.last_error as string) ?? undefined,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

/**
 * 更新 sync job 状态。
 * attempts 表示「实际发起同步的次数」，因此只在终态（DONE / FAILED）累加；
 * RUNNING 只是过程中的状态转移，不构成一次尝试。
 */
export function markSyncJob(ctx: CoreContext, id: string, status: 'DONE' | 'FAILED' | 'RUNNING', error?: string): void {
  const countsAsAttempt = status === 'DONE' || status === 'FAILED' ? 1 : 0;
  ctx.db
    .prepare(
      `UPDATE sync_jobs SET status=?, attempts=attempts + ?, last_error=?, updated_at=? WHERE id=?`
    )
    .run(status, countsAsAttempt, error ?? null, ts(), id);
}
