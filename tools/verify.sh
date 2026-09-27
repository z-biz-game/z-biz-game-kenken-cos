#!/usr/bin/env bash
# One-shot browser verification: real headless Chrome, real DOM, real localStorage.
#
#   ./tools/verify.sh                       # every scenario, in BOTH URL shapes
#   SCENARIOS="first play" ./tools/verify.sh
#   SHAPES=prefix ./tools/verify.sh         # only the Pages-shaped run
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-kenken-cos/ ./tools/verify.sh
#
# 两种 URL 形态各跑一遍是门禁口径，不是可选步骤：
#   ① 根形态   http://127.0.0.1:5315/                        （server.cjs 把仓库当文档根）
#   ② 前缀形态 http://127.0.0.1:5315/z-biz-game-kenken-cos/  （生产 Pages 的形状）
# 只在根形态下绿过的闸不算绿：斜杠开头的说明符在根形态下恰好解得着，挂到 /<repo>/ 下面就是
# 404，而一次失败的 import 会把整段场景拦腰抛断——绿的是「根本没跑」。前缀形态这里用
# 「把一个只含本仓软链的目录端起来」的办法复现 Pages 的路径段，本仓 server.cjs 只把 '/'
# 映射到 index.html，所以它自己服务不了这个形状（那是服务器的既定行为，不改它）。
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit on
# its own. 而且软件光栅化会让画布像素假绿——本闸一半的断言读的就是像素。
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(basename "$HERE")
# 9365：DevTools 端口（server.cjs:20 那行注释钉的就是 5315/9365 这一对）。
PORT=${CDP_PORT:-9365}
# 5315：本仓在 z-biz-game 端口表里占的号；5311–5314 是兄弟仓的，撞号等于把「验收」
# 变成「看了一个陌生页面」。
HTTP=${HTTP_PORT:-5315}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

SPID=0
CPID=
# PAGESPID 而不是 PPID：bash 把 PPID 声明成只读的「本 shell 的父进程」，`PPID=$!` 直接
# 报 "readonly variable"，赋值失败、那个变量始终是**真正的父进程**——于是下面
# stop_prefix 里那句 kill 打的是门禁自己的父 shell（一次「清理前缀服务器」变成把调用方
# 杀掉，红得毫无道理，而错误行还印在「ALL GREEN」前面）。
PAGESPID=0
UDD=""
PAGES=""
stop_root() {
  [ "$SPID" != 0 ] || return 0
  kill $SPID 2>/dev/null
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 || break
    sleep 0.15
  done
  SPID=0
}
stop_prefix() {
  [ "$PAGESPID" != 0 ] || return 0
  kill $PAGESPID 2>/dev/null
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/$REPO/" >/dev/null 2>&1 || break
    sleep 0.15
  done
  PAGESPID=0
}
cleanup() {
  stop_root
  stop_prefix
  [ -n "$CPID" ] && kill -9 $CPID 2>/dev/null
  [ -n "$UDD" ] && rm -rf "$UDD"
  [ -n "$PAGES" ] && rm -rf "$PAGES"
}
trap cleanup EXIT

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=1280,1024 --no-first-run --no-default-browser-check about:blank >/tmp/kenken-chrome.log 2>&1 &
CPID=$!
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-600}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT (see /tmp/kenken-chrome.log)" >&2; exit 3; }

start_root() {
  node "$HERE/server.cjs" "$HTTP" >/tmp/kenken-server.log 2>&1 &
  SPID=$!
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
}
start_prefix() {
  # Pages 的形状：仓库挂在 /<repo>/ 下面，目录 URL 由静态服务器解析到自己的 index.html。
  PAGES=$(mktemp -d)
  ln -sfn "$HERE" "$PAGES/$REPO"
  # exec：让 $! 就是 http.server 本身。包一层 subshell 的话 kill 打死的是壳，
  # python 留在端口上继续服务下一份形态——那是「在陌生页面上验收」。
  (cd "$PAGES" && exec python3 -m http.server "$HTTP" --bind 127.0.0.1 >/tmp/kenken-pages.log 2>&1) &
  PAGESPID=$!
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/$REPO/" >/dev/null 2>&1 && break
    sleep 0.25
  done
}

FAILED=0
run_shape() {
  local name=$1 BASE=$2
  echo
  echo "################ URL 形态：$name  $BASE ################"
  # Pre-flight: prove the bytes we are about to test are 聪明格 itself, not some other
  # repo's index.html served on this port by an orphan process.
  local SERVED
  SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
  case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/kenken-server.log, /tmp/kenken-pages.log)" >&2; exit 2 ;; esac
  echo "$SERVED" | grep -q 聪明格 || { echo "port $HTTP serving a different app (正文里找不到 聪明格)"; exit 2; }

  export CDP_PORT=$PORT
  export BASE_URL=$BASE
  cd "$HERE"
  node tools/playtest.cjs open "$BASE" | head -5

  local BOOT=""
  for i in $(seq 1 60); do
    BOOT=$(node tools/playtest.cjs eval "window.kenken&&window.kenken.ready()?window.kenken.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
    case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
  done
  echo "boot: kenken $BOOT at $BASE"
  [ "$BOOT" = "nope" ] && { echo "window.kenken never appeared at $BASE" >&2; exit 4; }

  for s in ${SCENARIOS:-first engine fingerprint play ui}; do
    echo "=== [$name] $s ==="
    node tools/playtest.cjs scenario "$s" 2>/tmp/kenken-$name-$s.console.log | tail -1 | sed 's/^RESULT //' | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/kenken-$name-$s.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception as e:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-46s %s' % (r['test'], r['detail']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
" || FAILED=1
    if [ -s /tmp/kenken-$name-$s.console.log ]; then
      echo "  --- console ---"
      sed 's/^/  /' /tmp/kenken-$name-$s.console.log | tail -12
    fi
  done
  echo "################ $name 跑完：$([ $FAILED -eq 0 ] && echo '本形态全绿' || echo '本形态有红') ################"
}

if [ -n "${BASE_URL:-}" ]; then
  # 只跑调用方指定的那一种形态（CI 的 deployed 复查、手工对着已部署站点复跑都走这条路）。
  run_shape given "$BASE_URL"
else
  for shape in ${SHAPES:-root prefix}; do
    case "$shape" in
      root)
        stop_prefix
        start_root
        run_shape root "http://127.0.0.1:$HTTP/"
        stop_root
        ;;
      prefix)
        stop_root
        start_prefix
        run_shape prefix "http://127.0.0.1:$HTTP/$REPO/"
        stop_prefix
        ;;
      *) echo "unknown SHAPES entry: $shape (root / prefix)" >&2; exit 2 ;;
    esac
  done
fi

kill $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN（两种 URL 形态各自跑完） ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
