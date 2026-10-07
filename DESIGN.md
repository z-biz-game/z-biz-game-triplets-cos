# DESIGN.md — 工程口径

这一份只写**代码里已经成立**的事，每条断言后面都跟 `文件:行号`（本轮重跑时逐个 grep 过函数名/常量名，
对不上就是行号漂了，改行号，别改断言）。玩家视角的规则在 README.md；docs 与代码冲突时**以代码为准**。

第一阶段没有浏览器、没有 `server.cjs`、没有 `tools/verify.sh`，所以这里没有渲染/端口/壳的章节。

---

## 一、四方互相不信任

判据不能由被判的东西自己签字。本仓有四份**各自独立**的几何/规则实现，故意重复：

| 谁 | 知道什么 | 自己另写一份什么 | 出口 |
|---|---|---|---|
| `js/engine/pencil.js` | 只有题面（`reg` + `givens`） | 区域摊平、邻格、边界：`createState` 内部自己算（`js/engine/pencil.js:52`） | `advance()`（`js/engine/pencil.js:398-411`）、`verify()`（`js/engine/pencil.js:369`） |
| `js/engine/counter.js` | 只有题面 | 连"谁是邻格、区域怎么摊平、九种填法的顺序"都另写一份（`js/engine/counter.js:3-4`） | `countByRegion()`（`js/engine/counter.js:82`）、`countNaive()`（`js/engine/counter.js:174`） |
| `js/engine/generate.js` | **知道答案**（参考解是自己生成的） | 不复用别人的判定，只调 counter + pencil 的出口 | `makePuzzle()`（`js/engine/generate.js:206`）、`auditClueNecessity()`（`js/engine/generate.js:245`） |
| `js/engine/partition.js` | 只负责切区域与出参考解 | `makePartition`（`js/engine/partition.js:103`）、`makeSolution`（`js/engine/partition.js:185`）、`makeBoard`（`js/engine/partition.js:256`） | `triadShapes()`（`js/engine/partition.js:37`）、`regionPatterns()`（`js/engine/partition.js:170`） |

`pencil.js` 不 import `counter.js`，`counter.js` 不 import `pencil.js`（两边文件头的自白）。
共享的只有 `grid.js` 的常量层（`SYMBOLS = 3` `js/engine/grid.js:18`、`ALL = 0b111` `js/engine/grid.js:19`、
`REGION_ALL_SAME / REGION_ALL_DIFF` `js/engine/grid.js:110-111`）和 `rng.js`。
"两个人格"是设计，不是重复代码：任何一方的 bug 会被另一方在门禁里撞出来。

`tools/pencil-test.mjs:35` 与 `:40` 用源码文本扫描守住这条纪律：引擎六个文件里
`Math.random` / `Date.now` / `performance.now` / `new Date(` 一律不许出现在判定路径上。
随机只有一个入口：`js/engine/rng.js:6` 的 FNV-1a `hash32` + `js/engine/rng.js:15` 的 mulberry32，只吃字符串 seed。

## 二、确定性的形状（为什么比较器里不许抽随机数）

- 洗牌：`js/engine/rng.js:32-39`，随机数在循环里**一次性抽完**，`Array#sort` 不参与。
- 需要"随机序 + 稳定断键"的场合用 `keyed()`（`js/engine/rng.js:43`），排序本身是纯函数。
  原因写在 `js/engine/rng.js:29-31`：V8 对长短数组用不同 sort 实现，比较器里抽随机数会让 node 和
  Chrome 挑出不同的盘，门禁连跑三次条数都在变。
- 挖线索的格序来自 `rnd.shuffle(...)`（`js/engine/generate.js:148`），不是 `Object.keys` 的枚举序。
- balance / ceiling 的样本是 `balance|<sizeKey>|<1..N>` 这种**串**（`tools/balance.mjs:114`），
  分位数一律真实排序后 nearest-rank 取（`tools/balance.mjs:73-77`），比较器只读实参。
- `loadavg` 只出现在抬头行做争用披露（`tools/balance.mjs:443-446`、`tools/ceiling.mjs` 抬头），
  不参与任何判定；`hrtime` 只用于量墙钟，不用于筛盘。

## 三、出货流水线（`generate.js`）

一次抽卡 = `attemptOnce()`（`js/engine/generate.js:106-202`），五步，每步的拒绝都单独记账：

1. **门 0**（`js/engine/generate.js:120-144`）：参考解自己合法（`illegalRef`）、满线索数得出唯一
   （`refRejected`）且过不了预算算失败（`gate0Overbudget`，`:126-129`），
   满线索盘面**必须被六条规则零猜测推完**并与参考解逐格一致（`pencilStuckFull` / `dropByMismatch`，`:134-143`）。
2. **挖线索**（`js/engine/generate.js:146-175`）：按预抽格序逐颗试删。删掉以后必须
   「计数器在预算内说 UNIQUE」且「铅笔推得完并与参考解一致」才真删；
   数不完 ⇒ `dropByOverbudget++` 把那颗放回（`js/engine/generate.js:154-157`）——
   **这一颗的"非留不可"就没证到**，所以它和"不唯一"分开记两个数。
   账本口径：`dropTried = dropKept + dropByPencil + dropByCounter + dropByOverbudget`
   （balance 的红线就是这条轧平式，`tools/balance.mjs:351`）。
3. **出货前独立复核**（`js/engine/generate.js:177-192`）：最后一次成功删改之后重新数一遍唯一、
   重新推一遍、`verify()`、并核对计数器的 `truth` 与参考解逐格相同（`refRejected++`，`:189-192`）。
4. **抽卡循环**：`makePuzzle()`（`js/engine/generate.js:206-241`）`for (trial < maxTrials)` 跑到底，
   **同步、不可中断**——这就是墙钟红线存在的理由（README 的"不承诺响应时间"）。
5. **`auditClueNecessity()`**（`js/engine/generate.js:245-265`）：给 balance 复算用的逐颗必要性出口，
   每颗留下的线索单独摘一遍，返回 `{cell, overbudget, notUnique, pencilStuck, pass}`；
   `pass === true` 的颗数必须是 0（"这颗还能删"就是打脸）。

计数器预算：`DEFAULT_BUDGET = 250_000` 个 DFS 结点（`js/engine/counter.js:264`）、`DEFAULT_CAP = 2`
（`js/engine/counter.js:265`，出货只需要区分"1 个"与"不止 1 个"）。
**`stopped` 的盘永远不许上架**：调用方看 `stopped` 而不是 `count`（`js/engine/counter.js:19-20`、`:102`、`:134`、`:165`）——
半路的 `count` 可能是 1，但"还没数完"和"数出来是 1"是两件事。
搜索空间小是因为每区恰好 9 种填法（3 全同 + 6 全异，`js/engine/counter.js:9-11`），
剪枝只有题面文字 P2/P4（`js/engine/counter.js:13-15`），不含 `pencil.js` 的规则表。

## 四、规则表：六条，每条都有不可替代性的证人

`RULE_ORDER`（`js/engine/pencil.js:300`）与权重 `RULE_WEIGHT`（`js/engine/pencil.js:313-319`）：

| key | 权重 | 人话 | 实现 |
|---|---|---|---|
| `A2-same-lock` | 3 | 区内两格已同为某符号 ⇒ 第三格也是它 | `js/engine/pencil.js:138` |
| `A3-all-diff-completion` | 3 | 区内两格已不同 ⇒ 第三格是剩下的那个 | `js/engine/pencil.js:165` |
| `A4-border-exclude` | 2 | 跨区邻格已定为 s ⇒ 本格删掉 s | `js/engine/pencil.js:192` |
| `A6-region-infeasible` | 3 | 本格取 s 时本区既凑不齐全同也凑不齐全异 ⇒ 删 s | `js/engine/pencil.js:208` |
| `C1-pair-block` | 4 | 本格取 s 时本区的每种填法都和某个邻区配不上 ⇒ 删 s | `js/engine/pencil.js:234` |
| `A5-naked-single` | 1 | 本格只剩一个符号 ⇒ 落子（兜底位，最后跑） | `js/engine/pencil.js:286` |

- 权重含义是"用这条规则要看多远"（本格 1 / 共边 2 / 区域可行性 3 / 两区联立 4），
  **不是**难度分；分数由 balance 计算，引擎里没有 `scoreOf()`。
- 规则出口三态：`{rule, cell, kind:'place'|'elim'}` / `{contradiction}` / `{stalled}`
  （`nextDeduction()`，`js/engine/pencil.js:345-351`）。矛盾只有一条出口：`advance` 见
  `d.contradiction` 就 `status: 'contradiction'` 并带上报的规则与格（`js/engine/pencil.js:404`），
  `verify` 不许被用来"抢救"没推完的盘（`js/engine/pencil.js:369-371`：没填的格直接判不过）。
- `runRule()` 里有一条防自嗨的闸：规则想往一个"该符号已被删掉"的格落子 ⇒ 直接 throw
  （`js/engine/pencil.js:334-336`）；`elim` 落在已删的位上返回 `null`（`js/engine/pencil.js:337-338`）。
- `applyDeduction()` 落子的同时把 `cand[cell]` 写成单元素并返回 `st`（`js/engine/pencil.js:353-366`）——
  `A5` 那句"掩码是单元素就 continue"没有 `placed` 守卫，这条写回就是它不误报矛盾的前提
  （证人：`tests/a5-contradiction.test.mjs:155-163`）。
- **B1/B2 已经删掉了。** 曾实现的 `B1-forced-all-diff` / `B2-forced-all-same` 在 84 张盘上出场 0 盘，
  引擎里现在搜不到这两个名字；`tests/rule-subsumption.test.mjs:144-147` 在源码里 grep 到就红，
  `:150` 核对 balance 的 `T.deadRuleIsRed` 那条红线还在。

## 五、"每条规则都真的出场"是怎么证的

出场率由 balance 逐档打印并判红线（`tools/balance.mjs:356-358` 单档独占披露、
`:456` 整条梯子的覆盖、`:433`/`:457` 死规则红线）：
一条规则在整条梯子 8 档 × SAMPLES 盘上出场 0 盘 ⇒ `RESULT ok=false`。
本轮 `SAMPLES=60`（480 盘）：`A3` 478 盘、`A2` 453 盘、其余四条 480 盘。
**聚合命中数必须带"最大贡献样本"**（`tools/balance.mjs:225-238`）：
每条规则印 `最大贡献 N 次 = 占比%（#样本号）`，一个退化样本撑不起整档的命中率。

不可替代性另有三份固定证人：

- `tools/rule-test.mjs:220-224`：整表 near-miss —— 六条规则轮询一圈 `steps === 0`、
  而独立计数器说这盘**有 3 个解**。这句话是"闷不是错，是线索不够"，
  也是 README 里"不承诺唯一解 ⇒ 推得完"的那张反例。
- `tools/rule-test.mjs:230-262` + `tests/c1-irreducible.test.mjs:30-35`：真实 4×6 出货盘
  （金标准 seed `smoke|4x6|3|4|9|10`），A 组推到 `stuck`，第一口结论必须是 C1，
  且被独立计数器确认"钉上那个符号 ⇒ 0 解"（`tests/c1-irreducible.test.mjs:60-62`），
  补上这一口之后整盘推完（`:68-75`）。
- `tests/rule-subsumption.test.mjs:85-92`：3×2 盘穷举 117649 个掩码局面，
  A 组不动点之后 C1 还能继续删的是 **74835** 个（金标准数），且没有任何局面 A 组删得比全表多
  （`:91`，抓 `rules` 选项的状态泄漏）。`tests/rule-subsumption.test.mjs:97-133` 再验 A2 与 A4 互不蕴含
  （带 A5 支持时，3×2 两横区：A2+A5 更强 4572 局、A4+A5 更强 85923 局，`tests/rule-subsumption.test.mjs:104` 记成金标准）。
- `tests/a5-contradiction.test.mjs:32`（金标准盘面 `reg 0,0,0/1,1,1/2,2,2`、`gv 0,0,-1/1,-1,-1/-1,1,-1`、
  矛盾格 4）+ `:120-136`（穷举复现：每一盘 A5 报矛盾都必须被独立计数器确认为 0 解，
  且没有一盘 0 解却被判 `solved`）。

## 六、难度口径：两条轴，不是"推理更深"

- `score` = Σ `RULE_WEIGHT[规则] × 该规则命中次数`，由 balance 计算（`tools/balance.mjs:104-108`）。
- `steps` 是**恒等式**量：实测 `steps/N` 在 1.92（4x6）～2.40（12x12）之间，
  上界 `3N` 由 pencil-test 的 Φ 只降不升不变式给出，balance 逐盘核对
  （`tools/balance.mjs:217-218` 的定义、`:350` 的硬判）。它随格数线性走，**不许**当难度口径。
- 跨档比较只用来抓事故（"大档反而比小档容易"），并且必须并排印出
  `score/N`、`steps/N` 两列说明它只是尺寸影子（`tools/balance.mjs:411-419`；
  梯子不足两档时 `tools/balance.mjs:414` 那句 `ladderMenu.length < 2` 让这条自动跳过）。
- 档内第二轴是线索稀度：`corr(score, 线索数)`（Pearson，`tools/balance.mjs:86-100`），
  红线 −0.35、只在出货样本 ≥12 的档判红（`tools/balance.mjs:340-344`），样本不足只披露。
  本轮 `SAMPLES=24` 实测 −0.85 ～ −0.93（对照档 12x12 −0.81）。
- 工作区根目录的 `_tmp-triplets-lib.mjs` 是**四规则原型**，它的 −0.75 与本表不同口径，
  本仓的表与文档不引用它。

## 七、尺寸天花板与 `SIZES`

- 菜单 `SIZES = ['4x6','6x6','6x8','6x9','8x9','9x9','8x12']`（`js/engine/generate.js:48`），
  档位表 `TIERS`（`js/engine/generate.js:53-62`）里 `12x12` 是 `inMenu: false` 且带
  `unshippable` 的理由文本（`js/engine/generate.js:61`）。
- 尺寸必须 3 的倍数：`sizeAllowed()`（`js/engine/generate.js:72-75`）。
- 两条红线写死在 `tools/ceiling.mjs:29-30`：`WALL_MENU_P95_MS = 300`、`WALL_SHIP_P95_MS = 2000`。
  探测梯子在 `tools/ceiling.mjs:34`（`12x15, 12x18, 15x15, 12x21, 18x18`），
  每档最多抽 `PROBE_MAX_TRIALS = 6` 张（`:39`）、单档墙钟预算 120s（`:52`），
  被截断时如实打 `capped`，那一档的"出货 x/target"就只是**下界**。
- 两趟实测（2026-09-28）：菜单 7 档各 10/10 出货、p95 load1 16.6 那趟 8～122ms / load1 5.9 那趟 5～87ms；
  `12x12` 6/6、p95 **504 / 332ms**（两趟都越过 300ms，但第二趟只超 10% ⇒ 这条线是 UX 线、不是能力线）；
  `12x15` **1460 / 784ms**；`12x18` **2534 / 1337ms**；`15x15` —/1459ms、`12x21` —/2985ms（第一趟的梯子在
  12x18 就撞线停了，所以那两档只有第二趟的读数）⇒ **"第一个撞 2000ms 的档"随争用在 12x18～12x21 间移动**，
  文档里不许把它钉成一个尺寸。
  **撞的是墙钟，不是计数器预算**：全普查最大结点 5178 对预算 250000 差 48 倍，
  `dropByOverbudget` 合计 0 颗。所以 `SIZES` 的上界由"点一下要等多久"决定，
  而不是"能不能数完"——这句写进 README 的"不承诺"，因为它是负结论。
- ceiling 每轮复核"菜单身份 ↔ 实测是否自洽"（`tools/ceiling.mjs` 的菜单身份复核节，
  打印 `TIERS` 记的理由与本轮实测的对照行），两边都不许手改。

## 八、balance 的口径纪律（为什么有的判红、有的只披露）

`tools/balance.mjs` 的红线表 `T`（`tools/balance.mjs:267-303`）与十条门 `GATES`（`tools/balance.mjs:305-319`）；
判定实现 `judge()`（`tools/balance.mjs:322-360`）分两个出口：`flags`（进 `RESULT`）与 `notes`（只打印）。

- **判红**：出货率、零猜测率、`已证`（唯一 ∧ 推完 ∧ verify ∧ 逐颗必要性，0 张不认账）、
  菜单档墙钟 p95、档内 corr、六个"应为 0"的账（`illegalRef / refRejected / pencilStuckFull /
  dropByMismatch / overbudget / gate0Overbudget`）、`steps ≤ 3N`、挖珠账轧平、
  单盘独占率、死规则、跨档单调（梯子 <2 档时自动跳过——同一档的 P(自己>自己) 恒为 0.50，
  那不是破口）。
- **只披露**：`OVERBUDGET`（`dropByOverbudget` 的颗数 / 涉及盘数 / 审计数不完的颗数，`tools/balance.mjs:353-354`）、
  单条规则被一个样本独占 >60%（`tools/balance.mjs:357`）、表外对照档的一切破口
  （`T.gateControlSizes = false`，`tools/balance.mjs:294-295`：门禁守的是发货承诺，对照档不发货）。
- `--dose=<sizeKey>#<n>`（`tools/balance.mjs:48-54`、`:119-127`）摘掉那一盘格号最小的一颗线索；
  变异落地的证据在 `--quiet` 模式也照打（`tools/balance.mjs:434-437`），因为"一条从没红过的绿不算证人"。
- 期望值全部来自**本轮重跑**：注释里每个数都标了口径（`SAMPLES=24` / `npm run ceiling` 与日期），
  跑出新数就改注释，不许反过来改判据。

## 九、已知边界（不是 TODO，是口径）

- 规则表不完备：唯一解与"六条规则推得完"之间没有蕴含关系（反例见 `:五` 第一条）。
- 极小性只到单颗删除那一层：没有"线索最少"的承诺，也没有两颗同摘的实验。
- 剖分是重启式随机（`js/engine/partition.js:103`），不是完备枚举：`partitionRestarts` 是它的账
  （本轮 `SAMPLES=24`：4x6 累计 3 次 → 12x12 累计 63 次）。
- 浏览器门禁是第二阶段补上的：`tools/check.mjs:21` 的 `EXTRA_JS = ['server.cjs']` 与 `:22` 的
  `SHELLS = ['tools/verify.sh']` 就是第一阶段留的两个空数组，现在都填了（`DIRS` 仍只有
  `js/tools/tests`，根目录那两个文件靠点名进语法门）。Electron 壳仍未开工，所以不进名单。
- `tests/` 的三套证人测试与 `tools/` 的四套门禁**判据不重叠**：证人测"这条规则删不得 /
  这个出口存在"，门禁测"引擎逐条对账"。删掉 `tests/` 的任何一套，对应那条承诺就只剩 README 在守。
