#!/usr/bin/env bash
# AI Growth — 一键安装（macOS）
#
# 核心原则：**开发与生产用同一条全局命令，数据始终在 ~/.ai-growth**。
# CLI / MCP / daemon / 面板 都指向"全局安装的那一份"代码，所以更新 = 替换全局包。
#
# 完成：环境检查 → 依赖 → 构建 → 全局安装 → 数据库迁移
#      → launchd 常驻服务（指向全局 CLI）→ MCP 配置 → Agent 入口说明 → doctor
#
# 用法：
#   ./scripts/install.sh              # 默认：npm link（开发态）+ 安装 Skill
#   ./scripts/install.sh --global     # 生产态：npm pack + npm install -g（实体包，与检出解耦）
#   ./scripts/install.sh --with-mcp   # 额外把 MCP 写入 ~/.workbuddy/mcp.json（会先备份）
#   ./scripts/install.sh --no-skill   # 不安装 Skill 到 ~/.workbuddy/skills/
#   ./scripts/install.sh --no-daemon  # 不安装 launchd 常驻服务
#   ./scripts/install.sh --device-lan # 常驻服务以局域网模式跑（AI Passport 设备要从 Wi-Fi 访问）

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${AI_GROWTH_DATA_DIR:-$HOME/.ai-growth}"
PLIST_LABEL="com.lairey.ai-growth.daemon"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
NODE_BIN="$(command -v node || true)"
NPM_GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null || true)"
GLOBAL_BIN="$NPM_GLOBAL_PREFIX/bin"
GLOBAL_CLI="$NPM_GLOBAL_PREFIX/lib/node_modules/ai-growth/dist/cli/main.js"

MODE="link"          # link | global
WITH_MCP=0
WITH_SKILL=1
WITH_DAEMON=1
DEVICE_LAN=0         # 1 = daemon 以局域网模式常驻（AI Passport 设备需要）
for arg in "$@"; do
  case "$arg" in
    --global) MODE="global" ;;
    --link) MODE="link" ;;
    --with-mcp) WITH_MCP=1 ;;
    --no-skill) WITH_SKILL=0 ;;
    --no-daemon) WITH_DAEMON=0 ;;
    --device-lan) DEVICE_LAN=1 ;;
    --no-device-lan) DEVICE_LAN=0 ;;
    *) echo "未知参数：$arg"; exit 1 ;;
  esac
done

step() { printf "\n\033[1;34m▶ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[0;33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[0;31m✗\033[0m %s\n" "$1"; exit 1; }

# ---------------------------------------------------------------- 1. 依赖检查
step "1/9 检查运行环境"
[ -n "$NODE_BIN" ] || die "未找到 node，请先安装 Node.js >= 20（https://nodejs.org）"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $("$NODE_BIN" -v)），需要 >= 20"
ok "node $("$NODE_BIN" -v) @ $NODE_BIN"
command -v npm >/dev/null || die "未找到 npm"
ok "npm $(npm -v)"
[ -n "$NPM_GLOBAL_PREFIX" ] || die "无法确定 npm 全局前缀（npm prefix -g 失败）"
ok "npm 全局前缀：$NPM_GLOBAL_PREFIX"
case ":$PATH:" in
  *":$GLOBAL_BIN:"*) ok "全局 bin 已在 PATH 中（终端里可直接用 ai-growth）" ;;
  *) warn "全局 bin 不在当前 PATH：$GLOBAL_BIN"
     warn "请在 ~/.zshrc 加：export PATH=\"$GLOBAL_BIN:\$PATH\"（你的交互式 shell 可能已配好）" ;;
esac
if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "当前非 macOS：daemon 自启动将跳过（launchd 仅限 macOS）"
  WITH_DAEMON=0
fi

# ---------------------------------------------------------------- 2. 安装依赖
step "2/9 安装依赖"
cd "$PROJECT_DIR"
need_install=0
[ -d node_modules ] || need_install=1
# 关键依赖缺失也要补装（避免"目录在但内容不全"的假象）
for dep in better-sqlite3 @modelcontextprotocol/sdk zod typescript; do
  [ -e "node_modules/$dep" ] || need_install=1
done

if [ "$need_install" -eq 0 ]; then
  ok "依赖已就绪（node_modules 完整）"
else
  # npm 偶发 "Tracker idealTree already exists"（并发/缓存态），重试一次即可
  if npm install --no-audit --no-fund; then
    ok "依赖安装完成"
  else
    warn "npm install 首次失败，清理状态后重试…"
    rm -rf node_modules/.package-lock.json
    if npm install --no-audit --no-fund; then
      ok "依赖安装完成（重试成功）"
    else
      die "依赖安装失败。请手动排查：cd \"$PROJECT_DIR\" && npm install"
    fi
  fi
fi
# 装完再确认一次，不允许带着残缺依赖继续
for dep in better-sqlite3 @modelcontextprotocol/sdk zod; do
  [ -e "node_modules/$dep" ] || die "依赖缺失：${dep}（请手动运行 npm install）"
done

# ---------------------------------------------------------------- 3. 构建
step "3/9 构建 TypeScript"
npm run build >/dev/null
ok "构建产物：dist/"

# ---------------------------------------------------------------- 3.5 全局安装
step "4/9 全局安装（CLI / MCP / daemon 都指向这一份）"
if [ "$MODE" = "global" ]; then
  TGZ="$(npm pack --silent | tail -1)"
  [ -f "$PROJECT_DIR/$TGZ" ] || die "npm pack 失败"
  npm install -g "$PROJECT_DIR/$TGZ" >/dev/null 2>&1 || die "npm install -g 失败"
  rm -f "$PROJECT_DIR/$TGZ"
  ok "生产态：已全局安装实体包（与源码检出解耦）"
else
  npm link >/dev/null 2>&1 || die "npm link 失败"
  ok "开发态：全局命令已软链到本检出（npm link）"
fi
# 用全局 CLI 自我确认（这也是 daemon / MCP 将要使用的那一份）
if [ -x "$GLOBAL_CLI" ] || [ -f "$GLOBAL_CLI" ]; then
  V="$("$NODE_BIN" "$GLOBAL_CLI" version --json 2>/dev/null | "$NODE_BIN" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.parse(s).data.version)}catch{console.log('?')}})" 2>/dev/null || echo '?')"
  ok "全局入口可用：${GLOBAL_CLI}（版本 ${V}）"
else
  warn "全局入口未就位：$GLOBAL_CLI"
fi

# ---------------------------------------------------------------- 5. 数据目录 + 迁移
step "5/9 初始化数据库（数据始终在 ${DATA_DIR}，与代码解耦）"
mkdir -p "$DATA_DIR"
AI_GROWTH_DATA_DIR="$DATA_DIR" "$NODE_BIN" "$GLOBAL_CLI" migrate 2>/dev/null \
  || AI_GROWTH_DATA_DIR="$DATA_DIR" "$NODE_BIN" dist/db/cli.js migrate

# ---------------------------------------------------------------- 6. launchd
step "6/9 安装常驻服务（launchd → 指向全局 CLI）"
if [ "$WITH_DAEMON" -eq 1 ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  TMP_PLIST="$(mktemp)"
  sed -e "s|__NODE_BIN__|${NODE_BIN}|g" \
      -e "s|__AI_GROWTH_CLI__|${GLOBAL_CLI}|g" \
      -e "s|__DATA_DIR__|${DATA_DIR}|g" \
      -e "s|__AI_GROWTH_DEVICE_LAN__|${DEVICE_LAN}|g" \
      "$PROJECT_DIR/launchd/${PLIST_LABEL}.plist" > "$TMP_PLIST"
  cp "$TMP_PLIST" "$PLIST_DEST"
  rm -f "$TMP_PLIST"
  ok "plist 已写入：$PLIST_DEST"
  ok "它调用的是全局 CLI：$GLOBAL_CLI serve（更新全局包即更新 daemon）"
  if [ "$DEVICE_LAN" -eq 1 ]; then
    ok "已开启设备局域网访问（AI_GROWTH_DEVICE_LAN=1）：AI Passport 可从 Wi-Fi 访问；令牌用 ai-growth device 查看"
  else
    warn "未开启设备局域网访问：AI Passport 设备连不上（需要时重跑 ./scripts/install.sh --device-lan）"
  fi

  # 先卸载可能存在的旧实例，保证幂等。
  # 注意：bootout 是异步的，紧接着 bootstrap 会偶发失败（服务尚未完全拆除），
  # 因此必须 sleep + 重试 —— 否则重装会把本来在跑的服务搞停。
  UID_NUM="$(id -u)"
  launchctl bootout "gui/$UID_NUM/$PLIST_LABEL" >/dev/null 2>&1 || true
  launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
  sleep 1

  LOADED=0
  for attempt in 1 2 3; do
    # 现代方式（macOS 11+）
    if launchctl bootstrap "gui/$UID_NUM" "$PLIST_DEST" >/dev/null 2>&1; then LOADED=1; break; fi
    # 旧版回退
    if launchctl load "$PLIST_DEST" >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then LOADED=1; break; fi
    sleep 2
  done

  # bootstrap 返回成功不等于进程活着 —— 直接看它在不在跑
  if [ "$LOADED" -eq 1 ]; then
    sleep 2
    if pgrep -f "ai-growth/dist/cli/main.js serve" >/dev/null 2>&1; then
      ok "daemon 已加载并运行（开机自动恢复）"
    else
      LOADED=0
    fi
  fi

  if [ "$LOADED" -eq 0 ]; then
    warn "launchd 未能启动服务（plist 已正确就位，不影响后续开机自启）。"
    printf "  \033[0;33m?\033[0m 三种方式任选：\n"
    printf "     · 重启电脑：~/Library/LaunchAgents/ 里的服务会在登录时自动加载\n"
    printf "     · 立刻生效（在「终端」执行）：\n\n"
    printf "         launchctl bootout gui/%s/%s 2>/dev/null; launchctl bootstrap gui/%s \"%s\"\n\n" "$UID_NUM" "$PLIST_LABEL" "$UID_NUM" "$PLIST_DEST"
    printf "     · 或先不管它 —— 手动前台跑：ai-growth serve\n\n"
    printf "  \033[0;33m?\033[0m 未跑 daemon 不影响核心闭环：Agent 每次进入会调用跨天检查，\n"
    printf "     跨天状态依旧正确；只有「定时提醒」需要它常驻。\n"
  fi
else
  warn "已跳过 daemon 安装。手动启动：ai-growth serve"
fi

# ---------------------------------------------------------------- 7. MCP 配置
step "7/9 MCP 配置（指向全局安装，不指向开发目录）"
SNIPPET="$PROJECT_DIR/mcp-config.snippet.json"
MCP_SERVER_JS="$NPM_GLOBAL_PREFIX/lib/node_modules/ai-growth/dist/mcp/server.js"
cat > "$SNIPPET" <<JSON
{
  "mcpServers": {
    "ai-growth": {
      "command": "${NODE_BIN}",
      "args": ["${MCP_SERVER_JS}"],
      "env": { "AI_GROWTH_DATA_DIR": "${DATA_DIR}" }
    }
  }
}
JSON
ok "片段已写入：$SNIPPET"
ok "MCP 入口：$MCP_SERVER_JS"

if [ "$WITH_MCP" -eq 1 ]; then
  MCP_JSON="$HOME/.workbuddy/mcp.json"
  mkdir -p "$(dirname "$MCP_JSON")"
  if [ -f "$MCP_JSON" ]; then
    cp "$MCP_JSON" "${MCP_JSON}.bak.$(date +%Y%m%d%H%M%S)"
    ok "已备份原配置"
  else
    echo '{"mcpServers":{}}' > "$MCP_JSON"
  fi
  "$NODE_BIN" - "$MCP_JSON" "$NODE_BIN" "$MCP_SERVER_JS" "$DATA_DIR" <<'NODE'
const [file, nodeBin, serverJs, dataDir] = process.argv.slice(2);
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers['ai-growth'] = {
  command: nodeBin,
  args: [serverJs],
  env: { AI_GROWTH_DATA_DIR: dataDir },
};
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log('  \x1b[0;32m✓\x1b[0m 已合并进 ' + file);
NODE
  warn "新 MCP 不会自动激活：请在连接器管理页右上角「自定义连接器」中对该服务点击「信任」"
else
  warn "未自动写入 Agent 配置（安全默认）。两种方式二选一："
  echo "     a) 重跑：./scripts/install.sh --with-mcp"
  echo "     b) 手动把 $SNIPPET 的内容合并进 ~/.workbuddy/mcp.json"
fi

# ---------------------------------------------------------------- 8. Agent 入口
step "8/9 Agent 入口与 Skill"
echo "   仓库根目录有三个 agent 可识别文件："
echo "     $PROJECT_DIR/AGENTS.md      ← Agent 入口（安装/接入/能力/铁律）"
echo "     $PROJECT_DIR/llms.txt       ← 精简机器可读索引"
echo "     $PROJECT_DIR/server.json    ← MCP Registry 清单"
echo ""

# Skill 决定 Agent「什么时候」用这套系统。不装的话，Agent 不知道何时该走 AI Growth。
SKILL_DEST="$HOME/.workbuddy/skills/ai-growth"
if [ "$WITH_SKILL" -eq 1 ]; then
  mkdir -p "$SKILL_DEST"
  cp "$PROJECT_DIR/SKILL.md" "$SKILL_DEST/SKILL.md"
  # frontmatter 的 name+description 是 always-in-context 的元数据，Agent 靠它路由
  if head -1 "$SKILL_DEST/SKILL.md" | grep -q '^---$'; then
    ok "Skill 已安装：$SKILL_DEST/SKILL.md（含 frontmatter，可被 Agent 识别触发时机）"
  else
    warn "Skill 已复制，但缺少 frontmatter（name/description），Agent 可能不会自动触发"
  fi
  echo "     移除：rm -rf \"$SKILL_DEST\""
else
  warn "已跳过 Skill 安装（--no-skill）。手动安装："
  echo "     mkdir -p \"$SKILL_DEST\" && cp \"$PROJECT_DIR/SKILL.md\" \"$SKILL_DEST/\""
fi
echo ""
if [ -x "$GLOBAL_BIN/ai-growth" ] || [ -f "$GLOBAL_BIN/ai-growth" ]; then
  ok "全局命令就绪：ai-growth（在终端里可直接用）"
  echo "     自检：ai-growth where       # 当前跑的是哪一份、怎么更新"
  echo "     Agent 自举：ai-growth agent-info --json"
else
  warn "全局命令未就绪，检查 $GLOBAL_BIN 是否在 PATH"
fi

# ---------------------------------------------------------------- 9. doctor
step "9/9 运行 doctor 验证"
bash "$PROJECT_DIR/scripts/doctor.sh" || warn "doctor 报告了问题，请查看上方输出"

printf "\n\033[1;32m安装完成。\033[0m\n"
printf "  代码位置：%s（%s）\n" "$GLOBAL_CLI" "$([ "$MODE" = global ] && echo '生产态：实体包' || echo '开发态：npm link 到本检出')"
printf "  数据位置：%s（更新代码不会动它）\n" "$DATA_DIR"
printf "\n  更新方式：\n"
if [ "$MODE" = global ]; then
  printf "    npm install -g ai-growth@latest && ai-growth migrate\n"
else
  printf "    git pull && npm install && npm run build    # 全局命令自动指向新代码\n"
fi
printf "    launchctl kickstart -k gui/$(id -u)/%s   # 让 daemon 加载新代码\n" "$PLIST_LABEL"
printf "\n  下一步：打开你的 Agent，让它加载 SKILL.md 并连接 ai-growth MCP，\n"

printf "          然后说一句「开启今日任务」——首次会主动开始访谈。\n\n"
