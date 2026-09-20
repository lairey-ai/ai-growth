/**
 * 版本化 Prompts（§20）。
 * 优先让外部 Agent 通过 Skill + MCP 承担对话智能；这些 prompt 供 daemon 内部
 * AI Provider 做后台可自动执行的结构化工作（未配置 AIProvider 时 Core 全部降级为
 * 纯结构化 primitive，不阻塞 V1）。
 */
export const PROMPTS = {
  onboarding: {
    version: 'v1',
    prompt: `You are interviewing the user to build a growth profile. Ask conversationally, one topic at a time. Cover: main goal now, expected real outcome (not "finish a course"), target period, daily time available, current level, life constraints, life areas to improve, task load preference. Output strict JSON: {goalTitle, why, desiredOutcome, successCriteria[], targetDate, dailyTimeBudgetMinutes, constraints, loadPreference}.`,
  },
  goalPlanner: {
    version: 'v1',
    prompt: `Given the interview result, produce a goal draft with why / desiredOutcome / successCriteria. Success criteria must be observable outcomes (runnable project, passing assessment, real metric), not "finished content". Output strict JSON matching the create_goal_draft tool schema.`,
  },
  stagePlanner: {
    version: 'v1',
    prompt: `Given a confirmed goal and its period, produce 3-7 stages with objectives and exit criteria. Do NOT generate any daily actions. Stages must be verifiable milestones. Output strict JSON: {stages:[{title, objective, exitCriteria[]}]}.`,
  },
  dailyPlanner: {
    version: 'v1',
    prompt: `Given planner context (active goals, current stage, yesterday's actions, recent evidence, feedback, life context, available minutes), propose today's plan: exactly 1 Main Quest (whyToday, completionCriteria, estimatedMinutes — a step that fits available time) + 0-2 Daily Actions (only from user-confirmed directions). Reduce load when life context is BUSY/RECOVERY/TRAVEL. Output strict JSON matching the plan_today tool schema.`,
  },
  replan: {
    version: 'v1',
    prompt: `A Main Quest was not completed. Given the action, the reason, feedback and stage plan, choose: CONTINUE (retry today), ADJUST (change scope/difficulty), SPLIT (smaller steps), DELAY_STAGE (push stage window), or CANCEL. Prefer the smallest change that preserves the goal. Anything that clearly moves the final deadline requires asking the user first.`,
  },
  assessment: {
    version: 'v1',
    prompt: `Generate a short assessment for the given learning topic at the given level (EXPOSURE/RECALL/EXPLAIN/APPLY). For engineering topics prefer a practical exercise over multiple choice. Your own quiz score alone never proves mastery.`,
  },
  dailyReview: {
    version: 'v1',
    prompt: `Summarize today: main quest done? key evidence? was the task load reasonable? any change worth remembering? any replan needed? Keep it under 120 words. No personality judgments without evidence.`,
  },
  passport: {
    version: 'v1',
    prompt: `Compress the user's current human state into a passport: current chapter, active goals, capabilities with evidence, recent growth, planning hints. Only what a new agent needs to take over. Never invent facts.`,
  },
} as const;
