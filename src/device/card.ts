/**
 * 设备卡（240×320）的 HTML 设计稿 —— 服务端渲染的唯一真相。
 *
 * 同一份代码被两处消费：
 *   1. 运行时：daemon 渲染"今日卡"推给设备
 *   2. 构建时：tools/gen_device_assets.ts 渲染固件内置的兜底卡（离线/开机）
 *
 * 设计约束：
 *   - 尺寸写死 240×320，圆角写死 30px（与固件 BSP_LVGL_SCREEN_RADIUS 一致，
 *     固件直接画图时不再做遮罩，圆角由图上就带好）
 *   - 所有文字必须放得下。标题按长度自动降字号，卡片底部一律留出提示区。
 *   - 不用 emoji（设备上会变成方框），图形一律用 CSS 画。
 *   - 数字用 tabular-nums，避免宽度跳动。
 */
import type { CardState, CardSpec } from './types.js';

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
/** 目标/任务标题来自用户输入，进 HTML 前必须转义 */
export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:240px;height:320px;background:#000;overflow:hidden;
  font-family:"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.card{position:relative;width:240px;height:320px;border-radius:30px;overflow:hidden;color:#eaf4ff;
  background:radial-gradient(130% 85% at 18% -5%,#13324b 0%,#0c1c2b 52%,#060d15 100%)}
.card::after{content:"";position:absolute;inset:0;border-radius:30px;
  box-shadow:inset 0 0 0 1px rgba(140,190,225,.13)}
.hd{display:flex;justify-content:space-between;align-items:center;
  padding:15px 18px 0 18px;font-size:11px;color:#7fa8c4;letter-spacing:.2px}
.bat{display:flex;align-items:center;gap:3px}
.bat .b{width:22px;height:10px;border:1.5px solid #6f97b2;border-radius:3px;padding:1.5px}
.bat .b i{display:block;height:100%;border-radius:1px;background:#4ade80}
.bat .b i.low{background:#f87171}
.bat .b i.mid{background:#fbbf24}
.bat .c{width:2px;height:5px;background:#6f97b2;border-radius:0 1px 1px 0;margin-left:-3px}
.bat .n{font-size:10px;color:#89aec6}
.wrap{padding:14px 18px 0 18px}
.track{display:flex;align-items:center;gap:5px}
.nd{width:11px;height:11px;border-radius:3px;flex:none}
.nd.done{background:#4ade80}
.nd.cur{background:#ffd166;box-shadow:0 0 9px rgba(255,209,102,.55)}
.nd.todo{border:1.5px solid #35566b}
.stg{margin-top:9px;font-size:11.5px;color:#8fb6cf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kick{font-size:9.5px;letter-spacing:1.6px;color:#ffd166;font-weight:500}
.kick.dim{color:#6f97b2}
.ttl{margin-top:9px;font-weight:600;line-height:1.34;word-break:break-word;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.ttl.s1{font-size:23px}
.ttl.s2{font-size:19px}
.ttl.s3{font-size:16px}
.meta{margin-top:11px;font-size:11px;color:#7fa8c4;line-height:1.6;word-break:break-word;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}
.ft{position:absolute;left:0;right:0;bottom:0;padding:0 18px 15px 18px}
.bar{height:4px;border-radius:2px;background:#1c3547;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#4ade80,#a3e635)}
.bar i.full{background:linear-gradient(90deg,#4ade80,#86efac)}
.hint{margin-top:9px;display:flex;justify-content:space-between;font-size:10px;color:#5d7f96}
.list{margin-top:13px;display:flex;flex-direction:column;gap:8px}
.row{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.35}
.tick{width:15px;height:15px;border-radius:5px;flex:none;margin-top:1px;position:relative;
  border:1.5px solid #3d6277}
.row.ok .tick{background:#4ade80;border-color:#4ade80}
.row.ok .tick::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4px;height:8px;
  border:2px solid #062417;border-top:0;border-left:0;transform:rotate(42deg)}
.row.ok .tx{color:#5d7f96;text-decoration:line-through}
.row.now .tick{border-color:#ffd166}
.tx{flex:1;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;
  -webkit-line-clamp:2;overflow:hidden}
.tag{margin-left:6px;font-size:9px;padding:1px 5px;border-radius:4px;
  background:rgba(255,209,102,.16);color:#ffd166;vertical-align:1px}
.big{position:absolute;left:0;right:0;top:74px;text-align:center;padding:0 22px}
.ring{width:76px;height:76px;margin:0 auto;border-radius:50%;position:relative;
  background:radial-gradient(circle at 50% 40%,rgba(74,222,128,.22),rgba(74,222,128,.04) 70%)}
.ring::after{content:"";position:absolute;left:26px;top:20px;width:19px;height:34px;
  border:4px solid #4ade80;border-top:0;border-left:0;transform:rotate(42deg);border-radius:2px}
.big h2{margin-top:16px;font-size:22px;font-weight:600}
.big p{margin-top:9px;font-size:11.5px;color:#7fa8c4;line-height:1.7}
.facts{margin:16px 20px 0;display:flex;gap:8px;position:absolute;left:0;right:0;top:196px}
.fact{flex:1;text-align:center;background:rgba(120,180,220,.07);border-radius:10px;padding:9px 4px}
.fact b{display:block;font-size:17px;font-weight:600;color:#eaf4ff}
.fact span{font-size:9.5px;color:#7fa8c4}
/* 完成页：用 flex 纵向排布，避免绝对定位的统计卡把上面的文字压住（实测会重叠）。
   ⚠ 容器类名【不能】叫 .done —— 阶段节点轨道里的已完成格子是 .nd.done，
     两个 .done 会互相命中：所有已完成的节点会被这条 position:absolute 抓住，
     全部叠成卡片左上角的一个绿点，轨道上的进度就看不见了。
     所以页级容器统一用与「状态」不重名的词（finish / big / facts）。 */
.finish{position:absolute;left:0;right:0;top:38px;bottom:44px;display:flex;flex-direction:column;
  justify-content:space-between}
.finish .dc{display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 22px}
.finish .dc h2{margin-top:16px;font-size:22px;font-weight:600}
.finish .dc p{margin-top:9px;font-size:11.5px;color:#7fa8c4;line-height:1.7}
.finish .facts{position:static;left:auto;right:auto;top:auto;margin:0 20px;display:flex;gap:8px}
.icon{width:60px;height:60px;margin:0 auto;position:relative;opacity:.95}
.icon.warn{border-radius:50%;background:rgba(251,191,36,.14)}
.icon.warn::after{content:"";position:absolute;left:28px;top:14px;width:4px;height:20px;
  border-radius:2px;background:#fbbf24}
.icon.warn::before{content:"";position:absolute;left:28px;top:40px;width:4px;height:4px;
  border-radius:50%;background:#fbbf24}
.icon.sync{border-radius:50%;background:rgba(127,168,196,.12)}
.icon.sync::after{content:"";position:absolute;left:17px;top:17px;width:26px;height:26px;
  border-radius:50%;border:3px solid #7fa8c4;border-right-color:transparent;border-bottom-color:transparent;
  transform:rotate(-45deg)}
.icon.sync::before{content:"";position:absolute;left:16px;top:11px;width:0;height:0;
  border:6px solid transparent;border-bottom-color:#7fa8c4;border-top:0}
.spin{animation:none}
`;

function battery(soc: number | null): string {
  if (soc === null || soc < 0) {
    return '<div class="bat"><div class="b"><i style="width:0"></i></div><div class="c"></div></div>';
  }
  const pct = Math.max(0, Math.min(100, Math.round(soc)));
  const cls = pct < 20 ? 'low' : pct < 50 ? 'mid' : '';
  return `<div class="bat"><div class="b"><i class="${cls}" style="width:${pct}%"></i></div><div class="c"></div><span class="n">${pct}%</span></div>`;
}

/** 节点轨道最多画这么多格，超了就只画当前阶段附近的窗口（真值看下面的文字） */
const TRACK_MAX = 12;

function track(stage: CardState['stage']): string {
  if (!stage) return '';
  const { total, order } = stage;
  // 阶段数过多时轨道会横向溢出（240px 放不下）；此时窗口化显示，
  // 权威数字始终由下面那行「阶段 order/total · 标题」给出。
  const shown = Math.min(total, TRACK_MAX);
  const start = total > TRACK_MAX
    ? Math.min(Math.max(order - Math.floor(TRACK_MAX / 2), 1), total - TRACK_MAX + 1)
    : 1;
  const nodes: string[] = [];
  for (let i = 0; i < shown; i++) {
    const n = start + i;
    const cls = n < order ? 'done' : n === order ? 'cur' : 'todo';
    nodes.push(`<div class="nd ${cls}"></div>`);
  }
  return `<div class="wrap"><div class="track">${nodes.join('')}</div>
    <div class="stg">阶段 ${order}/${total} · ${esc(stage.title)}</div></div>`;
}

/** 标题越长字号越小，保证一定放得下 */
function titleClass(t: string): string {
  const n = [...t].length;
  if (n <= 12) return 's1';
  if (n <= 20) return 's2';
  return 's3';
}

/**
 * 卡壳。
 * ⚠ dateLabel 为空时【不画日期】：固件内置兜底卡（未配置/离线/开机）是构建期渲染的，
 *   而设备没有备电 RTC。把构建那天的日期画进图里，等于让设备天天说"今天是构建日"——
 *   这正是铁律 8 要禁的伪造时间。时间只能来自服务端。
 */
function shell(inner: string, st: CardState): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${CSS}</style></head><body><div class="card">
<div class="hd"><div>${st.dateLabel ? esc(st.dateLabel) : ''}</div>${battery(st.battery)}</div>
${inner}
</div></body></html>`;
}

/** 今日总览：阶段轨道 + 条目列表 + 进度 */
function overview(st: CardState): string {
  const rows = st.items.map((it) => {
    const cls = it.done ? 'ok' : it.kind === 'MAIN_QUEST' ? 'now' : '';
    const tag = it.kind === 'MAIN_QUEST' ? '<span class="tag">主线</span>' : '';
    return `<div class="row ${cls}"><div class="tick"></div><div class="tx">${esc(it.title)}${tag}</div></div>`;
  }).join('');
  const pct = st.total ? Math.round((st.doneCount / st.total) * 100) : 0;
  return shell(`${track(st.stage)}
    <div class="wrap"><div class="kick">今天要做的事</div>
    <div class="list">${rows || '<div class="row"><div class="tx" style="color:#5d7f96">今天没有安排</div></div>'}</div></div>
    <div class="ft"><div class="bar"><i style="width:${pct}%"></i></div>
    <div class="hint"><span>完成 ${st.doneCount} / ${st.total}</span><span>上下键切换 · 确定查看</span></div></div>`, st);
}

/** 单条任务：大字标题 + 为什么今天 + 完成标准 */
function task(st: CardState, spec: CardSpec): string {
  const it = st.items[spec.itemIndex ?? 0];
  if (!it) return overview(st);
  const isMain = it.kind === 'MAIN_QUEST';
  const metaBits: string[] = [];
  if (it.minutes) metaBits.push(`约 ${it.minutes} 分钟`);
  if (it.why) metaBits.push(esc(it.why));
  if (it.completionCriteria) metaBits.push(`完成标准：${esc(it.completionCriteria)}`);
  const pct = st.total ? Math.round((st.doneCount / st.total) * 100) : 0;
  return shell(`${track(st.stage)}
    <div class="wrap"><div class="kick${isMain ? '' : ' dim'}">${isMain ? '今天这一件事' : '今天的小事'}</div>
    <div class="ttl ${titleClass(it.title)}">${esc(it.title)}</div>
    ${metaBits.length ? `<div class="meta">${metaBits.join('<br>')}</div>` : ''}</div>
    <div class="ft"><div class="bar"><i style="width:${pct}%"></i></div>
    <div class="hint"><span>完成 ${st.doneCount} / ${st.total}</span><span>${it.done ? '已完成' : '确定 = 完成'}</span></div></div>`, st);
}

/** 全部完成 */
function alldone(st: CardState): string {
  const ev = st.facts?.evidence ?? 0;
  const mainDone = st.facts?.mainDone ?? 0;
  return shell(`<div class="finish">
    <div class="dc">
      <div class="ring"></div>
      <h2>今天做完了</h2>
      <p>${esc(st.dateLabel)}${st.stage ? `<br>阶段推进到 ${st.stage.order}/${st.stage.total}` : '<br>继续保持'}</p>
    </div>
    <div class="facts">
      <div class="fact"><b>${st.doneCount}/${st.total}</b><span>今日任务</span></div>
      <div class="fact"><b>${ev}</b><span>累积证据</span></div>
      <div class="fact"><b>${mainDone}</b><span>主线完成</span></div>
    </div>
  </div>
  <div class="ft"><div class="bar"><i class="full" style="width:100%"></i></div>
  <div class="hint"><span>全部完成</span><span>上下键回看</span></div></div>`, st);
}

/** 今天还没排计划（能连上电脑，但 Agent 还没排） */
function noplan(st: CardState): string {
  return shell(`<div class="big">
    <div class="icon warn"></div>
    <h2>今天还没排计划</h2>
    <p>回家跟 Agent 说一声<br>「开启今日任务」<br>它会把今天安排到这张卡上</p>
  </div>
  <div class="ft"><div class="hint" style="justify-content:center"><span>${esc(st.dateLabel)}</span></div></div>`, st);
}

/**
 * 连不上电脑（固件内置兜底卡）。
 * 这里刻意不写"上次同步：xx"——构建期渲染的卡不知道用户哪天开机，写死一个时间就是假的。
 */
function offline(st: CardState): string {
  return shell(`<div class="big">
    <div class="icon sync"></div>
    <h2>暂时连不上电脑</h2>
    <p>回到家里同一个 Wi-Fi 就会自动同步<br>按「确定」可以立刻重试</p>
  </div>
  <div class="ft"><div class="hint"><span>确定 = 重试</span><span>上下键 = 翻卡</span></div></div>`, st);
}

/** 正在连接（固件内置兜底卡） */
function booting(st: CardState): string {
  return shell(`<div class="big" style="top:96px">
    <p style="font-size:14px;font-weight:600;color:#eaf4ff;letter-spacing:.3px">FoloToy AI Passport</p>
    <p style="font-size:11px;color:#7fa8c4;margin-top:8px">自驱动成长工具</p>
    <div class="bar" style="margin:22px 14px 0 14px"><i style="width:38%"></i></div></div>
  <div class="ft"><div class="hint" style="justify-content:center"><span>正在连接电脑…</span></div></div>`, st);
}

/**
 * 未配置（固件内置兜底卡）——告诉用户下一步做什么，而不是报错。
 *
 * ⚠ 文案必须指向**一条命令**：这条卡是刷完固件后开机第一眼看到的东西，
 *   如果写"用串口把 Wi-Fi 填进来"，用户就得装工具链、找串口、还躲不过
 *   "串口只能输 ASCII、中文 Wi-Fi 名填不进去"这个坑 —— 那就不是能发布的应用了。
 *   所以直接给出 `ai-growth device setup`，那条命令会自动处理 hex 与验证。
 */
function setup(st: CardState): string {
  return shell(`<div class="big">
    <div class="icon warn"></div>
    <h2>还没连上电脑</h2>
    <p>在电脑上跑一条命令就配好：<br>ai-growth device setup<br>--ssid "Wi-Fi名" --pass "密码"</p>
  </div>
  <div class="ft"><div class="hint" style="justify-content:center"><span>配好后会自动重启并取卡</span></div></div>`, st);
}

export function buildCardHtml(st: CardState, spec: CardSpec): string {
  switch (spec.kind) {
    case 'overview': return overview(st);
    case 'task': return task(st, spec);
    case 'alldone': return alldone(st);
    case 'noplan': return noplan(st);
    case 'offline': return offline(st);
    case 'booting': return booting(st);
    case 'setup': return setup(st);
    default: return overview(st);
  }
}
