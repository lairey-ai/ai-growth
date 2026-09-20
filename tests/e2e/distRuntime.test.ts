import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * 运行时冒烟测试：**对编译产物 dist/ 执行**，而不是源码。
 *
 * 为什么必须有这一层：测试默认读 src/，但用户实际运行的是 dist/。
 * 曾经出现过 `cp -R src/ui dist/ui` 在 dist/ui 已存在时套娃成 dist/ui/ui，
 * 导致 dist 中的 migration / UI 静默停留在旧版本 —— 源码测试全绿，
 * 而真实运行时的数据库 schema 是错的（assessments.level 缺默认值）。
 *
 * 本测试直接启动 dist/mcp/server.js 并按 MCP 协议调用工具，
 * 覆盖 compiler 输出、migration 文件拷贝、资源配置路径等"只有打包后才暴露"的问题。
 *
 * 前置：需要先 `npm run build`（未构建时自动跳过并给出提示）。
 */
const projectDir = join(__dirname, '..', '..');
const serverEntry = join(projectDir, 'dist', 'mcp', 'server.js');
const distReady = existsSync(serverEntry);

describe.skipIf(!distReady)('运行时冒烟：对 dist 产物执行（需先 npm run build）', () => {
  let client: Client;
  let dataDir: string;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    const raw = res.content?.[0]?.text ?? '';
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, protocolError: raw };
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ai-growth-dist-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...process.env, AI_GROWTH_DATA_DIR: dataDir },
      cwd: projectDir,
    });
    client = new Client({ name: 'dist-smoke', version: '1.0.0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('构建完整性：dist 中的资源必须与 src 逐字节一致（防 cp -R 套娃导致的静默陈旧）', async () => {
    const pairs = [
      ['src/db/migrations/V1__init.sql', 'dist/db/migrations/V1__init.sql'],
      ['src/ui/index.html', 'dist/ui/index.html'],
      ['src/ui/app.js', 'dist/ui/app.js'],
      ['src/ui/style.css', 'dist/ui/style.css'],
    ];
    const drifted: string[] = [];
    for (const [s, d] of pairs) {
      const sp = join(projectDir, s);
      const dp = join(projectDir, d);
      if (!existsSync(sp) || !existsSync(dp)) { drifted.push(`${d} 缺失`); continue; }
      // 必须按文本读取比较：无编码时返回 Buffer，Buffer !== Buffer 恒为 true
      if (readFileSync(sp, 'utf8') !== readFileSync(dp, 'utf8')) drifted.push(`${d} 与 ${s} 不一致`);
    }
    expect(drifted, `构建产物陈旧，请运行 npm run build：\n${drifted.join('\n')}`).toEqual([]);

    // cp -R 到已存在目录会套娃成 dist/ui/ui、dist/db/migrations/migrations
    const nested = ['dist/ui/ui', 'dist/db/migrations/migrations'].filter((p) => existsSync(join(projectDir, p)));
    expect(nested, `存在套娃目录，请运行 npm run clean && npm run build：${nested.join(', ')}`).toEqual([]);
  });

  it('package.json 的 bin 入口必须是带 shebang 的可执行文件（否则 npm install 后无法运行）', async () => {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(pkg.bin, 'package.json 应声明 bin').toBeTruthy();
    const bins = Object.entries(pkg.bin!);
    expect(bins.length).toBeGreaterThan(0);
    for (const [name, rel] of bins) {
      const file = join(projectDir, rel);
      expect(existsSync(file), `bin "${name}" 指向的文件不存在：${rel}（先 npm run build）`).toBe(true);
      // 没有 shebang 时，npm 生成的 .bin 软链会被 shell 当脚本执行 → "import: command not found"
      expect(readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node'), `${rel} 缺少 shebang`).toBe(true);
      // eslint-disable-next-line no-bitwise
      const mode = statSync(file).mode & 0o111;
      expect(mode, `${rel} 缺少可执行位`).toBeGreaterThan(0);
    }
  });

  it('agent 发现层文件齐全（AGENTS.md / SKILL.md / server.json / llms.txt）', async () => {
    for (const f of ['AGENTS.md', 'SKILL.md', 'server.json', 'llms.txt', 'README.md', 'PRODUCT_SPEC.md']) {
      expect(existsSync(join(projectDir, f)), `${f} 缺失`).toBe(true);
    }
    // server.json 的关键一致性：name 必须与 package.json 的 mcpName 相同（MCP Registry 靠它验所有权）
    const server = JSON.parse(readFileSync(join(projectDir, 'server.json'), 'utf8')) as {
      name: string; version: string; packages: { identifier: string; version: string; transport: { type: string } }[];
    };
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      name: string; version: string; mcpName?: string;
    };
    expect(pkg.mcpName, 'package.json 需要 mcpName').toBe(server.name);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.packages[0].transport.type).toBe('stdio');
  });

  it('产物可启动、能完成 initialize、tools 已注册', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(45);
    expect(tools.map((t) => t.name)).toContain('growth_status');
  });

  it('产物首次启动能自建数据库（migration 文件路径在打包后仍正确）', async () => {
    const r = await call('growth_status');
    expect(r.ok).toBe(true);
    expect((r.data as Record<string, string>).onboarding).toBe('NOT_STARTED');
    expect(existsSync(join(dataDir, 'growth.db'))).toBe(true);
  });

  it('运行时 schema 正确：create_assessment 必须成功（曾因 dist 里 migration 陈旧而失败）', async () => {
    const created = await call('create_assessment', { topic: '运行时冒烟主题', method: 'quiz' });
    expect(created.protocolError).toBeUndefined();
    expect(created.ok).toBe(true);

    const submitted = await call('submit_assessment', {
      assessmentId: (created.data as { id: string }).id,
      passed: true,
      level: 'APPLY',
    });
    expect(submitted.ok).toBe(true);
    expect((submitted.data as { knowledgeStateUpdated: boolean }).knowledgeStateUpdated).toBe(true);
  });

  it('运行时核心规则与源码一致：未完成 Onboarding 时拒绝 plan_today', async () => {
    const r = await call('plan_today', { dailyActions: [{ title: 'x' }] });
    expect(r.ok).toBe(false);
    expect((r.error as Record<string, string>).code).toBe('ONBOARDING_REQUIRED');
  });

  it('运行时状态机与源码一致：Daily 跨天正确处理', async () => {
    // 完整走一遍：onboarding → goal → stage → activate → rollover
    await call('update_profile_patch', { onboardingStatus: 'COMPLETED' });
    const goal = await call('create_goal_draft', {
      title: '运行时验证目标', why: 'w', desiredOutcome: 'o', successCriteria: ['c'],
    });
    const goalId = (goal.data as { id: string }).id;
    await call('confirm_goal', { goalId });
    await call('create_stage_plan', { goalId, stages: [{ title: 'S1' }] });
    await call('activate_goal', { goalId });

    const plan = await call('plan_today', {
      mainQuest: { title: 'm', whyToday: 'w', estimatedMinutes: 30, completionCriteria: 'c' },
    });
    expect(plan.ok).toBe(true);

    // DRAFT 任务直接完成（运行时也要走通自动提升）
    const actions = (plan.data as { actions: { id: string; kind: string }[] }).actions;
    const main = actions.find((a) => a.kind === 'MAIN_QUEST')!;
    const done = await call('complete_action', { actionId: main.id });
    expect(done.ok).toBe(true);
    expect((done.data as { status: string }).status).toBe('COMPLETED');

    const rollover = await call('run_daily_rollover');
    expect(rollover.ok).toBe(true);
    const again = await call('run_daily_rollover');
    expect((again.data as { alreadyRan: boolean }).alreadyRan).toBe(true);
  });

  it('运行时 Passport 可生成并同步（本地 JSON adapter 在打包后可写）', async () => {
    const sync = await call('sync_passport');
    expect(sync.ok).toBe(true);
    expect(existsSync(join(dataDir, 'passport.json'))).toBe(true);

    const passport = await call('get_passport');
    expect((passport.data as { passport: unknown }).passport).toBeTruthy();
  });
});

describe.skipIf(distReady)('运行时冒烟（未构建）', () => {
  it('提示先执行 npm run build', () => {
    console.warn('[skip] dist/mcp/server.js 不存在，运行时冒烟测试已跳过。先运行：npm run build');
    expect(distReady).toBe(false);
  });
});
