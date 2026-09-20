#!/usr/bin/env node
/**
 * ai-growth CLI — 让 Agent 与人都能直接驱动这套系统。
 *
 * 设计要点：
 * 1. **自描述**：`ai-growth help --json` 会输出全部命令、参数与规则，
 *    Agent 不需要读源码就知道怎么用；`ai-growth agent-info --json` 给出安装/接入所需的全部路径。
 * 2. **统一契约**：所有命令的输出与 MCP 工具一致 —— `{ ok, data, error? }`。
 * 3. **非 TTY 自动 JSON**：被管道/子进程调用时默认输出 JSON，避免 Agent 忘记加 --json。
 * 4. 所有读写都走 Core Service，与 MCP / 面板完全同一条路径。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

import { loadConfig } from '../shared/config.js';
import { openDb, dbPath } from '../db/client.js';
import { makeCtx } from '../mcp/ctx.js';
import { ok, err, DomainError, type ToolResult } from '../shared/result.js';

import { growthStatus } from '../core/status.js';
import { getTodayPlan, completeAction, skipAction, delayAction } from '../core/actions.js';
import { listStages, getCurrentStage, listGoals } from '../core/goals.js';
import { listGrowthEvents, listEvidence } from '../core/evidence.js';
import { runDailyRollover } from '../core/rollover.js';
import { listRemindersForDate } from '../reminder/service.js';
import { getActiveLifeContext } from '../core/lifeContext.js';
import { computeMetrics } from '../core/metrics.js';
import { renderProgress } from '../core/progress.js';
import { todayIn, resolveTimezone } from '../core/profile.js';
import { latestSnapshot } from '../passport/state.js';
import { isDeviceLanEnabled, setDeviceLanEnabled, getOrCreateDeviceToken, rotateDeviceToken } from '../device/token.js';
import { provisionDevice, probeService, type ProvisionResult } from '../device/provision.js';

const VERSION = '1.1.0';
/** 包根目录：dist/cli/main.js → 上两级 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 判断当前跑的是哪一份代码。
 * 设计目标：**开发与生产共用同一条全局命令**，所以这里只做"体检与告知"，不改变行为。
 * - `checkout`  从 git 检出目录直接跑（开发）
 * - `linked`    全局命令软链到检出目录（npm link：开发代码 + 全局入口）
 * - `installed` 全局装了一份实体（npm install -g：生产）
 */
type InstallKind = 'checkout' | 'linked' | 'installed';

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function detectInstall(): {
  kind: InstallKind;
  selfPath: string;
  invokedVia: 'global-command' | 'direct-path';
  globalPrefix: string;
  globalBin: string;
  globalCliPath: string;
  globalCliResolvesHere: boolean;
  binOnPath: boolean;
} {
  // 注意：Node 默认解析符号链接，import.meta.url 报的是**真实路径**。
  // 因此不能用"路径里是否含 node_modules/ai-growth"判断，
  // 必须比较「全局入口的 realpath」与「当前代码根目录」。
  const selfPath = fileURLToPath(import.meta.url);
  const invokedAs = process.argv[1] ?? '';
  const globalPrefix = sh('npm', ['prefix', '-g']);
  const globalBin = globalPrefix ? join(globalPrefix, 'bin') : '';
  const globalPkgDir = globalPrefix ? join(globalPrefix, 'lib', 'node_modules', 'ai-growth') : '';
  const globalCliPath = globalPkgDir ? join(globalPkgDir, 'dist', 'cli', 'main.js') : '';

  let globalCliResolvesHere = false;
  if (globalCliPath && existsSync(globalCliPath)) {
    const real = sh('node', ['-e', `process.stdout.write(require('fs').realpathSync(${JSON.stringify(globalCliPath)}))`]);
    globalCliResolvesHere = !!real && resolve(dirname(dirname(dirname(real)))) === resolve(ROOT);
  }

  let kind: InstallKind = 'checkout';
  if (globalCliResolvesHere) {
    // 全局入口存在；再看它是软链到本检出，还是独立的一份实体
    const realPkg = globalPkgDir
      ? sh('node', ['-e', `process.stdout.write(require('fs').realpathSync(${JSON.stringify(globalPkgDir)}))`])
      : '';
    kind = realPkg && resolve(realPkg) === resolve(ROOT) ? 'linked' : 'installed';
  }
  const invokedVia: 'global-command' | 'direct-path' =
    globalBin && invokedAs.startsWith(globalBin) ? 'global-command' : 'direct-path';

  const pathDirs = (process.env.PATH ?? '').split(':');
  return {
    kind, selfPath, invokedVia, globalPrefix, globalBin, globalCliPath, globalCliResolvesHere,
    binOnPath: pathDirs.includes(globalBin),
  };
}

// ---------------------------------------------------------------- 参数解析

interface Parsed {
  cmd: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): Parsed {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else if (a === '-h') {
      flags.help = true;
    } else if (!a.startsWith('-')) {
      args.push(a);
    }
  }
  return { cmd: args[0] ?? 'help', args: args.slice(1), flags };
}

// ---------------------------------------------------------------- 输出

function wantsJson(flags: Record<string, string | boolean>): boolean {
  if (flags.json === true) return true;
  if (flags.json === 'false' || flags['no-json'] === true) return false; // 逃生口
  // 非 TTY（被 Agent/管道调用）默认 JSON，避免忘记加 --json
  return !process.stdout.isTTY;
}

function emit(result: ToolResult<unknown>, flags: Record<string, string | boolean>, human?: () => string): void {
  if (wantsJson(flags)) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    process.stderr.write(`✗ ${result.error?.code}: ${result.error?.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write((human ? human() : JSON.stringify(result.data, null, 2)) + '\n');
}

function run<T>(fn: () => T, flags: Record<string, string | boolean>, human?: (d: T) => string): void {
  try {
    const data = fn();
    emit(ok(data), flags, human ? () => human(data) : undefined);
  } catch (e) {
    if (e instanceof DomainError) emit(err(e.code, e.message, e.retryable), flags);
    else emit(err('INTERNAL', e instanceof Error ? e.message : String(e)), flags);
  }
}

/**
 * run 的异步版。配置设备要真的走串口（异步 IO + 超时等待），同步签名套不住，
 * 所以错误映射必须在这里再做一遍，保持与 run 完全一致的输出契约。
 */
function runAsync<T>(
  fn: () => Promise<T>,
  flags: Record<string, string | boolean>,
  human?: (d: T) => string
): void {
  fn().then(
    (data) => emit(ok(data), flags, human ? () => human(data) : undefined),
    (e: unknown) => {
      if (e instanceof DomainError) emit(err(e.code, e.message, e.retryable), flags);
      else emit(err('INTERNAL', e instanceof Error ? e.message : String(e)), flags);
    }
  );
}

// ---------------------------------------------------------------- 命令目录（自描述）

interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  args?: string[];
  writes?: boolean;
  example?: string;
}

const COMMANDS: CommandSpec[] = [
  { name: 'help', summary: '列出全部命令、参数与使用规则（自描述入口）', usage: 'ai-growth help [--json]', example: 'ai-growth help --json' },
  { name: 'agent-info', summary: 'Agent 引导信息：安装路径、数据目录、MCP 配置、Skill 位置、下一步动作', usage: 'ai-growth agent-info [--json]', example: 'ai-growth agent-info --json' },
  { name: 'info', summary: '环境与运行状态：版本、数据目录、时区、安装形态与更新方式', usage: 'ai-growth info [--json]' },
  { name: 'where', summary: '当前跑的是哪一份代码、数据在哪、怎么更新（开发/生产统一入口）', usage: 'ai-growth where [--json]' },
  { name: 'status', summary: '当前成长状态与建议的下一步操作（等价于 MCP growth_status）', usage: 'ai-growth status [--json]' },
  { name: 'start', summary: '「开启今日任务」的确定性入口：跨天检查 + 状态 + 今日计划 + 明确该做什么（未访谈时不会生成任务）', usage: 'ai-growth start [--json]', example: 'ai-growth start --json' },
  { name: 'today', summary: '今日计划：Main Quest + Daily Actions + 提醒', usage: 'ai-growth today [--json]' },
  { name: 'goals', summary: '主线目标与阶段计划', usage: 'ai-growth goals [--json]' },
  { name: 'timeline', summary: '成长记录与证据流', usage: 'ai-growth timeline [--json] [--limit N]' },
  { name: 'passport', summary: 'AI Passport 快照', usage: 'ai-growth passport [--json]' },
  { name: 'progress', summary: '产出带样式的进度报告：阶段轨道 + 进度条 + Mermaid 甘特图 + 事实表（可 --out 存成 .md/.html）', usage: 'ai-growth progress [--html] [--out FILE]', example: 'ai-growth progress --no-json' },
  { name: 'metrics', summary: '本地规划指标（用于改进推荐，不是自律分）', usage: 'ai-growth metrics [--json] [--days N]' },
  { name: 'rollover', summary: '执行跨天检查（幂等）：昨日未完成 Daily → 过期，Main → 待重排', usage: 'ai-growth rollover [--json]', writes: true },
  { name: 'complete', summary: '完成一个任务', usage: 'ai-growth complete <actionId> [--note "..."]', args: ['actionId'], writes: true, example: 'ai-growth complete ab12-... --note "已跑通"' },
  { name: 'skip', summary: '跳过任务（可带原因）', usage: 'ai-growth skip <actionId> [--reason "..."]', args: ['actionId'], writes: true },
  { name: 'delay', summary: '延期任务（不跨天作废，与 Daily 的过期不同）', usage: 'ai-growth delay <actionId> [--reason "..."]', args: ['actionId'], writes: true },
  { name: 'mcp-config', summary: '输出可直接粘贴的 MCP 配置（含绝对路径）', usage: 'ai-growth mcp-config [--json]' },
  { name: 'skill', summary: '输出 SKILL.md 全文 —— Agent 应按它行事', usage: 'ai-growth skill [--json]' },
  { name: 'doctor', summary: '环境自检（依赖/构建/数据库/launchd/MCP/面板）', usage: 'ai-growth doctor' },
  { name: 'device', summary: 'AI Passport 设备接入：`device` 看局域网状态/本机地址/令牌；`device setup` 一条命令配好 Wi-Fi 并自动确认取卡成功', usage: 'ai-growth device [setup --ssid <Wi-Fi名> [--pass <密码>] [--port <串口>] [--no-verify] [--no-enable-lan]] [--rotate] [--json]', writes: true, example: 'ai-growth device setup --ssid "我家的WiFi" --pass "12345678"' },
  { name: 'init', summary: '初始化数据库并执行 migration（幂等）', usage: 'ai-growth init', writes: true },
  { name: 'migrate', summary: 'init 的别名 —— 更新后跑它执行数据库迁移（幂等、不丢数据）', usage: 'ai-growth migrate', writes: true },
  { name: 'serve', summary: '前台启动常驻服务（调度 + 面板 API）', usage: 'ai-growth serve' },
  { name: 'version', summary: '打印版本', usage: 'ai-growth version' },
];

/** 产品铁律：Agent 驱动本系统前必须知道 */
const RULES = [
  'AI 管路线，人决定目的地：不得替人决定人生方向。',
  '首次使用必须先做访谈（onboarding），不允许直接生成任务。',
  'Daily Action 只当天有效，次日自动过期，绝不顺延成跨天债务，也不 clone 到第二天。',
  'Main Quest 未完成不作废，进入 PENDING_REPLAN 由 Replan 解决。',
  '默认负荷 1 个 Main Quest + 0~2 个 Daily Action；长期提高负荷必须用户确认。',
  '不产生虚构属性值 / 掌握度百分比 / 自律分；进度只用可核对事实（如 Stage 3 / 6、Evidence）。',
  '所有状态变更必须经 Core Service；不要直接写数据库。',
  '"哪一天"按配置时区计算，绝不按 UTC 截断。',
  '不要为了展示功能而生成大量任务；宁可少而准。',
];

const NEXT_STEPS = [
  '1) ai-growth agent-info --json   # 拿到数据目录、MCP 配置片段、Skill 路径',
  '2) ai-growth start --json        # 启动今日：跨天检查 + 状态 + 今日计划 + 该做什么（推荐入口）',
  '3) 按 instruction / suggestedNextOperation 行动（先访谈 / 解决 Replan / 生成今日计划 / 继续推进）',
  '4) 需要完整工具集时接入 MCP（ai-growth mcp-config --json）',
];

// ---------------------------------------------------------------- 主流程

function main(): void {
  const { cmd, args, flags } = parseArgv(process.argv.slice(2));

  switch (cmd) {
    case 'help':
      return run(
        () => ({
          name: 'ai-growth',
          version: VERSION,
          description: 'Agent-native、Local-first 的个人成长执行系统：AI 维护计划，人保留目标与确认权。',
          outputContract: '所有命令加 --json 输出 { ok, data, error? }；非 TTY（被 Agent/管道调用）时默认即 JSON，加 --no-json 可强制人类可读输出。',
          rules: RULES,
          commands: COMMANDS,
          nextStepsForAgent: NEXT_STEPS,
          docs: ['AGENTS.md', 'README.md', 'SKILL.md', 'PRODUCT_SPEC.md'],
        }),
        flags,
        (d) => {
          const lines: string[] = [
            `ai-growth ${d.version} — ${d.description}`,
            '',
            '命令：',
            ...COMMANDS.map((c) => `  ${c.name.padEnd(12)} ${c.summary}${c.writes ? '  [写入]' : ''}`),
            '',
            '产品铁律（Agent 必读）：',
            ...RULES.map((r) => `  · ${r}`),
            '',
            'Agent 上手步骤：',
            ...NEXT_STEPS.map((s) => `  ${s}`),
          ];
          return lines.join('\n');
        }
      );

    case 'version':
      return run(() => ({ name: 'ai-growth', version: VERSION }), flags, (d) => `ai-growth ${d.version}`);

    case 'agent-info':
      return run(() => agentInfo(flags), flags, (d) => agentInfoHuman(d));

    case 'info':
      return run(() => envInfo(), flags, (d) => envInfoHuman(d));

    case 'where': {
      const inst = detectInstall();
      return run(
        () => ({
          kind: inst.kind,
          kindLabel: INSTALL_LABEL[inst.kind],
          codePath: inst.selfPath,
          invokedVia: inst.invokedVia,
          globalCommand: inst.globalBin ? join(inst.globalBin, 'ai-growth') : null,
          globalCliPath: inst.globalCliPath || null,
          globalCommandPointsHere: inst.globalCliResolvesHere,
          dataDir: loadConfig().dataDir,
          dataIndependentOfCode: true,
          note: 'CLI / MCP / daemon / 面板 都指向「正在运行的这一份」代码。更新就是替换这一份；数据在 ~/.ai-growth，与代码解耦。',
          howToUpdate: updateSteps(inst.kind),
        }),
        flags,
        (d) => [
          `安装形态：${d.kindLabel}`,
          `代码位置：${d.codePath}`,
          `调用方式：${d.invokedVia === 'global-command' ? '全局命令' : '直接指定路径'}`,
          d.globalCommand ? `全局命令：${d.globalCommand}${d.globalCommandPointsHere ? '  ✓ 指向这份代码' : ''}` : '',
          `数据目录：${d.dataDir}   （与代码解耦，更新不动它）`,
          '',
          '更新方式：',
          ...d.howToUpdate.map((s) => `  ${s}`),
        ].filter(Boolean).join('\n')
      );
    }

    case 'status':
      return run(() => withCtx((ctx) => growthStatus(ctx)), flags, (d) => statusHuman(d));

    /**
     * 「开启今日任务」的确定性入口：一次调用完成 跨天检查 → 状态 → 今日计划。
     * Agent 听到「开启今日任务 / 今天要做什么 / 开工」时，直接调它即可，不必先猜状态。
     * 注意：未完成访谈时不会生成任何任务，只返回 START_ONBOARDING（核心原则 2）。
     */
    case 'start':
      return run(
        () => withCtx((ctx) => {
          const rollover = runDailyRollover(ctx);
          const status = growthStatus(ctx);
          const { plan, actions } = getTodayPlan(ctx);
          const needsOnboarding = status.onboarding !== 'COMPLETED';
          return {
            today: todayIn(ctx),
            rollover: { alreadyRan: rollover.alreadyRan, expired: rollover.expiredDailyActionIds.length, pendingReplan: rollover.pendingReplanMainQuestIds.length },
            status,
            plan,
            actions,
            reminders: listRemindersForDate(ctx),
            // 明确告知调用方：现在该干什么。未访谈时不产出任务，先访谈。
            instruction: needsOnboarding
              ? 'ONBOARDING_REQUIRED：先与用户做访谈（不要生成任何任务），完成后再说 GOAL_SETUP'
              : {
                  START_ONBOARDING: '先访谈',
                  CONTINUE_ONBOARDING: '继续访谈，不要从头问',
                  DISCUSS_GOAL: '与用户讨论目标，不要自己编一个',
                  RESOLVE_REPLAN: '先解决待重排的主线，再规划今天',
                  RUN_DAILY_PLANNING: '生成今日计划（1 Main + 0~2 Daily）并请用户确认',
                  CONFIRM_TODAY_PLAN: '把今日计划给用户确认',
                  CONTINUE_TODAY: '帮用户推进手上的任务',
                }[status.suggestedNextOperation] ?? '按 suggestedNextOperation 行动',
          };
        }),
        flags,
        (d) => [
          `今天 ${d.today}`,
          d.rollover.alreadyRan ? '跨天检查：今天已执行过（幂等）' : `跨天检查：过期 ${d.rollover.expired} 个 Daily，${d.rollover.pendingReplan} 个 Main 待重排`,
          `状态：${d.status.onboarding} · 待重排 ${d.status.pendingReplan ? '有' : '无'}`,
          '',
          `该做什么：${d.instruction}`,
        ].join('\n')
      );

    case 'today':
      return run(
        () => withCtx((ctx) => {
          runDailyRollover(ctx); // 幂等：保证"今天"的视角正确
          const { plan, actions } = getTodayPlan(ctx);
          return {
            today: todayIn(ctx),
            plan,
            actions,
            reminders: listRemindersForDate(ctx),
            lifeContext: getActiveLifeContext(ctx),
          };
        }),
        flags,
        (d) => todayHuman(d)
      );

    case 'goals':
      return run(
        () => withCtx((ctx) => listGoals(ctx).map((g) => ({ ...g, stages: listStages(ctx, g.id), currentStage: getCurrentStage(ctx, g.id) }))),
        flags,
        (d) => d.map((g) => `${g.title} [${g.status}] — ${g.stages.length} 个阶段`).join('\n') || '（还没有 Goal）'
      );

    case 'timeline':
      return run(
        () => withCtx((ctx) => {
          const limit = Number(flags.limit ?? 20);
          const tz = resolveTimezone(ctx);
          return {
            today: todayIn(ctx),
            events: listGrowthEvents(ctx, undefined, limit),
            evidence: listEvidence(ctx, { limit }).map((e) => ({ ...e, dateKey: localDateKeySafe(e.createdAt, tz) })),
          };
        }),
        flags,
        (d) => d.events.map((e) => `  ${e.dateKey}  ${e.title}`).join('\n') || '（还没有成长记录）'
      );

    case 'passport':
      return run(() => withCtx((ctx) => {
        const snap = latestSnapshot(ctx);
        return { snapshot: snap?.passport ?? null, generatedAt: snap?.generatedAt, dirty: snap?.dirty };
      }), flags);

    case 'metrics':
      return run(() => withCtx((ctx) => computeMetrics(ctx, Number(flags.days ?? 14))), flags);

    /** 产出**带样式的 Markdown**（含阶段轨道、进度条、Mermaid 甘特图、事实表），不是纯文字流水账 */
    case 'progress':
      return run(
        () => {
          const cfg = loadConfig();
          const db = openDb(cfg.dataDir);
          const report = renderProgress(makeCtx(db, cfg, 'cli'));
          if (flags.out) {
            // --out 指定文件时按扩展名决定格式
            const target = String(flags.out);
            const isHtml = target.endsWith('.html');
            writeFileSync(target, isHtml ? report.html : report.markdown, 'utf8');
            return { saved: target, format: isHtml ? 'html' : 'markdown', title: report.title, facts: report.facts };
          }
          return {
            format: flags.html ? 'html' : 'markdown',
            title: report.title,
            facts: report.facts,
            markdown: report.markdown,
            html: report.html,
          };
        },
        flags,
        (d) => {
          const x = d as { markdown?: string; html?: string; format?: string; saved?: string };
          if (x.saved) return `✓ 已保存：${x.saved}（${x.format}）`;
          return (x.format === 'html' || flags.html) ? (x.html ?? '') : (x.markdown ?? '');
        }
      );

    case 'rollover':
      return run(() => withCtx((ctx) => runDailyRollover(ctx)), flags, (d) =>
        d.alreadyRan
          ? '今天已经执行过跨天检查（幂等）'
          : `已过期 ${d.expiredDailyActionIds.length} 个 Daily，${d.pendingReplanMainQuestIds.length} 个 Main 转入待重排`
      );

    case 'complete': {
      const id = args[0];
      if (!id) return failMissing('complete', '<actionId>', flags);
      return run(() => withCtx((ctx) => completeAction(ctx, id)), flags, (d) => `✓ 已完成：${d.title}`);
    }

    case 'skip': {
      const id = args[0];
      if (!id) return failMissing('skip', '<actionId>', flags);
      return run(() => withCtx((ctx) => skipAction(ctx, id, str(flags.reason))), flags, (d) => `已跳过：${d.title}`);
    }

    case 'delay': {
      const id = args[0];
      if (!id) return failMissing('delay', '<actionId>', flags);
      return run(() => withCtx((ctx) => delayAction(ctx, id, str(flags.reason))), flags, (d) => `已延期：${d.title}`);
    }

    case 'mcp-config':
      return run(() => mcpConfig(), flags, (d) => JSON.stringify(d.mcpServers, null, 2));

    case 'skill': {
      const file = join(ROOT, 'SKILL.md');
      return run(
        () => ({ path: file, content: existsSync(file) ? readFileSync(file, 'utf8') : null }),
        flags,
        (d) => d.content ?? `未找到 SKILL.md（预期位置：${d.path}）`
      );
    }

    case 'doctor':
      return runDoctor(flags);

    /**
     * 设备接入。
     *
     * 存在的理由：设备要取卡，必须让 daemon 以局域网模式跑（AI_GROWTH_DEVICE_LAN=1），
     * 而局域网一开，/api/device/* 对【所有】来源都强制校验令牌（见 src/device/token.ts）。
     * 于是「本机局域网地址 + 完整令牌」这两样缺一不可 —— 以前它们只散落在
     * daemon 启动日志的前 8 位里，用户拿不到完整值（固件、错误提示、启动日志
     * 三处却都在让用户跑 `ai-growth device`）。这个命令就是补上那个断掉的接口。
     */
    // 两个子命令：device（只读看状态） / device setup（一条命令配好并自己确认成功）。
    // setup 是发布出去的应用该有的体验：用户不需要跑脚本，Agent 也不需要逐步排查。
    case 'device': {
      if (args[0] !== 'setup') {
        return run(() => deviceInfo(flags.rotate === true), flags, (d) => deviceHuman(d));
      }

      const ssid = str(flags.ssid);
      if (!ssid) return failMissing('device setup', '--ssid <Wi-Fi 名>', flags);
      const password = str(flags.pass) ?? '';

      return runAsync(
        async () => {
          const info = deviceInfo(false);

          // ① 局域网开关：默认是关的，而设备只能走局域网才够得到电脑。
          //    作为要发布出去的应用，这条命令应该**把它打开并记住**，
          //    而不是让用户回去查文档再手动带环境变量。
          let justEnabledLan = false;
          if (!info.lanEnabled) {
            if (flags['no-enable-lan'] === true) {
              throw new DomainError(
                'LAN_DISABLED',
                '服务只绑在 127.0.0.1，设备在 Wi-Fi 上够不到它。按 --no-enable-lan 未自动开启；'
                + '去掉该参数重跑即可自动开启并记住。'
              );
            }
            withCtx((ctx) => setDeviceLanEnabled(ctx, true));
            justEnabledLan = true;
          }

          // ② 服务活着吗。刚刚才打开开关的话，正在跑的那个实例仍绑在 127.0.0.1，
          //    必须重启一次才生效 —— 这点必须明说，否则用户会以为已经好了。
          if (!(await probeService(info.apiPort))) {
            throw new DomainError(
              'SERVICE_NOT_RUNNING',
              `本机 ${info.apiPort} 端口没有服务在跑，设备取不到卡。\n`
              + '  启动：ai-growth serve'
              + (justEnabledLan ? '\n（局域网访问已开启并记住，直接 serve 就行，不用再带环境变量）' : '')
            );
          }
          if (justEnabledLan) {
            throw new DomainError(
              'LAN_JUST_ENABLED_RESTART_NEEDED',
              '已开启并记住「局域网访问」，但当前这个服务实例还是绑在 127.0.0.1，重启一次才生效'
              + '（重启后不需要任何环境变量）。\n  重启：ai-growth serve'
            );
          }
          if (!info.host) {
            throw new DomainError('NO_LAN_ADDRESS', '没找到本机的局域网地址：确认这台电脑连着 Wi-Fi 或网线。');
          }

          return provisionDevice({
            ssid,
            password,
            host: info.host,
            apiPort: info.apiPort,
            token: info.token,
            serialPath: str(flags.port),
            skipVerify: flags['no-verify'] === true,
          });
        },
        flags,
        (d) => provisionHuman(d)
      );
    }

    case 'init':
    case 'migrate':
      return run(() => {
        const cfg = loadConfig();
        openDb(cfg.dataDir);
        return { dataDir: cfg.dataDir, db: dbPath(cfg.dataDir), migrated: true };
      }, flags, (d) => `✓ 数据库就绪（migration 幂等）：${d.db}`);

    case 'serve': {
      const child = spawn(process.execPath, [join(ROOT, 'dist', 'daemon', 'main.js')], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }

    default:
      return emit(err('UNKNOWN_COMMAND', `未知命令：${cmd}。运行 ai-growth help 查看全部命令。`), flags);
  }
}

// ---------------------------------------------------------------- 辅助

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function failMissing(cmd: string, arg: string, flags: Record<string, string | boolean>): void {
  emit(err('VALIDATION_ERROR', `${cmd} 需要参数 ${arg}。用法见 ai-growth help --json`), flags);
}

function withCtx<T>(fn: (ctx: ReturnType<typeof makeCtx>) => T): T {
  const cfg = loadConfig();
  const db = openDb(cfg.dataDir);
  return fn(makeCtx(db, cfg, 'cli'));
}

// ---------------------------------------------------------------- 设备接入

/**
 * 找出「设备应该连哪个地址」。
 *
 * 为什么不能直接取第一个非回环地址：本机装了 Tailscale，会多出 utun* 隧道网卡；
 * 热点/虚拟机还会带来 awdl / llw / bridge / ap 这些前缀的网卡。设备是同一台 Wi-Fi 上的
 * 另一台机器，只有真实局域网地址（192.168 或 10 或 172.16-31）才连得上 —— 给错了它
 * 永远连不上，而设备上只显示"连不上电脑"，用户在电脑这边看不到任何线索。
 */
function lanIPv4(): { address: string; iface: string } | null {
  const ifaceRank = (n: string) => (/^en\d/.test(n) ? 0 : /^eth/.test(n) ? 1 : 2);
  const all: Array<{ address: string; iface: string; isPrivate: boolean }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(utun|llw|awdl|bridge|ap\d|gif|stf|lo)/.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      all.push({
        address: a.address,
        iface: name,
        isPrivate: /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a.address),
      });
    }
  }
  const lan = all.filter((c) => c.isPrivate).sort((a, b) => ifaceRank(a.iface) - ifaceRank(b.iface));
  return lan[0] ?? all[0] ?? null;
}

/**
 * 设备接入所需的一切。只读 + 幂等创建令牌（没有就生成，不覆盖已有的）。
 * 令牌是设备与电脑之间的共享密钥，只在局域网开启时参与校验。
 */
function deviceInfo(rotate: boolean) {
  const cfg = loadConfig();
  const lan = lanIPv4();
  // 令牌与"局域网开关"都落在 settings 表里（开关仍允许环境变量临时覆盖，见 token.ts）
  const { token, lanEnabled, lanFromEnv } = withCtx((ctx) => ({
    token: rotate ? rotateDeviceToken(ctx) : getOrCreateDeviceToken(ctx),
    lanEnabled: isDeviceLanEnabled(cfg, ctx),
    lanFromEnv: (cfg.deviceLan ?? '').trim() !== '',
  }));
  const host = lan?.address ?? null;
  const enableLanCommand = 'ai-growth device setup --ssid <Wi-Fi名> --pass <密码>（会自动开启并记住）';

  return {
    lanEnabled,
    lanFromEnv,
    lanSwitchEnvVar: 'AI_GROWTH_DEVICE_LAN',
    enableLanCommand,
    token,
    tokenCreatedOrRotated: rotate,
    host,
    iface: lan?.iface ?? null,
    apiPort: cfg.apiPort,
    deviceApiBase: host ? `http://${host}:${cfg.apiPort}/api/device` : null,
    /** 现在就差什么才能真正跑通 */
    ready: lanEnabled && !!host,
    blockedBy: !lanEnabled ? 'LAN_DISABLED' : !host ? 'NO_LAN_ADDRESS' : null,
    /**
     * 这一行要原样粘进设备串口。设备侧解析是 `growth_set <ssid> <pass> <host> <port> [token]`
     * （见固件 main/growth_config.c），<你的Wi-Fi名>/<Wi-Fi密码> 由用户替换；
     * 密码不能含空格，开放网络可以写 ""。
     */
    growthSetCommand: `growth_set <你的Wi-Fi名> <Wi-Fi密码> ${host ?? '<本机局域网IP>'} ${cfg.apiPort} ${token}`,
    /**
     * ⚠ Wi-Fi 名含中文（或空格）时必须用这一条，并把名字/密码换成 hex。
     * 原因：esp_console 交给命令前会过 sanitize()，只保留 isprint() 为真的字节，
     * 中文（UTF-8 的 0x80~0xFF）会被整段丢掉 —— 用 growth_set 只会存进一个残缺的尾巴。
     * （日常直接用 `ai-growth device setup`，它会自动判断该走哪条。）
     */
    growthSetHexCommand: `growth_set_hex <Wi-Fi名的hex> <密码的hex> ${host ?? '<本机局域网IP>'} ${cfg.apiPort} ${token}`,
    deviceConsoleCommands: ['growth_status', 'growth_set', 'growth_set_hex', 'growth_clear'],
    steps: [
      lanEnabled
        ? '服务已在局域网模式：确认 ai-growth serve（或已装好的 daemon）正在跑'
        : '先按上面那行把服务切成局域网模式再重启（否则设备永远连不上）',
      '确保设备连的是跟电脑同一个 Wi-Fi',
      '插上 USB、打开设备串口，粘上面那行 growth_set（保存后设备会自动重启）',
      '重启后敲 growth_status 看配置，再按键让它取卡',
    ],
    note: '局域网关闭时不校验令牌；开启后所有来源（含本机）都必须带令牌。',
  };
}

function deviceHuman(d: ReturnType<typeof deviceInfo>): string {  const out = ['设备接入（AI Passport）', ''];
  out.push(`本地服务   ：http://127.0.0.1:${d.apiPort}`);
  if (d.host) out.push(`设备要连的地址：http://${d.host}:${d.apiPort}${d.iface ? `   （网卡 ${d.iface}）` : ''}`);
  else out.push('设备要连的地址：没找到局域网地址 —— 确认这台电脑连着 Wi-Fi 或网线');
  out.push(
    `局域网访问 ：${d.lanEnabled ? '已开启 ✓' : '未开启 ✗ 设备在 Wi-Fi 上够不到这台电脑'}`
  );
  if (!d.lanEnabled) out.push(`             用这个命令重启服务即可开启：${d.enableLanCommand}`);
  out.push(`设备令牌   ：${d.token}${d.tokenCreatedOrRotated ? '   （刚刚重新生成，设备需要重新配置）' : ''}`);
  out.push('');
  out.push('在设备串口里粘这一行（把两个尖括号换成你的 Wi-Fi；密码不能含空格）：');
  out.push(`  ${d.growthSetCommand}`);
  out.push('');
  out.push('顺序：');
  for (const [i, s] of d.steps.entries()) out.push(`  ${i + 1}. ${s}`);
  if (!d.lanEnabled) {
    out.push('');
    out.push('⚠ 不先开局域网的话，设备会一直停在「连不上电脑」。');
  }
  return out.join('\n');
}

/** device setup 的结果，照"每步成/败 + 判定依据 + 下一步"三段给，方便人和 Agent 都直接用 */
function provisionHuman(d: ProvisionResult): string {
  const out = ['AI Passport 连接', ''];
  for (const s of d.steps) {
    out.push(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? `  —— ${s.detail}` : ''}`);
  }
  if (d.evidence.length > 0) {
    out.push('', '设备日志（判定依据）：');
    for (const line of d.evidence.slice(0, 6)) out.push(`  ${line}`);
  }
  out.push('');
  out.push(d.ok
    ? `✓ 完成：设备已连上 Wi-Fi 并成功取到卡（写入方式 ${d.usedCommand}；串口 ${d.serialPath}）`
    : `✗ 未完成：设备给出的结论是 ${d.verdict}`);
  if (d.nextAction) out.push('', `下一步：${d.nextAction}`);
  return out.join('\n');
}

/** 局部导入避免与 core/time 循环依赖写法分散 */
function localDateKeySafe(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));
}

function envInfo() {
  const cfg = loadConfig();
  const inst = detectInstall();
  return {
    version: VERSION,
    node: process.version,
    platform: process.platform,
    dataDir: cfg.dataDir,
    database: dbPath(cfg.dataDir),
    databaseExists: existsSync(dbPath(cfg.dataDir)),
    timezone: cfg.timezone,
    apiPort: cfg.apiPort,
    install: {
      kind: inst.kind,
      kindLabel: INSTALL_LABEL[inst.kind],
      selfPath: inst.selfPath,
      invokedVia: inst.invokedVia,
      projectRoot: ROOT,
      globalPrefix: inst.globalPrefix,
      globalBin: inst.globalBin,
      globalBinOnPath: inst.binOnPath,
      globalCliPath: inst.globalCliPath,
      globalCliResolvesHere: inst.globalCliResolvesHere,
    },
    mcpEntry: join(ROOT, 'dist', 'mcp', 'server.js'),
    daemonEntry: join(ROOT, 'dist', 'daemon', 'main.js'),
    howToUpdate: updateSteps(inst.kind),
  };
}

const INSTALL_LABEL: Record<InstallKind, string> = {
  checkout: '仅从源码检出运行 —— 全局命令尚未建立',
  linked: '全局命令指向当前源码检出（npm link）—— 开发与生产共用同一入口',
  installed: '全局安装的实体包（与源码检出解耦）',
};

function updateSteps(kind: InstallKind): string[] {
  if (kind === 'linked') {
    return [
      '开发态（npm link）：全局命令已指向源码检出，改代码后重新构建即生效。',
      '  更新：cd <项目> && git pull && npm install && npm run build',
      '  无需重新 link；daemon 重启即加载新代码，数据不受影响。',
      '要切成生产态（与检出解耦）：./scripts/install.sh --global',
    ];
  }
  if (kind === 'installed') {
    return [
      '生产态（全局实体包）。更新三步：',
      '  1) npm install -g ai-growth@latest',
      '  2) ai-growth migrate        # 幂等，不丢数据',
      '  3) launchctl kickstart -k gui/$(id -u)/com.lairey.ai-growth.daemon',
      '数据在 ~/.ai-growth，与代码包完全分离，更新不触碰它。',
    ];
  }
  return [
    '当前只能从源码检出目录运行，全局命令还没建立。二选一：',
    '  开发态：cd <项目> && npm link            （全局 ai-growth → 当前源码）',
    '  生产态：cd <项目> && ./scripts/install.sh --global',
  ];
}

function envInfoHuman(d: ReturnType<typeof envInfo>): string {
  return [
    `ai-growth ${d.version}  (node ${d.node}, ${d.platform})`,
    `安装形态：${d.install.kindLabel}`,
    `代码位置：${d.install.selfPath}`,
    d.install.globalPrefix ? `全局前缀：${d.install.globalPrefix}${d.install.globalBinOnPath ? '' : '  ⚠ 该 bin 不在当前 PATH 中'}` : '',
    `数据目录：${d.dataDir}`,
    `数据库：  ${d.database}${d.databaseExists ? '' : '  （尚未初始化，运行 ai-growth init）'}`,
    `时区：    ${d.timezone}`,
    `面板端口：${d.apiPort}`,
    '',
    '更新方式：',
    ...d.howToUpdate.map((s) => `  ${s}`),
  ].filter(Boolean).join('\n');
}

/** Agent 引导：一条命令拿到接入所需的全部信息 */
function agentInfo(flags: Record<string, string | boolean>) {
  const cfg = loadConfig();
  const inst = detectInstall();
  const skillPath = join(ROOT, 'SKILL.md');
  const agentsPath = join(ROOT, 'AGENTS.md');
  return {
    name: 'ai-growth',
    version: VERSION,
    whatItIs: 'Agent-native、Local-first 的个人成长执行系统。AI 维护计划，人保留目标与最终确认权。',
    whatItIsNot: '它不是 Todo List，也不是虚构属性值的 RPG；不要替用户决定人生方向。',
    install: {
      fromNpm: ['npm install -g ai-growth', 'ai-growth init'],
      fromSource: ['git clone <repo>', 'cd ai-growth', 'npm install', 'npm run build', 'ai-growth init'],
      oneShot: 'bash scripts/install.sh（开发：npm link；生产：--global）',
      currentKind: inst.kind,
      currentKindLabel: INSTALL_LABEL[inst.kind],
      howToUpdate: updateSteps(inst.kind),
    },
    runtime: {
      dataDir: cfg.dataDir,
      database: dbPath(cfg.dataDir),
      databaseReady: existsSync(dbPath(cfg.dataDir)),
      timezone: cfg.timezone,
      apiPort: cfg.apiPort,
    },
    connect: {
      mcp: mcpConfig(),
      mcpNote: '把上面的配置写进 Agent 的 MCP 配置后需「信任」该服务；MCP 暴露 63 个工具，含写操作。',
      skill: skillPath,
      skillNote: '把 SKILL.md 交给 Agent 作为行为准则；ai-growth skill 可直接打印其内容。',
      cliFallback: 'Agent 不支持 MCP 时可用 CLI：ai-growth status/today/complete/rollover 等，全部支持 --json。',
    },
    rules: RULES,
    nextSteps: NEXT_STEPS,
    docs: {
      agents: agentsPath,
      readme: join(ROOT, 'README.md'),
      spec: join(ROOT, 'PRODUCT_SPEC.md'),
      serverJson: join(ROOT, 'server.json'),
      llmsTxt: join(ROOT, 'llms.txt'),
    },
    flags: { jsonRequested: flags.json === true },
  };
}

function agentInfoHuman(d: ReturnType<typeof agentInfo>): string {
  return [
    `ai-growth ${d.version}`,
    d.whatItIs,
    '',
    '安装（二选一）：',
    ...d.install.fromNpm.map((c) => `  ${c}`),
    '  或从源码：',
    ...d.install.fromSource.map((c) => `  ${c}`),
    '',
    `数据目录：${d.runtime.dataDir}${d.runtime.databaseReady ? '' : '  ← 尚未初始化，先跑 ai-growth init'}`,
    `面板：http://127.0.0.1:${d.runtime.apiPort}`,
    `Skill：${d.connect.skill}`,
    '',
    '接入 Agent：',
    '  ai-growth mcp-config     # 打印可粘贴的 MCP 配置',
    '  ai-growth skill          # 打印 SKILL.md 全文，交给 Agent 作为行为准则',
    '',
    '产品铁律（Agent 必读）：',
    ...RULES.map((r) => `  · ${r}`),
    '',
    '下一步：',
    ...NEXT_STEPS.map((s) => `  ${s}`),
  ].join('\n');
}

function mcpConfig() {
  const cfg = loadConfig();
  return {
    mcpServers: {
      'ai-growth': {
        command: process.execPath,
        args: [join(ROOT, 'dist', 'mcp', 'server.js')],
        env: { AI_GROWTH_DATA_DIR: cfg.dataDir },
      },
    },
  };
}

function statusHuman(d: ReturnType<typeof growthStatus>): string {
  const onboarding: Record<string, string> = {
    NOT_STARTED: '未开始（需要先做访谈）',
    IN_PROGRESS: '访谈进行中',
    COMPLETED: '已完成',
  };
  return [
    `引导状态：${onboarding[d.onboarding] ?? d.onboarding}`,
    `活跃目标：${d.activeGoalCount}${d.currentStageTitle ? `（当前阶段：${d.currentStageTitle}）` : ''}`,
    `今日计划：${d.todayPlanStatus}`,
    `待重排：  ${d.pendingReplan ? '有 —— 先解决 Replan 再规划新主线' : '无'}`,
    `生活情境：${d.lifeContextMode}`,
    `建议下一步：${d.suggestedNextOperation}`,
  ].join('\n');
}

function todayHuman(d: {
  today: string;
  actions: { id: string; kind: string; title: string; status: string; estimatedMinutes?: number; completionCriteria?: string }[];
  reminders: unknown[];
}): string {
  const main = d.actions.filter((a) => a.kind === 'MAIN_QUEST');
  const dailies = d.actions.filter((a) => a.kind === 'DAILY');
  const line = (a: (typeof d.actions)[number]) =>
    `  [${a.status}] ${a.title}${a.estimatedMinutes ? ` · ${a.estimatedMinutes}min` : ''}\n     id=${a.id}`;
  return [
    `今天 ${d.today}`,
    '',
    'Main Quest:',
    main.length ? main.map(line).join('\n') : '  （无）',
    '',
    'Daily:',
    dailies.length ? dailies.map(line).join('\n') : '  （无）',
    '',
    `提醒：${d.reminders.length} 条`,
  ].join('\n');
}

function runDoctor(flags: Record<string, string | boolean>): void {
  const script = join(ROOT, 'scripts', 'doctor.sh');
  if (!existsSync(script)) {
    return emit(err('NOT_FOUND', `未找到 ${script}`), flags);
  }
  const child = spawn('bash', [script], { stdio: wantsJson(flags) ? 'pipe' : 'inherit' });
  let out = '';
  if (wantsJson(flags)) child.stdout?.on('data', (c) => { out += c; });
  child.on('exit', (code) => {
    if (wantsJson(flags)) {
      emit({ ok: code === 0, data: { exitCode: code, report: out } } as ToolResult<unknown>, flags);
    } else {
      process.exitCode = code ?? 0;
    }
  });
}

main();
