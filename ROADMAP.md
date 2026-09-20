# 路线图与当前状态

> 给「接手这个项目的下一个人 / 下一个 Agent」看：现在到哪了、下一步做什么、有哪些坑。
> 更新于 2026-09-21。

## 现状（已完成并有验证）

| 项 | 状态 |
|---|---|
| Host app（CLI + MCP server + Web 面板 + 设备接入） | ✅ 可用；**197 个测试通过** |
| npm 发布 | ✅ [`ai-growth@1.1.1`](https://www.npmjs.com/package/ai-growth)（`npm i -g ai-growth` 实测可用） |
| AI Passport 玩法（设备端） | ✅ 已提交社区审核：projectId `566` / revisionId `1164` / **状态 `pending`（未公开）** |
| 设备真机联调 | ✅ 已实测，含「电池供电开机纯白屏」根因修复 |
| 文档结构 | ✅ README 给人看；`AGENTS.md` / `SKILL.md` / `llms.txt` 给 Agent；细节在 `docs/` |

## 下一步（按优先级）

1. **建公开仓库并推一次** — `package.json` / `server.json` / README 都已指向
   `github.com/lairey-ai/ai-growth`，但仓库尚不存在 → npm 页面上的图片与文档链接现在是空的。
2. **等玩法审核结果** → 通过后更新玩法，把使用方法的准备步骤补上
   `npm install -g ai-growth`（提交时只写了 `ai-growth serve`，没说怎么装）。
   ⚠️ 玩法当前有 pending 修订，**不得再提交新修订**，必须等结果。
3. **Windows 支持** — `ai-growth device setup` 依赖系统的 `stty` 把串口设为 raw（Node 没有 termios），
   Windows 上没有该命令：要么明确提示不支持，要么在 Node 里直接设置串口参数。
4. **离线卡文案** — 设备离线卡只说"暂时连不上电脑"，应补一句
   「在电脑上重跑 `ai-growth device setup`」；否则换过 Wi-Fi 的用户不知道该做什么。
5. **收尾清理** — `~/.npmrc` 里存着 npm 发布令牌（可随时在 npm 后台撤销）。

## 已知约束（都踩过，别再踩）

- 🔴 **Node 版本分裂**：本机 shell 是 **Node 24**，而 `better-sqlite3` 按 **Node 22** 编译
  → 用 Node 24 跑 `npm test` 或全局 `ai-growth` 会因 ABI 不匹配整片失败。
  **根治**：`brew install node@22` → 把它的 `bin` 放到 PATH 中 `/usr/local/bin` 之前 →
  `npm rebuild better-sqlite3`。**发布时必须 `npm publish --ignore-scripts`**（跳过 prepublishOnly）。
- 🔴 **升版本要改两处**：`package.json` **和** `server.json`（后者版本必须与前者一致，有测试锁定）。
- 🔴 **npm 令牌权限**：必须选 **All packages**；选 "Only select packages" 时**发不了一个还不存在的包**。
- 🔴 **`ai-growth` 不在默认 PATH 上**：全局 bin 在 `~/.npm-global/bin`，只在用户的 zshrc 里加了 PATH。
  非交互 shell（脚本、定时任务、Agent 会话）里必须显式用
  `PATH="$HOME/.npm-global/bin:/Users/fuhaojie/.workbuddy/binaries/node/versions/22.22.2-3/bin:$PATH"`，
  或直接调绝对路径 `"$HOME/.npm-global/bin/ai-growth"` —— 否则 `command not found`。
- 🔴 **常驻服务不随代码更新自动重启**：更新后用
  `launchctl kickstart -k "gui/$(id -u)/com.lairey.ai-growth.daemon"`。
  排查"服务没在跑"的完整步骤见 `docs/usage.md`。
- 🔴 **本机构建**：`npm run build` 里的 `rm -rf dist` 会被批量删除保护拦下 →
  改用 `npx tsc -p tsconfig.json` + 手动 `cp` 资源（等价；`dist` 有逐字节一致性测试兜底）。
- ⚠️ **时间处理**：`dateKey` 一律由服务端按配置时区算；客户端**不要**对 ISO 串 `slice(0,10)`（会差一天）。
- ⚠️ **产品铁律不可违背**（见 README 与 `PRODUCT_SPEC.md`）：不编数值、不制造跨天债务、
  首次使用必须先访谈。改动前先看 `AGENTS.md` 里的禁止事项。
