import type { CoreContext } from './context.js';
import { todayIn } from './profile.js';
import { listGoals, listStages, getCurrentStage } from './goals.js';
import { getTodayPlan } from './actions.js';
import { listGrowthEvents } from './evidence.js';
import { getActiveLifeContext } from './lifeContext.js';

/**
 * 进度渲染器：给 Agent 和用户看的**非纯文本**报告（Markdown + Mermaid）。
 *
 * 约束（原则 6）：只用可核对事实，不产出掌握度百分比 / 自律分 / 等级。
 * 进度条的比例来自 Stage 序号 / 总数（可核对），不是估算。
 */
export interface ProgressReport {
  title: string;
  markdown: string;
  html: string;
  facts: {
    today: string;
    stageOrder: number | null;
    stageTotal: number | null;
    mainDoneToday: number;
    mainTotalToday: number;
    dailyDoneToday: number;
    dailyTotalToday: number;
    evidenceTotal: number;
    growthEventTotal: number;
  };
}

const BLOCK_FULL = '█';
const BLOCK_EMPTY = '░';

function bar(done: number, total: number, width = 20): string {
  if (!total) return BLOCK_EMPTY.repeat(width);
  const filled = Math.round((done / total) * width);
  return BLOCK_FULL.repeat(Math.max(0, Math.min(width, filled))) + BLOCK_EMPTY.repeat(Math.max(0, width - filled));
}

export function renderProgress(ctx: CoreContext): ProgressReport {
  const today = todayIn(ctx);
  const goals = listGoals(ctx);
  const primary = goals.find((g) => g.status === 'ACTIVE') ?? goals[0] ?? null;
  const stages = primary ? listStages(ctx, primary.id) : [];
  const current = primary ? getCurrentStage(ctx, primary.id) : null;
  const { plan, actions } = getTodayPlan(ctx);
  const events = listGrowthEvents(ctx, undefined, 12);
  const life = getActiveLifeContext(ctx);

  const mainActions = actions.filter((a) => a.kind === 'MAIN_QUEST');
  const dailyActions = actions.filter((a) => a.kind === 'DAILY');
  const done = (l: typeof actions) => l.filter((a) => a.status === 'COMPLETED').length;

  const md: string[] = [];
  md.push(`## 成长进度 · ${today}`);
  md.push('');

  if (!primary) {
    md.push('> 还没有主线目标。先和 Agent 聊一次你想做成什么，之后这里会自动长出进度。');
    md.push('');
  } else {
    md.push(`### 主线：${primary.title}`);
    md.push('');
    if (primary.why) md.push(`**为什么**　${primary.why}`);
    if (primary.targetDate) md.push(`**目标日期**　${primary.targetDate}`);
    md.push('');

    if (stages.length) {
      const order = current?.order ?? stages.filter((s) => s.status === 'COMPLETED').length + 1;
      md.push('#### 阶段进度');
      md.push('');
      md.push(`\`${bar(order, stages.length)}\`　**Stage ${clamp(order, 1, stages.length)} / ${stages.length}**${current ? `　·　${current.title}` : ''}`);
      md.push('');
      // 节点轨道：■ 已完成 / ◧ 进行中 / □ 未开始
      md.push(stages.map((s) => nodeGlyph(s.status)).join(' '));
      md.push('');
      md.push('| # | 阶段 | 状态 | 窗口 |');
      md.push('|---:|---|---|---|');
      for (const s of stages) {
        md.push(`| ${s.order} | ${s.title} | ${stageLabel(s.status)} | ${s.plannedStartDate ?? '—'} → ${s.plannedEndDate ?? '—'} |`);
      }
      md.push('');
      md.push('```mermaid');
      md.push('gantt');
      md.push('    dateFormat  YYYY-MM-DD');
      md.push('    title       阶段计划');
      for (const s of stages) {
        const start = s.plannedStartDate ?? today;
        const end = s.plannedEndDate ?? start;
        md.push(`    ${s.title} :${mermaidClass(s.status)}, ${start}, ${end}`);
      }
      md.push('```');
      md.push('');
    }
  }

  md.push('#### 今天');
  md.push('');
  if (!actions.length) {
    md.push('今天还没有安排。说一句「开启今日任务」，让 Agent 帮你规划。');
    md.push('');
  } else {
    md.push(`\`${bar(done(mainActions) + done(dailyActions), actions.length, 12)}\`　${done(mainActions) + done(dailyActions)} / ${actions.length}`);
    md.push('');
    md.push('| 类型 | 任务 | 状态 | 预计 |');
    md.push('|---|---|---|---|');
    for (const a of actions) {
      const mark = a.status === 'COMPLETED' ? '✅' : a.status === 'EXPIRED' ? '⌛' : a.status === 'SKIPPED' ? '⏭️' : '◻️';
      md.push(`| ${a.kind === 'MAIN_QUEST' ? '🔥 Main' : 'Daily'} | ${a.title} | ${mark} ${actionLabel(a.status)} | ${a.estimatedMinutes ? a.estimatedMinutes + 'min' : '—'} |`);
    }
    md.push('');
    if (plan?.rationale) {
      md.push(`> 为什么这么安排：${plan.rationale}`);
      md.push('');
    }
  }

  md.push('#### 累计事实');
  md.push('');
  md.push('| 指标 | 数值 |');
  md.push('|---|---:|');
  md.push(`| 今日主任务 | ${done(mainActions)} / ${mainActions.length || 0} |`);
  md.push(`| 今日每日任务 | ${done(dailyActions)} / ${dailyActions.length || 0} |`);
  md.push(`| 证据总数 | ${countEvidence(ctx)} |`);
  md.push(`| 成长记录 | ${events.length ? events.length + (events.length >= 12 ? '+' : '') : 0} |`);
  md.push('');
  if (life && life.mode !== 'NORMAL') {
    md.push(`> 当前生活情境：**${life.mode}**${life.availableMinutesPerDay ? `，每天约 ${life.availableMinutesPerDay} 分钟` : ''} —— 负荷已相应下调。`);
    md.push('');
  }

  if (events.length) {
    md.push('#### 最近进展');
    md.push('');
    md.push('| 日期 | 记录 | 领域 | 证据 |');
    md.push('|---|---|---|---:|');
    for (const e of events.slice(0, 10)) {
      md.push(`| ${e.dateKey} | ${e.title} | ${domainLabel(e.domain)} | ${e.evidenceIds.length} |`);
    }
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push('<sub>本报告的进度条与数字均来自本地可核对事实（阶段序号、证据计数、任务状态），不含估算的掌握度或自律分。</sub>');

  return {
    title: `成长进度 · ${today}`,
    markdown: md.join('\n'),
    html: renderHtml({
      today, primary: primary ? { title: primary.title, why: primary.why, targetDate: primary.targetDate } : null,
      stages: stages.map((s) => ({ order: s.order, title: s.title, status: s.status, start: s.plannedStartDate ?? null, end: s.plannedEndDate ?? null })),
      currentOrder: current?.order ?? null,
      actions: actions.map((a) => ({ kind: a.kind, title: a.title, status: a.status, estimatedMinutes: a.estimatedMinutes ?? null })),
      events: events.slice(0, 10).map((e) => ({ date: e.dateKey, title: e.title, domain: e.domain, evidence: e.evidenceIds.length })),
      life: life ? { mode: life.mode, minutes: life.availableMinutesPerDay ?? null } : null,
      plan: plan?.rationale ?? null,
    }),
    facts: {
      today,
      stageOrder: current?.order ?? null,
      stageTotal: stages.length || null,
      mainDoneToday: done(mainActions),
      mainTotalToday: mainActions.length,
      dailyDoneToday: done(dailyActions),
      dailyTotalToday: dailyActions.length,
      evidenceTotal: countEvidence(ctx),
      growthEventTotal: listGrowthEvents(ctx, undefined, 500).length,
    },
  };
}

function domainLabel(d: string): string {
  return { LEARN: '学习', BUILD: '构建', TRAIN: '训练', HABIT: '习惯', CREATE: '创作',
    RELATIONSHIP: '关系', EXPLORE: '探索', LIFE: '生活', OTHER: '其他' }[d] ?? d;
}

function countEvidence(ctx: CoreContext): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM evidence').get() as { n: number }).n;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function nodeGlyph(s: string): string {
  if (s === 'COMPLETED') return '■';
  if (s === 'ACTIVE' || s === 'DELAYED') return '◧';
  if (s === 'SKIPPED') return '▫';
  return '□';
}

function stageLabel(s: string): string {
  return { PLANNED: '未开始', ACTIVE: '进行中', COMPLETED: '已完成', DELAYED: '已顺延', SKIPPED: '已跳过' }[s] ?? s;
}

function actionLabel(s: string): string {
  return { DRAFT: '待确认', PLANNED: '待进行', IN_PROGRESS: '进行中', COMPLETED: '已完成',
    SKIPPED: '已跳过', DELAYED: '已延期', PENDING_REPLAN: '待重排', EXPIRED: '已过期', CANCELLED: '已取消' }[s] ?? s;
}

function mermaidClass(s: string): string {
  if (s === 'COMPLETED') return 'done';
  if (s === 'ACTIVE') return 'active';
  return 'todo';
}

// ---------------------------------------------------------------- HTML（独立可打开）

interface HtmlModel {
  today: string;
  primary: { title: string; why?: string; targetDate?: string } | null;
  stages: { order: number; title: string; status: string; start: string | null; end: string | null }[];
  currentOrder: number | null;
  actions: { kind: string; title: string; status: string; estimatedMinutes: number | null }[];
  events: { date: string; title: string; domain: string; evidence: number }[];
  life: { mode: string; minutes: number | null } | null;
  plan: string | null;
}

function renderHtml(m: HtmlModel): string {
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const order = m.currentOrder ?? (m.stages.filter((s) => s.status === 'COMPLETED').length + 1);
  const pct = m.stages.length ? Math.round((clamp(order, 1, m.stages.length) / m.stages.length) * 100) : 0;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.primary?.title ?? 'AI Growth')} · 进度</title>
<style>
:root{--bg:#070b16;--panel:#0e1526;--ink:#e8eefc;--dim:#8b9bc4;--faint:#5b6a90;--edge:#1e2a45;--edge2:#2c3d61;--gold:#ffc247;--cyan:#38d6d6;--violet:#9d7bff;--green:#45d483;--amber:#ffa94d}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",Arial,sans-serif;
background-image:radial-gradient(900px 480px at 10% -10%,rgba(56,214,214,.12),transparent 60%),radial-gradient(800px 460px at 100% 0,rgba(157,123,255,.14),transparent 60%);
background-attachment:fixed;padding:26px 18px;font-variant-numeric:tabular-nums}
.wrap{max-width:860px;margin:0 auto}
.card{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,0) 42%),var(--panel);border:1px solid var(--edge);border-radius:14px;padding:16px 17px;margin-bottom:14px;box-shadow:0 12px 28px -22px #000}
.hd{font-size:11px;font-weight:700;letter-spacing:.13em;color:var(--faint);text-transform:uppercase;margin-bottom:10px}
h1{font-size:21px;font-weight:750;margin-bottom:6px}
h2{font-size:17px;font-weight:700;margin-bottom:8px}
.meta{font-size:13px;color:var(--dim);line-height:1.7}
.bar{height:12px;border-radius:999px;background:#141d33;border:1px solid var(--edge);overflow:hidden;margin:10px 0 8px}
.bar span{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),var(--violet));box-shadow:0 0 18px -2px rgba(56,214,214,.7)}
.track{display:flex;align-items:center;gap:2px;margin:6px 0 12px}
.node{width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:11px;background:#131c31;border:1px solid var(--edge2);color:var(--faint)}
.node.done{background:rgba(69,212,131,.2);border-color:rgba(69,212,131,.6);color:var(--green)}
.node.now{background:linear-gradient(180deg,rgba(56,214,214,.3),rgba(56,214,214,.1));border-color:var(--cyan);color:var(--cyan);box-shadow:0 0 16px -3px rgba(56,214,214,.85)}
.link{flex:1;height:2px;background:var(--edge);min-width:6px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px dashed var(--edge)}
th{color:var(--faint);font-weight:600;font-size:11.5px;letter-spacing:.06em}
td.n{text-align:right;color:var(--dim)}
.chip{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid var(--edge2);color:var(--dim)}
.chip.g{background:rgba(69,212,131,.12);border-color:rgba(69,212,131,.32);color:var(--green)}
.chip.c{background:rgba(56,214,214,.12);border-color:rgba(56,214,214,.32);color:var(--cyan)}
.chip.a{background:rgba(255,169,77,.12);border-color:rgba(255,169,77,.32);color:var(--amber)}
.foot{font-size:11.5px;color:var(--faint);text-align:center;padding-top:6px}
</style></head><body><div class="wrap">

<div class="card"><div class="hd">当前主线</div>
${m.primary
    ? `<h2>${esc(m.primary.title)}</h2>
       <div class="meta">${m.primary.why ? '为什么：' + esc(m.primary.why) + '<br>' : ''}${m.primary.targetDate ? '目标日期：' + esc(m.primary.targetDate) : ''}</div>`
    : '<div class="meta">还没有主线目标 —— 先和 Agent 聊一次你想做成什么。</div>'}
${m.life && m.life.mode !== 'NORMAL' ? `<div style="margin-top:10px"><span class="chip a">${esc(m.life.mode)}${m.life.minutes ? ' · 每天 ' + m.life.minutes + ' 分钟' : ''}</span></div>` : ''}
</div>

${m.stages.length ? `<div class="card"><div class="hd">阶段进度</div>
<div class="bar"><span style="width:${pct}%"></span></div>
<div class="meta"><strong>Stage ${clamp(order, 1, m.stages.length)} / ${m.stages.length}</strong>${m.stages.find((s) => s.order === order)?.title ? ' · ' + esc(m.stages.find((s) => s.order === order)!.title) : ''}</div>
<div class="track">${m.stages.map((s, i) => `<div class="node ${s.status === 'COMPLETED' ? 'done' : s.status === 'ACTIVE' || s.status === 'DELAYED' ? 'now' : ''}">${s.status === 'COMPLETED' ? '✓' : s.order}</div>${i < m.stages.length - 1 ? '<div class="link"></div>' : ''}`).join('')}</div>
<table><tr><th>#</th><th>阶段</th><th>状态</th><th>窗口</th></tr>
${m.stages.map((s) => `<tr><td>${s.order}</td><td>${esc(s.title)}</td><td><span class="chip ${s.status === 'COMPLETED' ? 'g' : s.status === 'ACTIVE' ? 'c' : ''}">${stageLabel(s.status)}</span></td><td class="n">${esc(s.start ?? '—')} → ${esc(s.end ?? '—')}</td></tr>`).join('')}
</table></div>` : ''}

<div class="card"><div class="hd">今天 · ${esc(m.today)}</div>
${m.actions.length
    ? `<table><tr><th>类型</th><th>任务</th><th>状态</th><th class="n">预计</th></tr>
       ${m.actions.map((a) => `<tr><td>${a.kind === 'MAIN_QUEST' ? '🔥 Main' : 'Daily'}</td><td>${esc(a.title)}</td><td><span class="chip ${a.status === 'COMPLETED' ? 'g' : ''}">${actionLabel(a.status)}</span></td><td class="n">${a.estimatedMinutes ? a.estimatedMinutes + 'min' : '—'}</td></tr>`).join('')}
       </table>`
    : '<div class="meta">今天还没有安排。说一句「开启今日任务」让 Agent 帮你规划。</div>'}
${m.plan ? `<div class="meta" style="margin-top:10px">为什么这么安排：${esc(m.plan)}</div>` : ''}
</div>

${m.events.length ? `<div class="card"><div class="hd">最近进展</div>
<table><tr><th>日期</th><th>记录</th><th>领域</th><th class="n">证据</th></tr>
${m.events.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.title)}</td><td><span class="chip c">${domainLabel(e.domain)}</span></td><td class="n">${e.evidence}</td></tr>`).join('')}
</table></div>` : ''}

<div class="foot">进度条与数字均来自本地可核对事实（阶段序号、证据计数、任务状态），不含估算的掌握度或自律分 · AI Growth</div>
</div></body></html>`;
}
