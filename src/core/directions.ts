import type { CoreContext } from './context.js';
import { newId, ts } from '../shared/util.js';
import { DomainError, ErrorCodes } from '../shared/result.js';
import type { ActionDomain } from './types.js';

type DirectionRow = {
  id: string; title: string; description: string | null; domain: string; origin: string;
  confirmed: number; created_at: string; updated_at: string; deleted_at: string | null;
};

/** Daily Action 只能来自用户明确认可过的方向 / 意图 / 约束（核心原则 7）。 */
export function listDirections(ctx: CoreContext, onlyConfirmed = true): DirectionRow[] {
  const rows = onlyConfirmed
    ? ctx.db.prepare('SELECT * FROM directions WHERE deleted_at IS NULL AND confirmed=1 ORDER BY created_at').all()
    : ctx.db.prepare('SELECT * FROM directions WHERE deleted_at IS NULL ORDER BY created_at').all();
  return rows as DirectionRow[];
}

export function addDirection(
  ctx: CoreContext,
  input: { title: string; description?: string; domain?: ActionDomain; confirmed?: boolean }
): DirectionRow {
  // 新增长期方向必须用户确认（V1.1 §17.4）；Agent 推断的只能作为 INFERRED 未确认
  const id = newId();
  const now = ts();
  ctx.db
    .prepare(
      `INSERT INTO directions (id, title, description, domain, origin, confirmed, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id, input.title, input.description ?? null, input.domain ?? 'OTHER',
      input.confirmed ? 'USER_CONFIRMED' : 'INFERRED', input.confirmed ? 1 : 0, now, now
    );
  return ctx.db.prepare('SELECT * FROM directions WHERE id=?').get(id) as DirectionRow;
}

export function confirmDirection(ctx: CoreContext, id: string): DirectionRow {
  const r = ctx.db.prepare('SELECT * FROM directions WHERE id=?').get(id) as DirectionRow | undefined;
  if (!r) throw new DomainError(ErrorCodes.NOT_FOUND, `Direction not found: ${id}`);
  ctx.db.prepare('UPDATE directions SET confirmed=1, origin=?, updated_at=? WHERE id=?').run('USER_CONFIRMED', ts(), id);
  return ctx.db.prepare('SELECT * FROM directions WHERE id=?').get(id) as DirectionRow;
}
