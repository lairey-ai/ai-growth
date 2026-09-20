#!/usr/bin/env node
/**
 * 设备卡的「程序化布局断言」：用真实 Chrome 量每个元素的位置，
 * 抓肉眼容易漏的溢出/重叠（完成页统计卡压字、长 meta 顶穿页脚、阶段节点横向溢出）。
 *
 * 为什么必须用真 Chrome 量而不是 jsdom：jsdom 没有排版引擎，
 * `.wrap{bottom}` / `-webkit-line-clamp` 这类都不会生效，量出来恒为 0 —— 等于没测。
 *
 * 用法：node scripts/check-device-cards.mjs [--json]
 * 退出码 1 = 有布局问题。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');

const { buildCardHtml } = await import(join(DIST, 'device/card.js'));
const { findChrome, CARD_WIDTH, CARD_HEIGHT } = await import(join(DIST, 'device/render.js'));
const { buildDeck, dateLabelIn } = await import(join(DIST, 'device/deck.js'));

const chrome = findChrome();
if (!chrome) {
  console.error('找不到 Chrome/Chromium，无法做布局测量。可用 AI_GROWTH_CHROME 指定路径。');
  process.exit(2);
}

// ---- 用例：正常 + 边界（长标题 / 长 meta / 多阶段 / 无电量 / 全完成）----
const base = {
  dateLabel: dateLabelIn('Asia/Shanghai'),
  dateKey: '2026-09-20',
  stage: { title: 'Memory', order: 2, total: 5 },
  items: [
    { id: 'a1', kind: 'MAIN_QUEST', title: '实现最小 Agent Memory Demo', status: 'PLANNED', done: false, minutes: 60, why: 'Memory 是当前阶段的出口标准', completionCriteria: 'demo 能写入并召回' },
    { id: 'a2', kind: 'DAILY', title: '散步 30 分钟', status: 'PLANNED', done: false, minutes: 30, why: '保持运动习惯' },
    { id: 'a3', kind: 'DAILY', title: '读 20 页书', status: 'PLANNED', done: false, minutes: 20 },
  ],
  doneCount: 0, total: 3, battery: 72,
  facts: { evidence: 37, mainDone: 6 },
};
const doneItems = base.items.map((i) => ({ ...i, done: true, status: 'COMPLETED' }));

const cases = [
  ['总览', { ...base }, { kind: 'overview', title: 'x' }],
  ['总览·部分完成', { ...base, items: base.items.map((i, n) => ({ ...i, done: n === 0 })), doneCount: 1 }, { kind: 'overview', title: 'x' }],
  ['总览·空条目', { ...base, items: [], total: 0, doneCount: 0 }, { kind: 'overview', title: 'x' }],
  ['总览·无阶段', { ...base, stage: null }, { kind: 'overview', title: 'x' }],
  ['任务·主线', { ...base }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['任务·日常', { ...base }, { kind: 'task', itemIndex: 1, title: 'x' }],
  ['任务·无附加信息', { ...base, items: [{ id: 'x', kind: 'DAILY', title: '给妈妈打个电话', status: 'PLANNED', done: false }], total: 1, doneCount: 0 }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['任务·已完成', { ...base, items: [{ ...base.items[0], done: true, status: 'COMPLETED' }], total: 1, doneCount: 1 }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['完成页', { ...base, items: doneItems, doneCount: 3 }, { kind: 'alldone', title: 'x' }],
  ['完成页·无阶段', { ...base, items: doneItems, doneCount: 3, stage: null }, { kind: 'alldone', title: 'x' }],
  ['无计划', { ...base, items: [], total: 0, doneCount: 0, stage: null }, { kind: 'noplan', title: 'x' }],
  ['离线', { ...base, offlineSince: '9月20日 08:12' }, { kind: 'offline', title: 'x' }],
  ['离线·从未同步', { ...base }, { kind: 'offline', title: 'x' }],
  ['开机', { ...base, battery: null, stage: null }, { kind: 'booting', title: 'x' }],
  ['未配置', { ...base, battery: null, stage: null }, { kind: 'setup', title: 'x' }],
  // ---- 压力 ----
  ['压力·超长标题', { ...base, items: [{ id: 'x', kind: 'MAIN_QUEST', title: '把公司里那套离线优先的同步协议重新设计一遍并写清边界条件', status: 'PLANNED', done: false, minutes: 90, why: '这是当前阶段唯一的出口标准，也是整个系统最脆的部分', completionCriteria: '有一份能被人独立读懂并复现的协议文档，且包含失败路径' }], total: 1, doneCount: 0, battery: -1 }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['压力·超长阶段名', { ...base, stage: { title: '把 Agent 的记忆系统从零搭起来并跑通端到端', order: 4, total: 5 } }, { kind: 'overview', title: 'x' }],
  ['压力·12 阶段', { ...base, stage: { title: '打磨与交付', order: 11, total: 12 }, battery: 8 }, { kind: 'overview', title: 'x' }],
  ['压力·20 阶段', { ...base, stage: { title: '打磨与交付', order: 3, total: 20 }, battery: 8 }, { kind: 'overview', title: 'x' }],
  ['压力·50 阶段', { ...base, stage: { title: '长跑', order: 40, total: 50 }, battery: 8 }, { kind: 'overview', title: 'x' }],
  ['压力·超长每日标题', { ...base, items: [{ id: 'x', kind: 'DAILY', title: '把今天要交付的那份文档从头到尾再读一遍并逐条核对是否覆盖了所有边界条件', status: 'PLANNED', done: false }], total: 1, doneCount: 0 }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['压力·3 条长标题', { ...base, items: ['把公司里那套离线优先的同步协议重新设计一遍并写清边界条件', '把今天要交付的那份文档从头到尾再读一遍并逐条核对', '给所有早年的同事逐个写一封说明近况的邮件'].map((t, n) => ({ id: 'x' + n, kind: n === 0 ? 'MAIN_QUEST' : 'DAILY', title: t, status: 'PLANNED', done: false })), total: 3, doneCount: 0, stage: null }, { kind: 'overview', title: 'x' }],
];

const MEASURE = `
<script>
(() => {
  const issues = [];
  const card = document.querySelector('.card');
  const cr = card.getBoundingClientRect();
  const ft = document.querySelector('.ft');
  const fr = ft ? ft.getBoundingClientRect() : null;
  const CONTENT = ['.wrap', '.list', '.ttl', '.meta', '.big', '.done', '.dc', '.facts', '.track', '.stg', '.row', '.hint'];
  for (const sel of CONTENT) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > cr.right + 0.5) issues.push(sel + ' 横向溢出 ' + (r.right - cr.right).toFixed(1) + 'px');
      if (r.bottom > cr.bottom + 0.5) issues.push(sel + ' 纵向溢出卡片 ' + (r.bottom - cr.bottom).toFixed(1) + 'px');
      if (fr && !el.closest('.ft') && r.bottom > fr.top + 1) {
        issues.push(sel + ' 压住页脚 ' + (r.bottom - fr.top).toFixed(1) + 'px');
      }
    }
  }
  const nd = document.querySelectorAll('.nd').length;
  if (nd > 12) issues.push('阶段节点 ' + nd + ' 个（>12，轨道会溢出）');
  const pre = document.createElement('pre');
  pre.id = '__report';
  pre.textContent = JSON.stringify(issues);
  document.body.appendChild(pre);
})();
</script>`;

/** 用 Chrome --dump-dom 跑页面内的测量脚本，把结果读回来 */
function measure(html) {
  const dir = mkdtempSync(join(tmpdir(), 'aig-layout-'));
  const file = join(dir, 'card.html');
  writeFileSync(file, html.replace('</body>', MEASURE + '</body>'), 'utf8');
  return new Promise((resolve) => {
    const child = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions',
      `--user-data-dir=${join(dir, 'profile')}`,
      '--virtual-time-budget=1200', '--dump-dom', `file://${file}`,
    ], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    const finish = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      const m = out.match(/<pre id="__report">([\s\S]*?)<\/pre>/);
      resolve(m ? JSON.parse(m[1]) : null);
    };
    child.on('close', finish);
    child.on('error', finish);
    setTimeout(finish, 15000);
  });
}

const asJson = process.argv.includes('--json');
let failed = 0;
const rows = [];

for (const [name, state, spec] of cases) {
  const res = await measure(buildCardHtml(state, spec));
  if (!res) {
    rows.push({ name, ok: false, issues: ['测量失败（Chrome 没回吐报告）'] });
    failed++;
    continue;
  }
  rows.push({ name, ok: res.length === 0, issues: res });
  if (res.length) failed++;
}

// 牌组组成也要核一遍：没任务 → 只一张 noplan；全完成 → 末尾补 alldone
const deckChecks = [];
deckChecks.push(['空计划 → noplan', JSON.stringify(buildDeck({ ...base, items: [], total: 0, doneCount: 0 }).map((c) => c.kind)) === '["noplan"]']);
deckChecks.push(['有任务 → overview 打头', buildDeck(base)[0].kind === 'overview']);
deckChecks.push(['全完成 → 末位 alldone', buildDeck({ ...base, items: doneItems, doneCount: 3 }).at(-1).kind === 'alldone']);
deckChecks.push(['未全完成 → 无 alldone', !buildDeck({ ...base, doneCount: 1 }).some((c) => c.kind === 'alldone')]);

// 自检：往一张本来合格的卡里塞一个必然越界的元素，测量脚本必须报出来。
// 没有这一步的话，一个恒为绿的检查等于没检查。
const poison = buildCardHtml(base, { kind: 'overview', title: 'x' }).replace(
  '</body>',
  '<div class="wrap" style="position:absolute;top:282px;left:0;width:400px;height:80px"></div></body>'
);
const poisonRes = await measure(poison);
const selfTest = Array.isArray(poisonRes) && poisonRes.length > 0;

if (asJson) {
  console.log(JSON.stringify({ failed, rows, deckChecks, selfTest }, null, 2));
} else {
  console.log(`设备卡布局测量（${cases.length} 张，真实 Chrome ${CARD_WIDTH}×${CARD_HEIGHT}）\n`);
  for (const r of rows) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
    for (const i of r.issues) console.log(`    · ${i}`);
  }
  console.log('\n牌组组成：');
  for (const [label, ok] of deckChecks) {
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${label}`);
  }
  console.log(`\n自检（故意塞越界元素，必须被报出）：${selfTest ? '✓ 检查有效' : '✗ 检查失效 —— 上面的绿色不可信'}`);
  if (!selfTest) failed++;
  console.log(failed ? `\n✗ 共 ${failed} 处问题` : `\n✓ 全部通过`);
}

process.exit(failed ? 1 : 0);
