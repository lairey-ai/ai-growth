import type { CoreContext } from './context.js';
import { writeAudit } from './context.js';
import { DomainError, ErrorCodes } from '../shared/result.js';
import { todayIn } from './profile.js';
import {
  getAction, updateAction, cancelAction, rearmAction, createAction,
} from './actions.js';
import { shiftStagesFrom, getStage } from './goals.js';
import { listPendingReplanActions } from './rollover.js';

export type ReplanResolution =
  | 'CONTINUE' // 今天继续做（原任务移到今天）
  | 'ADJUST'   // 调整内容/难度后今天继续
  | 'SPLIT'    // 拆分为多个更小任务
  | 'DELAY_STAGE' // 顺延后续 Stage，任务重排
  | 'CANCEL';  // 放弃该任务

export interface ResolveReplanInput {
  actionId?: string; // 不填 = 处理最老的一个 pending replan
  resolution: ReplanResolution;
  reason: string;
  adjust?: {
    title?: string;
    description?: string;
    estimatedMinutes?: number;
    completionCriteria?: string;
    verificationStrategy?: string;
  };
  splitInto?: Array<{ title: string; estimatedMinutes?: number; completionCriteria?: string }>;
  delayDays?: number;
}

/**
 * Replan Engine（§4）。执行层调整 Agent 可自主执行；
 * 若 resolution 会明显影响 Goal Deadline（DELAY_STAGE 大幅顺延），调用方必须先获得用户确认。
 * 状态规则全部由 Core 保证，不依赖模型"记得遵守"。
 */
export function resolveReplan(ctx: CoreContext, input: ResolveReplanInput) {
  let targetId = input.actionId;
  if (!targetId) {
    const pending = listPendingReplanActions(ctx);
    if (pending.length === 0) throw new DomainError(ErrorCodes.NOT_FOUND, 'No pending replan actions');
    targetId = pending[0].id;
  }
  const action = getAction(ctx, targetId);
  if (!action) throw new DomainError(ErrorCodes.NOT_FOUND, `Action not found: ${targetId}`);
  if (action.status !== 'PENDING_REPLAN') {
    throw new DomainError(ErrorCodes.INVALID_STATE, `Action ${targetId} is not PENDING_REPLAN (got ${action.status})`);
  }
  const today = todayIn(ctx);

  // 决策级审计（§29.3）：单个 action/stage 的改动各自有审计，
  // 这里额外记录"Replan 决策本身"（选了哪种解法、为什么），便于回答"为什么这个任务被改了"。
  writeAudit(ctx, {
    entityType: 'replan',
    entityId: action.id,
    before: { status: action.status, dateKey: action.dateKey, title: action.title },
    after: { resolution: input.resolution, reason: input.reason, ...(input.adjust ?? {}), delayDays: input.delayDays },
    reason: input.reason,
  });

  switch (input.resolution) {
    case 'CONTINUE': {
      const updated = rearmToToday(ctx, action.id, today);
      return { resolution: 'CONTINUE', action: updated };
    }
    case 'ADJUST': {
      if (input.adjust) {
        updateAction(ctx, action.id, { ...input.adjust }, `replan adjust: ${input.reason}`);
      }
      const updated = rearmToToday(ctx, action.id, today);
      return { resolution: 'ADJUST', action: updated };
    }
    case 'SPLIT': {
      if (!input.splitInto?.length) {
        throw new DomainError(ErrorCodes.VALIDATION_ERROR, 'SPLIT requires splitInto tasks');
      }
      const children = input.splitInto.map((s) =>
        createAction(ctx, {
          kind: 'MAIN_QUEST',
          title: s.title,
          estimatedMinutes: s.estimatedMinutes,
          completionCriteria: s.completionCriteria,
          whyToday: action.whyToday,
          basis: action.basis,
          basisGoalId: action.basisGoalId,
          basisStageId: action.basisStageId,
          basisDirectionId: action.basisDirectionId,
          verificationStrategy: action.verificationStrategy,
        })
      );
      const cancelled = cancelAction(ctx, action.id, `replan split into ${children.length} tasks: ${input.reason}`);
      return { resolution: 'SPLIT', action: cancelled, createdActions: children };
    }
    case 'DELAY_STAGE': {
      const days = input.delayDays ?? 1;
      let stages: unknown = null;
      if (action.basisStageId) {
        const stage = getStage(ctx, action.basisStageId);
        if (stage) stages = shiftStagesFrom(ctx, stage.goalId, stage.id, days, `replan delay: ${input.reason}`);
      }
      const updated = rearmToToday(ctx, action.id, today);
      return { resolution: 'DELAY_STAGE', action: updated, stages };
    }
    case 'CANCEL': {
      const cancelled = cancelAction(ctx, action.id, `replan cancel: ${input.reason}`);
      return { resolution: 'CANCEL', action: cancelled };
    }
  }
}

function rearmToToday(ctx: CoreContext, actionId: string, today: string) {
  const a = getAction(ctx, actionId)!;
  if (a.dateKey !== today) updateAction(ctx, actionId, { dateKey: today }, 'replan move to today');
  return rearmAction(ctx, actionId);
}

/** Planner hint 数据：给 Agent 决策下一步用（Core 不做 LLM 判断） */
export function replanHints(ctx: CoreContext): {
  pendingReplans: { id: string; title: string; dateKey: string }[];
  rules: string[];
} {
  return {
    pendingReplans: listPendingReplanActions(ctx).map((a) => ({ id: a.id, title: a.title, dateKey: a.date_key })),
    rules: [
      '先调整 Action，再调整 Stage 内部节奏，再使用缓冲时间',
      '影响 Goal Deadline / Scope 的调整必须生成 Proposal 并让用户确认',
      '大幅改变最终 Deadline 前必须确认（V1.1 §23.4）',
    ],
  };
}
