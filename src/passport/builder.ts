import type { CoreContext } from '../core/context.js';
import { getProfile } from '../core/profile.js';
import { getActiveGoals, getCurrentStage, listStages } from '../core/goals.js';
import { listGrowthEvents } from '../core/evidence.js';
import { listMemories } from '../core/memory.js';
import { getActiveLifeContext } from '../core/lifeContext.js';
import { saveSnapshot, flagPassportDirty } from './state.js';
import { nowIso } from '../shared/time.js';

/**
 * Passport 结构（V1.1 §26）。压缩状态，可由 DB + Memory 完整重建。
 * 只放 Agent 接手当前用户真正需要的压缩信息。
 */
export interface Passport {
  schemaVersion: string;
  generatedAt: string;
  identity: {
    displayName?: string;
    stablePreferences: string[];
  };
  currentState: {
    currentChapter?: string;
    activeGoals: Array<{
      id: string;
      title: string;
      why: string;
      desiredOutcome: string;
      targetDate?: string;
      currentStage?: { title: string; order: number; total: number };
    }>;
    lifeContext?: string;
    currentFocus: string[];
  };
  capabilities: Array<{
    topic: string;
    level: string;
    basis: string;
    assessedAt?: string;
  }>;
  recentGrowth: Array<{
    date: string;
    title: string;
    domain: string;
    evidenceCount: number;
  }>;
  planningHints: string[];
}

export const PASSPORT_SCHEMA_VERSION = '1.1.0';

/** 从 Source of Truth（Growth DB + Memory）重建 Passport */
export function buildPassport(ctx: CoreContext): Passport {
  const profile = getProfile(ctx);
  const goals = getActiveGoals(ctx);
  const life = getActiveLifeContext(ctx);

  const activeGoals = goals.slice(0, 3).map((g) => {
    const stage = getCurrentStage(ctx, g.id);
    const all = listStages(ctx, g.id);
    return {
      id: g.id,
      title: g.title,
      why: g.why,
      desiredOutcome: g.desiredOutcome,
      targetDate: g.targetDate,
      currentStage: stage ? { title: stage.title, order: stage.order, total: all.length } : undefined,
    };
  });

  const growthEvents = listGrowthEvents(ctx, undefined, 10);

  // capabilities：来自 assessments 的最近知识状态（§22）
  // 注意：同一 topic 可能有多条评估，必须取"最近一次提交"。
  // created_at 在批量写入时会撞同一毫秒，故用 updated_at + rowid 作为稳定排序键。
  const assessmentRows = ctx.db
    .prepare(
      `SELECT topic, level, passed, updated_at FROM assessments ORDER BY updated_at DESC, rowid DESC LIMIT 50`
    )
    .all() as { topic: string; level: string; passed: number; updated_at: string }[];
  const latestByTopic = new Map<string, { topic: string; level: string; passed: number; updated_at: string }>();
  for (const a of assessmentRows) if (!latestByTopic.has(a.topic)) latestByTopic.set(a.topic, a);
  const capabilities = [...latestByTopic.values()]
    .filter((a) => a.passed)
    .slice(0, 12)
    .map((a) => ({ topic: a.topic, level: a.level, basis: 'assessment', assessedAt: a.updated_at }));

  // 记忆中的稳定偏好（仅用户确认过的）
  const confirmedStable = listMemories(ctx, { limit: 30 })
    .filter((m) => m.confirmedByUser && m.type === 'FACT')
    .map((m) => m.content)
    .slice(0, 8);

  const planningHints: string[] = [];
  if (life?.mode && life.mode !== 'NORMAL') {
    planningHints.push(`LifeContext: ${life.mode}${life.availableMinutesPerDay ? `, ~${life.availableMinutesPerDay} min/day` : ''}`);
  }
  planningHints.push('Daily Actions must trace to user-confirmed directions only');
  planningHints.push('Default load: 1 Main Quest + 0~2 Daily Actions');

  return {
    schemaVersion: PASSPORT_SCHEMA_VERSION,
    generatedAt: nowIso(),
    identity: {
      displayName: profile?.displayName,
      stablePreferences: confirmedStable,
    },
    currentState: {
      currentChapter: activeGoals[0]?.currentStage?.title,
      activeGoals,
      lifeContext: life ? `${life.mode}${life.note ? `: ${life.note}` : ''}` : undefined,
      currentFocus: goals.map((g) => g.title).slice(0, 3),
    },
    capabilities,
    recentGrowth: growthEvents.map((e) => ({
      date: e.dateKey,
      title: e.title,
      domain: e.domain,
      evidenceCount: e.evidenceIds.length,
    })),
    planningHints,
  };
}

export function generatePassport(ctx: CoreContext): Passport {
  const passport = buildPassport(ctx);
  saveSnapshot(ctx, JSON.stringify(passport));
  return passport;
}

export { flagPassportDirty, recentEvidenceCount };
function recentEvidenceCount(ctx: CoreContext): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n;
}
