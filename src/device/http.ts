/**
 * `/api/device/*` —— 给 AI Passport 设备用的极简接口。
 *
 * 为什么单独一组路由而不是复用 `/api/today`：
 *   - 设备和浏览器面板的信任级别不同。面板继续只走 loopback；设备需要局域网，
 *     所以它必须单独走令牌校验，且**不受** `isLocalHost` 的 Host 头判断影响
 *     （否则局域网客户端伪造 `Host: 127.0.0.1` 就能绕过）。
 *   - 设备只在开机/切页时取图，不需要面板那一大坨数据。
 *
 * 与 Agent 侧共用同一套 Core：这里没有任何"设备专属的业务规则"，
 * 只是把 Core 的只读视图编码成像素、把设备的按键翻译成 Core 的动作。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../shared/config.js';
import type { CoreContext } from '../core/context.js';
import { ok, err, DomainError } from '../shared/result.js';
import { runDailyRollover } from '../core/rollover.js';
import { todayIn, resolveTimezone } from '../core/profile.js';
import { deckSummary, renderCardAt } from './renderCard.js';
import { applyDeviceReport } from './report.js';
import { checkDeviceAccess, extractToken, deviceToken, isDeviceLanEnabled } from './token.js';
import type { DeviceOp } from './types.js';

export const DEVICE_PREFIX = '/api/device';

export const SERVICE_NAME = 'ai-growth';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendBinary(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {}); } catch { resolve({}); }
    });
  });
}

/**
 * 解析设备上报的电量，并**量化到 10% 一档**。
 *
 * 🔴 为什么要量化：卡片是现场用无头 Chrome 渲染的（1.1~1.2 秒），而缓存键是
 *   `sha256(卡片 HTML)` —— 电量画在卡片的页脚里，所以电量一变，整张卡就得重渲一次。
 *   实测：同一张卡 `bat=88` 命中缓存（1ms），`bat=87` 就变成 **1091ms**（重新渲染）。
 *   而设备每次取卡都会上报当前电量，读数本身还有 ±1~2% 的抖动 —— 于是几乎每次
 *   按上下键都在踩"电量变了→重渲"，用户感觉就是"切换要等一两秒"。
 *   量化到 10% 一档，抖动被吸收掉，同时页脚那个电量仍然是有意义的参考值。
 */
export function parseBattery(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(-1, Math.min(100, Math.round(n)));
  if (clamped < 0) return clamped;                       // -1 = 读不到电量
  return Math.min(100, Math.round(clamped / 10) * 10);
}

/**
 * 后台把牌组里其它卡也渲一遍（**不阻塞响应**）。
 *
 * 渲染一张卡要 1.1~1.2 秒（无头 Chrome 现场画），而牌组通常只有 2~4 张。
 * 设备是按上下键逐张翻的 —— 提前渲完，翻页就是缓存命中（几毫秒），
 * 而不是每按一次都等一整次渲染。
 *
 * ⚠ 串行执行：同时拉起多个 Chrome 会把机器压住，反而拖慢正在等的那一次。
 * ⚠ 预热失败不影响任何功能（用户翻到那张时照样会现场渲一次），所以这里吞掉异常。
 */
let warmingDeck = false;
async function warmDeckInBackground(
  ctx: CoreContext,
  count: number,
  skipIndex: number,
  battery: number | null,
  dataDir: string
): Promise<void> {
  if (warmingDeck) return;
  warmingDeck = true;
  try {
    for (let i = 0; i < count; i++) {
      if (i === skipIndex) continue;
      await renderCardAt(ctx, i, dataDir, { battery });
    }
  } catch {
    /* 预热是优化，失败不需要让任何人知道 */
  } finally {
    warmingDeck = false;
  }
}

export interface DeviceRequestArgs {
  ctx: () => CoreContext;
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  url: URL;
  cfg: AppConfig;
}

/**
 * 处理 `/api/device/*`。返回 true 表示已经响应（调用方不要再走后面的路由）。
 */
export async function handleDeviceRequest(args: DeviceRequestArgs): Promise<boolean> {
  const { ctx, req, res, path, url, cfg } = args;
  if (!path.startsWith(DEVICE_PREFIX)) return false;

  const lanEnabled = isDeviceLanEnabled(cfg, ctx());
  const c = ctx();
  const access = checkDeviceAccess({
    lanEnabled,
    expected: deviceToken(c),
    provided: extractToken(req.headers['x-device-token'] as string | undefined, url.searchParams.get('token')),
  });

  if (access === 'NOT_CONFIGURED') {
    return sendJson(res, 503, err(
      'DEVICE_NOT_CONFIGURED',
      '局域网访问已开启但还没有设备令牌。在电脑上运行 `ai-growth device --rotate` 生成一个。'
    )), true;
  }
  if (access === 'TOKEN_REQUIRED' || access === 'TOKEN_INVALID') {
    return sendJson(res, 401, err(
      access,
      access === 'TOKEN_REQUIRED'
        ? '缺少设备令牌。请求头 X-Device-Token 或查询参数 token 必填。'
        : '设备令牌不正确。在电脑上运行 `ai-growth device` 查看当前令牌。'
    )), true;
  }

  const m = path.slice(DEVICE_PREFIX.length);

  if (m === '/ping' && req.method === 'GET') {
    return sendJson(res, 200, ok({
      service: SERVICE_NAME,
      today: todayIn(c),
      timezone: resolveTimezone(c),
      lan: lanEnabled,
    })), true;
  }

  if (m === '/deck' && req.method === 'GET') {
    runDailyRollover(c); // 与 /api/today 同一保证：设备永远看到"今天"，不会看到昨日残留
    return sendJson(res, 200, ok(deckSummary(c, { battery: parseBattery(url.searchParams.get('bat')) }))), true;
  }

  if (m === '/status' && req.method === 'GET') {
    runDailyRollover(c);
    const s = deckSummary(c, { battery: parseBattery(url.searchParams.get('bat')) });
    return sendJson(res, 200, ok({
      today: s.today,
      dateLabel: s.dateLabel,
      deckId: s.deckId,
      count: s.count,
      doneCount: s.doneCount,
      total: s.total,
      stage: s.stage,
      nextActionId: s.cards.find((x) => x.actionId)?.actionId ?? null,
    })), true;
  }

  if (m === '/card' && req.method === 'GET') {
    const raw = url.searchParams.get('i');
    if (raw === null) {
      return sendJson(res, 400, err('VALIDATION_ERROR', '缺少参数 i（第几张卡）')), true;
    }
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0) {
      return sendJson(res, 400, err('VALIDATION_ERROR', `参数 i 非法：${raw}`)), true;
    }
    runDailyRollover(c);
    const battery = parseBattery(url.searchParams.get('bat'));
    const card = await renderCardAt(c, index, cfg.dataDir, { battery });
    if (!card) {
      return sendJson(res, 404, err('NOT_FOUND', `卡序号 ${index} 越界（牌组可能刚变了，重新取 0 号即可）`)), true;
    }
    // 预热牌组里其它卡：设备按上下键翻页时就能命中缓存（几毫秒），而不是每次等 1.2 秒渲染。
    // 故意不 await —— 它跑在后台，本次响应立刻返回。
    void warmDeckInBackground(c, deckSummary(c, { battery }).count, index, battery, cfg.dataDir);
    return sendBinary(res, card.payload), true;
  }

  if (m === '/action' && req.method === 'POST') {
    const input = await readBody(req);
    const actionId = typeof input.actionId === 'string' ? input.actionId : '';
    const op = input.op as DeviceOp;
    const occurred = typeof input.occurredDateKey === 'string' ? input.occurredDateKey : undefined;
    const reason = typeof input.reason === 'string' ? input.reason : undefined;

    const result = applyDeviceReport(c, { actionId, op, occurredDateKey: occurred, reason });
    const status = result.outcome === 'CONFLICT' ? 409 : 200;
    return sendJson(res, status, ok(result)), true;
  }

  return sendJson(res, 404, err('NOT_FOUND', `未知的设备接口：${path}`)), true;
}

export { DomainError };
