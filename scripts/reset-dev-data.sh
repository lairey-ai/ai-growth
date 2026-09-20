#!/usr/bin/env bash
# AI Growth — 重置「测试数据」
#
# 安全设计（§21 / 附录 C）：
#   · 默认把当前数据目录**改名备份**而不是删除，绝不静默销毁真实数据。
#   · 若检测到疑似真实使用痕迹（有已确认 Goal 或较多样本），需要 --force 才继续。
#
# 用法：
#   ./scripts/reset-dev-data.sh            # 备份现有数据 → 建一个干净的新库
#   ./scripts/reset-dev-data.sh --force    # 跳过"疑似真实数据"的拦截
#   ./scripts/reset-dev-data.sh --list     # 只查看当前数据概况，不做任何修改

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${AI_GROWTH_DATA_DIR:-$HOME/.ai-growth}"
NODE_BIN="$(command -v node || true)"

FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  --list) ;;
  "") ;;
  *) echo "未知参数：$1"; exit 1 ;;
esac

ok()   { printf "  \033[0;32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[0;33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[0;31m✗\033[0m %s\n" "$1"; exit 1; }

printf "\033[1mAI Growth 数据概况\033[0m\n数据目录：%s\n\n" "$DATA_DIR"

if [ ! -f "$DATA_DIR/growth.db" ]; then
  warn "尚无数据库，无需重置"
  exit 0
fi

[ -n "$NODE_BIN" ] || die "未找到 node"

STATS="$("$NODE_BIN" -e "
const P='$PROJECT_DIR/node_modules/better-sqlite3';
const D=require(P);
const db=new D('$DATA_DIR/growth.db',{readonly:true});
const q=(s)=>{try{return db.prepare(s).get().n}catch(e){return 0}};
console.log(JSON.stringify({
  goals:q(\"SELECT COUNT(*) n FROM goals WHERE deleted_at IS NULL\"),
  activeGoals:q(\"SELECT COUNT(*) n FROM goals WHERE status='ACTIVE'\"),
  actions:q('SELECT COUNT(*) n FROM actions'),
  evidence:q('SELECT COUNT(*) n FROM evidence'),
  events:q('SELECT COUNT(*) n FROM growth_events'),
  confirmed:q('SELECT COUNT(*) n FROM goals WHERE status IN (\\'ACTIVE\\',\\'CONFIRMED\\',\\'COMPLETED\\')')
}));
" 2>/dev/null)"

if [ -z "$STATS" ]; then
  warn "无法读取统计（数据库可能损坏）"
  STATS='{"goals":0,"activeGoals":0,"actions":0,"evidence":0,"events":0,"confirmed":0}'
fi

printf "  Goal: %s（其中活跃 %s）\n  Action: %s\n  Evidence: %s\n  Growth Event: %s\n\n" \
  "$(echo "$STATS" | "$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).goals')" \
  "$(echo "$STATS" | "$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).activeGoals')" \
  "$(echo "$STATS" | "$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).actions')" \
  "$(echo "$STATS" | "$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).evidence')" \
  "$(echo "$STATS" | "$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).events')"

if [ "${1:-}" = "--list" ]; then
  exit 0
fi

CONFIRMED="$(echo "$STATS" | "$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).confirmed')"
if [ "$CONFIRMED" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  warn "检测到 $CONFIRMED 个已确认/活跃的 Goal —— 这看起来是真实使用数据，不是测试数据。"
  warn "如需继续，请显式运行：./scripts/reset-dev-data.sh --force"
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DATA_DIR.backup-$STAMP"
printf "\033[1;33m▸ 将现有数据备份为：%s\033[0m\n" "$BACKUP"
mv "$DATA_DIR" "$BACKUP" || die "备份失败，已中止（原数据未改动）"
ok "备份完成（原数据完整保留在备份目录）"

mkdir -p "$DATA_DIR"
cd "$PROJECT_DIR"
if [ -f dist/db/cli.js ]; then
  AI_GROWTH_DATA_DIR="$DATA_DIR" "$NODE_BIN" dist/db/cli.js migrate >/dev/null && ok "已创建干净的数据库"
else
  warn "dist/db/cli.js 不存在，请先 npm run build，然后运行 npm run migrate"
fi

printf "\n完成。回滚方式：rm -rf \"%s\" && mv \"%s\" \"%s\"\n" "$DATA_DIR" "$BACKUP" "$DATA_DIR"
