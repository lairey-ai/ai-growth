/**
 * 领域类型定义（与 DB schema 对应）。
 * 状态机规则见附录 B：
 *  - Action: DRAFT → PLANNED → IN_PROGRESS → {COMPLETED, SKIPPED, CANCELLED, EXPIRED(DAILY), PENDING_REPLAN(MAIN), DELAYED}
 *  - Goal:   DRAFT → CONFIRMED → ACTIVE → {PAUSED↔ACTIVE, COMPLETED, ABANDONED}
 */

export type ActionKind = 'MAIN_QUEST' | 'DAILY';

export type ActionDomain =
  | 'LEARN' | 'BUILD' | 'TRAIN' | 'HABIT' | 'CREATE'
  | 'RELATIONSHIP' | 'EXPLORE' | 'LIFE' | 'OTHER';

export type ActionStatus =
  | 'DRAFT' | 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED'
  | 'DELAYED' | 'PENDING_REPLAN' | 'EXPIRED' | 'CANCELLED';

export type GoalStatus = 'DRAFT' | 'CONFIRMED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED';

export type StageStatus = 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'DELAYED' | 'SKIPPED';

export type EvidenceType = 'TEXT' | 'FILE' | 'GIT' | 'METRIC' | 'QUIZ' | 'ARTIFACT' | 'REFLECTION' | 'MANUAL';

export type EvidenceStrength = 'AUTO_VERIFIED' | 'USER_CONFIRMED' | 'AGENT_OBSERVED' | 'UNVERIFIED';

export type AssessmentLevel = 'EXPOSURE' | 'RECALL' | 'EXPLAIN' | 'APPLY' | 'REAL_WORLD_EVIDENCE';

export type TaskFeedbackReason =
  | 'NOT_INTERESTED' | 'BAD_TIMING' | 'TOO_HARD' | 'TOO_EASY'
  | 'ALREADY_DONE' | 'NOT_RELEVANT' | 'NO_TIME' | 'OTHER';

export type LifeContextMode = 'NORMAL' | 'BUSY' | 'RECOVERY' | 'TRAVEL' | 'FOCUS' | 'CUSTOM';

export interface Profile {
  id: string;
  displayName?: string;
  timezone: string;
  onboardingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  timePreferences: Record<string, unknown>;
  taskCapacity: { defaultDailyActions?: number; maxActionsPerDay?: number; [k: string]: unknown };
  learningPreferences: Record<string, unknown>;
  reminderPreferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: string;
  title: string;
  why: string;
  desiredOutcome: string;
  successCriteria: string[];
  motivation?: string;
  startDate?: string;
  targetDate?: string;
  status: GoalStatus;
  dailyTimeBudgetMinutes?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Stage {
  id: string;
  goalId: string;
  title: string;
  objective?: string;
  order: number;
  plannedStartDate?: string;
  plannedEndDate?: string;
  status: StageStatus;
  exitCriteria: string[];
}

export interface DailyPlan {
  id: string;
  dateKey: string;
  rationale?: string;
  status: 'DRAFT' | 'CONFIRMED';
  createdAt: string;
  confirmedAt?: string;
}

export interface Action {
  id: string;
  kind: ActionKind;
  domain: ActionDomain;
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
  planId?: string;
  dateKey: string;
  status: ActionStatus;
  skippedReason?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  id: string;
  actionId?: string;
  type: EvidenceType;
  strength: EvidenceStrength;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Reminder {
  id: string;
  actionId: string;
  scheduledAt: string;
  status: 'SCHEDULED' | 'SENT' | 'CANCELLED';
  channel: 'LOCAL_NOTIFICATION' | 'WEB' | 'OTHER';
  firedAt?: string;
  cancelledAt?: string;
}

export interface LifeContext {
  id: string;
  mode: LifeContextMode;
  availableMinutesPerDay?: number;
  startDate: string;
  expectedEndDate?: string;
  note?: string;
  confirmed: boolean;
  active: boolean;
}

export interface Memory {
  id: string;
  type: 'FACT' | 'PATTERN' | 'DECISION' | 'CHANGE';
  content: string;
  confidence: number;
  evidenceRefs: string[];
  confirmedByUser: boolean;
  createdAt: string;
}

export interface GrowthEvent {
  id: string;
  dateKey: string;
  title: string;
  description?: string;
  domain: ActionDomain;
  evidenceIds: string[];
  goalId?: string;
  stageId?: string;
  tags: string[];
}

export interface TaskFeedback {
  id: string;
  actionId: string;
  reason: TaskFeedbackReason;
  comment?: string;
  createdAt: string;
}

/** 打开（未终态）的 action */
export const OPEN_ACTION_STATUSES: ActionStatus[] = ['DRAFT', 'PLANNED', 'IN_PROGRESS', 'DELAYED', 'PENDING_REPLAN'];
export const TERMINAL_ACTION_STATUSES: ActionStatus[] = ['COMPLETED', 'SKIPPED', 'EXPIRED', 'CANCELLED'];
