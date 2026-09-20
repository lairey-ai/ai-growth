import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../shared/config.js';
import type { DB } from '../db/client.js';
import { makeCtx, toResult, toResultAsync } from './ctx.js';
import { ok } from '../shared/result.js';
import { nowIso, localDateKey } from '../shared/time.js';

import { growthStatus, getProfile, ensureProfile } from '../core/status.js';
import { updateProfile } from '../core/profile.js';
import { getSetting, setSetting, todayIn } from '../core/profile.js';
import { listSyncJobs } from '../passport/state.js';
import {
  getGoal, listGoals, getActiveGoals, createGoalDraft, confirmGoal, activateGoal,
  pauseGoal, resumeGoal, updateGoal, listStages, createStagePlan, updateStage, getCurrentStage,
} from '../core/goals.js';
import {
  getTodayPlan, createTodayPlan, confirmTodayPlan, createAction, updateAction,
  completeAction, skipAction, delayAction, startAction, cancelAction,
  listActionsForDate, addTaskFeedback, recentFeedbackStats, getAction,
} from '../core/actions.js';
import { runDailyRollover, listPendingReplanActions } from '../core/rollover.js';
import { resolveReplan, replanHints } from '../core/replan.js';
import {
  addEvidence, listEvidence, createAssessment, submitAssessment,
  createGrowthEvent, listGrowthEvents, listAssessments,
} from '../core/evidence.js';
import { getActiveLifeContext, setLifeContext } from '../core/lifeContext.js';
import { listMemories, addMemory, confirmMemory } from '../core/memory.js';
import { listDirections, addDirection, confirmDirection } from '../core/directions.js';
import { computeMetrics, plannerContext } from '../core/metrics.js';
import { renderProgress } from '../core/progress.js';
import { generatePassport } from '../passport/builder.js';
import { createPassportAdapter, syncPassport, retryPendingSyncs } from '../passport/sync.js';
import { latestSnapshot, isPassportDirty, flagPassportDirty } from '../passport/state.js';
import {
  createReminder, updateReminder, cancelReminder, listRemindersForDate, cancelRemindersByAction,
} from '../reminder/service.js';

/** 注册全部 MCP tools。返回 server。 */
export function registerTools(server: McpServer, db: DB, cfg: AppConfig): void {
  const ctxOf = () => makeCtx(db, cfg, 'agent');

  const S = z.string();
  const optS = z.string().optional();

  // ---------------- System ----------------

  server.tool('growth_status', 'System status & suggested next operation. Call this FIRST on load.', {}, async () => {
    const r = toResult(() => growthStatus(ctxOf()));
    return json(r);
  });

  server.tool('run_daily_rollover', 'Run daily rollover (idempotent). Expires stale DAILY actions, moves unfinished MAIN_QUEST to PENDING_REPLAN.', {}, async () => {
    const r = toResult(() => runDailyRollover(ctxOf()));
    return json(r);
  });

  // ---------------- Profile ----------------

  server.tool('get_profile', 'Get user profile (timezone, preferences, constraints, onboarding status).', {}, async () => {
    const r = toResult(() => getProfile(ctxOf()) ?? null);
    return json(r);
  });

  server.tool('update_profile_patch', 'Patch profile fields. Completing onboarding requires onboardingStatus=COMPLETED.', {
    displayName: optS,
    timezone: optS,
    onboardingStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']).optional(),
    timePreferences: z.record(z.unknown()).optional(),
    taskCapacity: z.record(z.unknown()).optional(),
    learningPreferences: z.record(z.unknown()).optional(),
    reminderPreferences: z.record(z.unknown()).optional(),
    constraints: z.record(z.unknown()).optional(),
  }, async (args) => {
    const r = toResult(() => {
      const ctx = ctxOf();
      ensureProfile(ctx, args.timezone);
      return updateProfile(ctx, args);
    });
    return json(r);
  });

  // ---------------- Directions ----------------

  server.tool('list_directions', 'List user-confirmed growth directions / life intentions. Daily Actions MUST trace to one of these.', {
    includeUnconfirmed: z.boolean().optional(),
  }, async (args) => {
    const r = toResult(() => listDirections(ctxOf(), !args?.includeUnconfirmed));
    return json(r);
  });

  server.tool('add_direction', 'Add a growth direction. New long-term directions REQUIRE user confirmation — pass confirmed=true only after user explicitly agrees.', {
    title: S,
    description: optS,
    domain: z.enum(['LEARN', 'BUILD', 'TRAIN', 'HABIT', 'CREATE', 'RELATIONSHIP', 'EXPLORE', 'LIFE', 'OTHER']).optional(),
    userConfirmed: z.boolean().optional(),
  }, async (args) => {
    const r = toResult(() => addDirection(ctxOf(), {
      title: args.title, description: args.description, domain: args.domain,
      confirmed: !!args.userConfirmed,
    }));
    return json(r);
  });

  server.tool('confirm_direction', 'Mark a direction as user-confirmed.', { directionId: S }, async (args) => {
    const r = toResult(() => confirmDirection(ctxOf(), args.directionId));
    return json(r);
  });

  // ---------------- Goals ----------------

  server.tool('create_goal_draft', 'Create a goal DRAFT. Must include why / desiredOutcome / successCriteria (user-confirmed via interview). Stays DRAFT until user confirms.', {
    title: S,
    why: S,
    desiredOutcome: S,
    // 业务规则（至少 1 条成功标准）由 Core 强制，保证错误码统一为结构化 ToolResult
    successCriteria: z.array(S),
    startDate: optS,
    targetDate: optS,
    dailyTimeBudgetMinutes: z.number().optional(),
    motivation: optS,
  }, async (args) => {
    const r = toResult(() => createGoalDraft(ctxOf(), args));
    return json(r);
  });

  server.tool('list_goals', 'List goals, optionally filtered by status.', {
    statuses: z.array(z.enum(['DRAFT', 'CONFIRMED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED'])).optional(),
  }, async (args) => {
    const r = toResult(() => listGoals(ctxOf(), args.statuses));
    return json(r);
  });

  server.tool('get_active_goals', 'List ACTIVE goals with current stage.', {}, async () => {
    const r = toResult(() => {
      const ctx = ctxOf();
      return getActiveGoals(ctx).map((g) => ({ ...g, currentStage: getCurrentStage(ctx, g.id) }));
    });
    return json(r);
  });

  server.tool('get_goal', 'Get one goal with its stages.', { goalId: S }, async (args) => {
    const r = toResult(() => {
      const ctx = ctxOf();
      const g = getGoal(ctx, args.goalId);
      return g ? { ...g, stages: listStages(ctx, g.id) } : null;
    });
    return json(r);
  });

  server.tool('confirm_goal', 'Confirm a goal draft (user has agreed). Transitions DRAFT→CONFIRMED.', { goalId: S }, async (args) => {
    const r = toResult(() => confirmGoal(ctxOf(), args.goalId));
    return json(r);
  });

  server.tool('activate_goal', 'Activate a CONFIRMED goal (after its stage plan is accepted). CONFIRMED→ACTIVE.', { goalId: S }, async (args) => {
    const r = toResult(() => activateGoal(ctxOf(), args.goalId));
    return json(r);
  });

  server.tool('update_goal', 'Update goal fields. why/outcome/criteria/targetDate changes MUST have prior user confirmation.', {
    goalId: S,
    title: optS,
    why: optS,
    desiredOutcome: optS,
    successCriteria: z.array(S).optional(),
    targetDate: optS,
    dailyTimeBudgetMinutes: z.number().nullable().optional(),
    motivation: optS,
    reason: optS,
  }, async (args) => {
    const { goalId, reason, ...patch } = args;
    const r = toResult(() => updateGoal(ctxOf(), goalId, patch, reason ?? 'update goal'));
    return json(r);
  });

  server.tool('pause_goal', 'Pause an active goal.', { goalId: S }, async (args) => {
    const r = toResult(() => pauseGoal(ctxOf(), args.goalId));
    return json(r);
  });

  server.tool('resume_goal', 'Resume a paused goal.', { goalId: S }, async (args) => {
    const r = toResult(() => resumeGoal(ctxOf(), args.goalId));
    return json(r);
  });

  // ---------------- Stage plan ----------------

  server.tool('create_stage_plan', 'Create the stage plan for a goal. Stages only — do NOT pre-generate all future daily actions.', {
    goalId: S,
    stages: z.array(z.object({
      title: S,
      objective: optS,
      order: z.number().optional(),
      plannedStartDate: optS,
      plannedEndDate: optS,
      exitCriteria: z.array(S).optional(),
    })),
  }, async (args) => {
    const r = toResult(() => createStagePlan(ctxOf(), args));
    return json(r);
  });

  server.tool('get_stage_plan', 'Get the stage plan of a goal.', { goalId: S }, async (args) => {
    const r = toResult(() => listStages(ctxOf(), args.goalId));
    return json(r);
  });

  server.tool('update_stage', 'Update one stage (title/window/status/exit criteria).', {
    stageId: S,
    title: optS,
    objective: optS,
    order: z.number().optional(),
    plannedStartDate: optS,
    plannedEndDate: optS,
    status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED', 'DELAYED', 'SKIPPED']).optional(),
    exitCriteria: z.array(S).optional(),
    reason: optS,
  }, async (args) => {
    const { stageId, reason, ...patch } = args;
    const r = toResult(() => updateStage(ctxOf(), { id: stageId, ...patch }, reason ?? 'update stage'));
    return json(r);
  });

  // ---------------- Today / Actions ----------------

  server.tool('get_today_plan', "Get today's plan and actions.", {}, async () => {
    const r = toResult(() => getTodayPlan(ctxOf()));
    return json(r);
  });

  server.tool('plan_today', "Create today's plan: exactly one mainQuest (with whyToday, completionCriteria, estimatedMinutes) + 0~2 dailyActions. Show it to the user for confirmation — do not self-confirm.", {
    mainQuest: z.object({
      title: S,
      description: optS,
      whyToday: S,
      estimatedMinutes: z.number(),
      completionCriteria: S,
      evidenceRequirements: optS,
      verificationStrategy: optS,
      basis: optS,
      basisGoalId: optS,
      basisStageId: optS,
      basisDirectionId: optS,
    }).optional(),
    dailyActions: z.array(z.object({
      title: S,
      description: optS,
      estimatedMinutes: z.number().optional(),
      basis: optS,
      basisDirectionId: optS,
      basisGoalId: optS,
      domain: z.enum(['LEARN', 'BUILD', 'TRAIN', 'HABIT', 'CREATE', 'RELATIONSHIP', 'EXPLORE', 'LIFE', 'OTHER']).optional(),
    })).optional(),
    rationale: optS,
  }, async (args) => {
    const r = toResult(() => createTodayPlan(ctxOf(), args));
    return json(r);
  });

  server.tool('confirm_today_plan', 'Confirm today plan after user agreement. Moves DRAFT actions to PLANNED.', { planId: optS }, async (args) => {
    const r = toResult(() => confirmTodayPlan(ctxOf(), args.planId));
    return json(r);
  });

  server.tool('create_action', 'Create a standalone execution-level action (agent-autonomous).', {
    title: S,
    kind: z.enum(['MAIN_QUEST', 'DAILY']).optional(),
    domain: z.enum(['LEARN', 'BUILD', 'TRAIN', 'HABIT', 'CREATE', 'RELATIONSHIP', 'EXPLORE', 'LIFE', 'OTHER']).optional(),
    description: optS,
    whyToday: optS,
    estimatedMinutes: z.number().optional(),
    completionCriteria: optS,
    evidenceRequirements: optS,
    verificationStrategy: optS,
    basis: optS,
    basisGoalId: optS,
    basisDirectionId: optS,
    basisStageId: optS,
    dateKey: optS,
  }, async (args) => {
    const r = toResult(() => createAction(ctxOf(), args));
    return json(r);
  });

  server.tool('update_action', 'Update an action (agent-autonomous for execution level).', {
    actionId: S,
    title: optS,
    description: optS,
    whyToday: optS,
    estimatedMinutes: z.number().optional(),
    completionCriteria: optS,
    evidenceRequirements: optS,
    verificationStrategy: optS,
    dateKey: optS,
    reason: optS,
  }, async (args) => {
    const { actionId, reason, ...patch } = args;
    const r = toResult(() => updateAction(ctxOf(), actionId, patch, reason ?? 'agent update action'));
    return json(r);
  });

  server.tool('start_action', 'Mark action in progress.', { actionId: S }, async (args) => {
    const r = toResult(() => startAction(ctxOf(), args.actionId));
    return json(r);
  });

  server.tool('complete_action', 'Complete an action. Low-risk life tasks may be confirmed with one sentence.', {
    actionId: S,
    note: optS,
  }, async (args) => {
    const r = toResult(() => {
      const ctx = ctxOf();
      const a = completeAction(ctx, args.actionId);
      if (args.note) {
        addEvidence(ctx, { actionId: a.id, type: 'TEXT', strength: 'USER_CONFIRMED', content: args.note });
      }
      return a;
    });
    return json(r);
  });

  server.tool('skip_action', 'Skip an action. If the user says the task is unreasonable, prefer add_task_feedback first.', {
    actionId: S,
    reason: optS,
  }, async (args) => {
    const r = toResult(() => skipAction(ctxOf(), args.actionId, args.reason));
    return json(r);
  });

  server.tool('delay_action', 'Delay an action (stays open, does not expire like DAILY).', {
    actionId: S,
    reason: optS,
  }, async (args) => {
    const r = toResult(() => delayAction(ctxOf(), args.actionId, args.reason));
    return json(r);
  });

  server.tool('cancel_action', 'Cancel an action.', { actionId: S, reason: S }, async (args) => {
    const r = toResult(() => cancelAction(ctxOf(), args.actionId, args.reason));
    return json(r);
  });

  server.tool('list_actions', 'List actions for a date (default today).', { dateKey: optS }, async (args) => {
    const r = toResult(() => listActionsForDate(ctxOf(), args.dateKey ?? todayIn(ctxOf())));
    return json(r);
  });

  // ---------------- Feedback ----------------

  server.tool('add_task_feedback', "Record why user rejected/modified a task. Use when user says 'too easy'/'bad timing'/'not interested' etc.", {
    actionId: S,
    reason: z.enum(['NOT_INTERESTED', 'BAD_TIMING', 'TOO_HARD', 'TOO_EASY', 'ALREADY_DONE', 'NOT_RELEVANT', 'NO_TIME', 'OTHER']),
    comment: optS,
  }, async (args) => {
    const r = toResult(() => addTaskFeedback(ctxOf(), args.actionId, args.reason as never, args.comment));
    return json(r);
  });

  server.tool('recent_feedback_stats', 'Feedback stats (last N days) — use to reduce repeat recommendations.', { days: z.number().optional() }, async (args) => {
    const r = toResult(() => recentFeedbackStats(ctxOf(), args.days ?? 14));
    return json(r);
  });

  // ---------------- Replan ----------------

  server.tool('replan', 'Resolve a pending replan. resolution: CONTINUE | ADJUST | SPLIT | DELAY_STAGE | CANCEL. Delaying stages that clearly moves the final deadline requires prior user confirmation.', {
    actionId: optS,
    resolution: z.enum(['CONTINUE', 'ADJUST', 'SPLIT', 'DELAY_STAGE', 'CANCEL']),
    reason: S,
    adjust: z.object({
      title: optS,
      description: optS,
      estimatedMinutes: z.number().optional(),
      completionCriteria: optS,
      verificationStrategy: optS,
    }).optional(),
    splitInto: z.array(z.object({
      title: S,
      estimatedMinutes: z.number().optional(),
      completionCriteria: optS,
    })).optional(),
    delayDays: z.number().optional(),
  }, async (args) => {
    const r = toResult(() => resolveReplan(ctxOf(), args));
    return json(r);
  });

  server.tool('get_replan_hints', 'Pending replan list + replan priority rules.', {}, async () => {
    const r = toResult(() => replanHints(ctxOf()));
    return json(r);
  });

  // ---------------- Evidence / Assessment ----------------

  server.tool('add_evidence', 'Record evidence. Types: TEXT/FILE/GIT/METRIC/QUIZ/ARTIFACT/REFLECTION/MANUAL. Strength defaults by type (GIT/METRIC/QUIZ/ARTIFACT → AUTO_VERIFIED).', {
    actionId: optS,
    type: z.enum(['TEXT', 'FILE', 'GIT', 'METRIC', 'QUIZ', 'ARTIFACT', 'REFLECTION', 'MANUAL']),
    strength: z.enum(['AUTO_VERIFIED', 'USER_CONFIRMED', 'AGENT_OBSERVED', 'UNVERIFIED']).optional(),
    content: S,
    metadata: z.record(z.unknown()).optional(),
    createGrowthEvent: z.boolean().optional(),
    eventTitle: optS,
    eventDomain: z.enum(['LEARN', 'BUILD', 'TRAIN', 'HABIT', 'CREATE', 'RELATIONSHIP', 'EXPLORE', 'LIFE', 'OTHER']).optional(),
  }, async (args) => {
    const r = toResult(() => {
      const ctx = ctxOf();
      const ev = addEvidence(ctx, {
        actionId: args.actionId,
        type: args.type,
        strength: args.strength,
        content: args.content,
        metadata: args.metadata,
      });
      let event = null;
      if (args.createGrowthEvent) {
        // 需要关联 action 时从该 action 继承 goal/stage，保证 Growth Event 可追溯
        const action = args.actionId ? getAction(ctx, args.actionId) : null;
        event = createGrowthEvent(ctx, {
          title: args.eventTitle ?? ev.content.slice(0, 60),
          domain: args.eventDomain ?? action?.domain,
          evidenceIds: [ev.id],
          goalId: action?.basisGoalId,
          stageId: action?.basisStageId,
        });
      }
      return { evidence: ev, event };
    });
    return json(r);
  });

  server.tool('list_evidence', 'List evidence with filters.', {
    actionId: optS,
    sinceDateKey: optS,
    type: z.enum(['TEXT', 'FILE', 'GIT', 'METRIC', 'QUIZ', 'ARTIFACT', 'REFLECTION', 'MANUAL']).optional(),
    limit: z.number().optional(),
  }, async (args) => {
    const r = toResult(() => listEvidence(ctxOf(), args));
    return json(r);
  });

  server.tool('create_assessment', 'Create a learning assessment (quiz/explain/challenge).', {
    topic: S,
    method: z.enum(['explain', 'quiz', 'coding-challenge', 'practical', 'mini-project', 'real-project']).optional(),
    actionId: optS,
    goalId: optS,
  }, async (args) => {
    const r = toResult(() => createAssessment(ctxOf(), args));
    return json(r);
  });

  server.tool('submit_assessment', 'Submit assessment result. Levels: EXPOSURE/RECALL/EXPLAIN/APPLY/REAL_WORLD_EVIDENCE. Failed assessment does NOT upgrade knowledge state.', {
    assessmentId: S,
    passed: z.boolean(),
    level: z.enum(['EXPOSURE', 'RECALL', 'EXPLAIN', 'APPLY', 'REAL_WORLD_EVIDENCE']),
    result: z.record(z.unknown()).optional(),
  }, async (args) => {
    const r = toResult(() => submitAssessment(ctxOf(), { ...args, id: args.assessmentId }));
    return json(r);
  });

  server.tool('list_assessments', 'List assessment history.', { goalId: optS, limit: z.number().optional() }, async (args) => {
    const r = toResult(() => listAssessments(ctxOf(), args.goalId, args.limit));
    return json(r);
  });

  server.tool('get_recent_growth', 'Recent growth events with evidence.', { limit: z.number().optional() }, async (args) => {
    const r = toResult(() => listGrowthEvents(ctxOf(), undefined, args.limit ?? 20));
    return json(r);
  });

  server.tool('create_growth_event', 'Create a growth event after MEANINGFUL real progress only. Requires evidenceIds — no evidence-free judgments.', {
    title: S,
    description: optS,
    domain: z.enum(['LEARN', 'BUILD', 'TRAIN', 'HABIT', 'CREATE', 'RELATIONSHIP', 'EXPLORE', 'LIFE', 'OTHER']).optional(),
    evidenceIds: z.array(S),
    goalId: optS,
    stageId: optS,
    tags: z.array(S).optional(),
  }, async (args) => {
    const r = toResult(() => createGrowthEvent(ctxOf(), args));
    return json(r);
  });

  // ---------------- Life context ----------------

  server.tool('get_life_context', 'Current active life context (NORMAL if none).', {}, async () => {
    const r = toResult(() => getActiveLifeContext(ctxOf()));
    return json(r);
  });

  server.tool('set_life_context', "Set life context (BUSY/RECOVERY/TRAVEL/FOCUS/CUSTOM). E.g. user says 'this week only 30min/day'. Planner must adapt load.", {
    mode: z.enum(['NORMAL', 'BUSY', 'RECOVERY', 'TRAVEL', 'FOCUS', 'CUSTOM']),
    availableMinutesPerDay: z.number().optional(),
    startDate: optS,
    expectedEndDate: optS,
    note: optS,
    userConfirmed: z.boolean().optional(),
  }, async (args) => {
    const r = toResult(() => setLifeContext(ctxOf(), args));
    return json(r);
  });

  // ---------------- Memory ----------------

  server.tool('add_memory', 'Store a memory. Inferences must include confidence and stay unconfirmed until user agrees.', {
    type: z.enum(['FACT', 'PATTERN', 'DECISION', 'CHANGE']),
    content: S,
    confidence: z.number().min(0).max(1).optional(),
    evidenceRefs: z.array(S).optional(),
    userConfirmed: z.boolean().optional(),
  }, async (args) => {
    const r = toResult(() => addMemory(ctxOf(), args));
    return json(r);
  });

  server.tool('list_memories', 'List memories.', { type: z.enum(['FACT', 'PATTERN', 'DECISION', 'CHANGE']).optional(), limit: z.number().optional() }, async (args) => {
    const r = toResult(() => listMemories(ctxOf(), args));
    return json(r);
  });

  server.tool('confirm_memory', 'Mark a memory as user-confirmed (stable fact).', { memoryId: S }, async (args) => {
    const r = toResult(() => confirmMemory(ctxOf(), args.memoryId));
    return json(r);
  });

  // ---------------- Review ----------------

  server.tool('daily_review', 'Summarize today: completion, evidence, feedback. Returns a structured summary the agent can present/extend.', {
    note: optS,
  }, async (args) => {
    const r = toResult(() => {
      const ctx = ctxOf();
      const today = todayIn(ctx);
      const actions = listActionsForDate(ctx, today);
      const summary = {
        date: today,
        mainQuest: actions.find((a) => a.kind === 'MAIN_QUEST') ?? null,
        dailyActions: actions.filter((a) => a.kind === 'DAILY'),
        evidenceToday: listEvidence(ctx, { sinceDateKey: today }),
        pendingReplan: listPendingReplanActions(ctx).map((p) => p.id),
      };
      if (args.note) {
        addEvidence(ctx, { type: 'REFLECTION', strength: 'USER_CONFIRMED', content: args.note });
      }
      flagPassportDirty(ctx, 'daily review');
      return summary;
    });
    return json(r);
  });

  server.tool('weekly_review', 'Weekly summary: goal/stage progress, completion patterns, metrics, replan suggestions.', {}, async () => {
    const r = toResult(() => {
      const ctx = ctxOf();
      const since = localDateKey(new Date(Date.now() - 7 * 86400_000), ctx.tz);
      return {
        since,
        goals: getActiveGoals(ctx).map((g) => ({ id: g.id, title: g.title, stages: listStages(ctx, g.id) })),
        metrics: computeMetrics(ctx, 7),
        growthEvents: listGrowthEvents(ctx, since, 30),
        feedback: recentFeedbackStats(ctx, 7),
      };
    });
    return json(r);
  });

  // ---------------- Planner context ----------------

  server.tool('get_planner_context', 'Everything the planner needs: yesterday actions, recent evidence/feedback, metrics, life context. Use before plan_today.', {}, async () => {
    const r = toResult(() => {
      const ctx = ctxOf();
      return { ...plannerContext(ctx), lifeContext: getActiveLifeContext(ctx) };
    });
    return json(r);
  });

  // ---------------- Reminders ----------------

  server.tool('list_reminders', 'List reminders for a date (default today).', { dateKey: optS }, async (args) => {
    const r = toResult(() => listRemindersForDate(ctxOf(), args.dateKey));
    return json(r);
  });

  server.tool('create_reminder', 'Create a reminder bound to an action. Daily actions are limited to 1 scheduled reminder each. Do NOT guess very specific times — ask once in daily planning if unknown.', {
    actionId: S,
    scheduledAt: S,
    channel: z.enum(['LOCAL_NOTIFICATION', 'WEB', 'OTHER']).optional(),
    allowMultiple: z.boolean().optional(),
  }, async (args) => {
    const r = toResult(() => createReminder(ctxOf(), args));
    return json(r);
  });

  server.tool('update_reminder', 'Reschedule a reminder.', { reminderId: S, scheduledAt: S }, async (args) => {
    const r = toResult(() => updateReminder(ctxOf(), args.reminderId, args.scheduledAt));
    return json(r);
  });

  server.tool('cancel_reminder', 'Cancel a reminder.', { reminderId: S, reason: optS }, async (args) => {
    const r = toResult(() => cancelReminder(ctxOf(), args.reminderId, args.reason ?? 'cancelled'));
    return json(r);
  });

  server.tool('cancel_action_reminders', 'Cancel all scheduled reminders of an action.', { actionId: S }, async (args) => {
    const r = toResult(() => ({ cancelled: cancelRemindersByAction(ctxOf(), args.actionId, 'user cancelled') }));
    return json(r);
  });

  // ---------------- Passport ----------------

  server.tool('get_passport', 'Get latest passport snapshot (or rebuild).', {}, async () => {
    const r = toResult(() => {
      const ctx = ctxOf();
      const snap = latestSnapshot(ctx);
      return snap ?? { snapshot: null, dirty: isPassportDirty(ctx) };
    });
    return json(r);
  });

  server.tool('rebuild_passport', 'Rebuild passport from source of truth (DB + memory).', {}, async () => {
    const r = toResult(() => generatePassport(ctxOf()));
    return json(r);
  });

  server.tool('sync_passport', 'Sync passport via configured adapter (local-json by default). Failures are queued for retry and never break local state.', {}, async () => {
    const r = await toResultAsync(() => syncPassport(ctxOf(), createPassportAdapter(cfg)));
    return json(r);
  });

  server.tool('retry_passport_sync', 'Retry pending/failed passport sync jobs.', {}, async () => {
    const r = await toResultAsync(() => retryPendingSyncs(ctxOf(), createPassportAdapter(cfg)));
    return json(r);
  });

  server.tool('list_sync_jobs', 'List passport sync jobs (status/attempts/lastError).', {}, async () => {
    const r = toResult(() => listSyncJobs(ctxOf()));
    return json(r);
  });

  // ---------------- Settings ----------------

  server.tool('get_setting', 'Read a setting (e.g. timezone).', { key: S }, async (args) => {
    const r = toResult(() => ({ key: args.key, value: getSetting(ctxOf(), args.key) }));
    return json(r);
  });

  server.tool('set_setting', 'Write a setting (e.g. timezone).', { key: S, value: S }, async (args) => {
    const r = toResult(() => {
      setSetting(ctxOf(), args.key, args.value);
      return { key: args.key, value: args.value };
    });
    return json(r);
  });

  server.tool('render_progress', '产出**带样式的进度报告**（Markdown + Mermaid 甘特图 + 进度条 + 事实表），用于把进度以非纯文字形式展示给用户。只想看结构化数据用 growth_status/get_today_plan；要展示给人看用这个。', {
    format: z.enum(['markdown', 'html']).optional(),
  }, async (args) => {
    const r = toResult(() => {
      const ctx = ctxOf();
      const report = renderProgress(ctx);
      return {
        title: report.title,
        facts: report.facts,
        markdown: report.markdown,
        html: args.format === 'html' ? report.html : undefined,
      };
    });
    return json(r);
  });

  server.tool('get_metrics', 'Local planner metrics (completion rate by kind, replan rate, feedback distribution, reminder response). For planner improvement — NOT a self-discipline score.', { windowDays: z.number().optional() }, async (args) => {
    const r = toResult(() => computeMetrics(ctxOf(), args.windowDays ?? 14));
    return json(r);
  });

  server.tool('server_time', 'Current ISO time and local date in configured timezone.', {}, async () => {
    const ctx = ctxOf();
    return json(ok({ iso: nowIso(), localDate: todayIn(ctx), timezone: ctx.tz }));
  });
}

function json(r: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
}
