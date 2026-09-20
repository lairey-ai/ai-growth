#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig } from '../shared/config.js';
import { Scheduler } from '../reminder/scheduler.js';
import { createApiServer } from '../api/app.js';
import { isDeviceLanEnabled, getOrCreateDeviceToken } from '../device/token.js';
import { makeCtx } from '../mcp/ctx.js';

const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const logFile = join(cfg.dataDir, 'daemon.log');

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(line + '\n');
  try {
    appendFileSync(logFile, line + '\n');
  } catch {
    /* 日志失败不影响服务 */
  }
}

process.on('uncaughtException', (e) => log(`uncaught: ${e.message}\n${e.stack}`));
process.on('unhandledRejection', (e) => log(`unhandled: ${e}`));

// ---- 计划/提醒调度 ----
const scheduler = new Scheduler(undefined, cfg);
scheduler.start();
log(`daemon started (data: ${cfg.dataDir}, pid: ${process.pid})`);

/**
 * ---- 面板 API 也由 daemon 托管 ----
 * 面板要能当桌面应用/常驻组件用，就必须和 daemon 同生命周期：
 * 只托管 daemon 的话，用户重启后还得手工 `npm run api`，违反"不要求用户维护系统"。
 * 端口被占用不致命：独立跑 `npm run api` 时 daemon 仍然正常工作。
 */
let api: Server | null = null;
if (process.env.AI_GROWTH_API_DISABLED !== '1') {
  api = createApiServer(scheduler.db, cfg);
  const lan = isDeviceLanEnabled(cfg, makeCtx(scheduler.db, cfg, 'api'));
  // 局域网关 → 只绑回环（默认）；局域网开 → 绑 0.0.0.0，此时 /api/device/*
  // 对任何来源都强制校验令牌。见 src/device/token.ts。
  const bindHost = lan ? '0.0.0.0' : '127.0.0.1';
  api.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      log(`api port ${cfg.apiPort} already in use — 面板可能由独立进程提供，daemon 继续运行`);
      api = null;
    } else {
      log(`api error: ${e.message}`);
    }
  });
  api.listen(cfg.apiPort, bindHost, () => {
    log(`panel api ready: http://127.0.0.1:${cfg.apiPort}${lan ? ` (device access: 0.0.0.0:${cfg.apiPort})` : ''}`);
    if (lan) {
      const t = getOrCreateDeviceToken(makeCtx(scheduler.db, cfg, 'api'));
      log(`device lan enabled · token ${t.slice(0, 8)}…（完整令牌：ai-growth device）`);
    }
  });
}

// launchd KeepAlive 下优雅退出
process.on('SIGTERM', () => {
  log('SIGTERM, stopping');
  scheduler.stop();
  api?.close();
  process.exit(0);
});
