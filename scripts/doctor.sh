#!/usr/bin/env bash
# AI Growth — 健康检查（doctor）
# 逐项验证：Node / 依赖 / 构建 / 数据库 / launchd / MCP / Web UI / 数据可写 / 时区
# 退出码：0 全部通过；1 存在失败项

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${AI_GROWTH_DATA_DIR:-$HOME/.ai-growth}"
PLIST_LABEL="com.lairey.ai-growth.daemon"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
NODE_BIN="$(command -v node || true)"

PASS=0; FAIL=0; INFO=0
ok()   { printf "  \033[0;32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[0;31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
info() { printf "  \033[0;33m-\033[0m %s\n" "$1"; INFO=$((INFO+1)); }
head_() { printf "\n\033[1m%s\033[0m\n" "$1"; }

printf "\033[1mAI Growth Doctor\033[0m\n项目：%s\n数据：%s\n" "$PROJECT_DIR" "$DATA_DIR"

# 1. Node
head_ "运行环境"
if [ -n "$NODE_BIN" ]; then
  V="$("$NODE_BIN" -p 'process.versions.node')"
  MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  if [ "$MAJOR" -ge 20 ]; then ok "node v$V"; else bad "node v$V 版本过低（需要 >= 20）"; fi
else
  bad "未找到 node"
fi

# 2. 依赖
head_ "依赖"
if [ -d "$PROJECT_DIR/node_modules/better-sqlite3" ]; then ok "better-sqlite3 已安装"; else bad "better-sqlite3 缺失（运行 npm install）"; fi
if [ -d "$PROJECT_DIR/node_modules/@modelcontextprotocol/sdk" ]; then ok "MCP SDK 已安装"; else bad "MCP SDK 缺失（运行 npm install）"; fi
if [ -d "$PROJECT_DIR/node_modules/zod" ]; then ok "zod 已安装"; else bad "zod 缺失（运行 npm install）"; fi

# 3. 构建产物
head_ "构建"
for f in dist/mcp/server.js dist/daemon/main.js dist/api/server.js dist/db/cli.js dist/db/migrations/V1__init.sql dist/ui/index.html; do
  if [ -f "$PROJECT_DIR/$f" ]; then ok "$f"; else bad "$f 缺失（运行 npm run build）"; fi
done

# 3b. 构建产物是否与源码同步（曾出现 cp -R 套娃导致 dist 静默陈旧）
STALE=0
for pair in "src/db/migrations/V1__init.sql:dist/db/migrations/V1__init.sql" \
            "src/ui/index.html:dist/ui/index.html" \
            "src/ui/app.js:dist/ui/app.js" \
            "src/ui/style.css:dist/ui/style.css"; do
  S="${pair%%:*}"; D="${pair##*:}"
  if [ -f "$PROJECT_DIR/$S" ] && [ -f "$PROJECT_DIR/$D" ]; then
    cmp -s "$PROJECT_DIR/$S" "$PROJECT_DIR/$D" || { bad "构建产物陈旧：$D ≠ ${S}（运行 npm run build）"; STALE=1; }
  fi
done
[ "$STALE" -eq 0 ] && ok "dist 与 src 一致（migration / UI 均已同步）"

# 3c. 套娃目录（cp -R 到已存在目录会产生 dist/ui/ui）
NESTED="$(find "$PROJECT_DIR/dist" -maxdepth 3 -type d -name ui -o -maxdepth 3 -type d -name migrations 2>/dev/null | sed -n '2,$p' | grep -E "/(ui/ui|migrations/migrations)$" || true)"
if [ -n "$NESTED" ]; then
  bad "存在套娃目录：$(echo "$NESTED" | tr '\n' ' ')（npm run clean && npm run build）"
else
  ok "无套娃目录"
fi

# 4. 数据库
head_ "数据库"
if [ -f "$DATA_DIR/growth.db" ]; then
  ok "growth.db 存在"
  if [ -n "$NODE_BIN" ]; then
    APPLIED="$("$NODE_BIN" -e "
      const D=require('$PROJECT_DIR/node_modules/better-sqlite3');
      const db=new D('$DATA_DIR/growth.db',{readonly:true});
      try{
        const r=db.prepare('SELECT COUNT(*) n FROM _migrations').get();
        const t=db.prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type='table'\").get();
        console.log(r.n+'|'+t.n);
      }catch(e){console.log('ERR');}
    " 2>/dev/null)"
    if [ "$APPLIED" = "ERR" ]; then bad "无法读取 schema（数据库可能损坏）"; else
      M="${APPLIED%%|*}"; T="${APPLIED##*|}"
      ok "migration 已应用：$M 个；表数量：$T"
    fi
  fi
else
  bad "growth.db 不存在（运行 node dist/db/cli.js migrate）"
fi

# 5. 数据目录可写
head_ "数据目录"
if [ -d "$DATA_DIR" ]; then
  if [ -w "$DATA_DIR" ]; then ok "$DATA_DIR 可写"; else bad "$DATA_DIR 不可写"; fi
else
  bad "$DATA_DIR 不存在"
fi

# 6. 时区
head_ "时区"
if [ -n "$NODE_BIN" ]; then
  TZ_="$(AI_GROWTH_DATA_DIR="$DATA_DIR" "$NODE_BIN" -e "
    process.env.AI_GROWTH_TZ=process.env.AI_GROWTH_TZ||Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log(process.env.AI_GROWTH_TZ);
  " 2>/dev/null)"
  if [ -n "$TZ_" ]; then ok "解析为 $TZ_"; else bad "无法解析时区"; fi
fi

# 7. launchd
head_ "常驻服务（launchd）"
UID_NUM="$(id -u)"
if [ "$(uname -s)" != "Darwin" ]; then
  info "非 macOS，跳过（Linux 需改为 systemd unit）"
elif [ ! -f "$PLIST_DEST" ]; then
  bad "plist 未安装（运行 ./scripts/install.sh）"
else
  ok "plist 已安装：$PLIST_DEST"
  if ! launchctl list >/dev/null 2>&1; then
    info "当前进程无权查询 launchd（正常，非故障）——plist 会在下次登录时自动加载"
    printf "     要立刻生效，在「终端」执行：launchctl bootstrap gui/%s \"%s\"\n" "$UID_NUM" "$PLIST_DEST"
    printf "     验证是否在跑：launchctl list | grep %s\n" "$PLIST_LABEL"
  elif launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    LINE="$(launchctl list | grep "$PLIST_LABEL" | head -1)"
    PID="$(echo "$LINE" | awk '{print $1}')"
    if [ "$PID" = "-" ]; then
      bad "daemon 未在运行（已加载但进程退出，查看 $DATA_DIR/daemon-stderr.log）"
    else
      ok "daemon 运行中（pid ${PID}）"
    fi
  else
    info "服务尚未加载——下次登录会自动加载；想立刻生效在「终端」执行："
    printf "     launchctl bootstrap gui/%s \"%s\"\n" "$UID_NUM" "$PLIST_DEST"
  fi
fi

# 8. MCP server 可启动
head_ "MCP Server"
if [ -f "$PROJECT_DIR/dist/mcp/server.js" ] && [ -n "$NODE_BIN" ]; then
  TMP_OUT="$(mktemp -t aigrowth-mcp)"
  # stdio MCP server 在 stdin EOF 时会正常退出，故用 sleep 管道保持 stdin 打开。
  # 注意：直接在主 shell 取 $!，不要用子 shell + PID 文件（存在竞态）。
  { sleep 5; } | AI_GROWTH_DATA_DIR="$DATA_DIR" "$NODE_BIN" "$PROJECT_DIR/dist/mcp/server.js" >"$TMP_OUT" 2>&1 &
  MCP_PID=$!
  sleep 3

  ALIVE=0
  kill -0 "$MCP_PID" 2>/dev/null && ALIVE=1

  if grep -q "MCP server ready" "$TMP_OUT" 2>/dev/null; then
    ok "启动成功：DB 打开 + migration + tools 注册完成"
    if [ "$ALIVE" -eq 1 ]; then ok "进程保持运行（pid ${MCP_PID}）"; fi
  elif [ "$ALIVE" -eq 1 ]; then
    ok "进程运行中（pid ${MCP_PID}），未捕获就绪日志"
  else
    bad "MCP server 启动失败：$(head -3 "$TMP_OUT" 2>/dev/null | tr '\n' ' ')"
  fi

  kill "$MCP_PID" 2>/dev/null || true
  pkill -P "$MCP_PID" 2>/dev/null || true
  rm -f "$TMP_OUT"
else
  bad "dist/mcp/server.js 缺失"
fi

# 9. 面板 API / Web UI
head_ "面板 API"
PORT="${AI_GROWTH_API_PORT:-4580}"
# 用 node 直连 127.0.0.1，不要用 curl：受限环境的 HTTP 代理会把本地请求变成 502，误判为"未运行"
PANEL_OK=0
if [ -n "$NODE_BIN" ]; then
  PANEL_OUT="$(AI_GROWTH_PROBE_PORT="$PORT" "$NODE_BIN" -e "
    const http=require('http');
    const req=http.get({host:'127.0.0.1',port:process.env.AI_GROWTH_PROBE_PORT,path:'/api/health',timeout:2500},res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{console.log(res.statusCode+'|'+d.replace(/\s+/g,''));process.exit(0)});
    });
    req.on('timeout',()=>{console.log('TIMEOUT');process.exit(0)});
    req.on('error',e=>{console.log('ERR:'+e.code);process.exit(0)});
  " 2>/dev/null)"
  case "$PANEL_OUT" in
    200*) PANEL_OK=1 ;;
  esac
fi
if [ "$PANEL_OK" -eq 1 ]; then
  ok "面板可访问：http://127.0.0.1:${PORT}（由 daemon 或 npm run api 提供）"
else
  info "面板未运行（daemon 会自带面板；或手动：npm run api）"
fi

# 汇总
printf "\n\033[1m结果：%d 项通过，%d 项失败" "$PASS" "$FAIL"
[ "$INFO" -gt 0 ] && printf "，%d 项提示" "$INFO"
printf "\033[0m\n"
if [ "$FAIL" -gt 0 ]; then
  printf "\033[0;31m存在失败项，请按上方提示修复。\033[0m\n"
  exit 1
fi
printf "\033[0;32m核心检查全部通过。\033[0m\n"
