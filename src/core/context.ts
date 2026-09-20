import type { DB } from '../db/client.js';
import { newId, ts } from '../shared/util.js';

export interface CoreContext {
  db: DB;
  /** 本地时区（自然日判断） */
  tz: string;
  /** 审计：谁触发 */
  actor: string;
}

export interface AuditEntry {
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export function writeAudit(ctx: CoreContext, entry: AuditEntry): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_log (id, actor, entity_type, entity_id, before, after, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId(),
      ctx.actor,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      ts()
    );
}
