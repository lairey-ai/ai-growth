import type { CoreContext } from './context.js';
import { writeAudit } from './context.js';
import { newId, ts, pj } from '../shared/util.js';
import { assertGoalTransition } from './stateMachine.js';
import { DomainError, ErrorCodes } from '../shared/result.js';
import type { Goal, GoalStatus, Stage, StageStatus } from './types.js';

// ---------- rows ----------

type GoalRow = {
  id: string; title: string; why: string; desired_outcome: string; success_criteria: string;
  motivation: string | null; start_date: string | null; target_date: string | null; status: string;
  daily_time_budget_minutes: number | null; acceptance_criteria: string;
  created_at: string; updated_at: string; deleted_at: string | null;
};

function rowToGoal(r: GoalRow): Goal {
  return {
    id: r.id, title: r.title, why: r.why, desiredOutcome: r.desired_outcome,
    successCriteria: pj(r.success_criteria, []), motivation: r.motivation ?? undefined,
    startDate: r.start_date ?? undefined, targetDate: r.target_date ?? undefined,
    status: r.status as GoalStatus, dailyTimeBudgetMinutes: r.daily_time_budget_minutes ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

type StageRow = {
  id: string; goal_id: string; title: string; objective: string | null; order_index: number;
  planned_start_date: string | null; planned_end_date: string | null; status: string;
  exit_criteria: string; created_at: string; updated_at: string;
};

function rowToStage(r: StageRow): Stage {
  return {
    id: r.id, goalId: r.goal_id, title: r.title, objective: r.objective ?? undefined,
    order: r.order_index, plannedStartDate: r.planned_start_date ?? undefined,
    plannedEndDate: r.planned_end_date ?? undefined, status: r.status as StageStatus,
    exitCriteria: pj(r.exit_criteria, []),
  };
}

// ---------- goals ----------

export interface CreateGoalDraftInput {
  title: string;
  why: string;
  desiredOutcome: string;
  successCriteria: string[];
  startDate?: string;
  targetDate?: string;
  dailyTimeBudgetMinutes?: number;
  motivation?: string;
}

/** Goal 必须包含 why / desiredOutcome / successCriteria（V1.1 §18） */
export function createGoalDraft(ctx: CoreContext, input: CreateGoalDraftInput): Goal {
  if (!input.title?.trim()) throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Goal title is required');
  if (!input.why?.trim()) throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Goal must include why (V1.1 §18)');
  if (!input.desiredOutcome?.trim())
    throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Goal must include desiredOutcome');
  if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0)
    throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Goal must include at least one success criterion');
  const id = newId();
  const now = ts();
  ctx.db
    .prepare(
      `INSERT INTO goals (id, title, why, desired_outcome, success_criteria, motivation, start_date,
       target_date, status, daily_time_budget_minutes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, input.title.trim(), input.why.trim(), input.desiredOutcome.trim(),
      JSON.stringify(input.successCriteria), input.motivation ?? null,
      input.startDate ?? null, input.targetDate ?? null, 'DRAFT',
      input.dailyTimeBudgetMinutes ?? null, now, now
    );
  const goal = getGoal(ctx, id);
  writeAudit(ctx, { entityType: 'goal', entityId: id, after: goal, reason: 'create goal draft' });
  return goal!;
}

export function getGoal(ctx: CoreContext, id: string): Goal | null {
  const row = ctx.db.prepare('SELECT * FROM goals WHERE id=? AND deleted_at IS NULL').get(id) as GoalRow | undefined;
  return row ? rowToGoal(row) : null;
}

export function listGoals(ctx: CoreContext, statuses?: GoalStatus[]): Goal[] {
  const rows = statuses?.length
    ? ctx.db
        .prepare(`SELECT * FROM goals WHERE deleted_at IS NULL AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`)
        .all(...statuses) as GoalRow[]
    : ctx.db.prepare('SELECT * FROM goals WHERE deleted_at IS NULL ORDER BY created_at').all() as GoalRow[];
  return rows.map(rowToGoal);
}

export function getActiveGoals(ctx: CoreContext): Goal[] {
  return listGoals(ctx, ['ACTIVE']);
}

function updateGoalStatus(ctx: CoreContext, id: string, to: GoalStatus, reason: string): Goal {
  const before = getGoal(ctx, id);
  if (!before) throw new DomainError(ErrorCodes.NOT_FOUND, `Goal not found: ${id}`);
  assertGoalTransition(before.status, to);
  ctx.db.prepare('UPDATE goals SET status=?, updated_at=? WHERE id=?').run(to, ts(), id);
  const after = getGoal(ctx, id)!;
  writeAudit(ctx, { entityType: 'goal', entityId: id, before, after, reason });
  return after;
}

export function confirmGoal(ctx: CoreContext, id: string): Goal {
  return updateGoalStatus(ctx, id, 'CONFIRMED', 'user confirmed goal draft');
}

export function activateGoal(ctx: CoreContext, id: string): Goal {
  return updateGoalStatus(ctx, id, 'ACTIVE', 'goal activated (stage plan confirmed)');
}

export function pauseGoal(ctx: CoreContext, id: string): Goal {
  return updateGoalStatus(ctx, id, 'PAUSED', 'user paused goal');
}

export function resumeGoal(ctx: CoreContext, id: string): Goal {
  return updateGoalStatus(ctx, id, 'ACTIVE', 'user resumed goal');
}

export interface UpdateGoalInput {
  title?: string;
  why?: string;
  desiredOutcome?: string;
  successCriteria?: string[];
  motivation?: string;
  targetDate?: string;
  dailyTimeBudgetMinutes?: number | null;
}

/** 重大字段（why/outcome/criteria/deadline）修改记录审计；调用方（Agent）必须先获得用户确认 */
export function updateGoal(ctx: CoreContext, id: string, input: UpdateGoalInput, reason = 'update goal'): Goal {
  const before = getGoal(ctx, id);
  if (!before) throw new DomainError(ErrorCodes.NOT_FOUND, `Goal not found: ${id}`);
  const next = {
    title: input.title ?? before.title,
    why: input.why ?? before.why,
    desiredOutcome: input.desiredOutcome ?? before.desiredOutcome,
    successCriteria: input.successCriteria ?? before.successCriteria,
    motivation: input.motivation ?? before.motivation,
    targetDate: input.targetDate !== undefined ? input.targetDate : before.targetDate,
    dailyTimeBudgetMinutes:
      input.dailyTimeBudgetMinutes !== undefined ? (input.dailyTimeBudgetMinutes ?? undefined) : before.dailyTimeBudgetMinutes,
  };
  ctx.db
    .prepare(
      `UPDATE goals SET title=?, why=?, desired_outcome=?, success_criteria=?, motivation=?,
       target_date=?, daily_time_budget_minutes=?, updated_at=? WHERE id=?`
    )
    .run(
      next.title, next.why, next.desiredOutcome, JSON.stringify(next.successCriteria),
      next.motivation ?? null, next.targetDate ?? null, next.dailyTimeBudgetMinutes ?? null, ts(), id
    );
  const after = getGoal(ctx, id)!;
  writeAudit(ctx, { entityType: 'goal', entityId: id, before, after, reason });
  return after;
}

// ---------- stages ----------

export interface CreateStagePlanInput {
  goalId: string;
  stages: Array<{
    title: string;
    objective?: string;
    order?: number;
    plannedStartDate?: string;
    plannedEndDate?: string;
    exitCriteria?: string[];
  }>;
}

/** 创建 Stage Plan。确认 Goal 后才允许激活（由调用方控制顺序） */
export function createStagePlan(ctx: CoreContext, input: CreateStagePlanInput): Stage[] {
  const goal = getGoal(ctx, input.goalId);
  if (!goal) throw new DomainError(ErrorCodes.NOT_FOUND, `Goal not found: ${input.goalId}`);
  const existing = listStages(ctx, input.goalId);
  if (existing.length > 0)
    throw new DomainError(ErrorCodes.ALREADY_EXISTS, 'Stage plan already exists for this goal');
  if (!input.stages?.length)
    throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Stage plan requires at least one stage');
  const now = ts();
  const insert = ctx.db.prepare(
    `INSERT INTO stages (id, goal_id, title, objective, order_index, planned_start_date, planned_end_date,
     status, exit_criteria, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const ids: string[] = [];
  const tx = ctx.db.transaction(() => {
    input.stages.forEach((s, i) => {
      const id = newId();
      ids.push(id);
      insert.run(
        id, input.goalId, s.title, s.objective ?? null, s.order ?? i + 1,
        s.plannedStartDate ?? null, s.plannedEndDate ?? null, 'PLANNED',
        JSON.stringify(s.exitCriteria ?? []), now, now
      );
    });
  });
  tx();
  writeAudit(ctx, { entityType: 'stage_plan', entityId: input.goalId, after: { stageCount: ids.length }, reason: 'create stage plan' });
  return listStages(ctx, input.goalId);
}

export function listStages(ctx: CoreContext, goalId: string): Stage[] {
  const rows = ctx.db
    .prepare('SELECT * FROM stages WHERE goal_id=? AND deleted_at IS NULL ORDER BY order_index')
    .all(goalId) as StageRow[];
  return rows.map(rowToStage);
}

export function getStage(ctx: CoreContext, id: string): Stage | null {
  const row = ctx.db.prepare('SELECT * FROM stages WHERE id=?').get(id) as StageRow | undefined;
  return row ? rowToStage(row) : null;
}

export function getCurrentStage(ctx: CoreContext, goalId: string): Stage | null {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM stages WHERE goal_id=? AND deleted_at IS NULL
       AND status IN ('ACTIVE','PLANNED','DELAYED') ORDER BY order_index LIMIT 1`
    )
    .all(goalId) as StageRow[];
  return rows[0] ? rowToStage(rows[0]) : null;
}

export interface UpdateStageInput {
  id: string;
  title?: string;
  objective?: string;
  order?: number;
  plannedStartDate?: string;
  plannedEndDate?: string;
  status?: StageStatus;
  exitCriteria?: string[];
}

export function updateStage(ctx: CoreContext, input: UpdateStageInput, reason = 'update stage'): Stage {
  const before = getStage(ctx, input.id);
  if (!before) throw new DomainError(ErrorCodes.NOT_FOUND, `Stage not found: ${input.id}`);
  ctx.db
    .prepare(
      `UPDATE stages SET title=?, objective=?, order_index=?, planned_start_date=?, planned_end_date=?,
       status=?, exit_criteria=?, updated_at=? WHERE id=?`
    )
    .run(
      input.title ?? before.title, input.objective ?? before.objective ?? null,
      input.order ?? before.order, input.plannedStartDate ?? before.plannedStartDate ?? null,
      input.plannedEndDate ?? before.plannedEndDate ?? null, input.status ?? before.status,
      JSON.stringify(input.exitCriteria ?? before.exitCriteria), ts(), input.id
    );
  const after = getStage(ctx, input.id)!;
  writeAudit(ctx, { entityType: 'stage', entityId: input.id, before, after, reason });
  return after;
}

/**
 * Replan 后顺延后续 Stage 窗口（Core primitive，由 Agent 决策调用）。
 *
 * 关键约束：
 * - COMPLETED / SKIPPED 是**历史记录**，日期与状态一律不改写，否则会伪造已完成阶段的窗口
 * - ACTIVE 必须保持 ACTIVE，否则会丢失"当前阶段"信号（getCurrentStage 与 UI 高亮都依赖它）
 * - PLANNED 顺延后标记为 DELAYED，用于记录"尚未开始就已滑档"
 */
export function shiftStagesFrom(ctx: CoreContext, goalId: string, fromStageId: string, days: number, reason: string): Stage[] {
  const stages = listStages(ctx, goalId);
  const from = stages.find((s) => s.id === fromStageId);
  if (!from) throw new DomainError(ErrorCodes.NOT_FOUND, `Stage not found: ${fromStageId}`);
  const addDaysToKey = (key?: string): string | undefined => {
    if (!key) return undefined;
    const d = new Date(`${key}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const FROZEN: StageStatus[] = ['COMPLETED', 'SKIPPED'];

  for (const s of stages.filter((x) => x.order >= from.order)) {
    if (FROZEN.includes(s.status)) continue;
    updateStage(ctx, {
      id: s.id,
      plannedStartDate: addDaysToKey(s.plannedStartDate),
      plannedEndDate: addDaysToKey(s.plannedEndDate),
      status: s.status === 'PLANNED' ? 'DELAYED' : s.status,
    }, reason);
  }
  return listStages(ctx, goalId);
}
