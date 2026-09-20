import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/db/client.js';
import { makeCtx } from '../../src/mcp/ctx.js';
import { isDeviceLanEnabled, setDeviceLanEnabled } from '../../src/device/token.js';
import { loadConfig } from '../../src/shared/config.js';
import type { AppConfig } from '../../src/shared/config.js';

/**
 * 局域网开关的取值规则。
 *
 * 为什么单独锁这个：以前它只认环境变量，于是"开启一次"根本存不下来 ——
 * 本机 launchd 起不来（全局包是指向 ~/Desktop 的符号链接，TCC 拦着），
 * 也没有别的可写配置文件，用户每次启动都得手动带环境变量。
 * 后来改成"环境变量优先 + 落库持久化"，结果又被 config.ts 的默认值 '0' 坑了一次：
 * 默认值非空 → "有没有设过环境变量"这个判断永远为真 → 库里的开关再也读不到。
 * 这两条都是静默失效（看着像设了没生效），所以要用测试钉住优先级。
 */
function cfgWith(deviceLan: string | undefined): AppConfig {
  return { deviceLan: deviceLan ?? '' } as AppConfig;
}

describe('设备局域网开关的取值优先级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-growth-lan-'));
  const db = openDb(dir);
  const ctx = makeCtx(db, {} as AppConfig, 'test');

  it('没设过环境变量时，读库里持久化过的开关', () => {
    setDeviceLanEnabled(ctx, true);
    expect(isDeviceLanEnabled(cfgWith(undefined), ctx)).toBe(true);
    setDeviceLanEnabled(ctx, false);
    expect(isDeviceLanEnabled(cfgWith(undefined), ctx)).toBe(false);
  });

  it('环境变量一旦显式设置，就盖过库里的开关（临时覆盖的能力要保留）', () => {
    setDeviceLanEnabled(ctx, true);
    expect(isDeviceLanEnabled(cfgWith('0'), ctx)).toBe(false);   // 库是开，环境说不
    expect(isDeviceLanEnabled(cfgWith('on'), ctx)).toBe(true);
    setDeviceLanEnabled(ctx, false);
    expect(isDeviceLanEnabled(cfgWith('1'), ctx)).toBe(true);     // 库是关，环境说开
  });

  it('默认值必须是空串：非空默认值会让"是否设过环境变量"永远为真', () => {
    // 这条是回归守卫。若 config.ts 把默认值改回 '0'，下面这行就会失败。
    const prev = process.env.AI_GROWTH_DEVICE_LAN;
    delete process.env.AI_GROWTH_DEVICE_LAN;
    try {
      expect(loadConfig().deviceLan).toBe('');
    } finally {
      if (prev === undefined) delete process.env.AI_GROWTH_DEVICE_LAN;
      else process.env.AI_GROWTH_DEVICE_LAN = prev;
    }
  });

  it('没有数据库上下文时只能看环境变量（不至于误判成已开启）', () => {
    expect(isDeviceLanEnabled(cfgWith('1'))).toBe(true);
    expect(isDeviceLanEnabled(cfgWith(undefined))).toBe(false);
  });

  it('关掉后不留脏值：设置项存在但为假值', () => {
    setDeviceLanEnabled(ctx, false);
    const v = (ctx.db.prepare("select value from settings where key='device_lan'").get() as { value: string } | undefined);
    expect(v?.value).toBe('0');
    expect(isDeviceLanEnabled(cfgWith(undefined), ctx)).toBe(false);
  });

  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
