import type { CoreContext } from './context.js';
import { newId, ts, pj } from '../shared/util.js';
import type { Memory } from './types.js';

type MemoryRow = {
  id: string; type: string; content: string; confidence: number; evidence_refs: string;
  confirmed_by_user: number; created_at: string; updated_at: string; deleted_at: string | null;
};

function rowToMemory(r: MemoryRow): Memory {
  return {
    id: r.id, type: r.type as Memory['type'], content: r.content, confidence: r.confidence,
    evidenceRefs: pj(r.evidence_refs, []), confirmedByUser: !!r.confirmed_by_user, createdAt: r.created_at,
  };
}

export interface AddMemoryInput {
  type: Memory['type'];
  content: string;
  confidence?: number; // 推断必须带 confidence（§7）
  evidenceRefs?: string[];
  confirmedByUser?: boolean;
}

/** 重要推断需用户确认后 confirmedByUser=1；不得把 AI 推断直接永久写成事实 */
export function addMemory(ctx: CoreContext, input: AddMemoryInput): Memory {
  const id = newId();
  const now = ts();
  const confidence = input.confidence ?? (input.confirmedByUser ? 1.0 : 0.5);
  ctx.db
    .prepare(
      `INSERT INTO memories (id, type, content, confidence, evidence_refs, confirmed_by_user, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      id, input.type, input.content, confidence, JSON.stringify(input.evidenceRefs ?? []),
      input.confirmedByUser ? 1 : 0, now, now
    );
  return getMemory(ctx, id)!;
}

export function getMemory(ctx: CoreContext, id: string): Memory | null {
  const r = ctx.db.prepare('SELECT * FROM memories WHERE id=? AND deleted_at IS NULL').get(id) as MemoryRow | undefined;
  return r ? rowToMemory(r) : null;
}

export function confirmMemory(ctx: CoreContext, id: string): Memory {
  ctx.db.prepare('UPDATE memories SET confirmed_by_user=1, confidence=1.0, updated_at=? WHERE id=?').run(ts(), id);
  return getMemory(ctx, id)!;
}

export function listMemories(ctx: CoreContext, opts: { type?: Memory['type']; limit?: number } = {}): Memory[] {
  const rows = opts.type
    ? ctx.db.prepare('SELECT * FROM memories WHERE deleted_at IS NULL AND type=? ORDER BY created_at DESC LIMIT ?').all(opts.type, opts.limit ?? 100)
    : ctx.db.prepare('SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?').all(opts.limit ?? 100);
  return (rows as MemoryRow[]).map(rowToMemory);
}

export function deleteMemory(ctx: CoreContext, id: string): void {
  ctx.db.prepare('UPDATE memories SET deleted_at=?, updated_at=? WHERE id=?').run(ts(), ts(), id);
}
