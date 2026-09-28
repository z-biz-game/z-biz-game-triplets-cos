#!/usr/bin/env node
// 难度实测（balance）：把"这七档尺寸到底有多难、出题要多久、每一颗线索删不删得掉"量出来，不猜。
//
// 和同目录别的工具的分工（不重复）：
//   rule-test / pencil-test / counter-test 答"引擎有没有坏"（判据逐条对账、变异必被拒）。
//   generator-probe 答"出题器记的账是不是真的"（应为 0 的项真的是 0、该有的分支真的走到过）。
//   ceiling 答"尺寸天花板在哪一档"（成本口径：抽卡、墙钟、OVERBUDGET）。
//   本文件答"发货承诺那句是不是真的"：出货率、零猜测、**逐颗线索必要性**、规则出场、分数分布。
//
// 三条不能妥协的口径（本组织栽过的坑，逐条写在这里）：
//   ① 随机只发生在"选 seed"这一步，而且这一步是**确定性**的（串里带样本号）。生成器和任何
//      sort 比较器里都不许出现 Math.random / Date.now —— 比较器里抽随机数会让 node 和 Chrome
//      画出两张盘（js/engine/rng.js:29-39 那份 shuffle 就是为了这件事）。
//   ② p50/p95 一律从**真实排序后的样本**里取，不由中位数推算（本仓墙钟不是双峰，但 12×12 那档
//      偶尔一次 noBoard 会把 max 拉飞，推算出来的 p95 会把它抹掉）。
//   ③ **两条承诺分开数**：「唯一解 + 推得完」和「每一颗线索都删不得」是两个不同的量，
//      分母也不同（盘 / 颗）。masyu 那一轮把它们混成一个"已证"数过一次，于是拦下了不该拦的东西。
//      本仓的 dropByOverbudget 实测在 8 档 × 60 盘（480 盘）上恒为 0，逐颗必要性审计 0/7143 颗数不完
//      （SAMPLES=60 那一轮，见 README 的表），所以这条**有**证人的口径敢写死；真撞上预算的那一天，红线会红，而不是悄悄把措辞降级。
//
// 跑法：
//   SAMPLES=24 node tools/balance.mjs                 正式跑（默认 SAMPLES=24）
//   node tools/balance.mjs --quiet                     只打一行 RESULT ok=<true|false>（门禁用）
//   node tools/balance.mjs --dose=6x8#3                把 6x8 第 3 盘摘掉一颗线索，红线必须咬住
//   ONLY=6x9,8x12 node tools/balance.mjs               只跑这几档（调试用，红线口径不变）
// 退出码：0 = 全绿；1 = 有红线（见文末 GATES）。
//
// 本文件只读 js/ 下的公开出口，不改引擎、不碰浏览器、不联网。
import { makePuzzle, auditClueNecessity, SIZE_TABLE, SIZES, TIERS, parseSize, newStats } from '../js/engine/generate.js';
import { countByRegion, DEFAULT_BUDGET, DEFAULT_CAP } from '../js/engine/counter.js';
import { solveWithRules, verify, RULE_ORDER, RULE_TEXT, RULE_WEIGHT } from '../js/engine/pencil.js';
import { loadavg, cpus } from 'node:os';

const QUIET = process.argv.includes('--quiet');
const SAMPLES = Math.max(1, Number(process.env.SAMPLES) || 24);
const BUDGET = DEFAULT_BUDGET; // 250_000 结点（js/engine/counter.js:264）—— 出货配置，不是测试配置
const AUDIT_BUDGET = 500_000; // 复算用两倍预算：数不完要单独归因，不许和"不唯一"混成一件事
const MAX_TRIALS = 40; // 与 TIERS[].maxDraws 一致（js/engine/generate.js:53-62）
const NOW = () => Number(process.hrtime.bigint() / 1000n) / 1000; // 高精度墙钟（引擎自记 ms 走的就是它）

// 摘掉 C1 之后的规则表：pencil.js:228-233 承诺"逐档救援率由 balance 印"，就是这一列。
const A_ONLY = RULE_ORDER.filter((k) => k !== 'C1-pair-block');

// 变异剂量 --dose=<sizeKey>#<样本号>：把指定那一盘摘掉**一颗**线索（取格号最小的那颗，确定性）。
// 需要它的原因：本仓最硬的那句承诺是「每颗线索都删不得」，而这条闸现在绿着 —— "绿着"不等于"拦得住"。
// 摘一颗破的是挖珠不变式（js/engine/generate.js:146-175），复算必须当场报出
// 「不唯一 / 推不完 / 必要性审计说这颗还能删」中的至少一个。摘了还全绿 ⇒ 是闸坏了，不是盘没事。
const DOSE = (() => {
  const a = process.argv.find((s) => s.startsWith('--dose='));
  if (!a) return null;
  const m = /^--dose=([0-9]+x[0-9]+)#([0-9]+)$/.exec(a);
  if (!m) throw new Error(`--dose 的形状是 --dose=6x8#3，收到 ${a}`);
  return { sizeKey: m[1], i: Number(m[2]) };
})();
const doseLanded = [];

// 档位 = 菜单档（SIZES）+ 表外对照档（SIZE_TABLE 里不进菜单的那些）。
// 对照档照样量、照样打，但破口只记 note 不记 red（T.gateControlSizes 的注释写了为什么）。
const CELLS = (k) => {
  const [w, h] = SIZE_TABLE[k];
  return w * h;
};
const EXTRA = Object.keys(SIZE_TABLE).filter((k) => !SIZES.includes(k));
const ALL_TIERS = [...SIZES, ...EXTRA];
// 比较器只读常量表和实参，不抽随机数（纪律：随机序要预抽随机键，见 rng.js:29）。
const LADDER = (process.env.ONLY ? process.env.ONLY.split(',').map((s) => s.trim()) : ALL_TIERS)
  .slice()
  .sort((a, b) => CELLS(a) - CELLS(b) || (a < b ? -1 : a > b ? 1 : 0));

const STATS_KEYS = Object.keys(newStats()); // 出货器记的那几项账（跑一遍印出来，别照文档抄）

// ── 分位数：真实排序后取第 ceil(q·n) 个（nearest-rank，向上取整），绝不由中位数推算 ──
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
const asc = (a) => a.slice().sort((x, y) => x - y);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const f0 = (x) => (Number.isFinite(x) ? String(Math.round(x)) : '-');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-');

// Pearson 相关（档内 score × 线索数）。全整数/浮点只在这里出现在**度量**上，不参与任何判定路径，
// 而且分母为 0（线索数完全一样）时返回 NaN 而不是伪造 0。
function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

// 难度分数：**引擎只给权重（pencil.js:313 RULE_WEIGHT），分数是 balance 算的度量**。
// 权重 = 用这条规则要"看多远"（本格 1 / 共边 2 / 区域可行性 3 / 两区联立 4）。
function scoreOf(hits) {
  let s = 0;
  for (const [r, n] of Object.entries(hits || {})) s += (RULE_WEIGHT[r] ?? 0) * n;
  return s;
}

// ── 跑一批样本：串可复现，随机只在"选 seed"，而选 seed 是确定性的 ──────────────
function runSize(sizeKey, n) {
  const recs = [];
  for (let i = 1; i <= n; i++) {
    const seed = `balance|${sizeKey}|${i}`;
    const r = makePuzzle(seed, sizeKey, { maxTrials: MAX_TRIALS, budget: BUDGET, cap: DEFAULT_CAP, now: NOW });
    const rec = { i, seed, ok: !!r.ok, status: r.status, stats: r.stats || {}, draws: r.draws, wall: r.ms };
    if (r.ok) {
      let puzzle = r.puzzle;
      if (DOSE && sizeKey === DOSE.sizeKey && i === DOSE.i) {
        const givens = Int8Array.from(puzzle.givens);
        const cell = givens.findIndex((v) => v >= 0);
        if (cell < 0) throw new Error(`--dose 落空：${sizeKey}#${i} 盘上一颗线索都没有，变异等于没做`);
        const sym = givens[cell];
        givens[cell] = -1;
        puzzle = { ...puzzle, givens };
        doseLanded.push(`${sizeKey}#${i} 摘掉第 ${cell} 格（原值 ${sym}）`);
      }
      const clueCount = Array.from(puzzle.givens).filter((v) => v >= 0).length;
      // ① 独立复算（不吃生成器返回值）：计数器预算内唯一 + 铅笔零猜测推完 + verify 自检
      const c = countByRegion({ ...puzzle }, { cap: DEFAULT_CAP, budget: BUDGET });
      const p = solveWithRules({ ...puzzle }, { maxSteps: 20000 });
      const v = p.status === 'solved' ? verify(p.st) : { ok: false, why: '没推完' };
      rec.clueCount = clueCount;
      rec.nodes = c.nodes;
      rec.counterStopped = c.stopped;
      rec.counterCount = c.count;
      rec.unique = !c.stopped && c.count === 1;
      rec.solveStatus = p.status;
      rec.steps = p.steps;
      rec.hits = p.hits;
      rec.score = scoreOf(p.hits);
      rec.verified = v.ok === true;
      rec.mismatch = p.status === 'solved' ? p.out.some((x, k) => x !== r.solution[k]) : false;
      // ② 逐颗必要性（本仓跟 masyu/slither 拉开区别的那一句）：每颗留下的线索都单独摘一遍
      const audit = auditClueNecessity(puzzle, { budget: AUDIT_BUDGET, cap: DEFAULT_CAP });
      rec.audited = audit.length;
      rec.necUnnecessary = audit.filter((a) => a.pass).length; // 摘掉它两道门都过 ⇒ "删不得"是吹的
      rec.necOverbudget = audit.filter((a) => a.overbudget).length; // 数不完 ⇒ 这颗没证到（披露，不判红）
      // ③ C1 救援率（pencil.js:228-233 承诺的那一列）：摘掉 C1 这一盘还推得完吗
      const noC1 = solveWithRules({ ...puzzle }, { rules: A_ONLY });
      rec.c1Rescued = noC1.status !== 'solved';
      rec.c1RescueBlank = noC1.status === 'stuck' ? noC1.blank : 0;
    }
    recs.push(rec);
  }
  return recs;
}

// ── 逐档读数 ────────────────────────────────────────────────────────────
function measure(recs, sizeKey) {
  const n = recs.length;
  const shipped = recs.filter((r) => r.ok);
  const N = CELLS(sizeKey);
  const m = { n, shipped: shipped.length, N };
  const ids = (a) => (a.length ? a.map((r) => `#${r.i}`).join(',') : '-');

  // 1) 抽卡 → 出货 → 已证
  const drawAsc = asc(recs.map((r) => r.draws));
  m.drawsP50 = quantile(drawAsc, 0.5);
  m.drawsMax = drawAsc[drawAsc.length - 1];
  m.drawsTotal = drawAsc.reduce((a, b) => a + b, 0);
  const agg = {};
  for (const r of recs) for (const [k, v] of Object.entries(r.stats)) if (typeof v === 'number') agg[k] = (agg[k] || 0) + v;
  m.agg = agg;
  m.failReasons = recs.filter((r) => !r.ok).map((r) => `#${r.i}:${r.status}`);

  // 2) 两条承诺**分开数**（口径见文件头 ③）
  //    已证盘 proven = 出货盘里独立复算四项全认账的那些（唯一 ∧ 推完 ∧ verify ∧ 逐颗必要性）
  m.notUnique = shipped.filter((r) => !r.unique);
  m.notSolved = shipped.filter((r) => r.solveStatus !== 'solved');
  m.notVerified = shipped.filter((r) => r.verified !== true);
  m.mismatch = shipped.filter((r) => r.mismatch);
  m.necViolation = shipped.filter((r) => r.necUnnecessary > 0); // 审计找到还能删的线索 ⇒ 红线
  m.unproven = shipped.filter((r) => !r.unique || r.solveStatus !== 'solved' || r.verified !== true || r.mismatch || r.necUnnecessary > 0);
  m.proven = shipped.length - m.unproven.length;
  //    没证到 ≠ 证伪：预算数不完的那些颗只披露（撞预算时 generate.js:154-157 把线索放回去，
  //    出货盘仍然 UNIQUE，破的只是"这颗非留不可"那半句）
  m.dropByOverbudget = agg.dropByOverbudget || 0; // 颗
  m.overbudgetBoards = shipped.filter((r) => (r.stats.dropByOverbudget || 0) > 0); // 盘
  m.auditOverbudget = shipped.filter((r) => r.necOverbudget > 0);
  m.auditOverbudgetCells = shipped.reduce((a, r) => a + r.necOverbudget, 0);
  m.auditedCells = shipped.reduce((a, r) => a + r.audited, 0);

  // 3) 零猜测：出货盘的独立复算按构造应当 100%；有信息量的是**挖珠那一步的淘汰率**
  m.zeroGuess = shipped.filter((r) => r.solveStatus === 'solved' && r.verified).length;
  m.dropTried = agg.dropTried || 0;
  m.dropKept = agg.dropKept || 0;
  m.dropByPencil = agg.dropByPencil || 0;
  m.dropByCounter = agg.dropByCounter || 0;
  m.pencilRejectRate = m.dropTried ? m.dropByPencil / m.dropTried : NaN;
  m.boardKilledByPencil = recs.filter((r) => r.stats.pencilStuckFull > 0).length; // 整盘级淘汰

  // 4) 线索 / 分数 / 步数 分位
  const clueAsc = asc(shipped.map((r) => r.clueCount));
  const scoreAsc = asc(shipped.map((r) => r.score));
  const stepAsc = asc(shipped.map((r) => r.steps));
  const nodeAsc = asc(shipped.map((r) => r.nodes));
  const wallAsc = asc(recs.filter((r) => r.ok).map((r) => r.wall));
  m.clue = { p50: quantile(clueAsc, 0.5), min: clueAsc[0], max: clueAsc[clueAsc.length - 1] };
  m.clueShare = m.clue.p50 / N;
  m.score = { p50: quantile(scoreAsc, 0.5), p95: quantile(scoreAsc, 0.95), max: scoreAsc[scoreAsc.length - 1], min: scoreAsc[0] };
  m.steps = { p50: quantile(stepAsc, 0.5), max: stepAsc[stepAsc.length - 1] };
  m.nodes = { p50: quantile(nodeAsc, 0.5), max: nodeAsc[nodeAsc.length - 1] };
  m.wall = { p50: quantile(wallAsc, 0.5), p95: quantile(wallAsc, 0.95), max: wallAsc[wallAsc.length - 1] };
  m.scorePerCell = m.score.p50 / N;
  m.stepsPerCell = m.steps.p50 / N;
  // steps 的恒等式核对：pencil-test 那条 Φ 只降不升 ⇒ steps ≤ 3N（js/engine/pencil.js:398-411）。
  m.stepsBoundOk = shipped.every((r) => r.steps > 0 && r.steps <= 3 * N);
  // 5) 档内第二条轴：线索稀度。corr 为负才支持"同档里越稀越难"这句话。
  m.corrScoreClue = corr(shipped.map((r) => r.score), shipped.map((r) => r.clueCount));
  m.scoreBand = shipped.length > 1 && m.score.p50 ? (m.score.max - m.score.min) / m.score.p50 : NaN;
  m.clueBand = shipped.length > 1 && m.clue.p50 ? (m.clue.max - m.clue.min) / m.clue.p50 : NaN;

  // 6) 每条规则出场盘数 + 命中数 + 最大贡献样本（聚合数必带最大贡献者，见文件头 ②）
  m.rules = RULE_ORDER.map((key) => {
    const per = shipped.map((r) => r.hits[key] || 0);
    const total = per.reduce((a, b) => a + b, 0);
    let top = 0;
    let topSample = -1;
    per.forEach((v, k) => {
      if (v > top) {
        top = v;
        topSample = shipped[k].i;
      }
    });
    const touched = per.filter((v) => v > 0).length;
    return { key, total, top, topSample, topShare: total ? top / total : 0, touched, cover: shipped.length ? touched / shipped.length : NaN };
  });
  const perBoardHits = shipped.map((r) => Object.values(r.hits).reduce((a, b) => a + b, 0));
  m.allHits = perBoardHits.reduce((a, b) => a + b, 0);
  m.topHits = perBoardHits.length ? Math.max(...perBoardHits) : 0;
  m.topHitsShare = m.allHits ? m.topHits / m.allHits : 0;
  m.topHitsSample = m.topHits ? shipped[perBoardHits.indexOf(m.topHits)].i : -1;
  m.ids = ids;
  // 7) C1 救援率（pencil.js 承诺 balance 印的那一列）
  m.c1Rescued = shipped.filter((r) => r.c1Rescued).length;
  m.c1RescueBlankP50 = quantile(asc(shipped.filter((r) => r.c1Rescued).map((r) => r.c1RescueBlank)), 0.5);
  return m;
}

// 支配概率 P(大档分数 > 小档分数)：全对枚举，无随机、无比较器抽奖。
function dominance(smallRecs, bigRecs) {
  const a = smallRecs.filter((r) => r.ok).map((r) => r.score);
  const b = bigRecs.filter((r) => r.ok).map((r) => r.score);
  if (!a.length || !b.length) return NaN;
  let win = 0;
  let tie = 0;
  for (const x of b) for (const y of a) {
    if (x > y) win++;
    else if (x === y) tie++;
  }
  return (win + 0.5 * tie) / (a.length * b.length);
}

// ── GATES：每条阈值都在下面写明来历（实测值 / 为什么是这个数）──────────────────
// 下面"实测"一栏取自 SAMPLES=24 的正式跑（2026-09-28，本机 load1 见每次运行的抬头行）。
const T = {
  yieldMenu: 0.9, // 实测（SAMPLES=24，菜单档全部）出货率 100%：每档 24/24，抽卡 p50 = 1、菜单档 max = 1。
  // 取 90% 而不是 100%：菜单档点一次"换一局"必须有盘，24 盘里容许 2 盘空是"该报警"的信号线，
  // 不是"允许偶发"的许可；真出现就去修生成器，别把绿字改成"通常会出货"。
  zeroGuessMenu: 1.0, // 实测 100%。这条**必须**是 100%：出货流水线里就有这道门（generate.js:134-138 整盘
  // 铅笔门、:162-166 逐颗铅笔门），掉一盘就说明那句"零猜测推得完"是流水线的自述而不是事实。
  // 老实说（README 也要有这句）：正因为它是流水线的定义，整盘级淘汰实测 0/192 盘（SAMPLES=24）、0/480 盘（SAMPLES=60）——
  // 有信息量的是挖珠那一步的淘汰率（本文件打印的 dropByPencil/dropTried，SAMPLES=24 实测 0.3%~1.7%）。
  provenMenu: 1.0, // 「出货盘的独立复算一项不认账」= 0 张。含**逐颗必要性**：审计找出一颗还能删就红。
  wallMenuP95Ms: 300, // 实测（SAMPLES=24，本机 load1 16.6 的争用下）菜单最差档 8×12 墙钟 p50 110 /
  // p95 124 / max 126ms，9×9 p95 72ms ⇒ 300ms 留了 2.4 倍余量。而表外对照档 12×12 实测
  // p50 461 / p95 506 / max 822ms（npm run ceiling 那一轮 p95 504ms）⇒ 这条线正是把 12×12 挡在菜单外的
  // 刀口（tools/ceiling.mjs 每轮复核"菜单身份与实测是否自洽"，两边都不许手改）。为什么盯这么紧：
  // makePuzzle 是同步的、不可中断（js/engine/generate.js:206-241 一个 for 跑到底），
  // 出题那一下就是主线程被占住的那一下。
  // 这条线红了就把那一档从菜单摘下来，**不许**用放大 budget 或减少 maxTrials 救绿。
  wallShipP95Ms: 2000, // 房子口径（同 z-biz-game-slither-cos 的天花板线）：出货路径 p95 超过 2s 的档
  // 就叫"浏览器承诺不起点一下等多久"。本轮 ceiling 实测 12×15 p50 988 / p95 1460ms 仍在线内，
  // 12×18 p50 2225 / p95 2534ms 越过 ⇒ 天花板量在 12×15 与 12×18 之间，写死在 tools/ceiling.mjs 的红线里。
  // 对照档越线只记 note（它不发货）。
  dominance: 0.85, // 实测首末菜单档 P(8×12 分数 > 4×6) = 1.000（两档分数区间不重叠）。
  // 但这句话**没有难度含义**：score/N 4.88→6.23、steps/N 1.92→2.33 都接近常数，跨档分数就是尺寸的
  // 影子（README 里就这么写）。门槛留着只抓一件事——"大档反而比小档容易"这种真事故。
  corrScoreClue: -0.35, // 档内第二条轴（线索稀度）。六规则下**本轮重测**（SAMPLES=24，出货盘全档 ≥20）：
  // 4x6 −0.93 / 6x6 −0.91 / 6x8 −0.85 / 6x9 −0.93 / 8x9 −0.91 / 9x9 −0.87 / 8x12 −0.88 / 12x12 −0.81
  // ⇒ 红线 −0.35 留着 2.3 倍余量，抓的是"这条轴塌了"（比如以后把 score 改成按线索数计数）那种事故。
  // 老板给的那批 −0.75 来自工作区根目录的**四规则原型** `_tmp-triplets-lib.mjs`，口径不同，本仓不引用它。
  gateControlSizes: false, // 表外对照档（12×12 等）：读数照打，破口只记 note 不记 red —— 门禁守的是
  // 发货承诺，对照档根本不发货，把它的破口算进 RESULT 会被一个不存在的档位卡住。
  contributionUniformFactor: 2.5, // 单盘独占全部命中的比例上限 = 2.5/SAMPLES（均匀分布下一盘只独占
  // 1/SAMPLES）。实测 SAMPLES=24 时各档最大单盘独占 ~4%（基线 1/24 = 4.2%）。聚合命中数必须带这一列，
  // 否则一个退化样本就能撑起整档的"命中率"（本组织那次事故的教训）。
  ruleTopShareMax: 0.6, // 单条规则命中里最大贡献样本占比 >60% 只记 note：冷门规则由一两盘撑起时
  // 该看的是"覆盖几盘"那一列，不是聚合数。
  deadRuleIsRed: true, // 一条规则在**整条梯子**上出场 0 盘 ⇒ 红（masyu 那仓有一条 0/192 的死规则，
  // 本仓实测六条全出场，所以这条绿是真绿；写成红线是为了"以后加规则时不许没人查出场"）。
};
const shareCap = () => Math.min(1, T.contributionUniformFactor / SAMPLES);
const GATES = [
  { key: 'yield', text: `菜单每档出货率 ≥ ${(T.yieldMenu * 100).toFixed(0)}%（实测 100%，${SAMPLES} 盘/档）` },
  { key: 'zeroGuess', text: `菜单每档零猜测可解率 = ${(T.zeroGuessMenu * 100).toFixed(0)}%，并照打"整盘级淘汰 0 盘"这句老实话（它是流水线的定义，不是独立闸）` },
  // proven 是这个仓的主账：出货盘独立复算「预算内 UNIQUE ∧ 铅笔推完 ∧ verify ∧ 逐颗必要性」，
  // 一张不认账就红，红名指到样本号。
  { key: 'proven', text: `出货盘独立复算：预算内 UNIQUE ∧ 铅笔零猜测推完 ∧ verify 通过 ∧ 逐颗必要性审计 0 颗多余（${T.provenMenu * 100}%，0 张不认账）` },
  // 这一条**不判红**，走逐档披露（口径与 proven 分开，两个量分开放）：计数器数不完 ≠ 证伪。
  { key: 'overbudget', text: 'OVERBUDGET 分开数并逐档披露：dropByOverbudget（颗）/ 涉及盘数 / 审计数不完（颗）——撞了就把那一档的"每颗都删不得"降级成逐档披露，不判红' },
  { key: 'monotone', text: `score p50 沿菜单不降，且首末两档支配概率 ≥ ${T.dominance}（并印"这只是尺寸差"的对照列 score/N、steps/N）` },
  { key: 'wall', text: `菜单档墙钟 p95 ≤ ${T.wallMenuP95Ms}ms；对照档照打，越过 ${T.wallShipP95Ms}ms 记 note（这条线就是天花板）` },
  { key: 'axis', text: `出货样本 ≥12 的档：档内 corr(score, 线索数) ≤ ${T.corrScoreClue}（第二轴必须是真的，不许引用四规则原型那批 −0.75）；样本不足只披露不判红` },
  { key: 'sound', text: 'illegalRef / refRejected / pencilStuckFull / dropByMismatch / overbudget / gate0Overbudget 恒为 0；steps ≤ 3N 恒成立' },
  { key: 'rules', text: `每条规则在整条梯子上至少出场 1 盘（死规则红线）；单档出场率 <100% 照实披露（A2 就是），单条独占 >${(100 * T.ruleTopShareMax).toFixed(0)}% 记 note` },
  { key: 'contribution', text: `每档最大单盘独占 ≤ ${shareCap().toFixed(2)}（＝${T.contributionUniformFactor}/SAMPLES）` },
];

// 一档的判定：flags = 红线（进 RESULT），notes = 只打印不拦。
function judge(sizeKey, m) {
  const flags = [];
  const notes = [];
  const isMenu = SIZES.includes(sizeKey);
  const push = (cond, what) => {
    if (cond) return;
    if (T.gateControlSizes || isMenu) flags.push(what);
    else notes.push(`（对照档 ${sizeKey}）${what}`);
  };
  const hard = (cond, what) => {
    if (!cond) flags.push(what); // 引擎正确性类：哪个档位非 0 都是写错，一律红
  };
  push(m.shipped / m.n >= T.yieldMenu, `${sizeKey} 出货率 ${m.shipped}/${m.n} < ${(T.yieldMenu * 100).toFixed(0)}%${m.failReasons.length ? `（${m.failReasons.join(' ')}）` : ''}`);
  push(m.zeroGuess / Math.max(1, m.shipped) >= T.zeroGuessMenu, `${sizeKey} 零猜测可解率 ${pct(m.zeroGuess, m.shipped)} < ${(T.zeroGuessMenu * 100).toFixed(0)}%`);
  push(m.proven === m.shipped, `${sizeKey} 已证 ${m.proven}/${m.shipped}：${m.unproven.length} 盘独立复算不认账（非唯一 ${m.ids(m.notUnique)}、推不完 ${m.ids(m.notSolved)}、verify 不过 ${m.ids(m.notVerified)}、与参考解不符 ${m.ids(m.mismatch)}、审计找到可删线索 ${m.ids(m.necViolation)}）`);
  push(m.wall.p95 <= (isMenu ? T.wallMenuP95Ms : T.wallShipP95Ms), `${sizeKey} 墙钟 p95 ${m.wall.p95}ms > ${isMenu ? T.wallMenuP95Ms : T.wallShipP95Ms}ms`);
  // 档内第二轴：corr 的判定要求 ≥12 个出货样本（Pearson r 在 6 个样本上的抽样噪声就有 ±0.4，
  // 拿它判红只会让门发红给样本量看）。样本不足时照打数字、不判红，并在行首写明"只披露"。
  if (m.shipped >= 12) {
    push(!Number.isFinite(m.corrScoreClue) || m.corrScoreClue <= T.corrScoreClue, `${sizeKey} 档内 corr(score, 线索数) = ${f2(m.corrScoreClue)} 没到 ${T.corrScoreClue}（线索稀度这条第二轴在本档不成立，README 那句得改）`);
  } else {
    notes.push(`${sizeKey} 出货样本 ${m.shipped} < 12 ⇒ corr(score, 线索数) = ${f2(m.corrScoreClue)} 只披露不判红（小样本的抽样噪声比这条线本身还大）`);
  }
  // 引擎正确性 + 账本口径：不分菜单/对照，非 0 就是写错
  hard(m.notUnique.length === 0 && m.notVerified.length === 0 && m.notSolved.length === 0, `${sizeKey} 有复算不过的盘（唯一性/verify/推完）`);
  for (const k of ['illegalRef', 'refRejected', 'pencilStuckFull', 'dropByMismatch', 'overbudget', 'gate0Overbudget']) {
    hard((m.agg[k] || 0) === 0, `${sizeKey} 应为 0 的项非 0：${k}=${m.agg[k] || 0}`);
  }
  hard(m.stepsBoundOk, `${sizeKey} 有盘的步数越过 3N 上界（Φ 只降不升那条不变式破了，pencil.js:398-411）`);
  hard(m.dropTried === m.dropKept + m.dropByPencil + m.dropByCounter + m.dropByOverbudget, `${sizeKey} 挖珠账不轧平：试 ${m.dropTried} ≠ 挖掉 ${m.dropKept} + 铅笔拒 ${m.dropByPencil} + 计数器拒 ${m.dropByCounter} + 数不完 ${m.dropByOverbudget}`);
  // OVERBUDGET 只披露，不判红（口径见 GATES.overbudget）
  if (m.dropByOverbudget) notes.push(`${sizeKey} 有 ${m.dropByOverbudget} 颗线索是"数不完所以留着"（dropByOverbudget，涉及 ${m.overbudgetBoards.length} 盘 ${m.ids(m.overbudgetBoards)}）⇒ 这些盘不许写"这颗非留不可"`);
  if (m.auditOverbudget.length) notes.push(`${sizeKey} 必要性审计里 ${m.auditOverbudgetCells} 颗数不完（涉及 ${m.auditOverbudget.length} 盘 ${m.ids(m.auditOverbudget)}）⇒ 独立复算也没证到那些颗`);
  push(m.topHitsShare <= shareCap(), `${sizeKey} 全档推理命中里最大单盘独占 ${(100 * m.topHitsShare).toFixed(0)}% > ${(100 * shareCap()).toFixed(0)}%（上限＝${T.contributionUniformFactor}/SAMPLES，聚合数是被一个样本撑起来的）`);
  for (const r of m.rules) {
    if (r.total > 0 && r.topShare > T.ruleTopShareMax) notes.push(`${sizeKey} 规则 ${r.key} 的 ${r.total} 次命中里 #${r.topSample} 独占 ${(100 * r.topShare).toFixed(0)}%（覆盖 ${r.touched}/${m.shipped} 盘）`);
  }
  return { flags, notes };
}

// ── 打印 ─────────────────────────────────────────────────────────────────
function printSize(sizeKey, m, recs, mono) {
  const tier = TIERS.find((x) => x.key === sizeKey);
  const tag = SIZES.includes(sizeKey) ? '菜单' : '对照';
  console.log(`\n── ${sizeKey}（${m.N} 格 / ${m.N / 3} 区，${tag}${tier && tier.unshippable ? '，ceiling 判定：不可出货 ' + tier.unshippable : ''}）样本 ${m.n} ──────`);
  console.log(`1) 抽卡 ${m.drawsTotal} 次（每盘 p50 ${f0(m.drawsP50)} max ${f0(m.drawsMax)}）→ 出货 ${m.shipped}/${m.n} = ${pct(m.shipped, m.n)} → 已证 ${m.proven}/${m.shipped}`);
  const A = m.agg;
  console.log(`   stats 归因（${STATS_KEYS.length} 项账，本档 ${m.n} 样本累计）：${STATS_KEYS.map((k) => `${k} ${A[k] || 0}`).join(' / ')}`);
  if (m.failReasons.length) console.log(`   没出货的样本：${m.failReasons.join(' ')}`);
  console.log(`   两条承诺分开数：已证 ${m.proven}/${m.shipped} 盘（不认账 ${m.unproven.length} 盘：非唯一 ${m.ids(m.notUnique)}、推不完 ${m.ids(m.notSolved)}、verify 不过 ${m.ids(m.notVerified)}、与参考解不符 ${m.ids(m.mismatch)}、可删线索 ${m.ids(m.necViolation)}）`);
  console.log(`   ｜OVERBUDGET（披露，不进红线）：挖珠时数不完放回 ${m.dropByOverbudget} 颗（涉及 ${m.overbudgetBoards.length} 盘）· 审计数不完 ${m.auditOverbudgetCells}/${m.auditedCells} 颗（涉及 ${m.auditOverbudget.length} 盘）`);
  console.log(`2) 零猜测率 ${m.zeroGuess}/${m.shipped} = ${pct(m.zeroGuess, m.shipped)}（出货盘独立复算）。老实说：这是**流水线的定义**，整盘级淘汰 ${m.boardKilledByPencil} 盘；`);
  console.log(`   有信息量的是挖珠那一步：试 ${m.dropTried} 颗 → 挖掉 ${m.dropKept} 颗、计数器拒 ${m.dropByCounter} 颗、铅笔拒 ${m.dropByPencil} 颗（${f1(100 * m.pencilRejectRate)}%）、数不完 ${m.dropByOverbudget} 颗`);
  console.log(`3) 线索 p50 ${f0(m.clue.p50)}（占 ${m.N} 格的 ${(100 * m.clueShare).toFixed(0)}%，区间 ${m.clue.min}..${m.clue.max}）｜score p50 ${f0(m.score.p50)} p95 ${f0(m.score.p95)} max ${f0(m.score.max)} min ${f0(m.score.min)}｜步数 p50 ${f0(m.steps.p50)} max ${f0(m.steps.max)}`);
  console.log(`   计数器结点 p50 ${f0(m.nodes.p50)} max ${f0(m.nodes.max)}（预算 ${BUDGET}）｜墙钟 p50 ${f0(m.wall.p50)} p95 ${f0(m.wall.p95)} max ${f0(m.wall.max)} ms`);
  console.log(`   steps 不当难度口径：steps/N = ${f2(m.stepsPerCell)}、score/N = ${f2(m.scorePerCell)}（都是格数的影子，不是"推理更深"）；档内第二轴 corr(score, 线索数) = ${f2(m.corrScoreClue)}（分数带宽 ${(100 * m.scoreBand).toFixed(0)}%，线索数带宽 ${(100 * m.clueBand).toFixed(0)}%）`);
  console.log(`4) 规则出场盘数（分母 = 出货盘 ${m.shipped}）｜全部命中 ${m.allHits} 次，最大贡献样本 #${m.topHitsSample} 独占 ${(100 * m.topHitsShare).toFixed(0)}%（上限 ${(100 * shareCap()).toFixed(0)}%）：`);
  for (const r of m.rules) {
    console.log(`     ${r.key.padEnd(22)} 出场 ${String(r.touched).padStart(2)}/${m.shipped} 盘（${pct(r.touched, m.shipped)}）命中 ${String(r.total).padStart(5)}（均 ${(m.shipped ? r.total / m.shipped : 0).toFixed(1)}/盘）｜最大贡献 ${r.top} 次=${(100 * r.topShare).toFixed(0)}%（#${r.topSample}）｜W=${RULE_WEIGHT[r.key]}｜${RULE_TEXT[r.key]}`);
  }
  console.log(`   C1 救援率（pencil.js:228-233 承诺印的那列）：摘掉 C1 推不完的盘 ${m.c1Rescued}/${m.shipped} = ${pct(m.c1Rescued, m.shipped)}（闷住时剩格 p50 ${f0(m.c1RescueBlankP50)}）`);
  if (mono) console.log(`5) ${mono.text}`);
}

// 一档正文 + 判决（红线打在最后，方便人一眼看到）。
function printSizeWithVerdict(sizeKey, m, recs, mono) {
  printSize(sizeKey, m, recs, mono);
  const { flags, notes } = judge(sizeKey, m);
  console.log(`   红线：${flags.length ? 'RED — ' + flags.join('；') : '无'}`);
  if (notes.length) console.log(`   披露项（不进 RESULT）：${notes.join('；')}`);
  return { flags, notes };
}

function main() {
  const per = {};
  for (const sizeKey of LADDER) {
    const recs = runSize(sizeKey, SAMPLES);
    per[sizeKey] = { recs, m: measure(recs, sizeKey) };
  }
  // 单调性只看菜单档（按格数升序）
  const menuAsc = SIZES.slice().sort((a, b) => CELLS(a) - CELLS(b) || (a < b ? -1 : a > b ? 1 : 0));
  const ladderMenu = menuAsc.filter((k) => per[k]);
  const seq = ladderMenu.map((k) => ({ k, p50: per[k].m.score.p50 }));
  const nonDescending = seq.every((x, i) => i === 0 || !(x.p50 < seq[i - 1].p50));
  const first = per[ladderMenu[0]];
  const last = per[ladderMenu[ladderMenu.length - 1]];
  const pScore = dominance(first.recs, last.recs);
  const firstScores = asc(first.recs.filter((r) => r.ok).map((r) => r.score));
  const lastScores = asc(last.recs.filter((r) => r.ok).map((r) => r.score));
  const mono = {
    // ONLY= 只跑一档时首末是同一档，P(自己 > 自己) 恒为 0.50 —— 那是单档梯子的定义，不是破口。
    // 单调性这条红线要比较的是"大档不比小档容易"，梯子至少两档才有这句话；单档时判 ok，但照样印出来。
    ok: ladderMenu.length < 2 || (nonDescending && pScore >= T.dominance),
    text: `单调性（只看菜单 ${ladderMenu.join('→')}${ladderMenu.length < 2 ? '，只有一档 ⇒ 跨档比较不适用，红线自动跳过' : ''}）score p50 ${seq.map((x) => `${x.k}:${f0(x.p50)}`).join(' ≤ ')} → ${nonDescending ? '不降 ✓' : '有下降 ✗'}；`
      + `区分力 P(${ladderMenu[ladderMenu.length - 1]} 分数 > ${ladderMenu[0]}) = ${f2(pScore)}（门槛 ${T.dominance}）；`
      + `两档区间 ${ladderMenu[0]} [${firstScores[0]}..${firstScores[firstScores.length - 1]}] vs ${ladderMenu[ladderMenu.length - 1]} [${lastScores[0]}..${lastScores[lastScores.length - 1]}]。`
      + `⚠ 这个 AUC 不描述推理深度：score/N ${f2(first.m.scorePerCell)}→${f2(last.m.scorePerCell)}、steps/N ${f2(first.m.stepsPerCell)}→${f2(last.m.stepsPerCell)} 都接近常数 ⇒ 跨档分数就是格数的影子。`,
  };

  // 死规则红线：整条梯子上出场 0 盘才算红（单档 0 盘只披露，见 judge）
  const globalCover = new Map(RULE_ORDER.map((k) => [k, { boards: 0, hits: 0 }]));
  for (const sizeKey of LADDER) for (const r of per[sizeKey].m.rules) {
    const g = globalCover.get(r.key);
    g.boards += r.touched;
    g.hits += r.total;
  }

  if (QUIET) {
    const flags = [];
    for (const sizeKey of LADDER) flags.push(...judge(sizeKey, per[sizeKey].m).flags);
    if (!mono.ok) flags.push(mono.text);
    for (const k of RULE_ORDER) if (globalCover.get(k).boards === 0) flags.push(`死规则：${k} 在 ${LADDER.join(',')} 共 ${per[LADDER[0]].m.n * LADDER.length} 个样本里一次都没出场`);
    if (doseLanded.length) {
      // 门禁模式也要把变异落地的证据打出来：一条从没红过的绿不算证人，A/B 得有可对拍的那一行。
      console.log(`[DOSE] 变异已落地：${doseLanded.join('；')}`);
      for (const f of flags) console.log(`  - ${f}`);
    }
    console.log(`RESULT ok=${flags.length === 0}`);
    return flags.length === 0 ? 0 : 1;
  }

  const la = loadavg();
  console.log(`balance 难度实测：SAMPLES=${SAMPLES} 档位=${LADDER.join(',')}（菜单 ${SIZES.join('/')}）预算=${BUDGET} 结点 maxTrials=${MAX_TRIALS} 审计预算=${AUDIT_BUDGET}`);
  console.log(`本机 load average（1/5/15）= ${la.map((x) => x.toFixed(2)).join(' / ')}，核数 ${cpus().length} ⇒ 墙钟绝对值随争用浮动，只当上界看；出货率/线索数/分数/步数/命中率是纯计算口径，同一批 seed 逐字节可复现。`);
  console.log(`可复现口径：seed 串 balance|<sizeKey>|<1..N>，随机不发生在生成器与任何 sort 比较器里（js/engine/rng.js:29-43）。`);
  const flags = [];
  const notes = [];
  for (const sizeKey of LADDER) {
    const r = printSizeWithVerdict(sizeKey, per[sizeKey].m, per[sizeKey].recs, SIZES.includes(sizeKey) && sizeKey === ladderMenu[ladderMenu.length - 1] ? mono : null);
    flags.push(...r.flags);
    notes.push(...r.notes);
  }
  if (!mono.ok) flags.push(mono.text);
  const dead = RULE_ORDER.filter((k) => globalCover.get(k).boards === 0);
  for (const k of RULE_ORDER) console.log(`规则出场（整条梯子 ${LADDER.length} 档 ×${SAMPLES} 盘）：${k} 覆盖 ${globalCover.get(k).boards} 盘、命中 ${globalCover.get(k).hits} 次`);
  if (dead.length && T.deadRuleIsRed) flags.push(`死规则：${dead.join(', ')} 在整条梯子一次都没出场 —— 要么删了它，要么说清它为什么还在表里`);

  console.log('\n── 档位对照（菜单 vs 表外；score 是 balance 的权重度量，不是引擎给的数）──');
  console.log('   尺寸   菜单 出货           零猜测  线索 p50(占格%)  score p50(每格)  steps p50  结点 p50/max   墙钟 p50/p95/max   corr(score,线索)');
  for (const sizeKey of LADDER) {
    const m = per[sizeKey].m;
    console.log(`   ${sizeKey.padEnd(6)} ${(SIZES.includes(sizeKey) ? '菜单' : '对照').padEnd(4)} ${`${m.shipped}/${m.n} 已证 ${m.proven}`.padEnd(14)} ${pct(m.zeroGuess, m.shipped).padEnd(7)} ${`${f0(m.clue.p50)}(${(100 * m.clueShare).toFixed(0)}%)`.padEnd(15)} ${`${f0(m.score.p50)}(${f2(m.scorePerCell)})`.padEnd(15)} ${f0(m.steps.p50).padStart(6)}  ${`${f0(m.nodes.p50)}/${f0(m.nodes.max)}`.padStart(11)}   ${`${f0(m.wall.p50)}/${f0(m.wall.p95)}/${f0(m.wall.max)}ms`.padEnd(19)} ${f2(m.corrScoreClue)}`);
  }
  console.log(`\n红线汇总：${flags.length ? `${flags.length} 项` : '0 项（全绿）'}`);
  for (const f of flags) console.log(`  - ${f}`);
  if (notes.length) {
    console.log(`披露项（不进 RESULT）：${notes.length} 项`);
    for (const f of notes) console.log(`  · ${f}`);
  }
  console.log('\n门禁口径（GATES，来历见 balance.mjs 里 T/GATES 的注释）：');
  for (const g of GATES) console.log(`  · ${g.text}`);
  if (doseLanded.length) {
    console.log(`\n[DOSE] 变异已落地：${doseLanded.join('；')}｜红线 ${flags.length} 项` +
      (flags.length ? '（摘一颗线索就红 ⇒ proven 那条闸确实咬得住，红名指到了那一盘）' : '（摘了线索还全绿 ⇒ 这条闸不咬，上面的绿别当证据）'));
  }
  console.log(`RESULT ok=${flags.length === 0}`);
  return flags.length === 0 ? 0 : 1;
}

process.exit(main());
