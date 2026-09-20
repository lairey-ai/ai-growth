# 给 Agent / 自动化用

> Agent 的主入口是 [AGENTS.md](../AGENTS.md)，行为准则是 [SKILL.md](../SKILL.md)，
> 精简索引是 [llms.txt](../llms.txt)。本文是自动发现与 CLI 参考。

## 给 Agent 用（自动发现）

仓库根目录有三个文件专供 Agent 扫描识别：

| 文件 | 作用 |
|---|---|
| **`AGENTS.md`** | **Agent 入口**：是什么、怎么装、怎么接、怎么用、哪些规则不能违反 |
| `llms.txt` | 精简机器可读索引 |
| `server.json` | MCP Registry 清单（官方 schema 校验通过） |

Agent 拿到仓库后，一条命令就能自举——**不需要读源码**：

```bash
npx ai-growth help --json        # 全部命令 + 产品规则 + 上手步骤
npx ai-growth agent-info --json  # 安装路径、数据目录、MCP 配置片段、Skill 位置、下一步
npx ai-growth status --json      # 当前状态 + suggestedNextOperation
```

用户自己装完之后，也可以直接对 Agent 说「用 ai-growth 帮我看看现在该做什么」，
Agent 会调 `ai-growth status --json` 拿到 `suggestedNextOperation` 并照做。

### CLI

```bash
ai-growth help [--json]          # 自描述：命令目录 + 产品铁律 + 上手步骤
ai-growth agent-info [--json]    # Agent 引导信息
ai-growth info [--json]          # 环境与运行状态
ai-growth status [--json]        # 状态 + 建议下一步
ai-growth today [--json]         # 今日计划
ai-growth goals|timeline|passport|metrics [--json]
ai-growth rollover [--json]      # 跨天检查（幂等）
ai-growth complete|skip|delay <actionId> [...]
ai-growth mcp-config [--json]    # 打印可粘贴的 MCP 配置
ai-growth skill                  # 打印 SKILL.md 全文
ai-growth doctor                 # 环境自检
ai-growth init                   # 初始化数据库
ai-growth serve                  # 前台启动常驻服务
```

**输出契约与 MCP 工具一致**：`{ ok, data, error? }`。非 TTY（被 Agent/管道调用）时**默认 JSON**，
避免 Agent 忘记加 `--json`；人类可读输出用 `--no-json`。

> CLI 只覆盖读操作与少数任务操作。建目标、写 Evidence、Replan、建提醒等要接 MCP——
> 那些涉及确认与上下文，CLI 刻意不做。
