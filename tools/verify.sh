#!/usr/bin/env bash
# 一把梭的浏览器门禁：单测 → 起服 → 真 Chrome + 真指针跑七场 → 截图 → 三个 URL 形态 → 结论。
# 生命周期归这个脚本所有：它起服务器、用自己的 --user-data-dir 拉 Chrome、跑场景、把两个都收掉；
# 任何一条断言红了它就得是非零，而且要报得出**是哪一条**。
#
#   bash tools/verify.sh                        # 全跑（含阶段一七套单测，几分钟）
#   SKIP_UNIT=1 bash tools/verify.sh            # 只跑浏览器那几趟
#   SCENARIOS="boot render" bash tools/verify.sh
#   SHOTS=1 bash tools/verify.sh                # 顺手往 tools/shots/ 落 board / win 两张 PNG
#   BASE_URL=https://z-biz-game.github.io/z-biz-game-triplets-cos/ bash tools/verify.sh
#
# 场景里不放断言之外的任何东西，判据都在 tools/scenarios.js（它只认三种证据：DOM 矩形与文本、
# 画布像素、真指针读数）。这里只管生命周期，所以也不放变异表。
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit
# on its own.
set -u
# pipefail 是这条脚本自己的命门：`npm test | tail` 取的是 tail 的退出码，单测全红也会一路
# 往下跑，最后报 ALL GREEN。下面每条管道都必须让最左边那个进程的死活算数。
set -o pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
# 5278 / 9378：本仓在 z-biz-game 端口表里占的那一对（5276 是 masyu、5277 是 slither）。
# server.cjs 的 DEFAULT_PORT、package.json 的 start 脚本、tools/playtest.cjs 的默认值和这里的
# 默认值必须是同一批数——任何一处漂了，一个忘关的别人家的服务器就会被当成本仓的盘面来测，
# 然后门禁在别人家的 DOM 上变绿。
HTTP=${HTTP_PORT:-5278}
PORT=${CDP_PORT:-9378}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
REPO=z-biz-game-triplets-cos
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .
  elif command -v nc >/dev/null 2>&1; then
    nc -z -w1 127.0.0.1 "$1" 2>/dev/null
  else
    return 1
  fi
}

LOCAL=0
case "$BASE" in "http://127.0.0.1:$HTTP/"*) LOCAL=1 ;; esac
# 预检一：这两个号必须是空的。这个工作区里同时跑着好几个会话的 dev server 与 headless Chrome，
# 曾经有一次 ALL GREEN 整局跑在隔壁会话留下的那个 Chrome 上（连视口形状都不是本站的）。
# 宁可现在停下，也不要去猜那份 DOM 是谁的。
if [ "$LOCAL" = 1 ]; then
  for p in $HTTP $PORT; do
    if port_busy "$p"; then echo "port $p is already listening — refusing to guess whose DOM this is (free it or set HTTP_PORT/CDP_PORT)" >&2; exit 2; fi
  done
fi

FAILED=0
note() { printf '::%s::%s\n' "$1" "$(printf '%s' "$2" | tr -d '\r\n' | cut -c1-500)"; }
run() { # run <名字> <命令…>：一步红就把 FAILED 抬起来，并且说清红在哪一步
  local name=$1
  shift
  if "$@"; then
    echo "  ok  $name"
  else
    echo "  FAIL $name（exit $?）" >&2
    FAILED=1
    note fail "$name 这一步没过"
  fi
}

# ── 1. 纯 Node 那三条腿：语法门 → 阶段一七套 → golden 对账 ────────────────────────────
cd "$HERE"
if [ "${SKIP_UNIT:-0}" = 1 ]; then
  echo "=== unit: SKIP_UNIT=1，跳过（浏览器那几趟照样跑）==="
else
  echo "=== unit: npm run check（node --check + bash -n）==="
  run check node tools/check.mjs
  echo "=== unit: npm test（阶段一七套，不许退）==="
  UNIT_LOG=${UNIT_LOG:-/tmp/triplets-verify-npmtest.log}
  npm test >"$UNIT_LOG" 2>&1
  UEXIT=$?
  grep -E '^RESULT' "$UNIT_LOG" | sed 's/^/  /' || true
  # 读数是**加出来的**，不是抄来的：套数不足七套就当场红（少跑一套是这一族门禁最常见的腐化方式）
  if python3 -c "
import re, sys
tot = fails = suites = 0
for line in open('$UNIT_LOG'):
    m = re.match(r'RESULT (\S+) ok=(\w+) checks=(\d+) fails=(\d+)', line.strip())
    if m:
        suites += 1; tot += int(m.group(3)); fails += int(m.group(4))
print('  npm test：%d 套，合计 %d 条断言，红 %d 条' % (suites, tot, fails))
sys.exit(0 if (suites >= 7 and fails == 0 and tot > 0) else 1)
"; then
    [ $UEXIT -eq 0 ] || { echo "  FAIL npm test 退出码 $UEXIT，但 RESULT 行看起来是绿的——查日志 $UNIT_LOG" >&2; FAILED=1; }
  else
    echo "  FAIL npm test 这一趟不够七套、或有红、或读不出数（exit=$UEXIT，见 $UNIT_LOG）" >&2
    FAILED=1
    note fail "npm test 七套没过或套数不足"
  fi
  echo "=== unit: node tools/golden-test.mjs（冻结夹具的 node 侧对账，浏览器那三场的靶）==="
  GOLDEN_LOG=${GOLDEN_LOG:-/tmp/triplets-verify-golden.log}
  node tools/golden-test.mjs >"$GOLDEN_LOG" 2>&1
  GEXIT=$?
  grep -E '^RESULT' "$GOLDEN_LOG" | sed 's/^/  /' || true
  [ $GEXIT -eq 0 ] || { echo "  FAIL golden-test exit=$GEXIT（见 $GOLDEN_LOG）" >&2; FAILED=1; note fail 'golden-test 红'; }
fi

# ── 2. 起服 + 标题身份证据 ────────────────────────────────────────────────────────────
SPID=0
PSPID=0
PROOT=""
if [ "$LOCAL" = 1 ]; then
  node "$HERE/server.cjs" "$HTTP" >/tmp/triplets-server.log 2>&1 &
  SPID=$!
  disown   # 收尾时 bash 不该把「Terminated: 15」当成测试输出喷出来
  for i in $(seq 1 40); do
    curl -fsS -m 1 "http://127.0.0.1:$HTTP/" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi
# 预检二：把要测的字节证明是本仓的。js/main.js 只会说「有个 app」，同或异 和 Triplets 说的是哪一个。
SERVED=$(curl -fsS -m 3 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see /tmp/triplets-server.log)" >&2; exit 2 ;; esac
echo "$SERVED" | grep -q 同或异 || { echo "$BASE is serving a different app, not 同或异 Triplets (title 里没有「同或异」)" >&2; exit 2; }
echo "$SERVED" | grep -qi triplets || { echo "$BASE is serving a different app, not 同或异 Triplets (title 里没有 Triplets)" >&2; exit 2; }
echo "identity: $(echo "$SERVED" | grep -o '<title>[^<]*</title>' | head -1) @ $BASE"

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,980 --no-first-run --no-default-browser-check about:blank >/tmp/triplets-chrome.log 2>&1 &
CPID=$!
disown
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  [ "$PSPID" != 0 ] && kill $PSPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  # 这个临时目录是「我拉的 Chrome」的物证：跑完就删，别给下一个会话留一个还能连的 DevTools。
  [ -n "$UDD" ] && rm -rf "$UDD"
  [ -n "$PROOT" ] && rm -rf "$PROOT"
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-900}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!
disown

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT" >&2; exit 3; }
# 这条 Chrome 也必须是我自己刚拉起来的那一个：--user-data-dir 是新造的临时目录（$UDD），
# 隔壁会话的 Chrome 占的是它自己的目录。号对上、根对上、标题对上，三样才算「这是本站」。
CVER=$(curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" | tr -d '\n' | grep -o '"Browser":"[^"]*"' || true)
echo "cdp: :$PORT ${CVER:-<no browser string>} profile=$UDD"

export CDP_PORT=$PORT
export BASE_URL=$BASE
node tools/playtest.cjs open "$BASE" | head -5

BOOT=""
for i in $(seq 1 240); do
  BOOT=$(node tools/playtest.cjs eval "(()=>{const a=window.triplets;return a&&a.game?a.version:'NOAPP:'+(a?a.state:'notriplets')})()" nonav 2>&1 | tail -1 | tr -d '\n" ')
  case "$BOOT" in NOAPP*|notriplets*|ERROR*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot: triplets $BOOT at $BASE"
case "$BOOT" in NOAPP*|notriplets*|ERROR*|"") echo "window.triplets.game never appeared at $BASE" >&2; exit 4 ;; esac

# ── 3. 七场：真指针 + 画布像素 ────────────────────────────────────────────────────────
# 顺序不能换：resume-set 用真指针落八组笔并让页面存盘，resume-check 在**下一次真导航**之后
# 核对「每一笔都接上了、步数不是 0」。两场之间 playtest 每次都重新导航，所以「刷新」这一步
# 不需要假的模拟；期望值走 URL 的 #expect=，不进 localStorage、也不进 argv 解析。
EXPECT_FILE=/tmp/triplets-expect.json
parse_row() { # $1 = 场景名：把 RESULT 那行解析成「几条、哪几条红」
  python3 -c "
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    print('  NO RESULT (see /tmp/triplets-' + '$1' + '.console.log)'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception:
    print('  UNPARSED:', raw[:300]); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-58s %s' % (r['test'], r['detail']))
if 'expect' in d:
    open('$EXPECT_FILE', 'w').write(json.dumps(d['expect']))
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail', 'expect')}
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green'); sys.exit(1)
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
sys.exit(1 if d['fail'] else 0)
"
}
rm -f $EXPECT_FILE   # resume-check 只许吃**本场** resume-set 交出去的期望值，不吃上一趟留下的文件
for s in ${SCENARIOS:-boot render play sizes reproof resume-set resume-check}; do
  echo "=== $s ==="
  if [ "$s" = resume-check ] && [ ! -f $EXPECT_FILE ]; then
    echo "  FAIL resume-check 要吃的 $EXPECT_FILE 不在（resume-set 必须先跑，且它得是绿的）" >&2
    FAILED=1
    continue
  fi
  if [ "$s" = resume-check ]; then
    node tools/playtest.cjs scenario "$s" "$(cat $EXPECT_FILE)" 2>/tmp/triplets-$s.console.log | tail -1 | sed 's/^RESULT //' | parse_row "$s" || FAILED=1
  else
    node tools/playtest.cjs scenario "$s" 2>/tmp/triplets-$s.console.log | tail -1 | sed 's/^RESULT //' | parse_row "$s" || FAILED=1
  fi
  if [ -s /tmp/triplets-$s.console.log ]; then
    echo "  --- console ---"
    sed 's/^/  /' /tmp/triplets-$s.console.log | tail -12
  fi
done

# ── 4. 截图：只有引擎说 ok 才有胜利卡片，所以卡片里那句话是 verify 给的，不是文案 ──────
if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  # 整段包在 IIFE 里：Runtime.evaluate 顶层的 const 会留在这个 tab 的词法作用域里，第二次跑就
  # 变成「已经声明过」。落笔一律走界面那三个写入口（这里经 hint()，它用的就是 place/toggleNote），
  # 所以截图上是「玩家点出来的中盘」，不是测试替玩家落的尾。
  node tools/playtest.cjs eval "(async()=>{const a=window.triplets;await a.playSeed('gold-6x8-3-0','6x8');for(let i=0;i<14;i++)a.hint();return 'board'})()" nonav >/dev/null 2>&1
  sleep 1
  node tools/playtest.cjs shot tools/shots/board-$SHOTS.png >/dev/null
  node tools/playtest.cjs eval "(async()=>{const a=window.triplets;await a.playSeed('gold-6x6-3-0','6x6');for(let i=0;i<400&&!a.game.status().ok;i++)a.hint();return a.game.status().why})()" nonav >/dev/null 2>&1
  sleep 1.4
  node tools/playtest.cjs shot tools/shots/win-$SHOTS.png >/dev/null
  echo "shots: $(ls tools/shots/*-$SHOTS.png 2>/dev/null | tr '\n' ' ')"
fi

# ── 5. 另外两个 URL 形态 ─────────────────────────────────────────────────────────────
# Pages 会把部署目录挂在 /<仓库名>/ 下面，而且**只发 index.html、css/、js/**：
#   · 前缀形状：相对路径必须一格不差，写死的 "/css/game.css" 会像在线上一样 404；
#   · 部署名单形状：tools/golden.mjs（躺着每张出货盘的唯一解）根本不该被服务到。
# 换根不换端口：还是那个 5278，所以本仓的端口对仍然只在三个地方各写一次。
# ⚠ 这一趟是**本地按 pages.yml 的名单搭出来的同形状根**，不是线上站点：本轮还没有 Pages
#   （.github/workflows/pages.yml 不在这一轮的范围里），所以「线上那趟」等于没跑，报告里要照说。
if [ "$LOCAL" = 1 ]; then
  echo "=== url-shape 2/3：Pages 前缀 /$REPO/ + 只发 index.html|css|js 的部署形状 ==="
  PROOT=$(mktemp -d)
  mkdir -p "$PROOT/$REPO"
  ln -s "$HERE/index.html" "$PROOT/$REPO/index.html"
  ln -s "$HERE/css" "$PROOT/$REPO/css"
  ln -s "$HERE/js" "$PROOT/$REPO/js"
  PRE="http://127.0.0.1:$HTTP/$REPO/"
  kill $SPID 2>/dev/null
  SPID=0
  node "$HERE/server.cjs" "$HTTP" "$PROOT" >/tmp/triplets-prefix-server.log 2>&1 &
  PSPID=$!
  disown
  for i in $(seq 1 40); do
    curl -fsS -m 1 "$PRE" >/dev/null 2>&1 && break
    sleep 0.25
  done
  PRESERVED=$(curl -fsS -m 3 "$PRE" 2>/dev/null || true)
  case "$PRESERVED" in *js/main.js*) ;; *) echo "  FAIL 前缀形状下拿不到本仓 index.html：$PRE（见 /tmp/triplets-prefix-server.log）" >&2; FAILED=1 ;; esac
  # 反证：部署名单里没有 tools/，所以答案文件在线上必须够不到。本地替它兜底就等于门禁在
  # 给被测对象自己打的补丁做见证，那这条腿永远红不了。
  for miss in "$PRE"tools/golden.mjs "$PRE"tools/scenarios.js "http://127.0.0.1:$HTTP/tools/golden.mjs" "$PRE"DESIGN.md; do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$miss" 2>/dev/null)
    if [ "$CODE" = 404 ]; then
      echo "  ok  够不到 $miss（HTTP $CODE，答案与门禁脚本都不在线上产物里）"
    else
      echo "  FAIL $miss 返回 HTTP $CODE —— 部署名单漏了东西，答案或门禁被服务出去了" >&2
      FAILED=1
      note fail "部署形状下 $miss 竟然可达（$CODE）"
    fi
  done
  if [ -n "$PRESERVED" ]; then
    # open 而不是 eval：eval 默认会把 tab 导航回 BASE（根路径），那这一段就又在测一次根、
    # 前缀从来没被访问过——一个永远不会红的门禁。open 会先关掉本 origin 的旧 tab。
    node tools/playtest.cjs open "$PRE" >/dev/null 2>&1
    PREOUT=$(node tools/playtest.cjs eval "(async()=>{
      const a=window.triplets;
      if(!a||!a.game) return 'NOAPP at='+location.pathname;
      const m=await import(new URL('js/engine/pencil.js', document.baseURI).href).catch(()=>({verify:0}));
      const app=getComputedStyle(document.getElementById('app'));
      const cr=a.view.canvas.getBoundingClientRect();
      const cssOk=app.maxWidth!=='none'&&getComputedStyle(document.getElementById('board-wrap')).position==='relative';
      const g=(await a.newGame('6x6'))||a.game;
      return [
        'PREFIX-'+(g?'BOARDED':'NOBOARD'),
        'at='+(location.pathname==='/$REPO/'?'PREFIXED':'NOT-PREFIXED'),
        'css='+(cssOk?'OK':'MISSING'),
        'canvas='+Math.round(cr.width)+'x'+Math.round(cr.height),
        'engine='+(m&&typeof m.verify==='function'?'OK':'FAIL'),
        'clues='+(g?g.counts().given:'-'),
        'fp='+((g&&g.fp)||'-'),
      ].join(' ');
    })()" nonav 2>&1 | tail -2 | tr '\n' ' ')
    echo "  $PREOUT"
    case "$PREOUT" in *PREFIX-BOARDED*at=PREFIXED*css=OK*engine=OK*) ;; *) echo "  FAIL 前缀形状冒烟没过：前缀下的 css/动态 import/盘面有一样不对" >&2; FAILED=1 ;; esac
    # 这一趟把 BASE_URL 换成前缀形态，再跑一次 boot 场：它那条「UI 一侧拿不到答案」读的是
    # **按部署名单发出去的那批字节**，线上那一份的源码扫描必须和根路径下同样成立。
    BASE_URL=$PRE node tools/playtest.cjs scenario boot 2>/tmp/triplets-prefix-boot.console.log | tail -1 | sed 's/^RESULT //' | parse_row "prefix-boot" || FAILED=1
    export BASE_URL=$BASE
  fi
  rm -f "$PROOT/$REPO/index.html" "$PROOT/$REPO/css" "$PROOT/$REPO/js"
  rmdir "$PROOT/$REPO" "$PROOT" 2>/dev/null
  # 符号链接交回给系统：$PROOT 已经空了，清掉之后 cleanup 那一趟就不必再碰它。
  PROOT=""
fi

echo "=== url-shape 3/3：线上站点 —— 本轮没跑 ==="
echo "  本仓还没有 Pages（.github/workflows/pages.yml 不在这一轮），所以没有 https://z-biz-game.github.io/$REPO/ 可打。"
echo "  上面第 5 段跑的是**本地按部署名单搭出来的同形状根**（前缀 + tools/ 与 *.md 必须 404），"
echo "  它替代不了线上那一趟：线上还差「真部署过的那份字节」这一层证据。"

kill $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
