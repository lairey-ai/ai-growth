import type { CoreContext } from './context.js';
import { getProfile, ensureProfile, getSetting } from './profile.js';
import { getActiveGoals, getCurrentStage } from './goals.js';
import { getTodayPlan } from './actions.js';
import { hasPendingReplan } from './rollover.js';
import { getActiveLifeContext } from './lifeContext.js';
import type { GrowthStatus } from './rolloverTypes.js';

/**
 * growth_status（§27 Agent Handoff）。
 * 一个新 Agent 调用此 tool 就能判断当前该做什么。
 */
export function growthStatus(ctx: CoreContext): GrowthStatus {
  const profile = getProfile(ctx);
  const onboarding: GrowthStatus['onboarding'] =
    !profile || profile.onboardingStatus === 'NOT_STARTED'
      ? 'NOT_STARTED'
      : profile.onboardingStatus === 'IN_PROGRESS'
        ? 'IN_PROGRESS'
        : 'COMPLETED';
  const goals = getActiveGoals(ctx);
  const primaryGoal = goals[0];
  const stage = primaryGoal ? getCurrentStage(ctx, primaryGoal.id) : null;
  const { plan, actions: todayActionsAll } = getTodayPlan(ctx);
  const life = getActiveLifeContext(ctx);
  const passportUpdated = getSetting(ctx, 'passport_last_generated_at') ?? undefined;

  let suggested = 'START_ONBOARDING';
  if (onboarding !== 'COMPLETED') {
    suggested = onboarding === 'NOT_STARTED' ? 'START_ONBOARDING' : 'CONTINUE_ONBOARDING';
  } else if (hasPendingReplan(ctx)) {
    suggested = 'RESOLVE_REPLAN';
  } else if (goals.length === 0) {
    suggested = 'DISCUSS_GOAL';
  } else if (!plan) {
    suggested = 'RUN_DAILY_PLANNING';
  } else if (plan.status === 'DRAFT') {
    suggested = 'CONFIRM_TODAY_PLAN';
  } else {
    suggested = 'CONTINUE_TODAY';
  }

  const todayActions = todayActionsAll.filter(
    (a) => !['COMPLETED', 'SKIPPED', 'CANCELLED', 'EXPIRED'].includes(a.status)
  );

  return {
    onboarding,
    hasProfile: !!profile,
    activeGoalCount: goals.length,
    currentStageTitle: stage?.title,
    currentStageOrder: stage ? `${stage.order}` : undefined,
    todayPlanStatus: !plan ? 'NOT_CREATED' : plan.status,
    pendingReplan: hasPendingReplan(ctx),
    lifeContextMode: life?.mode ?? 'NORMAL',
    passportLastUpdatedAt: passportUpdated,
    suggestedNextOperation: suggested,
    openActionCountToday: todayActions.length,
  };
}

export { ensureProfile, getProfile, getActiveGoals };
