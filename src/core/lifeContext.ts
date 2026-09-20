import type { CoreContext } from './context.js';
import { newId, ts } from '../shared/util.js';
import { todayIn } from './profile.js';
import type { LifeContext, LifeContextMode } from './types.js';

export function getActiveLifeContext(ctx: CoreContext): LifeContext | null {
  const today = todayIn(ctx);
  // active 且窗口覆盖今天（无 end 或 end >= today）
  const r = ctx.db
    .prepare(
      `SELECT * FROM life_contexts WHERE active=1 AND start_date <= ?
       AND (expected_end_date IS NULL OR expected_end_date >= ?)
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(today, today) as LifeContextRow | undefined;
  return r ? rowToLifeContext(r) : null;
}

type LifeContextRow = {
  id: string; mode: string; available_minutes_per_day: number | null; start_date: string;
  expected_end_date: string | null; note: string | null; confirmed: number; active: number;
  created_at: string; updated_at: string;
};

function rowToLifeContext(r: LifeContextRow): LifeContext {
  return {
    id: r.id, mode: r.mode as LifeContextMode, availableMinutesPerDay: r.available_minutes_per_day ?? undefined,
    startDate: r.start_date, expectedEndDate: r.expected_end_date ?? undefined, note: r.note ?? undefined,
    confirmed: !!r.confirmed, active: !!r.active,
  };
}

export interface SetLifeContextInput {
  mode: LifeContextMode;
  availableMinutesPerDay?: number;
  startDate?: string; // date key，默认今天
  expectedEndDate?: string;
  note?: string;
  confirmed?: boolean;
}

/** 设置 LifeContext（§19）。同一时间仅一个 active；新的设置使旧的失效 */
export function setLifeContext(ctx: CoreContext, input: SetLifeContextInput): LifeContext {
  const now = ts();
  const id = newId();
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE life_contexts SET active=0, updated_at=? WHERE active=1').run(now);
    ctx.db
      .prepare(
        `INSERT INTO life_contexts (id, mode, available_minutes_per_day, start_date, expected_end_date, note, confirmed, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id, input.mode, input.availableMinutesPerDay ?? null, input.startDate ?? todayIn(ctx),
        input.expectedEndDate ?? null, input.note ?? null, input.confirmed === false ? 0 : 1, 1, now, now
      );
  });
  tx();
  return getActiveLifeContext(ctx)!;
}

/** LifeContext 到期检查：过期后返回 null（Agent 应主动询问是否恢复） */
export function deactivateExpiredLifeContexts(ctx: CoreContext): number {
  const today = todayIn(ctx);
  const res = ctx.db
    .prepare('UPDATE life_contexts SET active=0, updated_at=? WHERE active=1 AND expected_end_date IS NOT NULL AND expected_end_date < ?')
    .run(ts(), today);
  return res.changes;
}
