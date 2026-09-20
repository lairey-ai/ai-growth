# 开发与贡献

> 架构约定、当前限制、提交规范。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # 118 个测试（unit + integration + e2e + dist 运行时冒烟）
npm run build       # 幂等：先 rm -rf dist 再编译并拷贝资源
```

> **`npm test` 里有一层「运行时冒烟」**：它直接启动编译后的 `dist/mcp/server.js` 并按 MCP 协议调用工具。
> 这层测试专门覆盖"只有打包后才暴露"的问题（资源拷贝路径、migration 陈旧、MIME 等）——
> 源码测试全绿但产物是坏的，就是靠它发现的。同时也校验 `dist` 与 `src` 逐字节一致。

工程结构：

```
src/
├── core/        # 领域层：状态机、Goal/Stage/Action、Rollover、Replan、Evidence、Memory、Metrics
├── db/          # SQLite 连接 + 版本化 migration
├── mcp/         # MCP Server + 63 个 tools（统一 ToolResult 契约）
├── planner/     # 规划上下文与约束（LLM 判断交给 Agent，Core 只保证规则）
├── reminder/    # 提醒生命周期 + Scheduler + 通知 Adapter
├── passport/    # Passport 构建 + Sync Adapter（local-json / 可替换）
├── api/         # 供 Web UI 使用的 HTTP API
├── ui/          # Today / Goals / Timeline / Passport / Settings
├── daemon/      # 常驻进程入口
└── shared/      # 配置、时间（timezone 感知）、统一结果类型
```

### 架构约定

- **状态机是唯一权威**（`src/core/stateMachine.ts`）。非法转换抛 `INVALID_STATE`，不静默通过。
  - `IN_PROGRESS` 是**可选**中间态：`PLANNED → COMPLETED` 合法（用户说"做完了"不该被要求先点"开始"）。
  - 任何未终结的 DAILY 都能跨天 `EXPIRED`（含 `IN_PROGRESS` / `DELAYED`），否则 rollover 会崩。
- **Core 强制业务规则，MCP 层不重复声明**：zod schema 只做类型校验，`0~2 个 Daily`、`Goal 必须含 why` 这类规则由 Core 抛出带错误码的 `ToolResult`，保证返回结构统一。
- **结构性优先于文档约定**：`ONBOARDING_REQUIRED`（未访谈不得生成任务）、`REPLAN_REQUIRED`（先解决 Replan 再开新主线）都由 Core 强制，不依赖 Agent"记得遵守"。
- **时间**：DB 存 ISO timestamp；「哪一天」一律按配置时区计算（`src/shared/time.ts`），绝不按 UTC 截断。
- **幂等**：rollover（日期级 + action 级）、reminder 取消、sync job 创建、daemon 重启均可重复执行。
- **排序必须带稳定 tiebreaker**：SQLite 用 `updated_at DESC, rowid DESC`；`created_at` 同毫秒撞车时不可作为唯一排序键。
- **审计**：关键变动（含 Replan 决策本身）写入 `audit_log`（谁触发 / before / after / 原因 / 时间）。

---

## 当前限制

- V1 不含：六维属性 / EXP / 等级、RPG 装备、Knowledge Graph UI、课程平台、社交排名、云端账号、多人协作（均为预留接口，不阻塞上线）。
- Passport 外部同步：仅实现 `local-json` Adapter；接真实外部 API 时实现 `PassportSyncAdapter` 接口即可，失败会进重试队列且不影响本地状态。
- 通知渠道：已实现 macOS 本地通知（osascript）与 `null` 两种 Adapter。
- 提醒精确定时依赖 daemon 轮询（默认 30s 粒度），非秒级精确。
- 面板**没有账号体系也刻意不做**（本机进程 + Agent 工具，loopback 即边界）。如需局域网访问请自行加代理与鉴权。
- 桌面应用打包尚未实施：面板已就绪（紧凑布局 + 无构建步骤），打包属独立交付项。

详见 `DELIVERY_REPORT.md` 与 `IMPLEMENTATION_PLAN.md`。

---

---

## 参与贡献

欢迎 Issue 与 PR。这个项目有几条**不可协商**的产品铁律（见文首「核心原则」），
改动前请先确认不违背它们——尤其是这两条最容易在实现里被悄悄破坏：

- **不产生虚构数值**：任何"属性值 / 掌握度 % / 自律分 / 等级"都会被测试拦下；
- **不制造跨天债务**：`Daily Action` 次日必须 `EXPIRED`，绝不 clone 到第二天。

提交前请跑：

```bash
npm run build && npx tsc --noEmit && npm test && bash scripts/doctor.sh
```
