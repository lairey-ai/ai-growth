import type { CoreContext } from '../core/context.js';
import { loadConfig, type AppConfig } from '../shared/config.js';
import { openDb, type DB } from '../db/client.js';
import { makeCtx } from '../mcp/ctx.js';
import { runDailyRollover } from '../core/rollover.js';
import { deactivateExpiredLifeContexts } from '../core/lifeContext.js';
import { listDueReminders, markReminderSent } from './service.js';
import { createNotificationAdapter, type NotificationAdapter } from './notify.js';
import { retryPendingSyncs, createPassportAdapter } from '../passport/sync.js';
import { getAction } from '../core/actions.js';
import { nowIso } from '../shared/time.js';

const CHECK_INTERVAL_MS = 30_000; // 30s：提醒精度 & rollover 检测
const SYNC_RETRY_INTERVAL_MS = 10 * 60_000;

/**
 * 常驻 Scheduler（§12）：
 * - 每 tick：rollover（幂等）→ 到期提醒触发（幂等）→ 过期 LifeContext 清理
 * - 定期重试 Passport 同步
 * - 崩溃/重启后自动恢复（所有状态在 DB，进程无状态）
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private running = false;
  readonly db: DB;
  readonly cfg: AppConfig;
  readonly notifier: NotificationAdapter;

  constructor(db?: DB, cfg?: AppConfig, notifier?: NotificationAdapter) {
    this.cfg = cfg ?? loadConfig();
    this.db = db ?? openDb(this.cfg.dataDir);
    this.notifier = notifier ?? createNotificationAdapter('macos-local');
  }

  start(): void {
    this.tick(); // 启动立即跑一次（覆盖开机错过的时间）
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this.syncTimer = setInterval(() => this.syncTick(), SYNC_RETRY_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.syncTimer) clearInterval(this.syncTimer);
  }

  /** 单次 tick：可独立调用（测试 / API 触发） */
  async tick(): Promise<{ rolloverRan: boolean; remindersFired: number; lifeContextsExpired: number }> {
    if (this.running) return { rolloverRan: false, remindersFired: 0, lifeContextsExpired: 0 }; // 防重入
    this.running = true;
    try {
      const ctx = makeCtx(this.db, this.cfg, 'daemon');
      const rollover = runDailyRollover(ctx);
      const lifeExpired = deactivateExpiredLifeContexts(ctx);
      const fired = await this.fireDueReminders(ctx);
      return { rolloverRan: !rollover.alreadyRan, remindersFired: fired, lifeContextsExpired: lifeExpired };
    } finally {
      this.running = false;
    }
  }

  private async fireDueReminders(ctx: CoreContext): Promise<number> {
    const due = listDueReminders(ctx, nowIso());
    let fired = 0;
    for (const rem of due) {
      // 幂等标记先做；通知失败不回滚状态（下次不会重复发）
      markReminderSent(ctx, rem.id);
      const action = getAction(ctx, rem.actionId);
      try {
        await this.notifier.notify({
          title: action ? `AI Growth: ${action.title}` : 'AI Growth 提醒',
          body: action?.completionCriteria ?? '该做今天的任务了',
        });
        fired++;
      } catch (e) {
        process.stderr.write(`[ai-growth] notify failed: ${e instanceof Error ? e.message : e}\n`);
      }
    }
    return fired;
  }

  private async syncTick(): Promise<void> {
    const ctx = makeCtx(this.db, this.cfg, 'daemon');
    try {
      await retryPendingSyncs(ctx, createPassportAdapter(this.cfg));
    } catch (e) {
      process.stderr.write(`[ai-growth] passport sync retry failed: ${e instanceof Error ? e.message : e}\n`);
    }
  }
}
