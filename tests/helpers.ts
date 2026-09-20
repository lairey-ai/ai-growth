import { openTestDb, type DB } from '../src/db/client.js';
import { makeCtx } from '../src/mcp/ctx.js';
import type { CoreContext } from '../src/core/context.js';
import type { AppConfig } from '../src/shared/config.js';

export interface TestEnv {
  db: DB;
  ctx: CoreContext;
  cfg: AppConfig;
}

export function testEnv(tz = 'Asia/Shanghai'): TestEnv {
  const db = openTestDb();
  const cfg: AppConfig = {
    dataDir: '/tmp/ai-growth-test',
    timezone: tz,
    logLevel: 'error',
    apiPort: 4599,
    passportAdapter: 'local-json',
    passportFile: 'passport.json',
  };
  const ctx = makeCtx(db, cfg, 'test');
  return { db, ctx, cfg };
}

/** 固定 date_key 创建 action 的便捷函数 */
export async function noop(): Promise<void> {}
