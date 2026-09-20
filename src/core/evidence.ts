import type { CoreContext } from './context.js';
import { writeAudit } from './context.js';
import { newId, ts, pj } from '../shared/util.js';
import { DomainError, ErrorCodes } from '../shared/result.js';
import { todayIn, resolveTimezone } from './profile.js';
import { startOfDateKey } from '../shared/time.js';
import { flagPassportDirty } from '../passport/state.js';
import type { ActionDomain, AssessmentLevel, Evidence, EvidenceStrength, EvidenceType, GrowthEvent } from './types.js';

type EvidenceRow = {
  id: string; action_id: string | null; type: string; strength: string; content: string;
  metadata: string; created_at: string;
};

function rowToEvidence(r: EvidenceRow): Evidence {
  return {
    id: r.id, actionId: r.action_id ?? undefined, type: r.type as EvidenceType,
    strength: r.strength as EvidenceStrength, content: r.content,
    metadata: pj(r.metadata, {}), createdAt: r.created_at,
  };
}

export interface AddEvidenceInput {
  actionId?: string;
  type: EvidenceType;
  strength?: EvidenceStrength;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * 记录 Evidence。UNVERIFIED 证据不能用于自动宣布完成关键目标（调用方约束），
 * 自动验证类（GIT/METRIC/QUIZ 结果）默认 AUTO_VERIFIED。
 */
export function addEvidence(ctx: CoreContext, input: AddEvidenceInput): Evidence {
  if (!input.content?.trim()) throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Evidence content is required');
  const id = newId();
  const strength: EvidenceStrength =
    input.strength ??
    (['GIT', 'METRIC', 'QUIZ', 'ARTIFACT'].includes(input.type) ? 'AUTO_VERIFIED' : 'USER_CONFIRMED');
  ctx.db
    .prepare(
      `INSERT INTO evidence (id, action_id, type, strength, content, metadata, created_at)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, input.actionId ?? null, input.type, strength, input.content.trim(), JSON.stringify(input.metadata ?? {}), ts());
  const ev = ctx.db.prepare('SELECT * FROM evidence WHERE id=?').get(id) as EvidenceRow;
  flagPassportDirty(ctx, 'evidence added');
  return rowToEvidence(ev);
}

export interface ListEvidenceFilters {
  actionId?: string;
  sinceDateKey?: string;
  type?: EvidenceType;
  strength?: EvidenceStrength;
  limit?: number;
}

export function listEvidence(ctx: CoreContext, filters: ListEvidenceFilters = {}): Evidence[] {
  const conds: string[] = ['1=1'];
  const params: unknown[] = [];
  if (filters.actionId) { conds.push('e.action_id = ?'); params.push(filters.actionId); }
  if (filters.type) { conds.push('e.type = ?'); params.push(filters.type); }
  if (filters.strength) { conds.push('e.strength = ?'); params.push(filters.strength); }
  if (filters.sinceDateKey) {
    // 必须按"证据自身产生时间"过滤，而不是它挂靠 action 的 date_key：
    // 跨天完成的旧任务，其证据属于记录当天；无 action 的证据（评估/反思）同样要计入。
    // created_at 是 UTC ISO，自然日边界需按配置时区换算。
    conds.push('e.created_at >= ?');
    params.push(startOfDateKey(filters.sinceDateKey, resolveTimezone(ctx)).toISOString());
  }
  const limit = Math.min(filters.limit ?? 100, 500);
  const rows = ctx.db
    .prepare(`SELECT e.* FROM evidence e WHERE ${conds.join(' AND ')} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ${limit}`)
    .all(...(params as string[])) as EvidenceRow[];
  return rows.map(rowToEvidence);
}

// ---------- assessments（§22 学习验收模型）----------

export interface CreateAssessmentInput {
  actionId?: string;
  goalId?: string;
  topic: string;
  method?: string; // explain | quiz | coding-challenge | practical | mini-project | real-project
}

export function createAssessment(ctx: CoreContext, input: CreateAssessmentInput): { id: string; topic: string } {
  const id = newId();
  const now = ts();
  // 新建评估处于 EXPOSURE（刚接触），提交结果时升级
  ctx.db
    .prepare(`INSERT INTO assessments (id, action_id, goal_id, topic, level, method, passed, result, created_at, updated_at)
              VALUES (?,?,?,?,'EXPOSURE',?,0,'{}',?,?)`)
    .run(id, input.actionId ?? null, input.goalId ?? null, input.topic, input.method ?? null, now, now);
  return { id, topic: input.topic };
}

export interface SubmitAssessmentInput {
  id: string;
  passed: boolean;
  level: AssessmentLevel;
  result?: Record<string, unknown>;
}

/**
 * 提交评估结果。规则（§22）：
 * - Quiz 高分不等于完全掌握；level 由 Agent 按表现判定
 * - 未通过 → 不升级 Knowledge State（返回给 Agent 决定重规划）
 */
export function submitAssessment(ctx: CoreContext, input: SubmitAssessmentInput): {
  assessment: { id: string; topic: string; level: AssessmentLevel; passed: boolean };
  knowledgeStateUpdated: boolean;
} {
  const row = ctx.db.prepare('SELECT * FROM assessments WHERE id=?').get(input.id) as
    | { id: string; topic: string; passed: number }
    | undefined;
  if (!row) throw new DomainError(ErrorCodes.NOT_FOUND, `Assessment not found: ${input.id}`);
  const passed = !!input.passed;
  ctx.db
    .prepare('UPDATE assessments SET passed=?, level=?, result=?, updated_at=? WHERE id=?')
    .run(passed ? 1 : 0, input.level, JSON.stringify({ ...(input.result ?? {}), level: input.level, passed }), ts(), input.id);
  // 评估本身也是 evidence（QUIZ 类型）
  addEvidence(ctx, {
    type: 'QUIZ',
    strength: passed ? 'AUTO_VERIFIED' : 'UNVERIFIED',
    content: `Assessment "${row.topic}": ${input.level} ${passed ? 'PASSED' : 'FAILED'}`,
    metadata: { assessmentId: input.id, level: input.level },
  });
  return {
    assessment: { id: input.id, topic: row.topic, level: input.level, passed },
    knowledgeStateUpdated: passed,
  };
}

export function listAssessments(ctx: CoreContext, goalId?: string, limit = 50) {
  const rows = goalId
    ? ctx.db.prepare('SELECT * FROM assessments WHERE goal_id=? ORDER BY created_at DESC LIMIT ?').all(goalId, limit)
    : ctx.db.prepare('SELECT * FROM assessments ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    topic: r.topic as string,
    method: (r.method as string) ?? undefined,
    level: r.level as AssessmentLevel,
    passed: !!r.passed,
    createdAt: r.created_at as string,
  }));
}

// ---------- growth events（§6：只在有意义的真实行动后创建）----------

export interface CreateGrowthEventInput {
  title: string;
  description?: string;
  domain?: ActionDomain;
  evidenceIds: string[];
  goalId?: string;
  stageId?: string;
  tags?: string[];
  dateKey?: string;
}

export function createGrowthEvent(ctx: CoreContext, input: CreateGrowthEventInput): GrowthEvent {
  if (!input.evidenceIds?.length) {
    throw new DomainError(
      ErrorCodes.VALIDATION_ERROR,
      'Growth Event requires at least one evidence id (no evidence-free personality judgments)'
    );
  }
  const id = newId();
  const dateKey = input.dateKey ?? todayIn(ctx);
  ctx.db
    .prepare(
      `INSERT INTO growth_events (id, date_key, title, description, domain, evidence_ids, goal_id, stage_id, tags, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, dateKey, input.title, input.description ?? null, input.domain ?? 'OTHER',
      JSON.stringify(input.evidenceIds), input.goalId ?? null, input.stageId ?? null,
      JSON.stringify(input.tags ?? []), ts()
    );
  flagPassportDirty(ctx, 'growth event created');
  writeAudit(ctx, { entityType: 'growth_event', entityId: id, after: input, reason: 'meaningful progress recorded' });
  return getGrowthEvent(ctx, id)!;
}

export function getGrowthEvent(ctx: CoreContext, id: string): GrowthEvent | null {
  const r = ctx.db.prepare('SELECT * FROM growth_events WHERE id=?').get(id) as
    | { id: string; date_key: string; title: string; description: string | null; domain: string; evidence_ids: string; goal_id: string | null; stage_id: string | null; tags: string }
    | undefined;
  if (!r) return null;
  return {
    id: r.id, dateKey: r.date_key, title: r.title, description: r.description ?? undefined,
    domain: r.domain as ActionDomain, evidenceIds: pj(r.evidence_ids, []),
    goalId: r.goal_id ?? undefined, stageId: r.stage_id ?? undefined, tags: pj(r.tags, []),
  };
}

export function listGrowthEvents(ctx: CoreContext, sinceDateKey?: string, limit = 100): GrowthEvent[] {
  const rows = sinceDateKey
    ? ctx.db.prepare('SELECT * FROM growth_events WHERE date_key >= ? ORDER BY date_key DESC, created_at DESC LIMIT ?').all(sinceDateKey, limit)
    : ctx.db.prepare('SELECT * FROM growth_events ORDER BY date_key DESC, created_at DESC LIMIT ?').all(limit);
  return (rows as { id: string }[]).map((r) => getGrowthEvent(ctx, r.id)!);
}

// ---------- human versions（§9：有 Evidence 引用的稳定变化）----------

export function createHumanVersion(ctx: CoreContext, title: string, description: string, evidenceIds: string[]): { id: string; version: number } {
  if (!evidenceIds?.length) {
    throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Human Version must reference evidence (V1.1 §9)');
  }
  const max = ctx.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM human_versions').get() as { v: number };
  const version = max.v + 1;
  const id = newId();
  ctx.db
    .prepare('INSERT INTO human_versions (id, version, title, description, evidence_ids, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, version, title, description, JSON.stringify(evidenceIds), ts());
  return { id, version };
}

export function listHumanVersions(ctx: CoreContext, limit = 20) {
  return ctx.db
    .prepare('SELECT * FROM human_versions ORDER BY version DESC LIMIT ?')
    .all(limit) as { id: string; version: number; title: string; description: string; evidence_ids: string; created_at: string }[];
}
