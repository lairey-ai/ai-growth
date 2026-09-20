import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../shared/config.js';
import { enqueueSyncJob, listSyncJobs, markSyncJob } from './state.js';
import type { Passport } from './builder.js';
import { generatePassport } from './builder.js';
import type { CoreContext } from '../core/context.js';

/**
 * Passport Sync Adapter Interface（§8）。
 * 外部 API 未确定时先用 Local JSON Adapter，不阻塞 Core。
 */
export interface PassportSyncAdapter {
  readonly name: string;
  /** 同步成功返回 true；失败抛错或返回 false（进入重试队列） */
  sync(passport: Passport): Promise<boolean>;
}

export class LocalJsonPassportAdapter implements PassportSyncAdapter {
  readonly name = 'local-json';
  constructor(private cfg: AppConfig) {}

  async sync(passport: Passport): Promise<boolean> {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    const file = join(this.cfg.dataDir, this.cfg.passportFile);
    writeFileSync(file, JSON.stringify(passport, null, 2));
    return true;
  }
}

export function createPassportAdapter(cfg: AppConfig): PassportSyncAdapter {
  switch (cfg.passportAdapter) {
    case 'local-json':
    default:
      return new LocalJsonPassportAdapter(cfg);
  }
}

/** 同步（幂等）：生成 → enqueue job → 尝试同步；失败不回滚本地状态（Scenario K） */
export async function syncPassport(ctx: CoreContext, adapter: PassportSyncAdapter): Promise<{ ok: boolean; jobId: string }> {
  const passport = generatePassport(ctx);
  const jobId = enqueueSyncJob(ctx, { schemaVersion: passport.schemaVersion, generatedAt: passport.generatedAt });
  try {
    markSyncJob(ctx, jobId, 'RUNNING');
    const okSync = await adapter.sync(passport);
    if (okSync) {
      markSyncJob(ctx, jobId, 'DONE');
      return { ok: true, jobId };
    }
    markSyncJob(ctx, jobId, 'FAILED', 'adapter returned false');
    return { ok: false, jobId };
  } catch (e) {
    markSyncJob(ctx, jobId, 'FAILED', e instanceof Error ? e.message : String(e));
    return { ok: false, jobId };
  }
}

/** 重试队列中 PENDING/FAILED 的 job */
export async function retryPendingSyncs(ctx: CoreContext, adapter: PassportSyncAdapter): Promise<number> {
  const jobs = listSyncJobs(ctx, 'PENDING').concat(listSyncJobs(ctx, 'FAILED'));
  let done = 0;
  for (const job of jobs) {
    const passport = generatePassport(ctx);
    try {
      const ok = await adapter.sync(passport);
      markSyncJob(ctx, job.id, ok ? 'DONE' : 'FAILED', ok ? undefined : 'adapter returned false');
      if (ok) done++;
    } catch (e) {
      markSyncJob(ctx, job.id, 'FAILED', e instanceof Error ? e.message : String(e));
    }
  }
  return done;
}
