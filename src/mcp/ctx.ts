import type { DB } from '../db/client.js';
import type { CoreContext } from '../core/context.js';
import type { AppConfig } from '../shared/config.js';

/**
 * 每次操作构造 ctx（timezone 实时解析：settings > profile > 默认）。
 * 所有状态变更必须通过 Core Service（§23.9），MCP 层只做参数校验与转发。
 */
export function makeCtx(db: DB, cfg: AppConfig, actor = 'agent'): CoreContext {
  // resolve timezone: settings.timezone > profiles.timezone > cfg.timezone
  let tz = cfg.timezone;
  try {
    const s = db.prepare("SELECT value FROM settings WHERE key='timezone'").get() as { value: string } | undefined;
    if (s?.value) tz = s.value;
    else {
      const p = db.prepare('SELECT timezone FROM profiles WHERE deleted_at IS NULL LIMIT 1').get() as { timezone: string } | undefined;
      if (p?.timezone) tz = p.timezone;
    }
  } catch {
    /* table may not exist during early init */
  }
  return { db, tz, actor };
}

import { ok, err, type ToolResult } from '../shared/result.js';
import { DomainError } from '../shared/result.js';

export function toResult<T>(fn: () => T): ToolResult<T> {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof DomainError) {
      return err(e.code, e.message, e.retryable);
    }
    const message = e instanceof Error ? e.message : String(e);
    return err('INTERNAL', message);
  }
}

export async function toResultAsync<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof DomainError) {
      return err(e.code, e.message, e.retryable);
    }
    const message = e instanceof Error ? e.message : String(e);
    return err('INTERNAL', message);
  }
}
