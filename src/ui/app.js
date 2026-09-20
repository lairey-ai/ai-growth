/* ============================================================
   AI Growth — 游戏面板式 HUD
   原则 6 / §16.3：不产生虚构属性值、掌握度百分比、自律分。
   面板上出现的每个数字都必须是可核对事实。
   ============================================================ */

const app = document.getElementById('app');
const statusText = document.getElementById('status-text');
const statusDate = document.getElementById('status-date');
const linkDot = document.getElementById('link-dot');

// 桌面小组件 / 打包成桌面应用时的紧凑布局
if (new URLSearchParams(location.search).get('layout') === 'widget') {
  document.body.classList.add('widget');
}

let page = 'today';
/** todayKey 由服务端按配置时区给出（不信任客户端时钟/时区） */
const state = { todayKey: null };

/** 标签页与 URL hash 同步：刷新/书签/桌面组件重启后能回到同一页 */
const PAGES = ['today', 'goals', 'timeline', 'passport', 'settings'];

function setPage(next, { push = true } = {}) {
  page = PAGES.includes(next) ? next : 'today';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-active', x.dataset.page === page));
  if (push && location.hash.slice(1) !== page) location.hash = page;
  render();
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setPage(btn.dataset.page);
});

window.addEventListener('hashchange', () => setPage(location.hash.slice(1), { push: false }));

document.addEventListener('keydown', (e) => {
  if (e.key === 'r' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); render(); }
});

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setLink(ok, text) {
  linkDot.className = 'dot ' + (ok ? 'ok' : 'bad');
  statusText.textContent = text;
}

function fmtMin(m) {
  if (!m && m !== 0) return '';
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? (m % 60) + 'm' : ''}` : `${m}m`;
}

/**
 * 相对日期。key 必须是服务端按配置时区算好的 YYYY-MM-DD。
 * state.todayKey 由任意一个接口返回（含 /api/timeline），因此直接打开 #timeline 也正确。
 * 注意：绝不要在客户端对 ISO 串做 slice(0,10) —— 那是按 UTC 截断，东八区会差一天。
 */
function relDate(key) {
  if (!key) return '';
  const today = state.todayKey;
  if (today && key === today) return '今天';
  const d = new Date(`${key}T12:00:00`);
  if (!today) return `${d.getMonth() + 1}月${d.getDate()}日`;
  const t = new Date(`${today}T12:00:00`);
  const diff = Math.round((t - d) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff > 1 && diff < 7) return `${diff} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ---------------------------------------------------------------- 渲染入口

async function render() {
  app.innerHTML = '<div class="boot">读取面板…</div>';
  try {
    if (page === 'today') await renderToday();
    else if (page === 'goals') await renderGoals();
    else if (page === 'timeline') await renderTimeline();
    else if (page === 'passport') await renderPassport();
    else if (page === 'settings') await renderSettings();
    setLink(true, '已连接');
  } catch (e) {
    setLink(false, '连接失败');
    app.innerHTML = `<div class="card hl-gold"><div class="empty">读不到数据：${esc(e.message)}<br><br>
      确认服务在跑：<br><code style="color:var(--cyan)">npm run api</code><br>
      或先自检：<code style="color:var(--cyan)">bash scripts/doctor.sh</code></div></div>`;
  }
}

// ---------------------------------------------------------------- 面板页

async function renderToday() {
  const r = await api('/api/today');
  const d = r.data ?? {};
  state.todayKey = d.today ?? state.todayKey;
  statusDate.textContent = d.today ?? '';

  const st = d.status ?? {};
  const facts = d.facts ?? {};
  const main = (d.actions ?? []).find((a) => a.kind === 'MAIN_QUEST') ?? null;
  const dailies = (d.actions ?? []).filter((a) => a.kind === 'DAILY');

  // 首次使用：不展示任务，先引导访谈（原则 2）
  if (st.onboarding !== 'COMPLETED') {
    app.innerHTML = `
    <div class="grid">
      <div class="card hl-cyan col-6">
        <div class="onboard">
          <h2>系统还没开始认识你</h2>
          <p>这个面板不是任务清单，它是<strong>替你维护计划</strong>的成长系统。
             开始前需要先和你的 Agent 聊一次——它会问你想去哪、每天有多少时间、想过什么样的生活。</p>
          <p style="margin-top:10px;color:var(--ink-faint)">没有访谈就不会有任务。这是刻意设计的：AI 管路线，你决定目的地。</p>
          <code>对 Agent 说：「开启今日任务」</code>
        </div>
      </div>
    </div>`;
    return;
  }

  const stagePct = d.stageProgress ? (d.stageProgress.order / d.stageProgress.total) : 0;
  const trackHtml = renderStageTrack(d.stages ?? []);

  app.innerHTML = `
  <div class="grid">

    <!-- 主线定位 -->
    <div class="card hl-violet col-4">
      <div class="card-head">当前主线<span class="rule"></span></div>
      ${d.primaryGoal
        ? `<div class="quest-title" style="font-size:16px">${esc(d.primaryGoal.title)}</div>
           <div class="field"><div class="field-k">Why</div><div class="field-v">${esc(d.primaryGoal.why)}</div></div>
           ${d.primaryGoal.targetDate ? `<div class="quest-meta"><span class="chip">目标 ${esc(d.primaryGoal.targetDate)}</span></div>` : ''}`
        : '<div class="empty">还没有 Active Goal</div>'}
      ${d.lifeContext && d.lifeContext.mode !== 'NORMAL'
        ? `<div class="quest-meta"><span class="chip chip-amber">${esc(modeLabel(d.lifeContext.mode))}${d.lifeContext.availableMinutesPerDay ? ' · 每天 ' + d.lifeContext.availableMinutesPerDay + ' 分钟' : ''}</span></div>`
        : ''}
    </div>

    <!-- 阶段轨道：Stage 3 / 6 是可核对事实 -->
    <div class="card hl-cyan col-2">
      <div class="card-head">阶段进度<span class="rule"></span></div>
      ${d.stageProgress
        ? `<div class="fact cyan" style="border:none;background:none;padding:0">
             <div class="fact-n">Stage ${d.stageProgress.order}<small> / ${d.stageProgress.total}</small></div>
             <div class="fact-k">${esc(d.stageProgress.title)}</div>
           </div>`
        : '<div class="empty">尚未分阶段</div>'}
      ${(d.stages ?? []).length > 1 ? `<div style="margin-top:14px">${trackHtml}</div>` : ''}
    </div>

    <!-- 今天最重要的一步 -->
    <div class="col-6">
      ${main ? mainQuestCard(main) : `
      <div class="card hl-cyan">
        <div class="card-head">今天最重要的一步<span class="rule"></span></div>
        <div class="empty">今天还没有 Main Quest。<br>让 Agent 帮你规划，或直接对它说你想推进什么。</div>
      </div>`}
    </div>

    <!-- 每日维护 + 今日提醒（高度相近，同排更紧凑） -->
    <div class="card col-4">
      <div class="card-head">每日维护<span class="rule"></span>
        ${facts.todayDaily ? `<span class="chip">${facts.todayDaily.done}/${facts.todayDaily.total} 完成</span>` : ''}
      </div>
      ${dailies.length
        ? `<div class="task-cols">${dailies.map(dailyRow).join('')}</div>`
        : '<div class="empty">今天没有每日任务<br><span style="font-size:12px">这也是合理的安排</span></div>'}
    </div>

    <div class="card col-2">
      <div class="card-head">今日提醒<span class="rule"></span></div>
      ${(d.reminders ?? []).length
        ? d.reminders.map((x) => `
          <div class="entry">
            <div class="entry-date">${esc(new Date(x.scheduledAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</div>
            <div><div class="entry-title">${x.status === 'SENT' ? '已提醒' : '待提醒'}</div>
            <div class="entry-sub">${esc(x.channel === 'LOCAL_NOTIFICATION' ? '系统通知' : x.channel)}</div></div>
          </div>`).join('')
        : '<div class="empty">没有安排提醒</div>'}
      <div class="hint">提醒会随任务一起失效：任务完成或过期，对应提醒自动取消，不会反复催。</div>
    </div>

    <!-- 事实统计（可核对，非虚构属性） -->
    <div class="card col-6">
      <div class="card-head">累计事实<span class="rule"></span>
        <span class="chip" style="font-size:10px">可核对</span></div>
      <div class="facts">
        <div class="fact gold"><div class="fact-n">${facts.mainQuestCompletedTotal ?? 0}</div><div class="fact-k">已完成主任务</div></div>
        <div class="fact cyan"><div class="fact-n">${facts.evidenceTotal ?? 0}</div><div class="fact-k">证据总数</div></div>
        <div class="fact violet"><div class="fact-n">${facts.growthEventTotal ?? 0}</div><div class="fact-k">成长记录</div></div>
        <div class="fact green"><div class="fact-n">${facts.todayMain?.done ?? 0}<small>/${facts.todayMain?.total ?? 0}</small></div><div class="fact-k">今日主任务</div></div>
      </div>
    </div>

    <!-- 最近进展 -->
    <div class="card col-6">
      <div class="card-head">最近进展<span class="rule"></span>
        ${(d.recentEvents ?? []).length ? `<span class="chip">${d.recentEvents.length}</span>` : ''}</div>
      ${(d.recentEvents ?? []).length
        ? `<div class="task-cols">${d.recentEvents.map((e) => `
          <div class="entry">
            <div class="entry-date">${esc(relDate(e.date))}</div>
            <div>
              <div class="entry-title">${esc(e.title)}</div>
              <div class="entry-sub">${chipDomain(e.domain)}${e.evidenceCount ? `<span class="chip" style="font-size:10.5px">${e.evidenceCount} 条证据</span>` : ''}</div>
            </div>
          </div>`).join('')}</div>`
        : '<div class="empty">还没有成长记录<br><span style="font-size:12px">完成真实任务并记下证据后会出现</span></div>'}
    </div>

  </div>`;

  bindOps();
}

/** 阶段节点轨道：只表达"第几个 / 共几个"，不换算百分比 */
function renderStageTrack(stages) {
  if (!stages.length) return '';
  const done = new Set(['COMPLETED']);
  const skip = new Set(['SKIPPED']);
  const now = new Set(['ACTIVE', 'DELAYED']);
  const items = stages.map((s, i) => {
    const cls = done.has(s.status) ? 'past' : now.has(s.status) ? 'now' : skip.has(s.status) ? 'skip' : '';
    const node = `<div class="node ${cls}" title="${esc(s.title)}">${done.has(s.status) ? '✓' : s.order}</div>`;
    const link = i < stages.length - 1 ? `<div class="link ${done.has(s.status) ? 'past' : ''}"></div>` : '';
    return `<div class="node-wrap">${node}${link}</div>`;
  }).join('');
  const current = stages.find((s) => now.has(s.status));
  // 图例加圆点标记，避免被误读成"节点 1 的标签"
  return `<div class="track">${items}</div>
    ${current ? `<div class="node-legend">
      <span><i class="dotmark"></i>当前：${esc(current.title)}</span>
      <span>${esc(current.end ?? '')}</span>
    </div>` : ''}`;
}

function mainQuestCard(a) {
  const open = isOpen(a);
  return `
  <div class="card quest-card">
    <div class="card-head" style="color:var(--gold)">今天最重要的一步<span class="rule"></span></div>
    <div class="quest-title">${esc(a.title)}</div>
    <div class="quest-meta">
      ${a.estimatedMinutes ? `<span class="chip chip-gold">预计 ${fmtMin(a.estimatedMinutes)}</span>` : ''}
      <span class="chip chip-${a.status === 'COMPLETED' ? 'green' : 'gold'}">${esc(statusLabel(a.status))}</span>
      ${chipDomain(a.domain)}
    </div>
    ${a.whyToday ? `<div class="field"><div class="field-k">为什么今天做</div><div class="field-v">${esc(a.whyToday)}</div></div>` : ''}
    ${a.completionCriteria ? `<div class="field"><div class="field-k">完成标准</div><div class="field-v">${esc(a.completionCriteria)}</div></div>` : ''}
    ${open ? `<div class="ops">
      <button class="btn btn-primary" data-id="${esc(a.id)}" data-op="complete">已完成</button>
      <button class="btn" data-id="${esc(a.id)}" data-op="delay">延期</button>
      <button class="btn" data-id="${esc(a.id)}" data-op="skip">跳过</button>
    </div>` : ''}
  </div>`;
}

function dailyRow(a) {
  const open = isOpen(a);
  const cls = a.status === 'COMPLETED' ? 'done' : a.status === 'EXPIRED' ? 'miss' : '';
  return `
  <div class="task">
    <div class="bullet ${cls}">${a.status === 'COMPLETED' ? '✓' : a.status === 'EXPIRED' ? '×' : ''}</div>
    <div class="task-body">
      <div class="task-title">${esc(a.title)}</div>
      <div class="task-sub">${esc(dailySub(a))}</div>
    </div>
    ${open ? `<div class="task-ops">
      <button class="btn btn-go" data-id="${esc(a.id)}" data-op="complete">完成</button>
      <button class="btn" data-id="${esc(a.id)}" data-op="skip">跳过</button>
    </div>` : ''}
  </div>`;
}

function dailySub(a) {
  if (a.status === 'COMPLETED') return '已完成';
  if (a.status === 'EXPIRED') return '已过期（不会累到明天）';
  if (a.status === 'SKIPPED') return '已跳过';
  return `${a.estimatedMinutes ? '约 ' + fmtMin(a.estimatedMinutes) + ' · ' : ''}${a.basis ? esc(a.basis) : '每日维护'}`;
}

function isOpen(a) {
  return !['COMPLETED', 'SKIPPED', 'CANCELLED', 'EXPIRED'].includes(a.status);
}

function statusLabel(s) {
  return { DRAFT: '待确认', PLANNED: '待进行', IN_PROGRESS: '进行中', COMPLETED: '已完成',
    SKIPPED: '已跳过', DELAYED: '已延期', PENDING_REPLAN: '待重排', EXPIRED: '已过期', CANCELLED: '已取消' }[s] ?? s;
}

function domainLabel(d) {
  return { LEARN: '学习', BUILD: '构建', TRAIN: '训练', HABIT: '习惯', CREATE: '创作',
    RELATIONSHIP: '关系', EXPLORE: '探索', LIFE: '生活', OTHER: '其他' }[d] ?? d;
}

/** 领域标签：OTHER 不显示（避免"其他"这种噪音标签） */
function chipDomain(d) {
  if (!d || d === 'OTHER') return '';
  return `<span class="chip chip-cyan" style="font-size:10.5px">${esc(domainLabel(d))}</span>`;
}

function modeLabel(m) {
  return { NORMAL: '常规', BUSY: '忙碌', RECOVERY: '恢复', TRAVEL: '在外', FOCUS: '冲刺', CUSTOM: '自定义' }[m] ?? m;
}

function bindOps() {
  app.querySelectorAll('.btn[data-op]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const op = btn.dataset.op;
      let reason = '';
      if (op !== 'complete') {
        reason = prompt(op === 'skip' ? '跳过原因（可留空）' : '延期原因（可留空）') ?? '';
      }
      btn.disabled = true;
      await api(`/api/action/${id}/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      render();
    });
  });
}

// ---------------------------------------------------------------- 主线页

async function renderGoals() {
  const r = await api('/api/goals');
  const goals = r.data ?? [];
  if (!goals.length) {
    app.innerHTML = '<div class="card hl-violet"><div class="empty">还没有 Goal</div></div>';
    return;
  }
  app.innerHTML = `<div class="grid">${goals.map((g) => `
    <div class="card ${g.status === 'ACTIVE' ? 'hl-violet' : ''} col-6">
      <div class="card-head">${esc(goalStatusLabel(g.status))}<span class="rule"></span>
        <span class="chip chip-${g.status === 'ACTIVE' ? 'violet' : ''}">${g.stages?.length ?? 0} 个阶段</span></div>
      <div class="quest-title" style="font-size:17px">${esc(g.title)}</div>
      <div class="field"><div class="field-k">为什么</div><div class="field-v">${esc(g.why)}</div></div>
      <div class="field"><div class="field-k">期望结果</div><div class="field-v">${esc(g.desiredOutcome)}</div></div>
      <div class="field"><div class="field-k">成功标准</div><div class="field-v">
        ${(g.successCriteria ?? []).map((s) => `· ${esc(s)}`).join('<br>')}</div></div>
      ${g.targetDate ? `<div class="quest-meta"><span class="chip">目标日期 ${esc(g.targetDate)}</span>${g.dailyTimeBudgetMinutes ? `<span class="chip">每天 ${g.dailyTimeBudgetMinutes} 分钟</span>` : ''}</div>` : ''}
      <div style="margin-top:16px">${renderStageTrack(g.stages ?? [])}</div>
      <div style="margin-top:14px">
        ${(g.stages ?? []).map((s) => `
          <div class="task">
            <div class="bullet ${s.status === 'COMPLETED' ? 'done' : s.status === 'ACTIVE' ? 'main' : ''}">${s.status === 'COMPLETED' ? '✓' : ''}</div>
            <div class="task-body">
              <div class="task-title">${s.order}. ${esc(s.title)}</div>
              <div class="task-sub">${esc(s.objective ?? '')}
                ${s.plannedStartDate || s.plannedEndDate ? `<br>窗口 ${esc(s.plannedStartDate ?? '?')} → ${esc(s.plannedEndDate ?? '?')}` : ''}</div>
            </div>
            <span class="chip">${esc(stageStatusLabel(s.status))}</span>
          </div>`).join('')}
      </div>
    </div>`).join('')}</div>`;
}

function goalStatusLabel(s) {
  return { DRAFT: '草案', CONFIRMED: '已确认', ACTIVE: '进行中', PAUSED: '已暂停', COMPLETED: '已完成', ABANDONED: '已放弃' }[s] ?? s;
}
function stageStatusLabel(s) {
  return { PLANNED: '未开始', ACTIVE: '进行中', COMPLETED: '已完成', DELAYED: '已顺延', SKIPPED: '已跳过' }[s] ?? s;
}

// ---------------------------------------------------------------- 记录页

async function renderTimeline() {
  const r = await api('/api/timeline');
  const d = r.data ?? {};
  state.todayKey = d.today ?? state.todayKey;
  const events = d.events ?? [];
  const evidence = d.evidence ?? [];
  app.innerHTML = `
  <div class="grid">
    <div class="card hl-violet col-3">
      <div class="card-head">成长记录<span class="rule"></span><span class="chip">${events.length}</span></div>
      ${events.length ? events.map((e) => `
        <div class="entry">
          <div class="entry-date">${esc(relDate(e.dateKey))}</div>
          <div><div class="entry-title">${esc(e.title)}</div>
          <div class="entry-sub">${chipDomain(e.domain)}${(e.evidenceIds?.length ?? e.evidenceCount) ? `<span class="chip" style="font-size:10.5px">${e.evidenceIds?.length ?? e.evidenceCount} 条证据</span>` : ''}</div>
          ${e.description ? `<div class="entry-sub">${esc(e.description)}</div>` : ''}</div>
        </div>`).join('')
        : '<div class="empty">还没有成长记录</div>'}
    </div>
    <div class="card hl-cyan col-3">
      <div class="card-head">证据流<span class="rule"></span><span class="chip">${evidence.length}</span></div>
      ${evidence.length ? evidence.map((e) => `
        <div class="entry">
          <div class="entry-date">${esc(relDate(e.dateKey))}</div>
          <div><div class="entry-title" style="font-weight:500">${esc(clip(e.content, 120))}</div>
          <div class="entry-sub">
            <span class="chip" style="font-size:10.5px">${esc(evidenceTypeLabel(e.type))}</span>
            <span class="chip chip-${strengthTone(e.strength)}" style="font-size:10.5px">${esc(strengthLabel(e.strength))}</span>
          </div></div>
        </div>`).join('')
        : '<div class="empty">还没有证据</div>'}
    </div>
  </div>`;
}

function clip(s, n) { return String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''); }
function evidenceTypeLabel(t) {
  return { TEXT: '文字', FILE: '文件', GIT: '代码提交', METRIC: '客观数据', QUIZ: '考核',
    ARTIFACT: '产出物', REFLECTION: '反思', MANUAL: '手动' }[t] ?? t;
}
function strengthLabel(s) {
  return { AUTO_VERIFIED: '自动验证', USER_CONFIRMED: '本人确认', AGENT_OBSERVED: 'Agent 观察', UNVERIFIED: '未验证' }[s] ?? s;
}
function strengthTone(s) {
  return { AUTO_VERIFIED: 'green', USER_CONFIRMED: 'cyan', AGENT_OBSERVED: 'amber', UNVERIFIED: '' }[s] ?? '';
}

// ---------------------------------------------------------------- 护照页

async function renderPassport() {
  const r = await api('/api/passport');
  const d = r.data ?? {};
  const p = d.snapshot;
  app.innerHTML = `
  <div class="grid">
    <div class="card hl-cyan col-6">
      <div class="card-head">AI Passport<span class="rule"></span>
        ${d.dirty ? '<span class="chip chip-amber">待同步</span>' : '<span class="chip chip-green">已同步</span>'}</div>
      ${p ? `
        <div class="kv"><div class="kv-k">生成时间</div><div>${esc(new Date(d.generatedAt).toLocaleString('zh-CN'))}</div></div>
        <div class="kv"><div class="kv-k">当前章节</div><div>${esc(p.currentState?.currentChapter ?? '—')}</div></div>
        <div class="kv"><div class="kv-k">活跃目标</div><div>${(p.currentState?.activeGoals ?? []).map((g) => esc(g.title)).join('、') || '—'}</div></div>
        <div class="kv"><div class="kv-k">生活情境</div><div>${esc(p.currentState?.lifeContext ?? '常规')}</div></div>
        <div class="kv"><div class="kv-k">能力证据</div><div>${(p.capabilities ?? []).map((c) => esc(`${c.topic}（${c.level}）`)).join('、') || '—'}</div></div>
        <div style="margin-top:14px"><div class="field-k">原始快照</div>
          <pre class="json">${esc(JSON.stringify(p, null, 2))}</pre></div>`
      : '<div class="empty">还没有生成过 Passport。<br><span style="font-size:12px">完成第一个真实任务后会自动生成</span></div>'}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- 设置页

async function renderSettings() {
  const r = await api('/api/settings');
  const d = r.data ?? {};
  app.innerHTML = `
  <div class="grid">
    <div class="card hl-cyan col-3">
      <div class="card-head">设置<span class="rule"></span></div>
      <form class="form" id="settings-form">
        <div><label>时区（决定"哪一天"怎么算）</label>
          <input name="timezone" value="${esc(d.timezone)}"></div>
        <div><label>提醒渠道</label>
          <select name="reminderChannel">
            <option value="macos-local" ${d.reminderChannel === 'macos-local' ? 'selected' : ''}>系统通知</option>
            <option value="none" ${d.reminderChannel === 'none' ? 'selected' : ''}>关闭提醒</option>
          </select></div>
        <div><button class="btn btn-go" type="submit">保存</button></div>
      </form>
      <div class="ops"><button class="btn" id="run-rollover">手动执行跨天检查</button></div>
      <div class="field"><div class="field-v" style="font-size:12px;color:var(--ink-faint)">
        跨天检查会把昨天没完成的每日任务标记为过期（不会累到明天），未完成的主线转入待重排。</div></div>
    </div>
    <div class="card col-3">
      <div class="card-head">关于<span class="rule"></span></div>
      <div class="kv"><div class="kv-k">数据位置</div><div>~/.ai-growth/growth.db</div></div>
      <div class="kv"><div class="kv-k">访问范围</div><div>仅本机 127.0.0.1（无账号体系）</div></div>
      <div class="kv"><div class="kv-k">紧凑面板</div><div><code style="color:var(--cyan)">?layout=widget</code></div></div>
      <div class="field"><div class="field-v" style="font-size:12px;color:var(--ink-faint)">
        面板不显示"掌握度百分比""自律分"这类东西——它们没有可信计算依据。
        进度只用可核对事实表达：阶段序号、证据条数、成长记录条数。</div></div>
    </div>
  </div>`;
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: fd.get('timezone'), reminderChannel: fd.get('reminderChannel') }),
    });
    render();
  });
  document.getElementById('run-rollover').addEventListener('click', async () => {
    await api('/api/rollover', { method: 'POST' });
    render();
  });
}

// 初始页由 URL hash 决定（支持 ?layout=widget#goals 这类组合）
setPage(location.hash.slice(1) || 'today', { push: false });
