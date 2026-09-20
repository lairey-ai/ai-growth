#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import { loadConfig } from '../shared/config.js';
import { openDb } from '../db/client.js';
import { createApiServer } from './app.js';
import { isDeviceLanEnabled, getOrCreateDeviceToken } from '../device/token.js';
import { makeCtx } from '../mcp/ctx.js';

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const server = createApiServer(db, cfg);

const lan = isDeviceLanEnabled(cfg, makeCtx(db, cfg, 'api'));
// 局域网关：只绑回环，物理上只有本机连得上（默认，符合铁律 10 的安全模型）
// 局域网开：绑 0.0.0.0，此时 /api/device/* 对**所有**来源都强制校验令牌
const host = lan ? '0.0.0.0' : '127.0.0.1';

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

server.listen(cfg.apiPort, host, () => {
  process.stderr.write(`[ai-growth] web UI: http://127.0.0.1:${cfg.apiPort}\n`);
  if (!lan) {
    process.stderr.write(
      '[ai-growth] 设备局域网访问：关（默认）。要开：ai-growth device --lan on\n'
    );
    return;
  }
  const ip = lanAddress();
  const token = getOrCreateDeviceToken(makeCtx(db, cfg, 'api'));
  process.stderr.write(
    `[ai-growth] 设备局域网访问：开（绑定 ${host}）\n` +
    `[ai-growth]   设备访问地址：${ip ? `http://${ip}:${cfg.apiPort}` : `http://<本机IP>:${cfg.apiPort}`}\n` +
    `[ai-growth]   设备令牌：${token}\n`
  );
});

// 退出时优雅收尾，便于 launchd 重启
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
