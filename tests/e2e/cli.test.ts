import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const projectDir = join(__dirname, '..', '..');
const cliEntry = join(projectDir, 'dist', 'cli', 'main.js');
const distReady = existsSync(cliEntry);

/**
 * CLI 是 Agent 在没有 MCP 时的入口，也是 `ai-growth agent-info` 这类自发现命令的载体。
 * 必须验证：JSON 契约、退出码、错误码、不依赖 TTY。
 */
describe.skipIf(!distReady)('CLI（对 dist 产物执行，需先 npm run build）', () => {
  let dataDir: string;

  interface CliResult { code: number; json: Record<string, unknown> | null; raw: string }

  async function cli(args: string[], expectFail = false): Promise<CliResult> {
    const env = { ...process.env, AI_GROWTH_DATA_DIR: dataDir, AI_GROWTH_TZ: 'Asia/Shanghai' };
    try {
      const { stdout } = await execFileAsync(process.execPath, [cliEntry, ...args, '--json'], { env, cwd: projectDir });
      return { code: 0, json: safeParse(stdout), raw: stdout };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      if (!expectFail) throw e;
      return { code: err.code ?? 1, json: safeParse(err.stdout ?? ''), raw: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  }

  function safeParse(s: string): Record<string, unknown> | null {
    try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ai-growth-cli-'));
  });

  it('help --json 是自描述的：含命令目录、产品规则、上手步骤', async () => {
    const r = await cli(['help']);
    expect(r.code).toBe(0);
    const d = r.json!.data as { commands: { name: string }[]; rules: string[]; nextStepsForAgent: string[]; outputContract: string };
    expect(d.commands.length).toBeGreaterThan(10);
    expect(d.commands.map((c) => c.name)).toContain('agent-info');
    expect(d.commands.map((c) => c.name)).toContain('status');
    expect(d.rules.length).toBeGreaterThanOrEqual(5);
    expect(d.nextStepsForAgent.length).toBeGreaterThanOrEqual(3);
    expect(d.outputContract).toContain('--json');
    // 产品铁律必须出现在自描述里，否则 Agent 可能不知道边界
    expect(d.rules.join(' ')).toContain('Daily Action');
    expect(d.rules.join(' ')).toContain('虚构');
  });

  it('agent-info --json 给出安装、接入与路径信息', async () => {
    const r = await cli(['agent-info']);
    const d = r.json!.data as {
      install: { fromNpm: string[]; fromSource: string[] };
      runtime: { dataDir: string; database: string };
      connect: { mcp: { mcpServers: Record<string, unknown> }; skill: string; cliFallback: string };
      rules: string[];
      docs: Record<string, string>;
    };
    expect(d.install.fromNpm.join(' ')).toContain('npm install -g');
    expect(d.install.fromSource.join(' ')).toContain('npm run build');
    expect(d.runtime.dataDir).toBe(dataDir);
    expect(d.connect.mcp.mcpServers['ai-growth']).toBeTruthy();
    expect(d.connect.skill).toContain('SKILL.md');
    expect(existsSync(d.connect.skill)).toBe(true);
    for (const p of Object.values(d.docs)) expect(existsSync(p), `${p} 应存在`).toBe(true);
  });

  it('start：未访谈时不得生成任何任务（核心原则 2 的结构性保护）', async () => {
    const r = await cli(['start']);
    expect(r.code).toBe(0);
    const d = r.json!.data as {
      today: string;
      rollover: { alreadyRan: boolean; expired: number; pendingReplan: number };
      status: { onboarding: string; suggestedNextOperation: string };
      actions: unknown[];
      instruction: string;
    };
    expect(d.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof d.rollover.alreadyRan).toBe('boolean');
    expect(d.status.onboarding).toBe('NOT_STARTED');
    expect(d.status.suggestedNextOperation).toBe('START_ONBOARDING');
    // 关键：未访谈时不能有任务
    expect(d.actions).toEqual([]);
    expect(d.instruction).toContain('ONBOARDING_REQUIRED');
    expect(d.instruction).toContain('不要生成任何任务');
  });

  it('start 幂等：连续调用不产生新任务', async () => {
    const a = await cli(['start']);
    const b = await cli(['start']);
    expect((a.json!.data as { actions: unknown[] }).actions).toEqual([]);
    expect((b.json!.data as { actions: unknown[] }).actions).toEqual([]);
    expect((b.json!.data as { rollover: { alreadyRan: boolean } }).rollover.alreadyRan).toBe(true);
  });

  it('help 里必须列出启动语相关的命令（start/status），且说明未访谈不派任务', async () => {
    const r = await cli(['help']);
    const d = r.json!.data as { commands: { name: string; summary: string }[] };
    const names = d.commands.map((c) => c.name);
    expect(names).toContain('start');
    expect(names).toContain('status');
    const startCmd = d.commands.find((c) => c.name === 'start')!;
    expect(startCmd.summary).toContain('今日任务');
  });

  it('progress：产出带样式的 Markdown（含声明与禁词检查）', async () => {
    const r = await cli(['progress']);
    expect(r.code).toBe(0);
    const d = r.json!.data as { format: string; markdown: string; title: string; facts: Record<string, unknown> };
    expect(d.format).toBe('markdown');
    expect(d.markdown).toContain('## 成长进度');
    // 原则 6 的可见承诺：必须声明数字来自可核对事实
    expect(d.markdown).toContain('可核对事实');
    // 不得出现"虚构数值的实际展示"（注意：footer 里"不含掌握度/自律分"是承诺，不算违规）
    expect(d.markdown).not.toMatch(/掌握度\s*[:：]?\s*\d/);
    expect(d.markdown).not.toMatch(/自律分\s*[:：]?\s*\d/);
    expect(d.markdown).not.toMatch(/等级\s*[:：]?\s*\d+/);
    expect(d.markdown).not.toMatch(/EXP|六维/);
    // facts 只允许白名单键
    const allowed = ['today', 'stageOrder', 'stageTotal', 'mainDoneToday', 'mainTotalToday',
      'dailyDoneToday', 'dailyTotalToday', 'evidenceTotal', 'growthEventTotal'];
    for (const k of Object.keys(d.facts)) expect(allowed, `facts 出现白名单外的键：${k}`).toContain(k);
  });

  it('progress --out 写文件且按扩展名决定格式', async () => {
    const outMd = join(dataDir, 'progress.md');
    const a = await cli(['progress', '--out', outMd]);
    expect((a.json!.data as { saved: string }).saved).toBe(outMd);
    expect(existsSync(outMd)).toBe(true);
    const text = require('fs').readFileSync(outMd, 'utf8');
    expect(text.startsWith('## 成长进度')).toBe(true);
  });

  it('status 与 start 对同一状态给出一致的 suggestedNextOperation', async () => {
    const s = await cli(['status']);
    const st = await cli(['start']);
    expect((s.json!.data as { suggestedNextOperation: string }).suggestedNextOperation)
      .toBe((st.json!.data as { status: { suggestedNextOperation: string } }).status.suggestedNextOperation);
  });

  it('未初始化时 status 提示 START_ONBOARDING（结构性保护生效）', async () => {
    const r = await cli(['status']);
    const d = r.json!.data as { onboarding: string; suggestedNextOperation: string };
    expect(d.onboarding).toBe('NOT_STARTED');
    expect(d.suggestedNextOperation).toBe('START_ONBOARDING');
  });

  it('init 幂等，可重复执行', async () => {
    const a = await cli(['init']);
    const b = await cli(['init']);
    expect((a.json!.data as { migrated: boolean }).migrated).toBe(true);
    expect((b.json!.data as { migrated: boolean }).migrated).toBe(true);
    expect(existsSync(join(dataDir, 'growth.db'))).toBe(true);
  });

  it('today / goals / timeline / passport / metrics 均有合法 JSON 契约', async () => {
    for (const cmd of ['today', 'goals', 'timeline', 'passport', 'metrics']) {
      const r = await cli([cmd]);
      expect(r.code, `${cmd} 应成功`).toBe(0);
      expect(r.json!.ok, `${cmd} 应 ok:true`).toBe(true);
      expect(r.json!.data, `${cmd} 应有 data`).toBeTruthy();
    }
  });

  it('today 不产生虚构数值字段（原则 6）', async () => {
    const r = await cli(['today']);
    const flat = JSON.stringify(r.json);
    for (const banned of ['mastery', 'percent', '"score"', '掌握', '自律']) {
      expect(flat.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it('rollover 幂等：第二次调用 alreadyRan=true', async () => {
    await cli(['rollover']);
    const r = await cli(['rollover']);
    expect((r.json!.data as { alreadyRan: boolean }).alreadyRan).toBe(true);
  });

  it('mcp-config 输出可直接使用的配置（含绝对路径与 env）', async () => {
    const r = await cli(['mcp-config']);
    const s = (r.json!.data as { mcpServers: { 'ai-growth': { command: string; args: string[]; env: Record<string, string> } } }).mcpServers['ai-growth'];
    expect(s.command).toBeTruthy();
    expect(s.args[0]).toContain('dist/mcp/server.js');
    expect(existsSync(s.args[0])).toBe(true);
    expect(s.env.AI_GROWTH_DATA_DIR).toBe(dataDir);
  });

  it('skill 输出 SKILL.md 全文', async () => {
    const r = await cli(['skill']);
    const d = r.json!.data as { path: string; content: string };
    expect(d.content).toContain('AI Growth Skill');
    expect(d.content).toContain('On load');
  });

  it('写操作：complete 走 Core，错误码与退出码正确', async () => {
    const bad = await cli(['complete', 'not-exist'], true);
    expect(bad.code).toBe(1);
    expect((bad.json!.error as { code: string }).code).toBe('NOT_FOUND');
    expect(bad.json!.ok).toBe(false);
  });

  it('缺少必填参数时给出 VALIDATION_ERROR 而非崩溃', async () => {
    const r = await cli(['complete'], true);
    expect(r.code).toBe(1);
    expect((r.json!.error as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('未知命令给出可行动的提示', async () => {
    const r = await cli(['nonsense-command'], true);
    expect(r.code).toBe(1);
    const e = r.json!.error as { code: string; message: string };
    expect(e.code).toBe('UNKNOWN_COMMAND');
    expect(e.message).toContain('ai-growth help');
  });

  it('version 正确', async () => {
    const r = await cli(['version']);
    expect((r.json!.data as { version: string }).version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.skipIf(distReady)('CLI（未构建）', () => {
  it('提示先构建', () => {
    console.warn('[skip] dist/cli/main.js 不存在，CLI 测试已跳过。先运行：npm run build');
    expect(distReady).toBe(false);
  });
});

/**
 * 设备接入（ai-growth device）。
 *
 * 为什么要单独锁这个命令：设备能不能取到卡，取决于「局域网模式 + 完整令牌 + 正确的
 * 局域网地址」三件事同时给对，缺一个的表现都是设备上那句"连不上电脑"—— 用户在电脑
 * 这边看不到任何线索。而这条链路以前是指向一个不存在的命令的（固件、错误提示、
 * daemon 启动日志三处都在让用户跑 `ai-growth device`，CLI 里却没有）。
 * 所以这里把「命令必须登记在 help 里」「必须给出可整行粘贴的 growth_set」钉死。
 */
describe.skipIf(!distReady)('CLI device（AI Passport 设备接入）', () => {
  let deviceDataDir: string;

  async function cliWithEnv(args: string[], extraEnv: Record<string, string> = {}) {
    const env = {
      ...process.env,
      AI_GROWTH_DATA_DIR: deviceDataDir,
      AI_GROWTH_TZ: 'Asia/Shanghai',
      ...extraEnv,
    };
    const { stdout } = await execFileAsync(process.execPath, [cliEntry, ...args, '--json'], {
      env,
      cwd: projectDir,
    });
    return JSON.parse(stdout) as { ok: boolean; data: Record<string, unknown> };
  }

  beforeAll(() => {
    deviceDataDir = mkdtempSync(join(tmpdir(), 'ai-growth-device-'));
  });

  it('已登记在 help --json 的命令目录里（否则 Agent 找不到入口）', async () => {
    const r = await cliWithEnv(['help']);
    const names = (r.data.commands as unknown as { name: string }[]).map((c) => c.name);
    expect(names).toContain('device');
  });

  it('给出可整行粘贴的 growth_set，且含地址/端口/令牌三要素', async () => {
    const r = await cliWithEnv(['device']);
    const d = r.data;
    expect(r.ok).toBe(true);
    expect(typeof d.token).toBe('string');
    expect((d.token as string).length).toBeGreaterThanOrEqual(16);
    expect((d.growthSetCommand as string).startsWith('growth_set ')).toBe(true);
    expect(d.growthSetCommand as string).toContain(String(d.apiPort));
    expect(d.growthSetCommand as string).toContain(d.token as string);
    // 本机有局域网地址时必须用真地址，不能只留占位符
    if (d.host) expect(d.growthSetCommand as string).toContain(d.host as string);
  });

  it('局域网关时明确报出被什么挡住，别让用户对着"连不上"猜', async () => {
    const r = await cliWithEnv(['device'], { AI_GROWTH_DEVICE_LAN: '0' });
    expect(r.data.lanEnabled).toBe(false);
    expect(r.data.ready).toBe(false);
    expect(r.data.blockedBy).toBe('LAN_DISABLED');
    // 开启方式必须指向"一条能自己搞定的命令"，而不是让用户去记环境变量
    expect(r.data.enableLanCommand as string).toContain('ai-growth device setup');
  });

  it('局域网开时 ready 与实际地址一致', async () => {
    const r = await cliWithEnv(['device'], { AI_GROWTH_DEVICE_LAN: '1' });
    expect(r.data.lanEnabled).toBe(true);
    if (r.data.host) {
      expect(r.data.ready).toBe(true);
      expect(r.data.blockedBy).toBe(null);
      expect(r.data.deviceApiBase as string).toContain('/api/device');
    } else {
      // 没插网线/没连 Wi-Fi 的环境：必须说清楚是这个原因，而不是含糊地"没准备好"
      expect(r.data.blockedBy).toBe('NO_LAN_ADDRESS');
    }
  });

  it('默认幂等：重复调用不会悄悄换掉设备上已配好的那个令牌', async () => {
    const a = await cliWithEnv(['device']);
    const b = await cliWithEnv(['device']);
    expect(b.data.token).toBe(a.data.token);
    expect(b.data.tokenCreatedOrRotated).toBe(false);
  });

  it('--rotate 才换令牌，并且换了就落盘（下次调用读到新的）', async () => {
    const before = await cliWithEnv(['device']);
    const rotated = await cliWithEnv(['device', '--rotate']);
    expect(rotated.data.tokenCreatedOrRotated).toBe(true);
    expect(rotated.data.token).not.toBe(before.data.token);
    const after = await cliWithEnv(['device']);
    expect(after.data.token).toBe(rotated.data.token);
  });
});
