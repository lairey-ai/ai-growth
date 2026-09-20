#!/usr/bin/env bash
# AI Growth — 卸载
# 停止并移除 launchd 常驻服务。默认**不删除数据**。
#
# 用法：
#   ./scripts/uninstall.sh            # 仅移除服务（数据保留）
#   ./scripts/uninstall.sh --purge    # 移除服务并删除数据目录（需二次确认）

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${AI_GROWTH_DATA_DIR:-$HOME/.ai-growth}"
PLIST_LABEL="com.lairey.ai-growth.daemon"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

ok()   { printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[0;33m!\033[0m %s\n" "$1"; }

printf "\033[1mAI Growth 卸载\033[0m\n"

# 停止并移除 launchd 服务
if [ -f "$PLIST_DEST" ]; then
  launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
  rm -f "$PLIST_DEST"
  ok "已停止并移除 launchd 服务：$PLIST_LABEL"
else
  warn "launchd 服务未安装，跳过"
fi

# 兜底：结束残留进程
if pgrep -f "dist/daemon/main.js" >/dev/null 2>&1; then
  pkill -f "dist/daemon/main.js" || true
  ok "已结束残留 daemon 进程"
fi

# 数据
if [ "$PURGE" -eq 1 ]; then
  printf "\n\033[1;31m⚠️  此操作非常危险，可能导致不可逆的数据丢失！\033[0m\n"
  printf "将删除整个数据目录：%s\n" "$DATA_DIR"
  if [ -f "$DATA_DIR/growth.db" ]; then
    CNT="$(command -v node >/dev/null 2>&1 && node -e "
      const D=require('$PROJECT_DIR/node_modules/better-sqlite3');
      try{const db=new D('$DATA_DIR/growth.db',{readonly:true});
      console.log(db.prepare('SELECT COUNT(*) n FROM actions').get().n);}catch(e){console.log('?')}
    " 2>/dev/null || echo '?')"
    printf "其中包含 %s 条 action 记录。\n" "$CNT"
  fi
  printf "确认删除请输入 yes（其他任何输入都会取消）："
  read -r ANSWER
  if [ "$ANSWER" = "yes" ]; then
    rm -rf "$DATA_DIR"
    ok "已删除 $DATA_DIR"
  else
    warn "已取消删除，数据保留在 $DATA_DIR"
  fi
else
  warn "数据保留在：${DATA_DIR}（如需删除请显式运行 ./scripts/uninstall.sh --purge）"
fi

printf "\n卸载完成。项目源码仍在：%s\n" "$PROJECT_DIR"
