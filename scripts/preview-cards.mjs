#!/usr/bin/env node
/**
 * 把设备会显示的所有卡面拼成一张「对照图」，用于设计评审。
 *
 * 为什么需要它：
 *   设备卡只有 240×320，单独看一张很难判断整体视觉是否成立（层级、留白、字号、
 *   状态色的可辨度）。把「开机/离线/未配置」三张固件内置兜底卡 + 运行时五种卡面
 *   放在同一张图上按 2× 像素放大对照，就能一眼看出是否成体系。
 *
 * 它渲染的是**与运行时完全相同**的 buildCardHtml()，不是另外画的示意图 ——
 * 所以这张图里看到什么，设备上就是什么（除了被放大 2 倍）。
 *
 * 用法：
 *   npm run build && node scripts/preview-cards.mjs [--out <png路径>] [--scale 2]
 * 默认输出：<项目>/.workbuddy/previews/device-cards.png
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const distDir = join(root, 'dist', 'device');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outPath = resolve(argValue('--out', join(root, '.workbuddy', 'previews', 'device-cards.png')));
const scale = Math.max(1, Math.min(3, Number(argValue('--scale', '2')) || 2));

if (!existsSync(join(distDir, 'card.js'))) {
  console.error('未找到 dist/device/card.js —— 先跑 `npm run build`。');
  process.exit(2);
}

const { buildCardHtml } = await import(join(distDir, 'card.js'));
const { screenshotPng, CARD_WIDTH, CARD_HEIGHT } = await import(join(distDir, 'render.js'));

const ITEMS = [
  { id: 'a1', kind: 'MAIN_QUEST', title: '实现最小 Agent Memory Demo', status: 'PLANNED', done: false, minutes: 60, why: 'Memory 是当前阶段的出口标准', completionCriteria: 'demo 能写入并召回' },
  { id: 'a2', kind: 'DAILY', title: '散步 30 分钟', status: 'COMPLETED', done: true, minutes: 30, why: '保持运动习惯' },
  { id: 'a3', kind: 'DAILY', title: '读 20 页书', status: 'PLANNED', done: false, minutes: 20 },
];

const BASE = {
  dateLabel: '9月20日 周日',
  dateKey: '2026-09-20',
  stage: { title: '跑通端到端最小闭环', order: 3, total: 6 },
  items: ITEMS,
  doneCount: 1,
  total: ITEMS.length,
  battery: 76,
  facts: { evidence: 14, mainDone: 3 },
};

const BLANK = { ...BASE, dateLabel: '', dateKey: '', items: [], total: 0, doneCount: 0, battery: null, stage: null };

/** 顺序 = 设备上实际会遇到的顺序：先固件兜底，再服务端正常卡面 */
const CARDS = [
  ['固件兜底 · 开机', BLANK, { kind: 'booting', title: '正在连接' }],
  ['固件兜底 · 离线', BLANK, { kind: 'offline', title: '连不上电脑' }],
  ['固件兜底 · 未配置', BLANK, { kind: 'setup', title: '还没配置' }],
  ['运行时 · 今日总览', BASE, { kind: 'overview', title: '今日总览' }],
  ['运行时 · 主线任务', BASE, { kind: 'task', itemIndex: 0, title: '主线' }],
  ['运行时 · 已完成的小事', BASE, { kind: 'task', itemIndex: 1, title: '小事' }],
  ['运行时 · 全部做完', { ...BASE, doneCount: 3, items: ITEMS.map((i) => ({ ...i, done: true, status: 'COMPLETED' })) }, { kind: 'alldone', title: '今天做完了' }],
  ['运行时 · 今天没排计划', { ...BASE, items: [], total: 0, doneCount: 0, stage: null }, { kind: 'noplan', title: '今天还没排计划' }],
];

async function renderCard(state, spec) {
  const html = buildCardHtml(state, spec);
  return screenshotPng(html, { width: CARD_WIDTH, height: CARD_HEIGHT });
}

function sheetHtml(entries) {
  const cols = 4;
  const cellW = CARD_WIDTH * scale;
  const imgH = CARD_HEIGHT * scale;
  const labelH = 26;
  const gap = 20;
  const pad = 26;
  const rows = Math.ceil(entries.length / cols);
  const w = pad * 2 + cols * cellW + (cols - 1) * gap;
  const h = pad * 2 + rows * (labelH + imgH) + (rows - 1) * gap;

  const cells = entries.map(([label, png]) => `
    <figure>
      <figcaption>${label}</figcaption>
      <img src="data:image/png;base64,${png.toString('base64')}" alt="${label}">
    </figure>`).join('');

  return { html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${w}px;height:${h}px;background:#0b0f14;
      font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
      -webkit-font-smoothing:antialiased}
    .sheet{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:${gap}px;padding:${pad}px}
    figure{display:flex;flex-direction:column;gap:6px}
    figcaption{height:${labelH - 6}px;line-height:${labelH - 6}px;font-size:13px;color:#9fb6c9;letter-spacing:.2px}
    img{width:${cellW}px;height:${imgH}px;display:block;border-radius:${30 * scale}px;image-rendering:pixelated;
      box-shadow:0 0 0 1px rgba(140,190,225,.18),0 10px 28px rgba(0,0,0,.55)}
  </style></head><body><div class="sheet">${cells}</div></body></html>`, width: w, height: h };
}

const entries = [];
for (const [label, state, spec] of CARDS) {
  entries.push([label, await renderCard(state, spec)]);
  console.log(`✓ 渲染 ${label}`);
}

const { html, width, height } = sheetHtml(entries);
console.log(`… 合成对照图 ${width}×${height}（每张卡放大 ${scale}×）`);
const sheet = await screenshotPng(html, { width, height });

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, sheet);
console.log(`\n✓ 对照图：${outPath}`);
console.log('  这张图里的卡面与运行时 buildCardHtml() 完全同源，只是被像素级放大了。');
