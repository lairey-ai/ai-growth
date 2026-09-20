import type { CoreContext } from './context.js';
import { newId, ts, pj } from '../shared/util.js';
import type { Profile } from './types.js';
import { todayKey } from '../shared/time.js';

// ---------- row mapping ----------

type ProfileRow = {
  id: string; display_name: string | null; timezone: string; onboarding_status: string;
  time_preferences: string; task_capacity: string; learning_preferences: string;
  reminder_preferences: string; constraints: string; notes: string | null;
  created_at: string; updated_at: string; deleted_at: string | null;
};

function rowToProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    displayName: r.display_name ?? undefined,
    timezone: r.timezone,
    onboardingStatus: r.onboarding_status as Profile['onboardingStatus'],
    timePreferences: pj(r.time_preferences, {}),
    taskCapacity: pj(r.task_capacity, {}),
    learningPreferences: pj(r.learning_preferences, {}),
    reminderPreferences: pj(r.reminder_preferences, {}),
    constraints: pj(r.constraints, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- profile service ----------

export function getProfile(ctx: CoreContext): Profile | null {
  const row = ctx.db
    .prepare('SELECT * FROM profiles WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1')
    .get() as ProfileRow | undefined;
  return row ? rowToProfile(row) : null;
}

export function ensureProfile(ctx: CoreContext, timezone?: string): Profile {
  const existing = getProfile(ctx);
  if (existing) return existing;
  const id = newId();
  const now = ts();
  ctx.db
    .prepare(
      `INSERT INTO profiles (id, timezone, onboarding_status, created_at, updated_at)
       VALUES (?, ?, 'NOT_STARTED', ?, ?)`
    )
    .run(id, timezone ?? ctx.tz, now, now);
  return getProfile(ctx)!;
}

export interface UpdateProfileInput {
  displayName?: string;
  timezone?: string;
  onboardingStatus?: Profile['onboardingStatus'];
  timePreferences?: Record<string, unknown>;
  taskCapacity?: Profile['taskCapacity'];
  learningPreferences?: Record<string, unknown>;
  reminderPreferences?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
}

export function updateProfile(ctx: CoreContext, input: UpdateProfileInput): Profile {
  const current = getProfile(ctx);
  if (!current) throw new Error('Profile does not exist; call ensureProfile first');
  const next = {
    displayName: input.displayName ?? current.displayName,
    timezone: input.timezone ?? current.timezone,
    onboardingStatus: input.onboardingStatus ?? current.onboardingStatus,
    timePreferences: input.timePreferences ?? current.timePreferences,
    taskCapacity: input.taskCapacity ?? current.taskCapacity,
    learningPreferences: input.learningPreferences ?? current.learningPreferences,
    reminderPreferences: input.reminderPreferences ?? current.reminderPreferences,
    constraints: input.constraints ?? current.constraints,
  };
  ctx.db
    .prepare(
      `UPDATE profiles SET display_name=?, timezone=?, onboarding_status=?, time_preferences=?,
       task_capacity=?, learning_preferences=?, reminder_preferences=?, constraints=?, updated_at=?
       WHERE id=?`
    )
    .run(
      next.displayName ?? null, next.timezone, next.onboardingStatus,
      JSON.stringify(next.timePreferences), JSON.stringify(next.taskCapacity),
      JSON.stringify(next.learningPreferences), JSON.stringify(next.reminderPreferences),
      JSON.stringify(next.constraints), ts(), current.id
    );
  return getProfile(ctx)!;
}

/** 解决"当前时区"：settings.timezone > profile.timezone > ctx.tz */
export function resolveTimezone(ctx: CoreContext): string {
  const s = getSetting(ctx, 'timezone');
  if (s) return s;
  const p = getProfile(ctx);
  if (p?.timezone) return p.timezone;
  return ctx.tz;
}

// ---------- settings ----------

export function getSetting(ctx: CoreContext, key: string): string | null {
  const row = ctx.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(ctx: CoreContext, key: string, value: string): void {
  ctx.db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    )
    .run(key, value, ts());
}

// ---------- system state ----------

export function getSystemState(ctx: CoreContext, key: string): string | null {
  const row = ctx.db.prepare('SELECT value FROM system_state WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSystemState(ctx: CoreContext, key: string, value: string): void {
  ctx.db
    .prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    )
    .run(key, value, ts());
}

export function lastRolloverDate(ctx: CoreContext): string | null {
  return getSystemState(ctx, 'last_rollover_date');
}

export function todayIn(ctx: CoreContext): string {
  return todayKey(resolveTimezone(ctx));
}
