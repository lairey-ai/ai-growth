import { DomainError, ErrorCodes } from '../shared/result.js';
import type { ActionKind, ActionStatus, GoalStatus } from './types.js';

/**
 * 状态机转换表（附录 B）。不得允许非法状态转换静默发生。
 *
 * 关于 PLANNED → COMPLETED：IN_PROGRESS 是**可选**的中间态（用于跨度较大的任务）。
 * 用户/Agent 说"做完了"时若从未显式 start，直接完成是合法的 —— 否则会强迫用户
 * 为一个仪式性动作多操作一步，违反 §21「低风险任务允许一句话确认」与 §17.2。
 *
 * 关于 EXPIRED：任何**未终结**的 DAILY 跨天后都必须能过期。
 * 用户会「开始了没做完」(IN_PROGRESS) 或「主动延期」(DELAYED)，这些同样要过期，
 * 否则 rollover 会抛异常并整体回滚，把系统卡死在无法 rollover 的状态。
 * （EXPIRED 仅 DAILY 的约束由 assertActionTransition 的 kind 检查保证。）
 *
 * Action 注意：PENDING_REPLAN 主要为 MAIN。
 */
const ACTION_TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'SKIPPED', 'EXPIRED', 'PENDING_REPLAN', 'DELAYED', 'DRAFT'],
  IN_PROGRESS: ['COMPLETED', 'SKIPPED', 'CANCELLED', 'PENDING_REPLAN', 'DELAYED', 'EXPIRED'],
  DELAYED: ['PLANNED', 'COMPLETED', 'CANCELLED', 'PENDING_REPLAN', 'SKIPPED', 'EXPIRED'],
  PENDING_REPLAN: ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DELAYED', 'SKIPPED', 'EXPIRED'],
  COMPLETED: [],
  SKIPPED: [],
  EXPIRED: [],
  CANCELLED: [],
};

const GOAL_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  DRAFT: ['CONFIRMED'],
  CONFIRMED: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'COMPLETED', 'ABANDONED'],
  PAUSED: ['ACTIVE', 'ABANDONED', 'COMPLETED'],
  COMPLETED: [],
  ABANDONED: [],
};

export function assertActionTransition(from: ActionStatus, to: ActionStatus, kind: ActionKind): void {
  if (to === 'EXPIRED' && kind !== 'DAILY') {
    throw new DomainError(ErrorCodes.INVALID_STATE, `EXPIRED is only valid for DAILY actions, got ${kind}`);
  }
  const allowed = ACTION_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new DomainError(
      ErrorCodes.INVALID_STATE,
      `Illegal action transition: ${from} → ${to}`
    );
  }
}

export function canActionTransition(from: ActionStatus, to: ActionStatus, kind: ActionKind): boolean {
  try {
    assertActionTransition(from, to, kind);
    return true;
  } catch {
    return false;
  }
}

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  const allowed = GOAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new DomainError(ErrorCodes.INVALID_STATE, `Illegal goal transition: ${from} → ${to}`);
  }
}

export function isTerminalActionStatus(s: ActionStatus): boolean {
  return ['COMPLETED', 'SKIPPED', 'EXPIRED', 'CANCELLED'].includes(s);
}
