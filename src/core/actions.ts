import type { CoreContext } from './context.js';
import { writeAudit } from './context.js';
import { newId, ts } from '../shared/util.js';
import { assertActionTransition, isTerminalActionStatus } from './stateMachine.js';
import { DomainError, ErrorCodes } from '../shared/result.js';
import { todayIn, resolveTimezone, getProfile } from './profile.js';
import { localDateKey } from '../shared/time.js';
import type { Action, ActionDomain, ActionKind, ActionStatus, DailyPlan, TaskFeedback, TaskFeedbackReason } from './types.js';
import { cancelRemindersByAction } from '../reminder/service.js';

// ---------- rows ----------

type ActionRow = {
  id: string; kind: string; domain: string; title: string; description: string | null;
  why_today: string | null; estimated_minutes: number | null; completion_criteria: string | null;
  evidence_requirements: string | null; verification_strategy: string | null; basis: string | null;
  basis_goal_id: string | null; basis_direction_id: string | null; basis_stage_id: string | null;
  plan_id: string | null; date_key: string; status: string; skipped_reason: string | null;
  completed_at: string | null; created_at: string; updated_at: string; deleted_at: string | null;
};

function rowToAction(r: ActionRow): Action {
  return {
    id: r.id, kind: r.kind as ActionKind, domain: r.domain as ActionDomain, title: r.title,
    description: r.description ?? undefined, whyToday: r.why_today ?? undefined,
    estimatedMinutes: r.estimated_minutes ?? undefined,
    completionCriteria: r.completion_criteria ?? undefined,
    evidenceRequirements: r.evidence_requirements ?? undefined,
    verificationStrategy: r.verification_strategy ?? undefined, basis: r.basis ?? undefined,
    basisGoalId: r.basis_goal_id ?? undefined, basisDirectionId: r.basis_direction_id ?? undefined,
    basisStageId: r.basis_stage_id ?? undefined, planId: r.plan_id ?? undefined,
    dateKey: r.date_key, status: r.status as ActionStatus,
    skippedReason: r.skipped_reason ?? undefined, completedAt: r.completed_at ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---------- daily plans ----------

export function getDailyPlan(ctx: CoreContext, dateKey: string): DailyPlan | null {
  const row = ctx.db
    .prepare('SELECT * FROM daily_plans WHERE date_key=?')
    .get(dateKey) as { id: string; date_key: string; rationale: string | null; status: string; created_at: string; confirmed_at: string | null } | undefined;
  if (!row) return null;
  return {
    id: row.id, dateKey: row.date_key, rationale: row.rationale ?? undefined,
    status: row.status as DailyPlan['status'], createdAt: row.created_at, confirmedAt: row.confirmed_at ?? undefined,
  };
}

export function getTodayPlan(ctx: CoreContext): { plan: DailyPlan | null; actions: Action[] } {
  const today = todayIn(ctx);
  const plan = getDailyPlan(ctx, today);
  return { plan, actions: plan ? listActionsForDate(ctx, today) : [] };
}

export interface PlanTodayInput {
  mainQuest?: CreateActionInput;
  dailyActions?: CreateActionInput[];
  rationale?: string;
}

/**
 * 创建今日计划（Core 保证结构性约束，V1.1 §23）：
 * - 必须先完成 Onboarding（核心原则 2：不允许直接生成任务）
 * - 有未处理的 Pending Replan 时不得创建新 Main Quest（先解决 Replan）
 * - Main Quest <= 1，Daily 0~2
 * - Main 必须有完成标准、预计耗时、whyToday
 * - 同一天已存在计划时返回错误（改用 confirm/update）
 */
export function createTodayPlan(ctx: CoreContext, input: PlanTodayInput): { plan: DailyPlan; actions: Action[] } {
  // 结构性强制核心原则 2：首次使用必须先完成访谈，Agent 无法用"忘记"绕过
  const profile = getProfile(ctx);
  if (!profile || profile.onboardingStatus !== 'COMPLETED') {
    throw new DomainError(
      ErrorCodes.ONBOARDING_REQUIRED,
      'Onboarding must be COMPLETED before daily planning. Interview the user first, then call plan_today.'
    );
  }

  const today = todayIn(ctx);
  if (getDailyPlan(ctx, today)) {
    throw new DomainError(ErrorCodes.ALREADY_EXISTS, `Plan for ${today} already exists`);
  }

  // 结构性强制：有 Pending Replan 时先解决它再开新主线，避免旧主线被静默丢弃
  if (input.mainQuest) {
    const pending = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM actions WHERE status='PENDING_REPLAN' AND deleted_at IS NULL`)
      .get() as { n: number };
    if (pending.n > 0) {
      throw new DomainError(
        ErrorCodes.REPLAN_REQUIRED,
        'A previous Main Quest is pending replan. Resolve it with replan() before creating a new Main Quest.'
      );
    }
  }

  const dailies = input.dailyActions ?? [];
  if (dailies.length > 2)
    throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Daily Actions must be 0~2 by default (V1.1 §23.1)');
  const main = input.mainQuest;
  if (main) {
    if (!main.completionCriteria?.trim())
      throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Main Quest requires completion criteria');
    if (!main.estimatedMinutes)
      throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Main Quest requires estimated time');
    if (!main.whyToday?.trim())
      throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'Main Quest requires whyToday');
  }
  const planId = newId();
  const now = ts();
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare('INSERT INTO daily_plans (id, date_key, rationale, status, created_at) VALUES (?,?,?,?,?)')
      .run(planId, today, input.rationale ?? null, 'DRAFT', now);
    if (main) insertAction(ctx, { ...main, kind: 'MAIN_QUEST', planId, dateKey: today });
    for (const d of dailies) insertAction(ctx, { ...d, kind: 'DAILY', planId, dateKey: today });
  });
  tx();
  writeAudit(ctx, {
    entityType: 'daily_plan', entityId: planId,
    after: { date: today, mainQuest: !!main, dailyCount: dailies.length },
    reason: 'create today plan',
  });
  const plan = getDailyPlan(ctx, today)!;
  return { plan, actions: listActionsForDate(ctx, today) };
}

/**
 * 确认当日计划。确认后该计划下的 DRAFT action 进入 PLANNED 可执行态。
 * 幂等：已确认的计划再次调用直接返回，不重复写审计。
 */
export function confirmTodayPlan(ctx: CoreContext, planId?: string): DailyPlan {
  let dateKey = todayIn(ctx);
  if (planId) {
    const target = ctx.db.prepare('SELECT date_key FROM daily_plans WHERE id=?').get(planId) as
      | { date_key: string }
      | undefined;
    if (!target) throw new DomainError(ErrorCodes.NOT_FOUND, `Plan not found: ${planId}`);
    dateKey = target.date_key;
  }
  const plan = getDailyPlan(ctx, dateKey);
  if (!plan) throw new DomainError(ErrorCodes.NOT_FOUND, `No plan for ${dateKey}`);
  if (plan.status === 'CONFIRMED') return plan;

  ctx.db
    .prepare('UPDATE daily_plans SET status=?, confirmed_at=? WHERE id=?')
    .run('CONFIRMED', ts(), plan.id);
  ctx.db
    .prepare(`UPDATE actions SET status='PLANNED', updated_at=? WHERE plan_id=? AND status='DRAFT'`)
    .run(ts(), plan.id);

  const after = getDailyPlan(ctx, dateKey)!;
  writeAudit(ctx, { entityType: 'daily_plan', entityId: plan.id, after, reason: 'user confirmed plan' });
  return after;
}

// ---------- actions ----------

export interface CreateActionInput {
  kind?: ActionKind;
  domain?: ActionDomain;
  title: string;
  description?: string;
  whyToday?: string;
  estimatedMinutes?: number;
  completionCriteria?: string;
  evidenceRequirements?: string;
  verificationStrategy?: string;
  basis?: string;
  basisGoalId?: string;
  basisDirectionId?: string;
  basisStageId?: string;
  dateKey?: string; // 默认今天
  planId?: string;
}

function insertAction(ctx: CoreContext, input: CreateActionInput & { kind: ActionKind; dateKey: string; planId?: string }): Action {
  const id = newId();
  const now = ts();
  ctx.db
    .prepare(
      `INSERT INTO actions (id, kind, domain, title, description, why_today, estimated_minutes,
       completion_criteria, evidence_requirements, verification_strategy, basis, basis_goal_id,
       basis_direction_id, basis_stage_id, plan_id, date_key, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, input.kind, input.domain ?? 'OTHER', input.title, input.description ?? null,
      input.whyToday ?? null, input.estimatedMinutes ?? null, input.completionCriteria ?? null,
      input.evidenceRequirements ?? null, input.verificationStrategy ?? null, input.basis ?? null,
      input.basisGoalId ?? null, input.basisDirectionId ?? null, input.basisStageId ?? null,
      input.planId ?? null, input.dateKey, 'DRAFT', now, now
    );
  return getAction(ctx, id)!;
}

/** Agent 自主创建执行层 action（V1.1 §17.2：当天执行层任务可自主创建） */
export function createAction(ctx: CoreContext, input: CreateActionInput): Action {
  const kind: ActionKind = input.kind ?? 'DAILY';
  const dateKey = input.dateKey ?? todayIn(ctx);
  const a = insertAction(ctx, { ...input, kind, dateKey });
  // 创建即视为已规划（Agent 创建执行层任务无需用户逐条确认）
  ctx.db.prepare(`UPDATE actions SET status='PLANNED', updated_at=? WHERE id=?`).run(ts(), a.id);
  writeAudit(ctx, { entityType: 'action', entityId: a.id, after: getAction(ctx, a.id), reason: 'agent created action' });
  return getAction(ctx, a.id)!;
}

export function getAction(ctx: CoreContext, id: string): Action | null {
  const row = ctx.db.prepare('SELECT * FROM actions WHERE id=? AND deleted_at IS NULL').get(id) as ActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function listActionsForDate(ctx: CoreContext, dateKey: string): Action[] {
  const rows = ctx.db
    .prepare('SELECT * FROM actions WHERE date_key=? AND deleted_at IS NULL ORDER BY kind DESC, created_at')
    .all(dateKey) as ActionRow[];
  return rows.map(rowToAction);
}

export function listOpenActionsBefore(ctx: CoreContext, dateKey: string): Action[] {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM actions WHERE date_key < ? AND deleted_at IS NULL
       AND status IN ('DRAFT','PLANNED','IN_PROGRESS','DELAYED','PENDING_REPLAN')
       ORDER BY date_key, created_at`
    )
    .all(dateKey) as ActionRow[];
  return rows.map(rowToAction);
}

function transitionAction(
  ctx: CoreContext,
  id: string,
  to: ActionStatus,
  reason: string,
  extra: { skippedReason?: string } = {}
): Action {
  const before = getAction(ctx, id);
  if (!before) throw new DomainError(ErrorCodes.NOT_FOUND, `Action not found: ${id}`);

  // 用户对 DRAFT（尚未确认的当日计划）执行动作，本身就是对该计划的认可。
  // 自动提升 DRAFT → PLANNED，避免用户点了「完成」却收到状态机报错
  // （符合 §21「低风险任务允许一句话确认」与"不让用户管理系统"的定位）。
  let from = before.status;
  if (from === 'DRAFT' && to !== 'PLANNED' && to !== 'CANCELLED') {
    ctx.db.prepare(`UPDATE actions SET status='PLANNED', updated_at=? WHERE id=?`).run(ts(), id);
    from = 'PLANNED';
  }

  assertActionTransition(from, to, before.kind);
  ctx.db
    .prepare('UPDATE actions SET status=?, skipped_reason=?, completed_at=?, updated_at=? WHERE id=?')
    .run(
      to, extra.skippedReason ?? before.skippedReason ?? null,
      to === 'COMPLETED' ? ts() : before.completedAt ?? null, ts(), id
    );
  if (isTerminalActionStatus(to)) {
    // Action 终态：取消未触发提醒（V1.1 §24 / Scenario I）
    cancelRemindersByAction(ctx, id, `action ${to}`);
  }
  const after = getAction(ctx, id)!;
  writeAudit(ctx, { entityType: 'action', entityId: id, before, after, reason });
  return after;
}

export function startAction(ctx: CoreContext, id: string): Action {
  return transitionAction(ctx, id, 'IN_PROGRESS', 'start action');
}

export interface UpdateActionInput {
  title?: string;
  description?: string;
  whyToday?: string;
  estimatedMinutes?: number;
  completionCriteria?: string;
  evidenceRequirements?: string;
  verificationStrategy?: string;
  dateKey?: string; // 重排到另一天（仅非当日执行层调整）
}

/** Agent 自主修改执行层任务（V1.1 §17.2）。修改顺带把 PENDING_REPLAN/DRAFT 拉回 PLANNED 由调用方决定 */
export function updateAction(ctx: CoreContext, id: string, input: UpdateActionInput, reason = 'agent update action'): Action {
  const before = getAction(ctx, id);
  if (!before) throw new DomainError(ErrorCodes.NOT_FOUND, `Action not found: ${id}`);
  if (isTerminalActionStatus(before.status))
    throw new DomainError(ErrorCodes.INVALID_STATE, `Cannot update terminal action (${before.status})`);
  ctx.db
    .prepare(
      `UPDATE actions SET title=?, description=?, why_today=?, estimated_minutes=?, completion_criteria=?,
       evidence_requirements=?, verification_strategy=?, date_key=?, updated_at=? WHERE id=?`
    )
    .run(
      input.title ?? before.title, input.description ?? before.description ?? null,
      input.whyToday ?? before.whyToday ?? null, input.estimatedMinutes ?? before.estimatedMinutes ?? null,
      input.completionCriteria ?? before.completionCriteria ?? null,
      input.evidenceRequirements ?? before.evidenceRequirements ?? null,
      input.verificationStrategy ?? before.verificationStrategy ?? null,
      input.dateKey ?? before.dateKey, ts(), id
    );
  const after = getAction(ctx, id)!;
  writeAudit(ctx, { entityType: 'action', entityId: id, before, after, reason });
  return after;
}

/** 完成 action。delay/skip 必须带 reason；complete 后触发 GrowthEvent 由 evidence 服务负责 */
export function completeAction(ctx: CoreContext, id: string): Action {
  return transitionAction(ctx, id, 'COMPLETED', 'user completed action');
}

export function skipAction(ctx: CoreContext, id: string, reason?: string): Action {
  return transitionAction(ctx, id, 'SKIPPED', 'user skipped action', { skippedReason: reason });
}

export function delayAction(ctx: CoreContext, id: string, reason?: string): Action {
  const delayed = transitionAction(ctx, id, 'DELAYED', 'user delayed action');
  if (!reason) return delayed;
  ctx.db.prepare('UPDATE actions SET skipped_reason=?, updated_at=? WHERE id=?').run(reason, ts(), id);
  return getAction(ctx, id)!;
}

export function cancelAction(ctx: CoreContext, id: string, reason: string): Action {
  return transitionAction(ctx, id, 'CANCELLED', reason);
}

/** Replan 内部使用：把 PENDING_REPLAN/DELAYED 的 Main Quest 拉回 PLANNED（可同时改日期） */
export function rearmAction(ctx: CoreContext, id: string, newDateKey?: string): Action {
  if (newDateKey) updateAction(ctx, id, { dateKey: newDateKey }, 'replan move date');
  return transitionAction(ctx, id, 'PLANNED', 'replanned');
}

// rollover 专用（绕过一般转换约束由状态机保证）
export function expireActionInternal(ctx: CoreContext, id: string): Action {
  return transitionAction(ctx, id, 'EXPIRED', 'daily rollover: not completed by end of day');
}

export function markPendingReplanInternal(ctx: CoreContext, id: string): Action {
  return transitionAction(ctx, id, 'PENDING_REPLAN', 'daily rollover: main quest not completed');
}

// ---------- task feedback（V1.1 §20）----------

export function addTaskFeedback(
  ctx: CoreContext,
  actionId: string,
  reason: TaskFeedbackReason,
  comment?: string
): TaskFeedback {
  const action = getAction(ctx, actionId);
  if (!action) throw new DomainError(ErrorCodes.NOT_FOUND, `Action not found: ${actionId}`);
  const id = newId();
  ctx.db
    .prepare('INSERT INTO task_feedback (id, action_id, reason, comment, created_at) VALUES (?,?,?,?,?)')
    .run(id, actionId, reason, comment ?? null, ts());
  writeAudit(ctx, { entityType: 'task_feedback', entityId: id, after: { actionId, reason, comment }, reason: 'user feedback' });
  return { id, actionId, reason, comment, createdAt: ts() };
}

export function listFeedbackForAction(ctx: CoreContext, actionId: string): TaskFeedback[] {
  const rows = ctx.db
    .prepare('SELECT * FROM task_feedback WHERE action_id=? ORDER BY created_at DESC')
    .all(actionId) as { id: string; action_id: string; reason: string; comment: string | null; created_at: string }[];
  return rows.map((r) => ({ id: r.id, actionId: r.action_id, reason: r.reason as TaskFeedbackReason, comment: r.comment ?? undefined, createdAt: r.created_at }));
}

/** 近 N 天反馈聚合（供 Planner 降低重复推荐概率） */
export function recentFeedbackStats(ctx: CoreContext, days = 14): { reason: TaskFeedbackReason; count: number }[] {
  const since = localDateKey(new Date(Date.now() - days * 86400_000), resolveTimezone(ctx));
  const rows = ctx.db
    .prepare(
      `SELECT tf.reason AS reason, COUNT(*) AS count FROM task_feedback tf
       JOIN actions a ON a.id = tf.action_id
       WHERE a.date_key >= ? GROUP BY tf.reason ORDER BY count DESC`
    )
    .all(since) as { reason: string; count: number }[];
  return rows.map((r) => ({ reason: r.reason as TaskFeedbackReason, count: r.count }));
}
