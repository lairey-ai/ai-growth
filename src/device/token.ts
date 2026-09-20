/**
 * 设备访问令牌 —— 唯一需要触碰铁律 10（不做账号体系、安全边界是 loopback）的地方。
 *
 * 设计原则：**默认关**。令牌只在显式开启局域网访问后才被强制校验，
 * 且校验对**所有**来源一律生效（含 localhost）—— 否则局域网客户端只要伪造
 * `Host: 127.0.0.1` 就能绕过校验，那就等于没锁。
 *
 * - 局域网关：socket 绑在 127.0.0.1，物理上只有本机能连 → 不校验令牌
 * - 局域网开：socket 绑 0.0.0.0，任何来源（含本机）都必须带正确令牌
 *
 * 这不是"登录"，是一把写进设备 NVS 的共享密钥，只为挡住同一个 Wi-Fi 下的其他人。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../shared/config.js';
import type { CoreContext } from '../core/context.js';
import { getSetting, setSetting } from '../core/profile.js';

const TOKEN_KEY = 'device_token';
const LAN_KEY = 'device_lan';

/**
 * 局域网访问开关（device_lan）。
 *
 * 取值顺序：**环境变量优先，其次数据库里持久化过的开关，最后默认关**。
 *
 * 为什么要落库：这个开关以前只认环境变量，于是「开一次」这个动作**根本存不下来** ——
 * 本机 launchd 起不来（全局包是指向 ~/Desktop 的符号链接，TCC 拦着），
 * 而项目里又没有别的可写配置文件。结果是用户每次启动都得手动带环境变量，
 * 对一个要发布出去的应用来说不能接受。令牌本来就存在 settings 表里（见 TOKEN_KEY），
 * 这里沿用同一套：环境变量仍然可以临时覆盖，但"开启"这个决定能被记住。
 */
export function isDeviceLanEnabled(cfg: AppConfig, ctx?: CoreContext): boolean {
  const truthy = (v: string) => v === '1' || v === 'true' || v === 'yes' || v === 'on';
  const env = (cfg.deviceLan ?? '').trim().toLowerCase();
  if (env) return truthy(env);                       // 显式设置的环境变量说了算
  if (!ctx) return false;                            // 没有数据库上下文时只能用环境变量
  return truthy((getSetting(ctx, LAN_KEY) ?? '').trim().toLowerCase());
}

/** 把"开/关局域网访问"这个决定记下来（下次启动生效）。 */
export function setDeviceLanEnabled(ctx: CoreContext, on: boolean): void {
  setSetting(ctx, LAN_KEY, on ? '1' : '0');
}

export function deviceToken(ctx: CoreContext): string | null {
  return getSetting(ctx, TOKEN_KEY);
}

export function getOrCreateDeviceToken(ctx: CoreContext): string {
  const cur = deviceToken(ctx);
  if (cur) return cur;
  const t = randomBytes(16).toString('hex');
  setSetting(ctx, TOKEN_KEY, t);
  return t;
}

export function rotateDeviceToken(ctx: CoreContext): string {
  const t = randomBytes(16).toString('hex');
  setSetting(ctx, TOKEN_KEY, t);
  return t;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 从请求里取令牌：优先请求头（不落日志），其次查询串（方便浏览器直接开） */
export function extractToken(headerValue: string | undefined, queryValue: string | null): string {
  if (headerValue && headerValue.trim()) return headerValue.trim();
  return (queryValue ?? '').trim();
}

export interface DeviceAccessInput {
  lanEnabled: boolean;
  expected: string | null;
  provided: string;
}

export type DeviceAccess = 'ALLOW' | 'TOKEN_REQUIRED' | 'TOKEN_INVALID' | 'NOT_CONFIGURED';

export function checkDeviceAccess(input: DeviceAccessInput): DeviceAccess {
  if (!input.lanEnabled) return 'ALLOW';
  if (!input.expected) return 'NOT_CONFIGURED';
  if (!input.provided) return 'TOKEN_REQUIRED';
  return safeEqual(input.expected, input.provided) ? 'ALLOW' : 'TOKEN_INVALID';
}
