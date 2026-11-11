#!/usr/bin/env bash
#
# 书源阅读 · 一行安装
#
#   curl -fsSL https://raw.githubusercontent.com/zuomeizuoyang/legado-reader/main/install.sh | bash
#
# 带参数（管道执行时参数要放在 bash -s -- 后面）：
#   curl -fsSL .../install.sh | bash -s -- --port 8080 --dir ~/books
#
# 参数：
#   --dir <路径>    安装目录，默认 ~/legado-reader
#   --port <端口>   监听端口，默认 8899
#   --public        公网部署：自动生成随机访问口令
#   --key <口令>    自己指定访问口令
#   --no-start      只装好，不启动
#
# 默认不设口令（本机/局域网直接打开就能用）。公网部署务必加 --public 或 --key，
# 否则任何扫到端口的人都能把这台机器当抓取代理。
#
# 需要：Node.js 18+、curl、tar

set -euo pipefail

REPO="zuomeizuoyang/legado-reader"
BRANCH="main"
DIR="${HOME}/legado-reader"
PORT="8899"
KEY=""
PUBLIC="0"
START="1"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      DIR="$2"; shift 2 ;;
    --port)     PORT="$2"; shift 2 ;;
    --key)      KEY="$2"; shift 2 ;;
    --public)   PUBLIC="1"; shift ;;
    --no-start) START="0"; shift ;;
    -h|--help|-help)
      sed -n '2,18p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 1 ;;
  esac
done

say() { printf '  %s\n' "$*"; }
die() { printf '\n✗ %s\n\n' "$*" >&2; exit 1; }

echo
echo "  书源阅读 · 自托管安装"
echo "  ─────────────────────────────"

# --- 环境检查 -------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "没找到 node。先装 Node.js 18+：https://nodejs.org/"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 版本太低（当前 $(node -v)），需要 18 或更高。"
say "Node：$(node -v)"

command -v curl >/dev/null 2>&1 || die "没找到 curl。"
command -v tar  >/dev/null 2>&1 || die "没找到 tar。"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    die "Windows 上请改用 Docker 或直接跑 Node（见 README）。这个脚本面向 Linux / macOS。" ;;
esac

# --- 取代码 ---------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "下载源码…"
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz" \
  | tar xz -C "$TMP" \
  || die "下载失败。检查网络，或改成 git clone 方式（见 README）。"

SRC="$(find "$TMP" -maxdepth 1 -type d -name '*legado-reader*' | head -1)"
[ -n "$SRC" ] || die "压缩包结构不对，没找到源码目录。"

# 已有安装：只更新代码，绝不动数据目录
if [ -d "$DIR" ]; then
  say "目标目录已存在，保留其中的数据，只更新代码与依赖：$DIR"
  for item in server.mjs package.json package-lock.json src public data; do
    if [ -e "$SRC/$item" ]; then
      rm -rf "${DIR:?}/$item"
      cp -R "$SRC/$item" "$DIR/$item"
    fi
  done
  for item in Dockerfile docker-compose.yml README.md AGENTS.md LICENSE; do
    [ -e "$SRC/$item" ] && cp -R "$SRC/$item" "$DIR/$item"
  done
else
  mkdir -p "$(dirname "$DIR")"
  cp -R "$SRC" "$DIR"
  say "已释放到：$DIR"
fi

# --- 装依赖 ---------------------------------------------------------------
cd "$DIR"
say "安装依赖（约 10 秒）…"
npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
  || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 \
  || die "依赖安装失败。手动跑一次 npm install 看详细错误。"

# --- 口令 -----------------------------------------------------------------
# 只有公网模式才自动生成。默认留空 = 打开就能用，不会弹输入框。
if [ "$PUBLIC" = "1" ] && [ -z "$KEY" ]; then
  KEY="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 24 || true)"
  [ -n "$KEY" ] || KEY="$(node -p 'require("crypto").randomBytes(12).toString("hex")')"
fi

DATA="${LEGADO_DATA:-$DIR/runtime-data}"
mkdir -p "$DATA"

cat > "$DIR/.env.local" <<EOF
ACCESS_KEY=$KEY
PORT=$PORT
DATA_DIR=$DATA
EOF
chmod 600 "$DIR/.env.local" 2>/dev/null || true

# --- 启动 -----------------------------------------------------------------
echo
if [ "$START" = "0" ]; then
  say "已安装完成，未启动。手动启动："
  say "  cd $DIR && DATA_DIR=$DATA ACCESS_KEY=$KEY PORT=$PORT node server.mjs"
  echo
  exit 0
fi

say "启动服务…"
DATA_DIR="$DATA" ACCESS_KEY="$KEY" PORT="$PORT" \
  nohup node server.mjs > "$DIR/legado.log" 2>&1 &
echo $! > "$DIR/legado.pid"
sleep 2

if [ -n "$KEY" ]; then
  PROBE="http://127.0.0.1:${PORT}/api/state?k=${KEY}"
  QS="?k=${KEY}"
else
  PROBE="http://127.0.0.1:${PORT}/api/state"
  QS=""
fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' "$PROBE" || echo 000)"
if [ "$CODE" != "200" ]; then
  echo
  say "⚠ 服务没在 2 秒内就绪，看日志："
  say "  tail -30 $DIR/legado.log"
  echo
  exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"

echo
echo "  ✓ 起来了"
echo "  ─────────────────────────────"
say "本机：   http://127.0.0.1:${PORT}/${QS}"
say "局域网： http://${IP}:${PORT}/${QS}"
if [ -n "$KEY" ]; then
  say "口令：   ${KEY}"
else
  say "口令：   未设置 —— 打开就能用，不会弹输入框"
  say "         要对外提供访问，重装时加 --public（自动生成口令）或 --key 你的口令"
fi
say "数据：   ${DATA}"
say "日志：   ${DIR}/legado.log"
echo
say "书源要自己导入（网页底部「书源」→「导入」），本仓库不附带任何书源。"
say "停止：  kill \$(cat $DIR/legado.pid)"
echo
