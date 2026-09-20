/**
 * HTTP API 工厂（无模块级副作用，便于测试）。
 * 入口是 src/api/server.ts；测试直接 import createApiServer 并用随机端口监听。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../db/client.js';
import type { AppConfig } from '../shared/config.js';
import { makeCtx } from '../mcp/ctx.js';
import { ok, err, DomainError } from '../shared/result.js';
import { handleDeviceRequest } from '../device/http.js';

import { growthStatus } from '../core/status.js';
import { getTodayPlan, completeAction, skipAction, delayAction } from '../core/actions.js';
import { getActiveGoals, listStages, getCurrentStage, listGoals } from '../core/goals.js';
import { listGrowthEvents, listEvidence } from '../core/evidence.js';
import { latestSnapshot } from '../passport/state.js';
import { getSetting, setSetting, todayIn, resolveTimezone } from '../core/profile.js';
import { localDateKey } from '../shared/time.js';
import { runDailyRollover } from '../core/rollover.js';
import { listRemindersForDate } from '../reminder/service.js';
import { getActiveLifeContext } from '../core/lifeContext.js';
import { computeMetrics } from '../core/metrics.js';

/** 静态资源目录：与产物同目录（src/ui ↔ dist/ui） */
const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function send(res: ServerResponse, status: number, body: unknown, contentType?: string): void {
  const isString = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': contentType ?? (isString ? 'text/html; charset=utf-8' : 'application/json'),
  });
  res.end(isString ? body : JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

/**
 * Host 白名单校验：只允许本机地址。
 * 本系统没有账号体系（本地进程 + Agent 工具），安全边界不是"登录"而是 loopback：
 * 这条校验阻止浏览器里的任意网页通过 DNS rebinding / CSRF 驱动本地 Growth 数据。
 */
export function isLocalHost(host?: string): boolean {
  if (!host) return false; // HTTP/1.1 必须有 Host
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(name);
}

/** 计数辅助：只读，用于面板展示可核对事实。from 为表名或 "表名 WHERE ..." 片段 */
function countRows(ctx: ReturnType<typeof makeCtx>, from: string): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get() as { n: number }).n;
}

export function createApiServer(db: DB, cfg: AppConfig): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${cfg.apiPort}`);
    const path = url.pathname;
    const ctx = () => makeCtx(db, cfg, 'web');

    try {
      // 设备接口优先：它自带令牌校验，且局域网开启时**不能**受 Host 头限制
      // （否则局域网客户端伪造 Host: 127.0.0.1 就能绕过令牌）。
      // 详见 src/device/token.ts 的安全模型说明。
      if (await handleDeviceRequest({ ctx, req, res, path, url, cfg })) return;

      if (!isLocalHost(req.headers.host)) {
        return send(res, 403, err('FORBIDDEN_HOST', 'This service only accepts requests addressed to localhost.'));
      }

      // ---------- static ----------
      if (req.method === 'GET' && !path.startsWith('/api/')) {
        const rel = path === '/' ? 'index.html' : path.slice(1);
        const file = join(uiDir, rel);
        // 防目录穿越
        if (!resolve(file).startsWith(resolve(uiDir)) || !existsSync(file)) {
          return send(res, 404, 'Not found');
        }
        // 必须按扩展名给出正确 MIME：以 text/html 提供 .js/.css 会被浏览器拒绝执行
        const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
        return send(res, 200, readFileSync(file, 'utf8'), mime);
      }

      // ---------- API ----------
      if (path === '/api/health' && req.method === 'GET') {
        const c = ctx();
        return send(res, 200, ok({ status: 'ok', today: todayIn(c), timezone: c.tz }));
      }

      if (path === '/api/today' && req.method === 'GET') {
        const c = ctx();
        // 幂等执行 rollover：daemon 未运行时，用户第二天打开界面也不该看到昨日残留任务。
        // 与 Agent 每次进入时调用 run_daily_rollover 是同一保证。
        runDailyRollover(c);
        const { plan, actions } = getTodayPlan(c);
        const goals = getActiveGoals(c);
        const primary = goals[0];
        const stages = primary ? listStages(c, primary.id) : [];
        const current = primary ? getCurrentStage(c, primary.id) : null;
        const recentEvents = listGrowthEvents(c, undefined, 5);
        const mainActions = actions.filter((a) => a.kind === 'MAIN_QUEST');
        const dailyActions = actions.filter((a) => a.kind === 'DAILY');
        const done = (list: typeof actions) => list.filter((a) => a.status === 'COMPLETED').length;

        return send(res, 200, ok({
          today: todayIn(c),
          status: growthStatus(c),
          plan, actions,
          primaryGoal: primary ? { id: primary.id, title: primary.title, why: primary.why, targetDate: primary.targetDate } : null,
          stageProgress: current && stages.length ? { title: current.title, order: current.order, total: stages.length } : null,
          // 阶段轨道（节点式进度）：只表达"第几个 / 共几个"与真实状态，不做百分比
          stages: stages.map((s) => ({ order: s.order, title: s.title, status: s.status, end: s.plannedEndDate ?? null })),
          recentEvents: recentEvents.map((e) => ({ date: e.dateKey, title: e.title, domain: e.domain, evidenceCount: e.evidenceIds.length })),
          reminders: listRemindersForDate(c),
          lifeContext: getActiveLifeContext(c),
          // 面板数值一律为可核对事实（原则 6：不产生虚构属性值 / 掌握度 / 自律分）
          facts: {
            todayMain: { done: done(mainActions), total: mainActions.length },
            todayDaily: { done: done(dailyActions), total: dailyActions.length },
            evidenceTotal: countRows(c, 'evidence'),
            growthEventTotal: countRows(c, 'growth_events'),
            mainQuestCompletedTotal: countRows(c, `actions WHERE kind='MAIN_QUEST' AND status='COMPLETED' AND deleted_at IS NULL`),
          },
        }));
      }

      const m = path.match(/^\/api\/action\/([^/]+)\/(complete|skip|delay)$/);
      if (m && req.method === 'POST') {
        const input = await readBody(req);
        const c = ctx();
        const a = m[2] === 'complete' ? completeAction(c, m[1])
          : m[2] === 'skip' ? skipAction(c, m[1], String(input.reason ?? ''))
          : delayAction(c, m[1], String(input.reason ?? ''));
        return send(res, 200, ok(a));
      }

      if (path === '/api/goals' && req.method === 'GET') {
        const c = ctx();
        return send(res, 200, ok(listGoals(c).map((g) => ({
          ...g,
          stages: listStages(c, g.id),
          currentStage: getCurrentStage(c, g.id),
        }))));
      }

      if (path === '/api/timeline' && req.method === 'GET') {
        const c = ctx();
        const since = url.searchParams.get('since') ?? undefined;
        // dateKey 一律由服务端按配置时区计算（铁律 8：绝不按 UTC 截断）。
        // 客户端若自己 slice(0,10) ISO 串，在东八区会把当天记录算成前一天。
        const tz = resolveTimezone(c);
        return send(res, 200, ok({
          today: todayIn(c),
          events: listGrowthEvents(c, since ?? undefined, 200).map((e) => ({
            ...e,
            evidenceCount: e.evidenceIds.length,
          })),
          evidence: listEvidence(c, { limit: 200 }).map((e) => ({
            ...e,
            dateKey: localDateKey(new Date(e.createdAt), tz),
          })),
        }));
      }

      if (path === '/api/passport' && req.method === 'GET') {
        const snap = latestSnapshot(ctx());
        return send(res, 200, ok({ snapshot: snap?.passport ?? null, generatedAt: snap?.generatedAt, dirty: snap?.dirty }));
      }

      if (path === '/api/settings' && req.method === 'GET') {
        const c = ctx();
        return send(res, 200, ok({
          timezone: getSetting(c, 'timezone') ?? c.tz,
          reminderChannel: getSetting(c, 'reminder_channel') ?? 'macos-local',
        }));
      }

      if (path === '/api/settings' && req.method === 'POST') {
        const input = await readBody(req);
        const c = ctx();
        if (typeof input.timezone === 'string') setSetting(c, 'timezone', input.timezone);
        if (typeof input.reminderChannel === 'string') setSetting(c, 'reminder_channel', input.reminderChannel);
        return send(res, 200, ok({ saved: true }));
      }

      if (path === '/api/rollover' && req.method === 'POST') {
        return send(res, 200, ok(runDailyRollover(ctx())));
      }

      if (path === '/api/metrics' && req.method === 'GET') {
        return send(res, 200, ok(computeMetrics(ctx(), 14)));
      }

      return send(res, 404, err('NOT_FOUND', `Unknown path: ${path}`));
    } catch (e) {
      // 领域错误按其错误码返回（便于界面/日志定位），非领域错误才是 500
      if (e instanceof DomainError) {
        const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'ALREADY_EXISTS' ? 409 : 400;
        return send(res, status, err(e.code, e.message, e.retryable));
      }
      return send(res, 500, err('INTERNAL', e instanceof Error ? e.message : String(e)));
    }
  });
}
