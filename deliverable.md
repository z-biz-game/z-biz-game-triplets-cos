# 同或异 - 交付报告

| 项 | 值 |
| --- | --- |
| **App 名称** | 同或异（Triplets · 三格区域的推理） |
| 仓库 | z-biz-game-triplets-cos |
| 品类 | 益智 · 三格区域（每块要么三个同号、要么三个全异；跨区相邻必不同） |
| 依赖 | 0（`dependencies` 为 `{}`，零构建） |
| node 断言 | 108,654 条 / 0 失败（7 套：`rule-test 259 · pencil-test 56545 · counter-test 39067 · generator-probe 763 · a5-contradiction-test 11935 · c1-irreducible-test 65 · rule-subsumption-test 20`） |
| 浏览器断言 | 80 条 / 0 失败（`boot 13 · render 21 · play 13 · sizes 17 · reproof 8 · resume-set 3 · resume-check 5`），另前缀形态重跑 boot 13 条 |
| 金标准 | `golden-test` 170 条 / 0 失败；文档行号对账 27 条 / 0 失败（119 条引用、103 条带指认） |
| 部署集闸 | 36 条引用（含 7 张位图尺寸核对）/ 64 行 / 0 失败；阴性自证 `DS_SELFTEST rc=0` |

## 任务摘要

把"有机并线"之后那棵**整局不可玩**的树救回来，再把它推到可上线的状态。

并线（`0786859`，两侧 `4f9ddcb` / `04854be` 有机合并 + `629d98b` 去同名顶层声明）留下的是一棵树，
不是一局能玩的游戏：`js/main.js` 顶层两处 `let paused` 让整个模块 **SyntaxError**；
`clockStart` 的声明在并线里被裁掉了，于是秒表一读就是 ReferenceError；
`$('btn-mute')` 指向一个**页面上根本没有**的 id，模块加载到那一行抛 TypeError；
同一颗按钮上并线留下了两套接线（暂停、全屏各一份），点一下等于按了两次。
这一轮把这些逐条修掉，并把每一条的**依据**写在下表里。

## 真实文件清单

```
index.html  css/game.css  server.cjs  package.json  .gitignore  LICENSE
js/main.js  js/theme.js  js/store.js  js/fx.js  js/sfx.js  js/sw-register.js
js/engine/  rng.js grid.js pencil.js generate.js partition.js counter.js
js/ui/game.js
js/render/board.js
icons/      favicon-16/32 icon-96/192/512/1024 icon-maskable-512 apple-touch-icon
assets/     img/(og-image triad-sprite) textures/(grain-256) gen/(gen_art.py · 不进站点)
tests/      rule-subsumption c1-irreducible a5-contradiction
tools/      check.mjs engine-test.mjs pencil-test.mjs rule-test.mjs counter-test.mjs
            generator-probe.mjs ceiling.mjs balance.mjs golden.mjs golden-test.mjs
            write-golden.mjs docs-test.mjs check-assets.mjs scenarios.js playtest.cjs
            verify.sh assemble-site.sh deploy-set.mjs deploy-set-selftest.mjs
.github/workflows/  ci.yml pages.yml
README.md  DESIGN.md  deliverable.md
```

## 改动表：一开始错在哪 → 现在为什么对

| # | 现象 | 处理 | 依据 |
| --- | --- | --- | --- |
| 1 | `js/main.js` 顶层两处 `let paused = false;`（第 85 行与第 122 行） | 留一份声明 | ES module 顶层同名声明是 **SyntaxError**，整份 main.js 不加载 ⇒ 页面停在选档页，`window.triplets` 永不出现。`node --check` 复现 |
| 2 | `js/main.js` 的 `clockStart` **全文件没有声明**：107/134/136 行赋值、114 行读取 | 补回 `let clockStart = 0;` | ES module 是严格模式，赋给未声明变量抛 ReferenceError ⇒ 每次 `resetClock()` / `elapsedMs()` / `setPaused()` 都炸。声明在远端侧原文里（`0786859^2:js/main.js` 第 71 行），并线时与本地侧的声明块重叠被裁掉了 |
| 3 | `js/main.js` 的 `$('btn-mute').addEventListener('click', toggleMute)` —— 页面上**没有** `#btn-mute` | 顶栏把静音按钮补回来 | 并线把本地侧那颗静音按钮裁掉了，`getElementById` 返回 null，模块加载到这一行就抛 TypeError ⇒ 整局不可玩。按钮补回来，`M` 键才有着落 |
| 4 | `#btn-pause` 挂了两个 click（接线段的 `togglePause` 与 `bindPause()` IIFE 里的 `setPaused(!paused)`） | 只留 `bindPause()` 那一份 | 同一颗按钮两个 handler ⇒ 点一下暂停、紧接着又放开，**按了没反应** |
| 5 | `#btn-fullscreen` 挂了两个 click（`toggleFullscreen` 与文件末尾 `bindFullscreen()` IIFE 里的 `toggle()`）；两套实现还打在不同元素上（本地侧打 `#app`，IIFE 打 `documentElement`），退出时两套 sync 抢同一颗按钮的文字 | 合成**一套**实现（打 `#app`），IIFE 整个删掉 | 同上：双开关＝按了没反应；两套 sync 各写一次按钮文字，屏上会看到"退出全屏"被立刻改回"全屏" |
| 6 | `F` 键接了两遍（`typeKey` 里的 `toggleFullscreen()` 与 IIFE 里 window 级 keydown 的 `toggle()`） | 只留 `typeKey` 那一份 | 一次按键走完两处 ⇒ 进一次全屏、紧接着退一次 |
| 7 | `P` 键在 `typeKey` 里写了两段（649 与 675），前一段 return 掉了 | 删掉够不到的那一段 | 死代码留着会让人以为键位有两套 |
| 8 | `setPaused` 是**两套实现混搭**：定义是远端那版（单参数、performance.now 冻结、只 `paintPause()` 改按钮文案），而第 498 行 `setPaused(false, { announceIt: false })` 是本地侧的签名 | 合成一份：`setPaused(v, { announceIt = true } = {})`，**秒表**按远端侧（较新的一侧）真冻结，**仿真钟**按本地侧一起停 | 两侧的 `setPaused` 签名不同，选项被静默丢掉；而文件自己第 424 行的合同写着「暂停 → FrameClock 一帧都不推进（秒表与光晕同时冻住）」——只有一半兑现了。合成后两台钟一起停 |
| 9 | `#stat-paused` 那枚「‖ 已暂停」芯片在页面上，却没有任何代码更新它 | `paintPause()` 一并更新它 | 状态读数永远不出现，玩家只看见按钮换了字 |
| 10 | `css/game.css` 被裁掉 24 行：`#app:fullscreen`（全屏时 UA 铺黑、宽度上限还在）与 `prefers-reduced-motion`（系统减动效的 CSS 那半边） | 整段补回 | 全屏功能打的是 `#app`，那段规则就是为它写的；JS 侧 `theme.js` 的 `prefersReducedMotion()` 管 `--fx-glow`，CSS 侧管自己的动画，两边各关各的 |
| 11 | `index.html` 的 head 是远端那版：viewport 与 twitter:card 挤在一行、og/twitter 只留一半字段、data-URI 的手画 SVG 与真 PNG 图标各挂一份 | head 归一：viewport 独占一行、og/twitter 补齐（`og:image` 指真图 `assets/img/og-image.png`，绝对 URL）、只留真 PNG 图标（16/32/96 + apple-touch-icon）、补回 `mobile-web-app-capable` 与 `apple-mobile-web-app-*` | `og:image` 必须写绝对 URL（抓取器不替 Pages 补 `/<repo>/` 前缀），`tools/deploy-set.mjs` 的 R7 就按这一条盯 |
| 12 | `manifest.webmanifest` 是远端那版：主题色 `#0a0a12`（既不是页面的 `#070A14`，也不是 `js/theme.js` 的 `bgTop`）、少 11 个字段、六张图标只剩三张、screenshots 没了 | 恢复本地侧那版（主题色对齐 `#070A14`；`id/scope/display_override/orientation/lang/dir/categories/description` 齐全；六张图标的 `sizes` 逐张量过 PNG IHDR 真值；screenshots 指 `assets/img/og-image.png`） | `tools/deploy-set.mjs` 的 P 段（声明的 sizes 必须等于真宽高）与 R3/R5/R6 |
| 13 | `tools/assemble-site.sh` 把整个 `assets/` 拷进产物 | 只拷 `icons/` 与 `assets/textures`、`assets/img` | `assets/gen/` 是 Python 出图脚本、`assets/manifest.json` 是它的清单，都不该上线；而 `tools/verify.sh` 的部署形状腿**正反着查** `assets/gen/gen_art.py` 必须 404 —— 原样拷出去，这条腿自己会红 |
| 14 | `tools/deploy-set.mjs` 的实数钉（`EXPECT_CHECKS 27` / `EXPECT_ROWS 46`）在并线后就已经对不上 | 改成实测值 `36` / `64` | 在合并前的 ref 上建 worktree 跑同一个闸，基线读数就是 `31 条引用 / rows 50`，与钉的 27/46 不符 ⇒ **并线那一刻起部署集闸就是红的**。**钉的是实数，强度不变** |
| 15 | `tools/deploy-set-selftest.mjs` 的 X1 针写死 `for d in icons assets; do` | 改成从仓里现取那行循环 | 清单收哪几个位图目录是本仓自己的事；针写死就等于给改清单的人埋一颗地雷（针打空 ⇒ `edit()` 抛错 ⇒ 那一刀没落地） |
| 16 | `js/store.js` 是远端那版 naive 的 `load()`（`{...base, ...JSON.parse(raw)}`） | 保留本地侧那版（坏记录只丢那一条） | 一条 `null` 记录就能让整个 Store 拿不到 data，玩家看到的是"页面白屏/按钮全哑"而不只是"那次续局没了"。本地侧那版是并线里已经取胜的，本轮未改 |

## 口径裁决：两处两侧互斥的地方

**① 秒表用哪台钟。** 远端侧（较新，10-03 20:54，`feat(triplets): 暂停真冻结 performance.now 时钟`）把秒表改成
performance.now 真冻结；本地侧（10-03 04:29）走 `js/fx.js` 的 FrameClock 仿真钟。
⇒ 取远端侧的**秒表语义**（较新且有意的一侧），并把本地侧的**仿真钟冻结**一并接上
（`simClock.setPaused` + `simClock.reset({paused})`）：两台钟一起停，正是文件顶上那条纪律要的。

**② 全屏打在谁身上。** 本地侧打 `#app`（配 `#app:fullscreen` 那段 CSS），远端侧打 `documentElement`。
⇒ 取本地侧：门面（`window.triplets.toggleFullscreen`、`readout().fullscreenSupported`）本来就是本地侧那套 API，
CSS 那段也是为 `#app` 写的；并把远端侧多出来的能力并进来（`ms` 前缀、
"浏览器不给全屏就把那颗按钮禁用并写清原因"）。

## 待人接手（本轮没有替产品做决定的事项）

无。本轮所有两侧互斥处都按"较新且有意的一侧 + 能力取并集"收口，没有留下需要产品拍板的语义分叉。

## 构建验证结论

本机直接测量（不依赖任何子代理转述）：

```
node tools/check.mjs          node --check：38/38 个文件语法通过；bash -n：1/1 个 shell 脚本
npm test                     7 套 / 108,654 条断言 / 0 失败
node tools/golden-test.mjs   170 条 / 0 失败
node tools/docs-test.mjs     27 条 / 0 失败（119 条引用 · 103 条带指认）
node tools/deploy-set.mjs    36 条引用（含 7 张位图尺寸核对）/ rows 64 / fail 0
node tools/deploy-set-selftest.mjs   DS_SELFTEST rc=0（12 把刀逐个按预期发力，X13 内联位图 SKIP）
bash tools/verify.sh         === ALL GREEN ===   exit 0
  浏览器 80 checks / 0 failed
    boot 13 · render 21 · play 13 · sizes 17 · reproof 8 · resume-set 3 · resume-check 5
  前缀形态 boot 13 checks / 0 failed
  PREFIX-BOARDED at=PREFIXED css=OK canvas=472x472 engine=OK
```

`VERIFY_RC=0`。

## 本轮提交的顺序

1. 主修复（`js/main.js`、`index.html`、`css/game.css`、`manifest.webmanifest`、
   `tools/assemble-site.sh`、`tools/deploy-set.mjs` 的实数钉、`tools/deploy-set-selftest.mjs` 的针）。
2. 交付报告与 README 的实数对齐（浏览器断言条数、部署集两颗钉、语法门文件数、四个壳开关的说明）。
