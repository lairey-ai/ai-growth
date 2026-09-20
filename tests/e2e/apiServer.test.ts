import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createApiServer, isLocalHost } from '../../src/api/app.js';
import { openTestDb, type DB } from '../../src/db/client.js';
import { makeCtx } from '../../src/mcp/ctx.js';
import type { AppConfig } from '../../src/shared/config.js';
import { createGoalDraft, confirmGoal, createStagePlan, activateGoal } from '../../src/core/goals.js';
import { ensureProfile, updateProfile, todayIn } from '../../src/core/profile.js';
import { addEvidence, createGrowthEvent } from '../../src/core/evidence.js';
import { createAction, createTodayPlan, confirmTodayPlan } from '../../src/core/actions.js';

/**
 * API 层测试：这是用户实际打开的界面所依赖的一层。
 * 用随机端口起真实 HTTP 服务，走真实 socket 请求（不 mock）。
 */
describe('HTTP API（Web UI 的后端）', () => {
  let server: Server;
  let base: string;
  let db: DB;
  let cfg: AppConfig;

  async function get(p: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${p}`, { headers });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, type: res.headers.get('content-type'), text, json };
  }
  async function post(p: string, payload: unknown) {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  /** fetch 不能伪造 Host（规范禁止），需要原生 http 来测 Host 边界 */
  function rawRequest(p: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const port = (server.address() as AddressInfo).port;
      const req = httpRequest(
        { host: '127.0.0.1', port, path: p, method: 'GET', headers },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ai-growth-api-'));
    cfg = {
      dataDir, timezone: 'Asia/Shanghai', logLevel: 'error',
      apiPort: 0, passportAdapter: 'local-json', passportFile: 'passport.json',
    };
    db = openTestDb();
    // 业务数据：走 Core（与 Agent 完全同一路径）
    const ctx = makeCtx(db, cfg, 'test');
    ensureProfile(ctx, 'Asia/Shanghai');
    updateProfile(ctx, { displayName: 'lairey', onboardingStatus: 'COMPLETED' });
    const g = createGoalDraft(ctx, {
      title: 'API 测试目标', why: 'w', desiredOutcome: 'o', successCriteria: ['c'],
      targetDate: '2026-10-19',
    });
    confirmGoal(ctx, g.id);
    createStagePlan(ctx, { goalId: g.id, stages: [{ title: 'S1', plannedEndDate: '2026-09-30' }, { title: 'S2' }] });
    activateGoal(ctx, g.id);
    const { plan } = createTodayPlan(ctx, { mainQuest: { title: '今天的活', whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' } });
    confirmTodayPlan(ctx, plan.id);
    const ev = addEvidence(ctx, { type: 'GIT', content: 'commit abc: 测试证据' });
    createGrowthEvent(ctx, { title: 'API 测试进展', domain: 'BUILD', evidenceIds: [ev.id] });
    createAction(ctx, { title: '额外任务', kind: 'DAILY' });

    server = createApiServer(db, cfg);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(cfg.dataDir, { recursive: true, force: true });
  });

  // ---------------- 本地服务边界（无账号体系，靠 loopback + Host 校验） ----------------

  it('Host 白名单逻辑正确', () => {
    expect(isLocalHost('127.0.0.1:4580')).toBe(true);
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('[::1]:4580')).toBe(true);
    expect(isLocalHost('evil.example.com')).toBe(false);
    expect(isLocalHost('192.168.1.5:4580')).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });

  it('伪造 Host 的请求被拒绝（防 DNS rebinding / CSRF）', async () => {
    // 注意：fetch 规范把 Host 列为禁止修改的头，必须用 node:http 才能伪造
    const result = await rawRequest('/api/today', { Host: 'evil.example.com' });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body).error.code).toBe('FORBIDDEN_HOST');
  });

  it('合法 Host 正常放行', async () => {
    const r = await get('/api/health');
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
  });

  // ---------------- 静态资源 ----------------

  it('静态资源 Content-Type 正确（.js 不能用 text/html，否则浏览器拒绝执行）', async () => {
    const html = await get('/');
    expect(html.status).toBe(200);
    expect(html.type).toContain('text/html');

    const js = await get('/app.js');
    expect(js.status).toBe(200);
    expect(js.type).toContain('text/javascript');

    const css = await get('/style.css');
    expect(css.status).toBe(200);
    expect(css.type).toContain('text/css');
  });

  it('目录穿越被拦住', async () => {
    const r = await get('/../package.json');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('ai-growth');
  });

  // ---------------- 面板数据 ----------------

  it('/api/today 返回面板所需的全部字段', async () => {
    const r = await get('/api/today');
    const d = (r.json as { data: Record<string, unknown> }).data;
    expect(d.today).toBe(todayIn(makeCtx(db, cfg, 't')));
    expect((d.status as Record<string, string>).onboarding).toBe('COMPLETED');
    expect((d.primaryGoal as Record<string, string>).title).toBe('API 测试目标');
    expect((d.stages as unknown[]).length).toBe(2);
    expect((d.stageProgress as Record<string, number>).order).toBe(1);
    expect((d.stageProgress as Record<string, number>).total).toBe(2);
    expect((d.actions as unknown[]).length).toBeGreaterThan(0);
  });

  it('/api/today 的 facts 全部是可核对计数，不含百分比/属性分', async () => {
    const r = await get('/api/today');
    const facts = ((r.json as { data: { facts: Record<string, unknown> } }).data.facts);
    expect(facts.evidenceTotal).toBeGreaterThanOrEqual(1);
    expect(facts.growthEventTotal).toBeGreaterThanOrEqual(1);
    // 不得出现虚构成长数值
    const flat = JSON.stringify(facts);
    for (const banned of ['score', 'level', 'mastery', 'percent', '%', '掌握', '自律', 'exp', 'strength']) {
      expect(flat.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it('/api/timeline 的 dateKey 由服务端按配置时区计算（不按 UTC 截断）', async () => {
    const r = await get('/api/timeline');
    const d = (r.json as { data: { today: string; evidence: { dateKey: string }[]; events: { dateKey: string }[] } }).data;
    expect(d.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 所有刚写入的证据都应算作"今天"
    for (const e of d.evidence) expect(e.dateKey).toBe(d.today);
    expect(d.events.length).toBeGreaterThanOrEqual(1);
  });

  it('/api/goals 返回 stage 列表', async () => {
    const r = await get('/api/goals');
    const goals = (r.json as { data: { stages: unknown[]; status: string }[] }).data;
    expect(goals.length).toBe(1);
    expect(goals[0].status).toBe('ACTIVE');
    expect(goals[0].stages.length).toBe(2);
  });

  // ---------------- 状态变更（走同一 Core Service） ----------------

  it('POST /api/action/:id/complete 走 Core，前端与 Agent 行为一致', async () => {
    const today = await get('/api/today');
    const actions = (today.json as { data: { actions: { id: string; kind: string; status: string }[] } }).data.actions;
    const daily = actions.find((a) => a.kind === 'DAILY' && a.status !== 'COMPLETED')!;
    const r = await post(`/api/action/${daily.id}/complete`, {});
    expect(r.status).toBe(200);
    expect((r.json.data as { status: string }).status).toBe('COMPLETED');
  });

  it('领域错误按错误码返回 4xx，而非笼统 500', async () => {
    const r = await post('/api/action/not-exist/complete', {});
    expect(r.status).toBe(404);
    expect((r.json.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('未知路径返回结构化 404', async () => {
    const r = await get('/api/nope');
    expect(r.status).toBe(404);
    expect((r.json as { ok: boolean; error: { code: string } }).ok).toBe(false);
  });

  it('/api/rollover 幂等', async () => {
    const a = await post('/api/rollover', {});
    const b = await post('/api/rollover', {});
    expect((b.json.data as { alreadyRan: boolean }).alreadyRan).toBe(true);
    expect((a.json.data as { today: string }).today).toBe((b.json.data as { today: string }).today);
  });

  it('/api/settings 可读可写', async () => {
    const before = await get('/api/settings');
    expect((before.json as { data: { timezone: string } }).data.timezone).toBe('Asia/Shanghai');
    const w = await post('/api/settings', { timezone: 'Asia/Tokyo', reminderChannel: 'none' });
    expect((w.json as { ok: boolean }).ok).toBe(true);
    const after = await get('/api/settings');
    expect((after.json as { data: { timezone: string } }).data.timezone).toBe('Asia/Tokyo');
    // 复原，避免影响其它用例
    await post('/api/settings', { timezone: 'Asia/Shanghai' });
  });
});
