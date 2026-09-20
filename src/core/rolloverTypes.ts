export interface RolloverResult {
  today: string;
  alreadyRan: boolean;
  expiredDailyActionIds: string[];
  pendingReplanMainQuestIds: string[];
  cancelledReminderCount: number;
}

export interface GrowthStatus {
  onboarding: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  hasProfile: boolean;
  activeGoalCount: number;
  currentStageTitle?: string;
  currentStageOrder?: string;
  todayPlanStatus: 'NOT_CREATED' | 'DRAFT' | 'CONFIRMED';
  pendingReplan: boolean;
  lifeContextMode: string;
  passportLastUpdatedAt?: string;
  suggestedNextOperation: string;
  openActionCountToday: number;
}
