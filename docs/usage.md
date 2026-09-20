# 安装与使用

> 本文是 README 里"细节部分"的完整版（安装、接入、面板、设备、数据、卸载、排查）。
> 想快速上手，看 [README](../README.md) 的「3 分钟开始」。

## 安装

**设计原则：开发与生产是同一条全局命令，数据始终在 `~/.ai-growth`。**
CLI / MCP / daemon / 面板都指向「全局安装的那一份」，所以**更新 = 替换全局包**，数据不受影响。

```bash
cd "该项目目录"
./scripts/install.sh              # 默认开发态：npm link（全局 ai-growth → 当前源码）
./scripts/install.sh --global     # 生产态：npm pack + npm install -g（与源码检出解耦）
```

安装脚本 9 步：环境检查 → 依赖 → 构建 → **全局安装** → 数据库迁移
→ launchd 常驻服务（指向全局 CLI）→ MCP 配置 → Agent 入口说明 → doctor。

### 更新

| 形态 | 怎么更新 |
|---|---|
| 开发态（`npm link`） | `git pull && npm install && npm run build` → 全局命令自动生效，无需重新 link |
| 生产态（`npm i -g`） | `npm install -g ai-growth@latest && ai-growth migrate` |
| 让 daemon 加载新代码 | `launchctl kickstart -k gui/$(id -u)/com.lairey.ai-growth.daemon` |

**数据不受更新影响**：`~/.ai-growth/growth.db` 与代码包完全分离，schema 变更走 migration（幂等、增量）。

随时用 `ai-growth where` 查看当前是哪一种形态、代码在哪、数据在哪、该怎么更新。

---

## 接入 Agent

两步：**Skill** + **MCP**。

**MCP**（给出 `node` 与项目绝对路径）：

```json
{
  "mcpServers": {
    "ai-growth": {
      "command": "/path/to/node",
      "args": ["/absolute/path/to/dist/mcp/server.js"],
      "env": { "AI_GROWTH_DATA_DIR": "/Users/you/.ai-growth" }
    }
  }
}
```

**Skill**：把仓库根目录的 `SKILL.md` 交给 Agent。WorkBuddy 用户级安装：

```bash
mkdir -p ~/.workbuddy/skills/ai-growth && cp SKILL.md ~/.workbuddy/skills/ai-growth/
```

接好后对 Agent 说一句 **「开启今日任务」**（同义：「今天要做什么」「开工」）——它会调用 `growth_status`，按状态决定下一步；首次使用会主动开始访谈，而不是直接派任务。

---

## 启动

| 服务 | 命令 | 说明 |
|---|---|---|
| 常驻 Daemon | 安装后由 launchd 托管（`ai-growth serve` 手动前台） | **同时提供调度（rollover + 提醒 + 同步重试）与面板 API** |
| MCP Server（stdio，由 Agent 拉起） | `ai-growth` MCP 配置指向全局安装 | 平时无需手动运行 |
| 面板 | http://127.0.0.1:4580（daemon 自带） | 单独跑用 `npm run api` |
| 健康检查 | `ai-growth doctor` 或 `bash scripts/doctor.sh` | 逐项验证环境（含构建新鲜度） |
| 数据库迁移 | `ai-growth migrate` | 幂等，可重复执行 |
| 清理构建产物 | `npm run clean` | 删除 `dist/`（`build` 已内置） |

daemon 与面板合成一个进程是刻意的：面板要能当桌面组件/桌面应用用，就必须和 daemon 同生命周期，
否则用户每次重启还得手工起面板——违反「不要求用户维护系统」。

---

## 面板（游戏面板式 HUD）

`http://127.0.0.1:4580`

深色面板风格：卡片式布局、阶段节点轨道、主任务高亮卡、事实计数条。

**🔴 面板上不会出现虚构数值。** 这是你自己定的铁律（核心原则 6 / §16.3 明确禁止六维属性、EXP、等级、
掌握度百分比、自律分）。所以面板的「游戏感」只体现在**视觉语言**上——卡片、发光描边、节点轨道、状态色——
而每一个数字都是可核对事实：

| 显示 | 来源 |
|---|---|
| `Stage 2 / 5` | Stage 序号与总数 |
| 已完成主任务 / 证据总数 / 成长记录 | 数据库计数 |
| 阶段节点轨道 | 各 Stage 的真实 status |
| 最近进展 | Growth Event（每条都挂着 Evidence） |

页面：**面板**（Progress First：当前主线 → 阶段轨道 → 今天最重要的一步 → 每日维护 → 累计事实 → 最近进展）、
**主线**（Goal 的 why/outcome/成功标准 + Stage Timeline）、**记录**（Growth Events + Evidence 流，含强度标签）、
**护照**（Passport 快照）、**设置**（时区、提醒渠道、手动跨天检查）。

支持 URL 深链：`#goals`、`#timeline`、`#settings`。

### 桌面组件 / 打包成桌面应用

面板已为桌面形态预留两件事：

1. **紧凑布局**：URL 加 `?layout=widget`（或窗口宽度 < 420px 自动切换）→ 单列、窄边距、隐藏品牌字。
   实测 360px / 430px 宽均无横向溢出。
2. **无构建步骤**：纯 HTML/CSS/JS，任何 WebView 都能直接托管。状态全来自本地 API，
   应用本身只是"视图"，daemon 照常headless 运行。

后续打包路径（按成本从低到高）：

| 方案 | 说明 | 成本 |
|---|---|---|
| 浏览器固定窗口 | Safari/Chrome 加到程序坞，加载 `http://localhost:4580/?layout=widget` | 0 |
| Übersicht 桌面组件 | 直接渲染 HTML 到桌面层，最贴近"在桌面上显示" | 低 |
| Tauri v2 | 体积小（~5MB），需 Rust；可做无边框 + 常驻置顶 | 中 |
| Electron | 无需 Rust，体积大（~150MB）；`frame:false, transparent, alwaysOnTop` | 中 |

⚠️ **打包时必须让 WebView 加载 `http://localhost:4580`，不要用 `file://` 打开 index.html**：
页面 origin 为 `null` 时浏览器会按 CORS 拦掉对本地 API 的请求。加载 localhost 时 Host 校验也正好放行。

---

## 连上 AI Passport 设备

把固件刷到设备之后，让设备连上这台电脑**只需要一条命令**（它会自己确认成功）：

```bash
ai-growth device setup --ssid "你的Wi-Fi名" --pass "Wi-Fi密码"
```

- 它会自动找到串口、写好配置、顺手开启并记住「局域网访问」，然后**等设备真的取到卡**再回报结果
- Wi-Fi 名含中文或空格也没关系（会自动改用十六进制编码：设备控制台本身只能收 ASCII）
- 设备之后每次开机都会自动连上并显示今天的卡，**不需要按任何键**
- 想先看当前状态／本机地址／令牌：`ai-growth device`
- 失败时它给出的不是错误码，而是**下一步该做什么**（连不上 Wi-Fi／够不到电脑／服务没起来）

设备上的按键：**上/下** 翻今天的卡，**确定** 完成当前这件事，**长按确定** 回到设备自带的演示菜单。
屏幕 1 分钟无操作会自动熄屏，按任意键立刻亮回。

---

## 数据位置

| 内容 | 路径 |
|---|---|
| 数据库 | `~/.ai-growth/growth.db`（WAL 模式） |
| Passport 输出 | `~/.ai-growth/passport.json` |
| Daemon 日志 | `~/.ai-growth/daemon.log`、`daemon-stderr.log` |
| 配置 | 项目根 `.env`（参考 `.env.example`）或 `~/.ai-growth/config.env` |
| launchd plist | `~/Library/LaunchAgents/com.lairey.ai-growth.daemon.plist` |

备份 = 复制 `~/.ai-growth/growth.db`。所有数据默认只在本机；外部同步必须显式配置 Adapter。

---

## 卸载 / 重置

```bash
./scripts/uninstall.sh           # 停止并移除 launchd 服务，数据保留
./scripts/uninstall.sh --purge    # 额外删除数据目录（需输入 yes 二次确认）

./scripts/reset-dev-data.sh --list    # 只看数据概况，不做任何修改
./scripts/reset-dev-data.sh           # 备份现有数据 → 建一个干净新库
./scripts/reset-dev-data.sh --force   # 跳过"疑似真实数据"拦截
```

`reset-dev-data.sh` 永不静默删数据：它把数据目录改名备份，并打印回滚命令。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| Agent 说连不上 MCP | `bash scripts/doctor.sh` 看 MCP 一节；确认 `dist/mcp/server.js` 存在（`npm run build`） |
| **改了代码但行为没变** | **`dist/` 陈旧**。`npm run build`（已内置 `rm -rf dist`，幂等）；`doctor.sh` 会检测 `dist ≠ src` |
| Web UI 打开是空白页 | 静态资源 MIME 必须正确（`.js` 不能用 `text/html` 返回）。若手工改过 server 需重启 `npm run api` |
| 重启后提醒不触发 | `launchctl list \| grep ai-growth`；未加载则 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lairey.ai-growth.daemon.plist` |
| daemon 反复退出 | 看 `~/.ai-growth/daemon-stderr.log` |
| 时间不对 / 日期错乱 | Web UI → Settings 设置正确 timezone（自然日判断依据，非 UTC 截断） |
| 提醒太吵 | Settings 把 Reminder Channel 设为「关闭提醒」；每个 Daily 默认最多 1 次提醒 |
| 昨日任务还挂在今天 | Web UI 打开时会自动执行 rollover；也可在 Settings 手动执行 / 让 Agent 调 `run_daily_rollover` |
| `ONBOARDING_REQUIRED` 报错 | 未完成首次访谈就调了 `plan_today`——这是结构性保护，先完成访谈 |
| `REPLAN_REQUIRED` 报错 | 有未处理的 Replan，先让 Agent 调 `replan` 再规划新主线 |
| 想确认状态机没被绕过 | `audit_log` 表记录了关键变动（含 Replan 决策）的 before/after 与原因 |
| 面板打不开 / 白屏 | 面板由 daemon 提供：`bash scripts/doctor.sh` 看「面板 API」；单跑用 `npm run api`。白屏多半是 MIME 不对，重启进程即可 |
| 打包后 API 调用失败 | WebView 必须加载 `http://localhost:4580`，不能用 `file://`（origin 为 null 会被 CORS 拦） |
