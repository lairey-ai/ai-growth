# AGENTS.md

> 给 AI Agent 的入口文件。人类请看 [README.md](./README.md)。
> 读到这里说明你（Agent）已经拿到这个仓库，本文件告诉你**这是什么、怎么装、怎么接、怎么用**，
> 以及**哪些规则不能违反**。

## 一句话

`ai-growth` 是一个 **Agent-native、Local-first 的个人成长执行系统**：
AI 维护计划，人保留目标与最终确认权。

它**不是** Todo List，也**不是**虚构属性值的 RPG。它的价值是把"持续维护计划"这件事从人身上拿走。

## 启动语（用户最常用的入口）

用户说下面任意一句，就应当进入本系统。**第一步永远是 `growth_status`**
（CLI 等价入口：`ai-growth start --json`，它把跨天检查 + 状态 + 今日计划合成一次调用）：

> 「开启今日任务」「今天要做什么」「开始今天的学习」「今天安排什么」「开工」「今天该干嘛」

**启动语 ≠ 立刻派任务。** 拿到 `suggestedNextOperation` 再决定：

| suggestedNextOperation | 该做什么 |
|---|---|
| `START_ONBOARDING` / `CONTINUE_ONBOARDING` | **先访谈，不生成任何任务**（核心原则 2） |
| `RESOLVE_REPLAN` | 先解决待重排主线，再谈今天 |
| `DISCUSS_GOAL` | 与用户讨论目标，不要自己编一个 |
| `RUN_DAILY_PLANNING` | 生成今日计划并请用户确认 |
| `CONFIRM_TODAY_PLAN` | 把计划给用户确认 |
| `CONTINUE_TODAY` | 帮用户推进手上任务 |

也就是说：**同一个「开启今日任务」，第一天会带你走访谈，之后才变成"今天的 1 主 + 0~2 每日"**。
不要因为用户说了"开启"就跳过访谈或跳过 Replan。

## 立刻上手（按顺序执行）

```bash
# 1. 先看它需要什么、能做什么（自描述，无需读源码）
ai-growth help --json
ai-growth agent-info --json        # 安装路径 / 数据目录 / MCP 配置 / Skill 位置 / 下一步

# 2. 一条命令拿到"现在该做什么"（跨天检查 + 状态 + 今日计划）
ai-growth start --json             # 关注 instruction 与 suggestedNextOperation

# 3. 需要完整工具集（写操作、Evidence、Replan、Reminder）时接入 MCP
ai-growth mcp-config --json
```

所有命令都支持 `--json`，输出统一为 `{ ok, data, error? }`（与 MCP 工具的返回契约一致）。
**被管道/子进程调用时默认就是 JSON**，需要人类可读输出加 `--no-json`。

## 安装

**方式 A：从 npm（推荐）**

```bash
npm install -g ai-growth
ai-growth init          # 初始化数据库 + migration（幂等）
```

**方式 B：从源码**

```bash
git clone <repo-url> && cd ai-growth
npm install
npm run build
./scripts/install.sh    # 依赖 → 构建 → 迁移 → launchd 常驻服务 → 输出 MCP 配置 → doctor
```

需要 Node.js >= 20。数据默认落在 `~/.ai-growth/`，全部本地，不外传。

## 接入 Agent（两种方式，可同时用）

### 1. MCP（完整能力，63 个工具）

```bash
ai-growth mcp-config --json     # 输出含绝对路径的配置，粘进 Agent 的 MCP 配置即可
```

配置形如：

```json
{
  "mcpServers": {
    "ai-growth": {
      "command": "/path/to/node",
      "args": ["/abs/path/to/dist/mcp/server.js"],
      "env": { "AI_GROWTH_DATA_DIR": "/Users/you/.ai-growth" }
    }
  }
}
```

> 写入配置后该服务**不会自动生效**，需要在连接器管理里对它点「信任」。
> MCP 是 stdio 传输，由 Agent 拉起，不需要手动常驻。

### 2. Skill（行为准则）

```bash
ai-growth skill                 # 直接打印 SKILL.md 全文
```

把 `SKILL.md` 交给 Agent 作为行为准则。它规定了 On load 流程、每日任务规则、何时必须征求人类确认。

### 3. CLI（不支持 MCP 时的降级路径）

| 命令 | 用途 |
|---|---|
| `ai-growth status --json` | 状态 + 建议下一步 |
| `ai-growth today --json` | 今日计划（Main Quest / Daily / 提醒） |
| `ai-growth goals --json` | 主线与阶段 |
| `ai-growth timeline --json` | 成长记录与证据 |
| `ai-growth passport --json` | AI Passport 快照 |
| `ai-growth metrics --json` | 本地规划指标（用于改进推荐，不是自律分） |
| `ai-growth rollover --json` | 跨天检查（幂等，随时可调） |
| `ai-growth complete <actionId> [--note]` | 完成任务 |
| `ai-growth skip <actionId> [--reason]` | 跳过任务 |
| `ai-growth delay <actionId> [--reason]` | 延期任务 |
| `ai-growth doctor` | 环境自检 |
| `ai-growth serve` | 前台启动常驻服务（调度 + 面板 API） |

> CLI 只能做读操作与少数几个任务操作。**建目标、写 Evidence、Replan、建提醒等要接 MCP**——
> 那些涉及确认与上下文，CLI 不做。

## 🔴 不可违反的规则

驱动本系统前必须遵守。违反这些会直接破坏产品价值：

1. **AI 管路线，人决定目的地。** 不得替人决定人生方向。
2. **首次使用必须先访谈**，不允许直接生成任务。`plan_today` 会在未完成访谈时返回
   `ONBOARDING_REQUIRED`——这是刻意的结构性保护，不要试图绕过（例如改用 `create_action`）。
3. **Daily Action 只当天有效**：次日自动 `EXPIRED`，**绝不 clone 到第二天**，不制造跨天债务。
   若今天仍合适，创建**全新 ID** 的新任务。
4. **Main Quest 未完成不作废**：进 `PENDING_REPLAN`，由 Replan 解决。连续多天没处理也不会崩，
   但要在 `RESOLVE_REPLAN` 时优先处理。
5. **默认负荷 1 个 Main Quest + 0~2 个 Daily Action**。要长期提高负荷必须先获得用户同意。
6. **不产生虚构数值**：禁止六维属性、EXP、等级、掌握度百分比、自律分。
   进度只用可核对事实（`Stage 3 / 6`、Evidence 条数、客观训练指标）。
7. **重大变更必须用户确认**：新建/放弃 Goal、改 Goal 的 why/outcome/成功标准、
   明显改 Deadline、长期加负荷、新增长期方向、把推断写成 Passport 稳定事实。
   可自主执行：调整当天执行层任务、拆分/合并、重排阶段内顺序、小幅顺延阶段（并告知）。
8. **所有状态变更经 Core Service**（MCP / CLI / 面板都走它）。**不要直接写数据库。**
9. **"哪一天"按配置时区计算**，绝不按 UTC 截断。
10. **不要为了展示功能而生成大量任务。** 宁可少而准——用户愿意做才算任务。

### 访谈（Onboarding）要问清的最小集合

当前主要目标 / 希望达到什么程度（不是"学完什么"）/ 目标周期 / 每天可投入时间 /
当前基础 / 生活约束 / 想改善的生活领域 / 任务负荷偏好。

Goal 必须包含 `why`、`desiredOutcome`、`successCriteria`，缺任一项 Core 会拒绝。

## 架构速览

```
Agent ──MCP(stdio)──┐
用户 ──CLI──────────┼──► Core Service ──► SQLite (~/.ai-growth/growth.db)
面板 ──HTTP(127.0.0.1:4580)─┘        │
                          daemon（调度：跨天检查 / 提醒 / 同步重试）
```

- **Core 是唯一权威**：状态机、规则强制、审计都在这里。MCP / CLI / 面板都只是入口。
- **时间**：DB 存 ISO timestamp，「哪一天」按配置时区算。
- **幂等**：跨天检查、提醒取消、同步任务创建、daemon 重启都可重复执行。
- **审计**：关键变动（含 Replan 决策）写入 `audit_log`，可回答"为什么这个任务被改了"。

| 路径 | 内容 |
|---|---|
| `src/core/` | 领域层：状态机、Goal/Stage/Action、Rollover、Replan、Evidence、Metrics |
| `src/mcp/` | MCP Server + 63 个工具（统一 `ToolResult` 契约） |
| `src/cli/` | 本文件所述 CLI |
| `src/daemon/` | 常驻进程：调度 + 面板 API |
| `src/ui/` | 面板（纯 HTML/CSS/JS，无构建步骤；`?layout=widget` 为桌面组件紧凑布局） |
| `START-HERE.md` | 给用户的开始指引（3 步 + 该对 Agent 说什么） |
| `SKILL.md` | Agent 行为准则（比本文件更细的运行时流程；frontmatter 的 description 决定触发时机） |
| `PRODUCT_SPEC.md` | 冻结的产品规范（V1.1 补充规范优先级最高） |
| `server.json` | MCP Registry 清单 |
| `scripts/` | install / uninstall / doctor / reset-dev-data |

## 常见错误码

| 错误码 | 含义 | 处理 |
|---|---|---|
| `ONBOARDING_REQUIRED` | 未完成访谈就尝试规划 | 先访谈 |
| `REPLAN_REQUIRED` | 有待重排主线 | 先 `replan` 再开新主线 |
| `ALREADY_EXISTS` | 今天已有计划 | 用 `get_today_plan` + `update_action`，别重复建 |
| `INVALID_STATE` | 状态机拒绝（如终态任务再转换） | 重新读状态再行动 |
| `NOT_FOUND` | 对象不存在 | 检查 id |
| `FORBIDDEN_HOST` | 面板只接受 localhost | 本系统无账号体系，仅本机访问 |

## 连接 AI Passport 设备（硬件）

**不要逐步排查。** 只有一条命令，它自带验证：

```bash
ai-growth device setup --ssid "<Wi-Fi 名>" --pass "<Wi-Fi 密码>"
```

流程：自动找串口 → 写入配置（按凭据是否纯 ASCII 自动选 `growth_set` / `growth_set_hex`）
→ 等设备重启 → **等设备真的取到卡**并给出结论。它还会顺手打开并记住"局域网访问"，
之后 `ai-growth serve` 就够了（不再需要环境变量）。

**唯一需要向用户索取的是 Wi-Fi 名与密码** —— 别试图从系统里读 SSID：
macOS 对没有定位权限的进程返回 `SSID : <redacted>`，程序读不到。

结果读法：

| `verdict` / 错误码 | 含义 | 处理 |
|---|---|---|
| `FETCHED` | 已连上并渲染出卡 | 完成 |
| `WIFI_FAIL` | Wi-Fi 名/密码不对 | 确认是 **2.4GHz**（ESP32-C3 不支持 5GHz）且密码正确，重跑 |
| `FETCH_FAIL` | Wi-Fi 通了但够不到电脑 | 确认 `ai-growth serve` 在跑、同一局域网 |
| `SERVICE_NOT_RUNNING` | 服务没起 | `ai-growth serve` |
| `LAN_JUST_ENABLED_RESTART_NEEDED` | 刚自动开启局域网，当前实例还是绑 127.0.0.1 | 重启 `ai-growth serve`（之后不用带环境变量） |
| `DEVICE_NOT_FOUND` / `MULTIPLE_DEVICES` | 没找到/找到多个串口 | 检查 USB 线与数据线；多个时用 `--port` 指定 |

两个只有踩过才知道的坑：

- **中文（或含空格）Wi-Fi 名没法用串口命令直接填。** ESP-IDF 的控制台在把输入交给命令前
  会剥掉所有非 ASCII 字节，于是 `growth_set` 只会存进一个残缺的名字，设备永远连不上。
  `device setup` 会自动改用 `growth_set_hex`（hex 编码绕过）；手工操作要用 `growth_set_hex`。
- **设备开机直接进卡页并自动取卡**，不需要用户按任何键。要回 BSP 演示菜单是长按 OK 退出。

## 验证

```bash
npm run build && npx tsc --noEmit && npx vitest run && bash scripts/doctor.sh
```

132 个测试（unit / integration / e2e / dist 运行时冒烟 / HTTP API 层）。
其中 `tests/e2e/distRuntime.test.ts` 直接跑编译产物——**测试读 `src/` 而用户跑 `dist/`，
这个盲区曾经导致"测试全绿但运行时数据库 schema 是错的"**，所以有两层验证。
