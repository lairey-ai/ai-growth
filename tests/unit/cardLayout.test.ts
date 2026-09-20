import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCardHtml } from '../../src/device/card.js';
import { findChrome } from '../../src/device/render.js';
import type { CardState } from '../../src/device/types.js';

/**
 * 设备卡的【真实布局】回归测试 —— 用 Chrome 量元素坐标，不看截图。
 *
 * 为什么必须有这个文件（这是踩过的坑，不是预防性洁癖）：
 *   卡片样式表里曾经同时存在 `.nd.done`（阶段轨道上「已完成」的格子）
 *   和 `.done`（完成页的整页容器，带 position:absolute;top:38px;left:0）。
 *   两个类名撞在一起，于是**所有已完成阶段的格子都被抓成绝对定位**，
 *   全部叠在卡片左上角的同一个点上、还跑到内边距外面去了。
 *
 *   这个东西截图肉眼几乎看不出来（就是一个小绿点，看着像装饰），
 *   而 scripts/check-device-cards.mjs 那 22 个用例查的是「文字有没有溢出」，
 *   也查不出来。只有把元素坐标量出来才会暴露。
 *
 * 所以这里锁的不是某一处像素，而是那条被违反的不变量：
 *   阶段轨道上的每个节点，必须横排、同高、等距、不重叠、且完整落在轨道容器内。
 * 以后谁再往卡片 CSS 里加一个和状态类重名的页级容器，这里就会红。
 */

const CHROME = findChrome();
/** 量布局必须真的跑浏览器；没有 Chrome 就明确跳过，而不是假装通过 */
const describeIfChrome = CHROME ? describe : describe.skip;

const BODY_FONT =
  '"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",sans-serif';

interface Rect { x: number; y: number; w: number; h: number }
interface Probe {
  track: Rect | null;
  wrap: Rect | null;
  wrapPaddingLeft: string;
  nodes: Array<Rect & { cls: string }>;
  /** 轨道容器在文档里的左边界（用于判断节点有没有跑到内边距外面） */
  trackPaddingLeft: string;
  cards: number;
  hasFinishContainer: number;
}

/**
 * 把卡片 HTML 丢给 Chrome，读回真实几何。
 *
 * ⚠ 不能用 execFileSync + --dump-dom：本机实测 Chrome 打完 DOM 后【不会自己退出】，
 *   同步等待必然 ETIMEDOUT（render.ts 里截图那套也是因为同样的原因改成轮询 + 杀进程组的）。
 *   所以这里照抄那套：detached 起进程、轮询 stdout 直到看到结束哨兵、然后杀掉整个进程组。
 */
const BEGIN = 'AIGPROBE_BEGIN';
const END = 'AIGPROBE_END';

function probeLayout(html: string): Promise<Probe> {
  const chrome = CHROME as string;
  const dir = mkdtempSync(join(tmpdir(), 'aig-layout-'));
  const file = join(dir, 'card.html');
  const probeDiv =
    `<div id="aig-probe" style="position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000"></div>` +
    `<script>(function(){` +
    `function r(e){var b=e.getBoundingClientRect();return {x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2)};}` +
    `var t=document.querySelector('.track');` +
    `var w=t?t.closest('.wrap'):null;` +
    `var o={track:t?r(t):null,wrap:w?r(w):null,` +
    `wrapPaddingLeft:w?getComputedStyle(w).paddingLeft:'',` +
    `trackPaddingLeft:t?getComputedStyle(t).paddingLeft:'',` +
    `nodes:t?[].map.call(t.querySelectorAll('.nd'),function(n){var b=r(n);b.cls=n.className;return b;}):[],` +
    `cards:document.querySelectorAll('.card').length,` +
    `hasFinishContainer:document.querySelectorAll('.finish').length};` +
    `document.getElementById('aig-probe').textContent='${BEGIN}'+JSON.stringify(o)+'${END}';` +
    `})();</script>`;

  writeFileSync(file, html.replace('</body>', probeDiv + '</body>'), 'utf8');

  return new Promise<Probe>((resolve, reject) => {
    const child = spawn(
      chrome,
      [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions',
        `--user-data-dir=${join(dir, 'profile')}`,
        '--virtual-time-budget=1500',
        '--dump-dom',
        `file://${file}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    );

    let out = '';
    let settled = false;
    const cleanup = () => {
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* 已退出 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const fail = (e: Error) => { if (settled) return; settled = true; cleanup(); reject(e); };

    child.stdout?.on('data', (d) => { out += String(d); });
    child.on('error', (e) => fail(e));

    const deadline = Date.now() + 30_000;
    const poll = () => {
      if (settled) return;
      const ok = out.indexOf(END);
      if (ok >= 0) {
        settled = true;
        const from = out.indexOf(BEGIN);
        const json = out.slice(from + BEGIN.length, ok)
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
        cleanup();
        try { resolve(JSON.parse(json) as Probe); } catch (e) { reject(e as Error); }
        return;
      }
      if (Date.now() > deadline) {
        fail(new Error(`探测超时：Chrome 30s 内没产出布局结果（收到 ${out.length} 字节）`));
        return;
      }
      setTimeout(poll, 80);
    };
    poll();
  });
}

function state(over: Partial<CardState> = {}): CardState {
  const items = [
    { id: 'a1', kind: 'MAIN_QUEST' as const, title: '实现最小 Agent Memory Demo', status: 'PLANNED', done: false, minutes: 60 },
    { id: 'a2', kind: 'DAILY' as const, title: '散步 30 分钟', status: 'PLANNED', done: false, minutes: 30 },
  ];
  return {
    dateLabel: '9月20日 周日',
    dateKey: '2026-09-20',
    stage: { title: '跑通端到端最小闭环', order: 3, total: 6 },
    items,
    doneCount: 0,
    total: items.length,
    battery: 76,
    ...over,
  };
}

const overviewHtml = (over: Partial<CardState> = {}) =>
  buildCardHtml(state(over), { kind: 'overview', title: '今日总览' });

describe('卡片样式的类名不能撞车（纯 HTML 层，不需要浏览器）', () => {
  it('完成页容器不叫 .done，否则会命中轨道上的 .nd.done', () => {
    const html = buildCardHtml(
      { ...state(), doneCount: 2, total: 2, items: state().items.map((i) => ({ ...i, done: true })) },
      { kind: 'alldone', title: '今天做完了' }
    );
    // 完成页确实有自己的页级容器
    expect(html).toContain('class="finish"');
    // 而且绝不能再出现一个裸的 class="done"
    expect(html).not.toMatch(/class="done(\s|")/);
  });

  it('轨道节点的状态类（done/cur/todo）不会同时出现在页级容器上', () => {
    const css = overviewHtml();
    const style = css.slice(css.indexOf('<style>'), css.indexOf('</style>'));
    // 页级容器的特征：在 CSS 里以裸类名出现并带 position:absolute
    for (const cls of ['done', 'cur', 'todo']) {
      const bare = new RegExp(`(^|[},])\\s*\\.${cls}\\s*\\{`, 'm');
      expect(bare.test(style), `.${cls} 被当成了页级容器，会和节点状态类撞车`).toBe(false);
    }
  });
});

describeIfChrome('阶段轨道必须横排、等距、不重叠（真实几何）', () => {
  it('6 个阶段 / 当前第 3 个：6 个节点全部落在轨道内且同一行', async () => {
    const p = await probeLayout(overviewHtml());
    expect(p.cards).toBe(1);
    expect(p.track).not.toBeNull();
    const track = p.track!;
    const nodes = p.nodes;

    expect(nodes.length).toBe(6);
    expect(nodes.map((n) => n.cls)).toEqual([
      'nd done', 'nd done', 'nd cur', 'nd todo', 'nd todo', 'nd todo',
    ]);

    // 1) 同一行：所有节点的 y 与高度一致（这正是当初被 position:absolute 打散的地方）
    const ys = new Set(nodes.map((n) => n.y));
    expect([...ys]).toHaveLength(1);
    const hs = new Set(nodes.map((n) => n.h));
    expect([...hs]).toHaveLength(1);

    // 2) 完整落在轨道容器内（不许跑到内边距外面）
    for (const n of nodes) {
      expect(n.x, `节点 ${n.cls} 跑到轨道左边外面了`).toBeGreaterThanOrEqual(track.x);
      expect(n.x + n.w).toBeLessThanOrEqual(track.x + track.w + 0.01);
      expect(n.y).toBeGreaterThanOrEqual(track.y);
      expect(n.y + n.h).toBeLessThanOrEqual(track.y + track.h + 0.01);
    }

    // 3) 等距且不重叠
    const xs = nodes.map((n) => n.x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i], `第 ${i} 个节点与第 ${i - 1} 个重叠了`).toBeGreaterThan(xs[i - 1] + nodes[i - 1].w);
    }
    const gaps = xs.slice(1).map((x, i) => +(x - (xs[i] + nodes[i].w)).toFixed(2));
    expect(new Set(gaps).size, `节点间距不一致：${gaps.join(',')}`).toBe(1);

    // 4) 第一个节点从内边距开始（不是贴着卡片边缘）
    expect(xs[0]).toBeCloseTo(parseFloat(p.wrapPaddingLeft), 1);
  });

  it('阶段数超过 12 时窗口化，节点仍然横排且不溢出 240px', async () => {
    const p = await probeLayout(overviewHtml({ stage: { title: '长跑', order: 40, total: 50 } }));
    expect(p.nodes.length).toBe(12);
    const track = p.track!;
    for (const n of p.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(track.x + track.w + 0.01);
      expect(n.x).toBeGreaterThanOrEqual(track.x);
    }
    expect(new Set(p.nodes.map((n) => n.y)).size).toBe(1);
  });

  it('只有 1 个阶段时不画多余的格子', async () => {
    const p = await probeLayout(overviewHtml({ stage: { title: '唯一阶段', order: 1, total: 1 } }));
    expect(p.nodes.length).toBe(1);
    expect(p.nodes[0].cls).toBe('nd cur');
  });

  it('没有阶段（stage=null）时整条轨道不出现', async () => {
    const p = await probeLayout(overviewHtml({ stage: null }));
    expect(p.track).toBeNull();
    expect(p.nodes.length).toBe(0);
  });
});
