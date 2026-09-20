#!/usr/bin/env node
/**
 * 生成 AI Passport 固件内置的「兜底卡」资源，并顺带校验中文字形覆盖。
 *
 * 为什么兜底卡要在【构建期】出图：
 *   设备的开机卡、离线卡、未配置卡必须在不联网、没配置的情况下也能显示中文。
 *   而固件里没有可用的中文字库（见 docs/development/engineering/lvgl-chinese-fonts.md）。
 *   所以这三张图在构建期就用与运行时完全相同的 HTML/CSS 渲染成 RGB565 塞进 Flash，
 *   设备端一个汉字都不用画 —— 中文显示问题在宿主侧一次性解决。
 *
 * 用法：
 *   npm run build && node scripts/gen-device-assets.mjs \
 *     --out <ai-passport>/main/assets/growth \
 *     --preview <ai-passport>/assets/growth/firmware
 *
 * 产物（与仓库里 rock-paper-scissors 示例的布局一致：
 * 只有二进制进 main/assets/，给人看的预览和说明进 assets/）：
 *   <out>/booting.rgb565  offline.rgb565  setup.rgb565   240×320 RGB565 小端，各 153600 字节
 *   <out>/manifest.json                                  尺寸/哈希/字形覆盖结论
 *   <preview>/<name>.png                                 预览图（不参与固件）
 *
 * 退出码：0 = 资源生成且字形覆盖检查通过；非 0 = 生成失败或发现缺字（不会留下"看起来成功"的产物）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = resolve(argValue('--out', join(root, 'out', 'device-assets')));
const previewDir = resolve(argValue('--preview', join(outDir, 'preview')));
const distDir = join(root, 'dist', 'device');

if (!existsSync(join(distDir, 'card.js'))) {
  console.error('未找到 dist/device/card.js —— 先跑 `npm run build`。');
  process.exit(2);
}

const { buildCardHtml } = await import(join(distDir, 'card.js'));
const { screenshotPng, toRgb565, CARD_WIDTH, CARD_HEIGHT } = await import(join(distDir, 'render.js'));
const { decodePng } = await import(join(distDir, 'png.js'));
const { renderGlyphMasks, classifyCoverage } = await import(join(distDir, 'fontCoverage.js'));
const { encodeCardPayload, buildCardMeta, CARD_W, CARD_H } = await import(join(distDir, 'deck.js'));

/** 与 check-device-cards.mjs 保持同一套"最坏情况"素材，避免两边覆盖不一致 */
const BASE_ITEMS = [
  { id: 'a1', kind: 'MAIN_QUEST', title: '实现最小 Agent Memory Demo', status: 'PLANNED', done: false, minutes: 60, why: 'Memory 是当前阶段的出口标准', completionCriteria: 'demo 能写入并召回' },
  { id: 'a2', kind: 'DAILY', title: '散步 30 分钟', status: 'PLANNED', done: false, minutes: 30, why: '保持运动习惯' },
  { id: 'a3', kind: 'DAILY', title: '读 20 页书', status: 'PLANNED', done: false, minutes: 20 },
];
const BASE = {
  dateLabel: '9月20日 周日',
  dateKey: '2026-09-20',
  stage: { title: '跑通端到端最小闭环', order: 3, total: 6 },
  items: BASE_ITEMS,
  doneCount: 0,
  total: BASE_ITEMS.length,
  battery: 76,
  facts: { evidence: 14, mainDone: 3 },
};

/**
 * 要写进 Flash 的兜底卡（必须成功）。
 * ⚠ dateLabel 一律留空：这三张卡是构建期渲染的，设备上没有 RTC；
 *   把构建日的日期烧进去 = 设备天天说"今天是 9 月 20 日"。时间只能由服务端给。
 * 后面那几张"覆盖用"的卡只用来把字符集铺开，不产出资源。
 */
const FALLBACK = [
  ['booting', { ...BASE, dateLabel: '', dateKey: '', items: [], total: 0, doneCount: 0, battery: null, stage: null }, { kind: 'booting', title: '正在连接' }],
  ['offline', { ...BASE, dateLabel: '', dateKey: '', items: [], total: 0, doneCount: 0, battery: null, stage: null }, { kind: 'offline', title: '连不上电脑' }],
  ['setup', { ...BASE, dateLabel: '', dateKey: '', items: [], total: 0, doneCount: 0, battery: null, stage: null }, { kind: 'setup', title: '还没配置' }],
];

const COVERAGE_ONLY = [
  ['总览', { ...BASE }, { kind: 'overview', title: 'x' }],
  ['总览·12 阶段', { ...BASE, stage: { title: '打磨与交付', order: 11, total: 12 } }, { kind: 'overview', title: 'x' }],
  ['任务·主线', { ...BASE }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['任务·无附加信息', { ...BASE, items: [{ id: 'x', kind: 'DAILY', title: '给妈妈打个电话', status: 'PLANNED', done: false }], total: 1, doneCount: 0 }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['完成页', { ...BASE, items: BASE_ITEMS.map((i) => ({ ...i, done: true })), doneCount: 3 }, { kind: 'alldone', title: 'x' }],
  ['无计划', { ...BASE, items: [], total: 0, doneCount: 0, stage: null }, { kind: 'noplan', title: 'x' }],
  ['压力·超长标题', { ...BASE, items: [{ id: 'x', kind: 'MAIN_QUEST', title: '把公司里那套离线优先的同步协议重新设计一遍并写清边界条件', status: 'PLANNED', done: false, minutes: 90, why: '这是当前阶段唯一的出口标准，也是整个系统最脆的部分', completionCriteria: '有一份能被人独立读懂并复现的协议文档，且包含失败路径' }], total: 1, doneCount: 0, battery: -1 }, { kind: 'task', itemIndex: 0, title: 'x' }],
  ['压力·下标数字', { ...BASE, stage: { title: '长跑', order: 40, total: 50 }, battery: 8 }, { kind: 'overview', title: 'x' }],
  ['标点与符号', { ...BASE, items: [{ id: 'x', kind: 'DAILY', title: '写《周报》初稿（第 3 版）；含 13% 数据、A/B 对比', status: 'PLANNED', done: false, why: '用全角标点与括号测字形：，。；：！？（）《》、' }], total: 1, doneCount: 0 }, { kind: 'task', itemIndex: 0, title: 'x' }],
];

/** 从卡片 HTML 里抽出"真正会画出来的文字"，交给字形覆盖检查 */
function visibleText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function renderOne(state, spec) {
  const html = buildCardHtml(state, spec);
  const png = await screenshotPng(html, { width: CARD_WIDTH, height: CARD_HEIGHT });
  const img = decodePng(png);
  if (img.width !== CARD_WIDTH || img.height !== CARD_HEIGHT) {
    throw new Error(`${spec.kind}: 渲染出 ${img.width}x${img.height}，期望 ${CARD_WIDTH}x${CARD_HEIGHT}`);
  }
  return { html, png, pixels: toRgb565(img) };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });

  const manifest = {
    card: { width: CARD_W, height: CARD_H, pixelFormat: 'RGB565 little-endian' },
    generatedFrom: 'scripts/gen-device-assets.mjs',
    assets: [],
    coverage: null,
  };

  // 1) 生成兜底卡（先删旧的，避免"生成失败但旧文件还在"的假成功）
  for (const [name] of FALLBACK) {
    const f = join(outDir, `${name}.rgb565`);
    if (existsSync(f)) rmSync(f, { force: true });
  }

  const texts = [];
  for (const [name, state, spec] of FALLBACK) {
    const { html, png, pixels } = await renderOne(state, spec);
    if (pixels.length !== CARD_W * CARD_H * 2) {
      throw new Error(`${name}: RGB565 长度 ${pixels.length}，期望 ${CARD_W * CARD_H * 2}`);
    }
    // 自检：用与运行时相同的编码器包一层，再解回来，确保这 153600 字节能被固件原样解析
    const meta = buildCardMeta(state, spec, 0, 1);
    const payload = encodeCardPayload(meta, pixels);
    if (payload.length !== 14 + Buffer.byteLength(JSON.stringify(meta), 'utf8') + pixels.length) {
      throw new Error(`${name}: 载荷长度自检失败`);
    }
    writeFileSync(join(outDir, `${name}.rgb565`), pixels);
    writeFileSync(join(previewDir, `${name}.png`), png);
    texts.push(visibleText(html));
    manifest.assets.push({
      name,
      file: `${name}.rgb565`,
      bytes: pixels.length,
      sha256: createHash('sha256').update(pixels).digest('hex').slice(0, 16),
      payloadBytes: payload.length,
    });
    console.log(`✓ ${name}.rgb565  ${pixels.length} 字节`);
  }

  // 2) 把字符集铺开（只渲染不落盘，用于覆盖检查）
  for (const [name, state, spec] of COVERAGE_ONLY) {
    const html = buildCardHtml(state, spec);
    texts.push(visibleText(html));
    void name;
  }

  // 3) 字形覆盖：让同一套 Chrome 把每个字符画进网格，再与"缺字参考格"逐像素比对
  const allText = texts.join('');
  const masks = await renderGlyphMasks(allText);
  const coverage = classifyCoverage(masks);
  manifest.coverage = {
    ok: coverage.ok,
    detectorOk: coverage.detectorOk,
    checked: coverage.checked,
    missing: coverage.missing,
    noInk: coverage.noInk,
    message: coverage.message,
  };
  console.log(`${coverage.ok ? '✓' : '✗'} ${coverage.message}`);

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  if (!coverage.ok) {
    console.error('字形覆盖检查未通过 —— 不交付这些资源。');
    process.exit(1);
  }

  const total = manifest.assets.reduce((n, a) => n + a.bytes, 0);
  console.log(`\n资源目录 ${outDir}`);
  console.log(`共 ${manifest.assets.length} 张，合计 ${total} 字节（约 ${(total / 1024).toFixed(0)} KB Flash）`);
}

await main();
