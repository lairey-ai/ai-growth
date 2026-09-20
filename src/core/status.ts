import type { CoreContext } from './context.js';
import { getProfile, ensureProfile, getSetting } from './profile.js';
import { getActiveGoals, getCurrentStage, listGoals, listStages } from './goals.js';
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
  // ⚠️ 不能只看 ACTIVE 目标。目标处于 DRAFT（草稿待确认）或 CONFIRMED（已确认、尚未激活）时，
  //   getActiveGoals() 也是空的 —— 于是这里会走到"没有目标 → 去聊目标"，
  //   而用户明明已经访谈完、目标也确认过了。真机上就是这么把人卡住的：
  //   status 说 DISCUSS_GOAL，但该做的是"排阶段计划"。
  const openGoals = listGoals(ctx, ['DRAFT', 'CONFIRMED', 'ACTIVE']);
  const goals = openGoals.filter((g) => g.status === 'ACTIVE');
  const primaryGoal = goals[0] ?? openGoals.find((g) => g.status === 'CONFIRMED') ?? openGoals[0];
  const stage = primaryGoal ? getCurrentStage(ctx, primaryGoal.id) : null;
  const hasStage = primaryGoal ? listStages(ctx, primaryGoal.id).length > 0 : false;
  const { plan, actions: todayActionsAll } = getTodayPlan(ctx);
  const life = getActiveLifeContext(ctx);
  const passportUpdated = getSetting(ctx, 'passport_last_generated_at') ?? undefined;

  let suggested = 'START_ONBOARDING';
  if (onboarding !== 'COMPLETED') {
    suggested = onboarding === 'NOT_STARTED' ? 'START_ONBOARDING' : 'CONTINUE_ONBOARDING';
  } else if (hasPendingReplan(ctx)) {
    suggested = 'RESOLVE_REPLAN';
  } else if (openGoals.length === 0) {
    suggested = 'DISCUSS_GOAL';
  } else if (openGoals.some((g) => g.status === 'DRAFT')) {
    // 草稿还在等用户确认 —— 这一步必须先做，否则后面做什么都不作数
    suggested = 'CONFIRM_GOAL';
  } else if (!hasStage) {
    // 有目标但没阶段计划：每日任务是**从当前阶段生成的**，没有阶段就排不出今天
    suggested = 'CREATE_STAGE_PLAN';
  } else if (goals.length === 0) {
    // 阶段排好了但目标还没激活（PAUSED 也落这里）
    suggested = 'ACTIVATE_GOAL';
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
