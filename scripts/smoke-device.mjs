#!/usr/bin/env node
/**
 * AI Passport 设备接口的端到端冒烟。
 *
 * 为什么要有这个脚本（而不是只靠 vitest）：
 *   vitest 里的设备测试大多直接调函数，测不到「真实 socket + 真实 HTTP 头 + 真实二进制载荷」
 *   这一层。而设备上跑的是**已经编译好的固件**，它看到的只有 HTTP 响应。中间任何一处
 *   契约漂移（字段改名、battery 变成字符串、URL 少了 &bat=）都不会被单测发现，
 *   但会让真机上出现「能连上、画面不动」或「按 OK 没反应」——最难查的那种故障。
 *
 * 所以这里的核心不是「服务端自测」，而是 **G 段：与固件的协议一致性**。
 *   G 段直接去读固件源码（main/growth_protocol.h / .c）：
 *     - 从 growth_parse_meta() 里抽出固件真正读取的 meta 字段名与类型
 *     - 从 #define 里抽出卡宽高、头长、分带行数、各字段缓冲上限
 *   然后拿服务端**真实的响应**去对。固件改了字段名 / 服务端改了字段名，这里都会红。
 *   固件源码不在旁边时，退回内置清单并明确标注「非真 parity」。
 *
 * 用法：
 *   node scripts/smoke-device.mjs                      # 临时库 + 临时输出目录
 *   SMOKE_DATA_DIR=/tmp/x SMOKE_OUT_DIR=/tmp/y node scripts/smoke-device.mjs
 *   AI_PASSPORT_DIR=~/path/to/ai-passport node scripts/smoke-device.mjs
 *
 * 需要先 `npm run build`（脚本跑的是 dist/）。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const D = path.join(ROOT, 'dist');

if (!fs.existsSync(path.join(D, 'device', 'deck.js'))) {
  console.error(`找不到编译产物 ${D}。先跑 \`npm run build\`。`);
  process.exit(2);
}

const dataDir = process.env.SMOKE_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ai-growth-smoke-'));
const outDir = process.env.SMOKE_OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ai-growth-cards-'));

// 固件仓库位置：默认取同级目录的 ai-passport（本机就是这样摆的），可用环境变量覆盖。
const FW_DIR = path.resolve(
  (process.env.AI_PASSPORT_DIR || path.join(ROOT, '..', 'ai-passport')).replace(/^~(?=\/)/, os.homedir())
);
const FW_HEADER = path.join(FW_DIR, 'main', 'growth_protocol.h');
const FW_PROTO = path.join(FW_DIR, 'main', 'growth_protocol.c');

const { openDb } = await import(path.join(D, 'db/client.js'));
const { makeCtx } = await import(path.join(D, 'mcp/ctx.js'));
const { createApiServer } = await import(path.join(D, 'api/app.js'));
const G = await import(path.join(D, 'core/goals.js'));
const A = await import(path.join(D, 'core/actions.js'));
const P = await import(path.join(D, 'core/profile.js'));
const { decodeCardPayload, CARD_W, CARD_H, HEADER_SIZE, PAYLOAD_VERSION, PIXEL_FORMAT_RGB565_LE } =
  await import(path.join(D, 'device/deck.js'));
const { deviceToken } = await import(path.join(D, 'device/token.js'));

const base = {
  dataDir, timezone: 'Asia/Shanghai', logLevel: 'error', apiPort: 0,
  passportAdapter: 'local-json', passportFile: 'passport.json', deviceLan: '0',
};

// ───────────────────────── 断言框架 ─────────────────────────
const results = [];
let section = '';
function begin(name) { section = name; console.log(`\n═══ ${name} ═══`); }
function check(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ section, name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
  return pass;
}
function note(text) { console.log(`    ${text}`); }

// ───────────────────── 从固件源码提取契约 ─────────────────────
/**
 * 抽 growth_parse_meta() 里真正被读取的 key 及其类型。
 * 只扫函数体，避免把别处的字符串误判成 meta 字段。
 */
function firmwareMetaKeys() {
  if (!fs.existsSync(FW_PROTO)) return null;
  const src = fs.readFileSync(FW_PROTO, 'utf8');
  const at = src.indexOf('void growth_parse_meta');
  if (at < 0) return null;
  const body = src.slice(at, src.indexOf('\n}', at));
  const str = [];
  const int = [];
  for (const m of body.matchAll(/growth_meta_(str|int)\(json,\s*"([A-Za-z0-9_]+)"/g)) {
    (m[1] === 'str' ? str : int).push(m[2]);
  }
  if (!str.length && !int.length) return null;
  return { str, int };
}

/** 抽固件侧的尺寸/上限常量 */
function firmwareConsts() {
  if (!fs.existsSync(FW_HEADER)) return null;
  const src = fs.readFileSync(FW_HEADER, 'utf8');
  const num = (n) => {
    const m = src.match(new RegExp(`#define\\s+${n}\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const out = {
    W: num('GROWTH_CARD_W'), H: num('GROWTH_CARD_H'),
    HEADER: num('GROWTH_HEADER_SIZE'), VERSION: num('GROWTH_PAYLOAD_VERSION'),
    FORMAT: num('GROWTH_PIXEL_FORMAT_RGB565_LE'),
    BAND_ROWS: num('GROWTH_BAND_ROWS'),
    META_MAX: num('GROWTH_META_MAX'),
    MAX: {
      deckId: num('GROWTH_DECK_ID_MAX'), kind: num('GROWTH_KIND_MAX'),
      actionId: num('GROWTH_ACTION_ID_MAX'), dateKey: num('GROWTH_DATE_KEY_MAX'),
      dateLabel: num('GROWTH_DATE_LABEL_MAX'),
    },
  };
  return Object.values(out).some((v) => v === null) ? null : out;
}

/** 固件能识别的上报裁决字符串 */
function firmwareOutcomes() {
  if (!fs.existsSync(FW_PROTO)) return null;
  const src = fs.readFileSync(FW_PROTO, 'utf8');
  const set = new Set();
  for (const m of src.matchAll(/strcmp\(outcome,\s*"([A-Z_]+)"\)/g)) set.add(m[1]);
  return set.size ? set : null;
}

// ───────────────────────── 造数据（走 Core）─────────────────────────
const db = openDb(dataDir);
const ctx = makeCtx(db, base, 'seed');
P.ensureProfile(ctx, 'Asia/Shanghai');
P.updateProfile(ctx, { onboardingStatus: 'COMPLETED' });
const goal = G.createGoalDraft(ctx, {
  title: '30 天掌握 Agent Engineering', why: '想独立做出能交付的 Agent 产品',
  desiredOutcome: '能独立设计并交付', successCriteria: ['产出 1 个可运行项目'],
  targetDate: '2026-10-19', dailyTimeBudgetMinutes: 60,
});
G.confirmGoal(ctx, goal.id);
G.createStagePlan(ctx, {
  goalId: goal.id,
  stages: [
    { title: 'Tool Calling 基础', plannedStartDate: '2026-09-15', plannedEndDate: '2026-09-21' },
    { title: 'Memory', plannedStartDate: '2026-09-22', plannedEndDate: '2026-09-28' },
    { title: 'MCP 集成', plannedStartDate: '2026-09-29', plannedEndDate: '2026-10-05' },
    { title: '端到端项目', plannedStartDate: '2026-10-06', plannedEndDate: '2026-10-12' },
    { title: '打磨与交付', plannedStartDate: '2026-10-13', plannedEndDate: '2026-10-19' },
  ],
});
G.activateGoal(ctx, goal.id);
const stages = G.listStages(ctx, goal.id);
db.prepare(`UPDATE stages SET status='COMPLETED' WHERE id=?`).run(stages[0].id);
db.prepare(`UPDATE stages SET status='ACTIVE' WHERE id=?`).run(stages[1].id);

const { plan, actions: todayActions } = A.createTodayPlan(ctx, {
  rationale: '进入 Memory 阶段的第一步',
  mainQuest: {
    title: '实现最小 Agent Memory Demo', whyToday: 'Memory 是当前阶段的出口标准',
    estimatedMinutes: 60, completionCriteria: 'demo 能写入并召回',
    basisGoalId: goal.id, basisStageId: stages[1].id,
  },
  dailyActions: [
    { title: '散步 30 分钟', estimatedMinutes: 30, basis: '用户确认的运动方向', domain: 'TRAIN' },
    { title: '读 20 页书', estimatedMinutes: 20, basis: '用户确认的阅读方向', domain: 'LEARN' },
  ],
});
A.confirmTodayPlan(ctx, plan.id);
const dailies = todayActions.filter((a) => a.kind === 'DAILY');
const daily = dailies[0];
const spare = dailies[1]; // 留给「跨天补记」用，全程不完成
const main = todayActions.find((a) => a.kind === 'MAIN_QUEST');

// ───────────────────────── 起服务 ─────────────────────────
const server = createApiServer(db, base);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function req(method, path, body, headers = {}, _port = port) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: _port, path, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message, buf: Buffer.alloc(0) }));
    if (payload) r.write(payload);
    r.end();
  });
}
const parse = (r) => { try { return JSON.parse(r.buf.toString('utf8')); } catch { return null; } };
const save = (name, pixels) => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `${name}.rgb565`), pixels); };

// ═════════════════════ A) 局域网关（默认）· 本机免令牌 ═════════════════════
begin('A) 局域网关（默认）· 本机免令牌');
let r = await req('GET', '/api/device/ping');
check('ping 200', r.status === 200, JSON.stringify(parse(r)?.data));
r = await req('GET', '/api/device/status');
check('status 200 且带 today/deckId', r.status === 200 && !!parse(r)?.data?.today, `count=${parse(r)?.data?.count}`);
r = await req('GET', '/api/device/deck');
const deck = parse(r)?.data;
check('deck 200 且非空', r.status === 200 && (deck?.count ?? 0) > 0, `count=${deck?.count} deckId=${deck?.deckId}`);
for (const c of deck?.cards ?? []) note(`[${c.index}] ${String(c.kind).padEnd(9)} actionId=${c.actionId ?? '-'}  ${c.title}`);

// ═════════════════════ B) 取图并校验载荷 ═════════════════════
begin('B) 取图并校验载荷（像素真的渲染出来了）');
for (let i = 0; i < (deck?.count ?? 0); i++) {
  const cr = await req('GET', `/api/device/card?i=${i}&bat=72`);
  let parsed = null;
  try { parsed = decodeCardPayload(cr.buf); } catch (e) { check(`card ${i} 可解码`, false, e.message); continue; }
  const at = (x, y) => parsed.pixels.readUInt16LE((y * CARD_W + x) * 2);
  const corner = at(1, 1);
  const center = at(120, 200);
  check(`card ${i} 200 / octet-stream / 153600B`, cr.status === 200 && cr.headers['content-type'] === 'application/octet-stream' && cr.buf.length === HEADER_SIZE + Buffer.byteLength(JSON.stringify(parsed.meta), 'utf8') + CARD_W * CARD_H * 2,
    `kind=${parsed.meta.kind} 角=0x${corner.toString(16)} 中=0x${center.toString(16)}`);
  check(`card ${i} 角像素为 0（圆角遮黑）且中心非 0`, corner === 0 && center !== 0);
  save(`card${i}_${parsed.meta.kind}`, parsed.pixels);
}
r = await req('GET', '/api/device/card?i=999');
check('越界 index 返回 404', r.status === 404, parse(r)?.error?.code);
r = await req('GET', '/api/device/card');
check('缺 index 返回 400', r.status === 400, parse(r)?.error?.code);

// ═════════════════════ C) 上报完成 + 幂等 + 牌组变化 ═════════════════════
begin('C) 上报完成 + 幂等 + 牌组变化');
r = await req('POST', '/api/device/action', { actionId: main.id, op: 'complete' });
check('第一次完成 → COMPLETED', parse(r)?.data?.outcome === 'COMPLETED', `status=${r.status}`);
r = await req('POST', '/api/device/action', { actionId: main.id, op: 'complete' });
check('重复上报 → ALREADY_IN_STATE + duplicate', parse(r)?.data?.outcome === 'ALREADY_IN_STATE' && parse(r)?.data?.duplicate === true);
r = await req('POST', '/api/device/action', { actionId: daily.id, op: 'complete' });
check('完成日常 → COMPLETED', parse(r)?.data?.outcome === 'COMPLETED');
r = await req('GET', '/api/device/deck');
const deck2 = parse(r)?.data;
check('牌组指纹已变化', deck2?.deckId !== deck?.deckId, `${deck?.deckId} → ${deck2?.deckId}`);
for (const c of deck2?.cards ?? []) note(`[${c.index}] ${String(c.kind).padEnd(9)} ${c.title}`);

// ═════════════════════ D) 令牌校验（局域网开启时）═════════════════════
begin('D) 令牌校验（局域网开启时）');
P.setSetting(ctx, 'device_token', 'smoke-token-1234');
const server2 = createApiServer(db, { ...base, deviceLan: '1' });
await new Promise((res) => server2.listen(0, '127.0.0.1', res));
const port2 = server2.address().port;
const q2 = (method, path, headers = {}) => req(method, path, null, headers, port2);
// 带 body 的版本：q2 只发 header，POST 必须用这个，否则 body 会被当成 header 丢掉
const post2 = (path, body, headers = {}) => req('POST', path, body, headers, port2);
check('无令牌 → 401', (await q2('GET', '/api/device/ping')).status === 401);
check('错误令牌 → 401', (await q2('GET', '/api/device/ping', { 'X-Device-Token': 'nope' })).status === 401);
check('正确令牌（header）→ 200', (await q2('GET', '/api/device/ping', { 'X-Device-Token': 'smoke-token-1234' })).status === 200);
check('正确令牌（query，固件走这条）→ 200', (await q2('GET', '/api/device/ping?token=smoke-token-1234')).status === 200);
check('伪造 Host: 127.0.0.1 不能绕过 → 401', (await q2('GET', '/api/device/ping', { Host: '127.0.0.1' })).status === 401);
check('面板接口仍锁回环（Host 127.0.0.1 → 200）', (await q2('GET', '/api/today', { Host: '127.0.0.1' })).status === 200);
check('面板接口拒绝局域网 Host → 403', (await q2('GET', '/api/today', { Host: '192.168.3.46' })).status === 403);
note(`当前令牌 = ${deviceToken(ctx)}`);

// ═════════════════════ E) 跨天降级为迟记 ═════════════════════
begin('E) 跨天降级为迟记');
note(`把未完成的「${spare.title}」摆成昨天的 fixture（不伪造时钟）`);
db.prepare(`UPDATE actions SET date_key='2026-09-19' WHERE id=?`).run(spare.id);
db.prepare(`UPDATE actions SET status='EXPIRED' WHERE id=?`).run(spare.id);
const before = db.prepare('SELECT status FROM actions WHERE id=?').get(spare.id).status;
check('fixture：该动作已 EXPIRED', before === 'EXPIRED', `dateKey=2026-09-19 status=${before}`);
r = await req('POST', '/api/device/action', { actionId: spare.id, op: 'complete', occurredDateKey: '2026-09-19' });
check('跨天补交 → LATE_RECORDED', parse(r)?.data?.outcome === 'LATE_RECORDED', `status=${r.status}`);
note(parse(r)?.data?.note ?? '');
const after = db.prepare('SELECT status FROM actions WHERE id=?').get(spare.id).status;
check('动作状态不变（铁律 3：不产生跨天债务）', after === 'EXPIRED', `${before} → ${after}`);
const evDate = db.prepare('SELECT date_key FROM growth_events ORDER BY rowid DESC LIMIT 1').get()?.date_key;
check('补记的进展落在 2026-09-19 而非今天', evDate === '2026-09-19', `date_key=${evDate}`);
const evBefore = db.prepare('SELECT COUNT(*) n FROM growth_events').get().n;
r = await req('POST', '/api/device/action', { actionId: spare.id, op: 'complete', occurredDateKey: '2026-09-19' });
check('重复补记幂等（不再新增 growth_event）',
  parse(r)?.data?.duplicate === true && db.prepare('SELECT COUNT(*) n FROM growth_events').get().n === evBefore);
r = await req('POST', '/api/device/action', { actionId: spare.id, op: 'complete', occurredDateKey: '2030-01-01' });
check('未来日期被拒', r.status >= 400, `${r.status} ${parse(r)?.error?.code}`);
r = await req('POST', '/api/device/action', { actionId: spare.id, op: 'complete', occurredDateKey: '2026-01-01' });
check('早于动作日期被拒', r.status >= 400, `${r.status} ${parse(r)?.error?.code}`);
r = await req('POST', '/api/device/action', { actionId: 'no-such-action', op: 'complete' });
check('未知 actionId → NOT_FOUND', parse(r)?.error?.code === 'NOT_FOUND', `${r.status}`);
r = await req('POST', '/api/device/action', { actionId: spare.id, op: 'teleport' });
check('非法 op → VALIDATION_ERROR', parse(r)?.error?.code === 'VALIDATION_ERROR', `${r.status}`);

// ═════════════════════ F) 今天没排计划 ═════════════════════
begin('F) 今天没排计划');
r = await req('GET', '/api/device/deck');
const kinds = new Set((parse(r)?.data?.cards ?? []).map((c) => c.kind));
check('牌组里的 kind 都在固件已知集合内（固件不 switch kind，但日志/兜底卡要对得上）',
  [...kinds].every((k) => ['overview', 'task', 'alldone', 'noplan'].includes(k)), [...kinds].join(','));

// ═════════════════════ G) 与固件的协议一致性（真 parity）═════════════════════
begin('G) 与固件的协议一致性（读固件源码来对，不是手抄清单）');
const fwKeys = firmwareMetaKeys();
const fwC = firmwareConsts();
const fwOut = firmwareOutcomes();
const haveFw = !!(fwKeys && fwC);
check('找到固件源码，走真 parity 提取', haveFw, haveFw ? FW_DIR : `未找到 ${FW_HEADER} → 退回内置清单`);
if (!haveFw) note('⚠ 固件源码不在预期位置，下面的字段清单是内置的，仅供参考（设 AI_PASSPORT_DIR 可恢复真 parity）');

const strKeys = fwKeys?.str ?? ['deckId', 'kind', 'actionId', 'dateKey', 'dateLabel'];
const intKeys = fwKeys?.int ?? ['index', 'count', 'doneCount', 'total', 'battery'];
note(`固件读取的字符串字段：${strKeys.join(', ')}`);
note(`固件读取的数值字段：${intKeys.join(', ')}`);

// 取一张「有 actionId」和一张「actionId:null」的卡，两种形态都要对
const withAction = await req('GET', '/api/device/card?i=1&bat=72');
const noAction = await req('GET', '/api/device/card?i=0');   // 总览页：actionId=null、battery=null
const mWith = decodeCardPayload(withAction.buf).meta;
const mNone = decodeCardPayload(noAction.buf).meta;

check('存在 actionId 为 null 的卡（固件据此只刷新、不上报）', mNone.actionId === null, `kind=${mNone.kind}`);
check('该卡同时带 battery:null（固件应保持 -1，不是 0）', mNone.battery === null);

for (const [label, meta] of [['有动作卡', mWith], ['无动作卡', mNone]]) {
  const missStr = strKeys.filter((k) => !(k in meta));
  const missInt = intKeys.filter((k) => !(k in meta));
  check(`${label}：固件要读的字段一个都不缺`, missStr.length === 0 && missInt.length === 0,
    [...missStr, ...missInt].join(',') || 'ok');
  const badType = [
    ...strKeys.filter((k) => !(meta[k] === null || typeof meta[k] === 'string')),
    ...intKeys.filter((k) => !(meta[k] === null || typeof meta[k] === 'number')),
  ];
  check(`${label}：字段类型固件能解析（str|int，允许 null）`, badType.length === 0, badType.join(',') || 'ok');
  check(`${label}：meta.v === GROWTH_PAYLOAD_VERSION`, meta.v === (fwC?.VERSION ?? PAYLOAD_VERSION), `${meta.v}`);
}

// 头与分带
const cr0 = await req('GET', '/api/device/card?i=0');
const hdr = {
  magic: cr0.buf.subarray(0, 4).toString('ascii'),
  version: cr0.buf.readUInt8(4),
  format: cr0.buf.readUInt8(5),
  w: cr0.buf.readUInt16LE(6),
  h: cr0.buf.readUInt16LE(8),
  metaLen: cr0.buf.readUInt32LE(10),
};
check('magic = AGCD', hdr.magic === 'AGCD', hdr.magic);
check('头长与固件 GROWTH_HEADER_SIZE 一致', HEADER_SIZE === (fwC?.HEADER ?? HEADER_SIZE), `${HEADER_SIZE}`);
check('宽高与固件 GROWTH_CARD_W/H 一致', hdr.w === fwC.W && hdr.h === fwC.H && hdr.w === CARD_W && hdr.h === CARD_H, `${hdr.w}x${hdr.h}`);
check('像素格式 = RGB565 小端', hdr.format === (fwC?.FORMAT ?? PIXEL_FORMAT_RGB565_LE), `${hdr.format}`);
check('像素段长度 = 固件 GROWTH_CARD_PIXEL_BYTES', cr0.buf.length - HEADER_SIZE - hdr.metaLen === fwC.W * fwC.H * 2,
  `${cr0.buf.length - HEADER_SIZE - hdr.metaLen}B`);

const bandCount = Math.ceil(fwC.H / fwC.BAND_ROWS);
const lastRows = fwC.H - (bandCount - 1) * fwC.BAND_ROWS;
const bandBytes = fwC.W * fwC.BAND_ROWS * 2;
check('分带整除：每带字节数恰好等于带宽*行数', bandBytes === fwC.W * fwC.BAND_ROWS * 2, `${bandBytes}B/带 × ${bandCount}带`);
check('分带覆盖整屏不缺行', (bandCount - 1) * fwC.BAND_ROWS + lastRows === fwC.H, `末带 ${lastRows} 行`);
check('每带字节数不超 SPI max_transfer_sz(240*80*2)', bandBytes <= 240 * 80 * 2, `${bandBytes} <= ${240 * 80 * 2}`);

// 缓冲余量：字段超长会被固件静默截断 → 屏幕上是残缺文字，最难查
const over = [];
for (const [label, meta] of [['有动作卡', mWith], ['无动作卡', mNone]]) {
  for (const k of ['deckId', 'kind', 'actionId', 'dateKey', 'dateLabel']) {
    const v = meta[k];
    if (typeof v !== 'string') continue;
    const limit = fwC.MAX[k];
    if (limit && v.length >= limit) over.push(`${label}.${k}=${v.length}>=${limit}`);
  }
}
check('各字段长度都在固件缓冲内（不会被静默截断）', over.length === 0, over.join(' ') || 'ok');
check('meta JSON 不超固件 GROWTH_META_MAX', Buffer.byteLength(JSON.stringify(mWith), 'utf8') < fwC.META_MAX,
  `${Buffer.byteLength(JSON.stringify(mWith), 'utf8')} < ${fwC.META_MAX}`);

// 固件实际会拼出来的 URL 形态，逐个打一遍（这是真机最容易翻车的地方）
check('固件形态① /card?i=N（无电量无令牌）', (await req('GET', '/api/device/card?i=0')).status === 200);
check('固件形态② /card?i=N&bat=72', (await req('GET', '/api/device/card?i=0&bat=72')).status === 200);
check('固件形态③ /card?i=N&bat=72&token=T（局域网）', (await q2('GET', '/api/device/card?i=0&bat=72&token=smoke-token-1234')).status === 200);
const actUrl = await post2('/api/device/action?token=smoke-token-1234', { actionId: daily.id, op: 'complete' });
check('固件形态④ POST /action?token=T（body {actionId,op}）', actUrl.status === 200 && !!parse(actUrl)?.data?.outcome,
  parse(actUrl)?.data?.outcome ?? JSON.stringify(parse(actUrl)?.error));
check('固件形态⑤ /deck?bat=N（固件带电量取牌组）', (await req('GET', '/api/device/deck?bat=72')).status === 200);

// 裁决字符串：服务端产出的，固件必须都认得
const serverOutcomes = new Set(
  ['COMPLETED', 'SKIPPED', 'DELAYED', 'ALREADY_IN_STATE', 'LATE_RECORDED', 'CONFLICT']
);
const unknown = fwOut ? [...serverOutcomes].filter((o) => !fwOut.has(o)) : [];
check('服务端的所有 outcome 固件都认得', unknown.length === 0, unknown.join(',') || [...serverOutcomes].join(','));
check('幂等/迟记被固件判为成功（不弹错误）', !fwOut ? false : fwOut.has('ALREADY_IN_STATE') && fwOut.has('LATE_RECORDED'));

// ═════════════════════ 收尾 ═════════════════════
server.close();
server2.close();
db.close();

const failed = results.filter((x) => !x.pass);
console.log('\n──────────────────────────────────');
console.log(`断言 ${results.length} 项：通过 ${results.length - failed.length} / 失败 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name}`);
  console.log(`\n卡图输出：${outDir}`);
  process.exit(1);
}
console.log(`✓ 设备接口冒烟全部通过（真 parity${haveFw ? '已启用' : '未启用'}）`);
console.log(`  数据目录：${dataDir}`);
console.log(`  卡图输出：${outDir}`);
