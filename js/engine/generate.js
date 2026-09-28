// 出题器：随机剖分 → 造合法解 → 从满线索逐颗挖，每挖一颗都重新同时过"唯一"和"铅笔推完"
// 两道门 → 出货。
//
// 流程（全都只吃 seed，没有 Math.random / Date.now / 任何时钟参与判定）：
//   ① partition.js 切一张 3 格区域的盘、造一个满足 P3/P4 的参考解。
//   ② 门 0：参考解必须过 counter.satisfies（生成器自己写错就在这儿红），
//      满线索题面的解数必须是 1（预算内）。
//   ③ 门 1：同一份题面，铅笔必须在零猜测下推到底，且**逐格等于参考解**。
//   ④ 挖线索：按预抽好的格序逐颗试着删。删掉后"计数器 UNIQUE（预算内）"且"铅笔推得完并对得上
//      参考解"才保留；任何一道门没过就把这颗线索放回去。超预算＝这颗线索必须留着，
//      所以**最终端出去的题一定是预算内 UNIQUE 的，OVERBUDGET 的候选永远不出货**。
//   ⑤ 出货前复核：对最终题面再问一次计数器 + 再跑一次铅笔（第 ④ 步的最后一次是"没删成"的
//      那一版，这里独立再算一遍，防止循环里的状态漂移）。
//
// 于是端出去的每一盘同时带着两张证：
//   唯一解 —— 独立穷举计数器在预算内数出 1；
//   零猜测 —— 命名规则表从空题面推到填满，一次都不回溯。
// 而且**每一颗留下的线索都被逐颗试过**：删掉它之后两道门里至少一道不过（分类见 stats）。
// 这句是本仓跟 masyu/slither 拉开区别的地方 —— 它们的计数器会撞预算，所以证不到"逐颗试过"。
//
// 本文件只 import partition / pencil / counter / rng / grid，不共享它们的规则表：
// 铅笔和计数器各自独立实现（谁都不 import 谁），两边都点头才出货。
//
// 浏览器可用：本文件不碰 process / fs；计时由调用方注入（opts.now），默认不计时。

import { makeRng } from './rng.js';
import { makeBoard } from './partition.js';
import { countByRegion, satisfies, DEFAULT_BUDGET, DEFAULT_CAP } from './counter.js';
import { solveWithRules, verify } from './pencil.js';

// 出货尺寸：表里每一档都是**实测跑过**的档（npm run ceiling / npm run balance 打印读数）。
// 12x12 是表内最外面那一档：实测能出货（墙钟 p50 ~0.5s、计数器结点离预算差三个数量级），
// 但同步出题的等待越过菜单红线 ⇒ 只当对照档量，不进菜单（判定与实测数见 tools/ceiling.mjs）。
export const SIZE_TABLE = {
  '4x6': [4, 6],
  '6x6': [6, 6],
  '6x8': [6, 8],
  '6x9': [6, 9],
  '8x9': [8, 9],
  '9x9': [9, 9],
  '8x12': [8, 12],
  '12x12': [12, 12],
};

// 菜单档 = SIZE_TABLE 里过得了"点一下换一局"那条墙钟红线的档（tools/ceiling.mjs 的 WALL_MENU_P95_MS）。
// 这条线是**量出来的**：ceiling 每轮复核"每一档的实测 p95 与它的菜单身份是否自洽"，
// 红了就改档位表而不是改红线（纪律：不许为了让命令变绿而放宽预算或期望值）。
export const SIZES = ['4x6', '6x6', '6x8', '6x9', '8x9', '9x9', '8x12'];

// 档位表：maxDraws 是"这一档最多抽几张就停手"，ceiling/balance 用它当普查预算。
// unshippable 由 tools/ceiling.mjs 量完再填，**不许手填感觉**：null = 本轮实测在红线内，
// 字符串 = 撞了哪条线（写读数，不写形容词）。
export const TIERS = [
  { key: '4x6', inMenu: true, maxDraws: 40, unshippable: null },
  { key: '6x6', inMenu: true, maxDraws: 40, unshippable: null },
  { key: '6x8', inMenu: true, maxDraws: 40, unshippable: null },
  { key: '6x9', inMenu: true, maxDraws: 40, unshippable: null },
  { key: '8x9', inMenu: true, maxDraws: 40, unshippable: null },
  { key: '9x9', inMenu: true, maxDraws: 40, unshippable: null },
  { key: '8x12', inMenu: true, maxDraws: 40, unshippable: null },
  { key: '12x12', inMenu: false, maxDraws: 40, unshippable: '墙钟 p95 504ms > 菜单线 300ms（npm run ceiling 实测 2026-09-28，load1 16.6：出货 6/6、单盘最大抽卡 2、OVERBUDGET 0）' },
];

export function parseSize(sizeKey) {
  const pair = SIZE_TABLE[sizeKey];
  if (pair) return { w: pair[0], h: pair[1] };
  const m = /^(\d+)x(\d+)$/.exec(String(sizeKey));
  if (!m) throw new Error(`未知尺寸 ${sizeKey}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

export function sizeAllowed(sizeKey) {
  const { w, h } = parseSize(sizeKey);
  return (w * h) % 3 === 0;
}

export function newStats() {
  return {
    draws: 0, // 为了端出这一盘抽了几次卡
    partitionRestarts: 0, // 剖分内部整盘重启的次数
    noBoard: 0, // 剖分/造解没成（生成器自己的运气，不是谜题难度）
    illegalRef: 0, // 参考解过不了 satisfies（应为 0，出现即 partition.js 写错）
    refRejected: 0, // 满线索题面被计数器判不是唯一（应为 0，出现即两边有一边写错）
    pencilStuckFull: 0, // 门 1：满线索铅笔推不完（应为 0，满线索是把答案抄在盘上）
    dropByMismatch: 0, // 铅笔推完却定出另一个解（应为 0，出现即铅笔不 sound）
    dropTried: 0,
    dropKept: 0, // 真正挖掉的线索数
    dropByPencil: 0, // 删了就铅笔推不完
    dropByCounter: 0, // 删了就不唯一
    dropByOverbudget: 0, // 删了以后计数器超预算（这颗只能留着，且"极小性"没证到）
    gate0Overbudget: 0, // 门 0 撞预算
    overbudget: 0, // 出货复核撞预算（应为 0，出现即这张盘不能上货架）
  };
}

// 把题面压成一个稳定指纹（同样的题面永远得到同样的串，全程无浮点）。
export function fingerprint(w, h, reg, givens) {
  let r = '';
  for (let i = 0; i < w * h; i++) r += reg[i].toString(36);
  let g = '';
  for (let i = 0; i < w * h; i++) g += (givens[i] < 0 ? '.' : String(givens[i]));
  return `${w}x${h}|${r}|${g}`;
}

// 一次抽卡：剖分 + 造解 + 两道门 + 挖珠循环。成功返回题面，失败返回 status。
export function attemptOnce({ w, h, seed, budget = DEFAULT_BUDGET, cap = DEFAULT_CAP, dfsBudget, rules }) {
  const stats = newStats();
  const rnd = makeRng(seed);
  const board = makeBoard(w, h, rnd, { dfsBudget });
  if (!board) {
    stats.noBoard = 1;
    return { ok: false, status: 'noBoard', stats };
  }
  stats.partitionRestarts = board.partitionRestarts;
  const { reg, val: solution } = board;
  const n = w * h;
  const fullGivens = Int8Array.from(solution);
  const ask = (givens) => countByRegion({ w, h, reg, givens }, { cap, budget });

  // 门 0：参考解自己得合法 + 满线索数得出唯一
  if (!satisfies(w, h, reg, solution)) {
    stats.illegalRef = 1;
    return { ok: false, status: 'illegalRef', stats };
  }
  const full = ask(fullGivens);
  if (full.stopped) {
    stats.gate0Overbudget = 1;
    return { ok: false, status: 'overbudgetFull', stats };
  }
  if (full.count !== 1) {
    stats.refRejected = 1;
    return { ok: false, status: 'notUniqueFull', stats };
  }
  const fullPencil = solveWithRules({ w, h, reg, givens: fullGivens }, { rules });
  if (fullPencil.status !== 'solved' || !fullPencil.st || verify(fullPencil.st).ok !== true) {
    stats.pencilStuckFull = 1;
    return { ok: false, status: 'pencilStuckFull', stats };
  }
  for (let i = 0; i < n; i++) {
    if (fullPencil.out[i] !== solution[i]) {
      stats.dropByMismatch = 1;
      return { ok: false, status: 'pencilMismatch', stats };
    }
  }

  // 挖线索：格序由**预抽好随机键**的 shuffle 给出（比较器里不抽随机数）
  let givens = fullGivens;
  const order = rnd.shuffle(Array.from({ length: n }, (_, i) => i));
  for (const i of order) {
    const trial = Int8Array.from(givens);
    trial[i] = -1;
    stats.dropTried++;
    const c = ask(trial);
    if (c.stopped) {
      stats.dropByOverbudget++;
      continue; // 数不完 ⇒ 这颗线索必须留着，且极小性没证到
    }
    if (c.count !== 1) {
      stats.dropByCounter++;
      continue; // 不唯一（0 解或多解）⇒ 留着
    }
    const p = solveWithRules({ w, h, reg, givens: trial }, { rules });
    if (p.status !== 'solved' || verify(p.st).ok !== true) {
      stats.dropByPencil++;
      continue; // 推不完 ⇒ 留着（0 解的盘 count!==1 已经在上面拦掉了）
    }
    let mismatch = false;
    for (let t = 0; t < n; t++) if (p.out[t] !== solution[t]) mismatch = true;
    if (mismatch) {
      stats.dropByMismatch++;
      return { ok: false, status: 'pencilMismatch', stats }; // 铅笔不 sound ⇒ 这张盘不可能是真盘
    }
    givens = trial;
    stats.dropKept++;
  }

  // 出货前独立复核（第 ④ 步最后一次成功删改之后没再整体验过）
  const finalCount = ask(givens);
  if (finalCount.stopped) return { ok: false, status: 'overbudget', stats };
  if (finalCount.count !== 1) return { ok: false, status: 'notUnique', stats };
  const finalPencil = solveWithRules({ w, h, reg, givens }, { rules });
  if (finalPencil.status !== 'solved' || verify(finalPencil.st).ok !== true) return { ok: false, status: 'pencilStuck', stats };
  let mismatch2 = false;
  for (let t = 0; t < n; t++) if (finalPencil.out[t] !== solution[t]) mismatch2 = true;
  if (mismatch2) {
    stats.dropByMismatch++;
    return { ok: false, status: 'pencilMismatch', stats };
  }
  if (!finalCount.truth || finalCount.truth.some((v, i) => v !== solution[i])) {
    stats.refRejected++;
    return { ok: false, status: 'truthMismatch', stats };
  }
  return {
    ok: true,
    status: 'ok',
    puzzle: { w, h, reg, givens },
    solution,
    stats,
    hits: finalPencil.hits,
    steps: finalPencil.steps,
  };
}

// 出货：抽卡直到端出一盘，最多 maxTrials 次。
// 返回 { ok, status, puzzle, solution, stats, draws }
export function makePuzzle(seed, sizeKey, opts = {}) {
  const { w, h } = parseSize(sizeKey);
  const maxTrials = opts.maxTrials ?? 40;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const now = opts.now || null;
  const t0 = now ? now() : 0;
  const agg = newStats();
  let shipped = null;
  for (let trial = 0; trial < maxTrials; trial++) {
    const r = attemptOnce({
      w, h, seed: `${seed}|${sizeKey}|${trial}`, budget, cap: opts.cap ?? DEFAULT_CAP,
      dfsBudget: opts.dfsBudget, rules: opts.rules,
    });
    agg.draws++;
    for (const k of Object.keys(agg)) {
      if (k === 'draws') continue;
      agg[k] += r.stats[k] || 0;
    }
    if (r.ok) {
      shipped = r;
      break;
    }
  }
  if (!shipped) return { ok: false, status: 'trialsExhausted', stats: agg, draws: agg.draws };
  return {
    ok: true,
    status: 'ok',
    puzzle: shipped.puzzle,
    solution: shipped.solution,
    hits: shipped.hits,
    steps: shipped.steps,
    stats: agg,
    draws: agg.draws,
    ms: now ? now() - t0 : null,
  };
}

// 出货前那张"每一颗留下的线索都被逐颗试过"的账，独立复算一遍给 balance 用：
// 返回每条线索的分类（unnecessary = 删掉两道门都过 ⇒ 循环漏了，必须是 0）。
export function auditClueNecessity(puzzle, opts = {}) {
  const { w, h, reg, givens } = puzzle;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const cap = opts.cap ?? DEFAULT_CAP;
  const out = [];
  for (let i = 0; i < w * h; i++) {
    if (givens[i] < 0) continue;
    const trial = Int8Array.from(givens);
    trial[i] = -1;
    const c = countByRegion({ w, h, reg, givens: trial }, { cap, budget });
    const p = c.stopped ? null : solveWithRules({ w, h, reg, givens: trial }, { rules: opts.rules });
    out.push({
      cell: i,
      overbudget: c.stopped,
      notUnique: !c.stopped && c.count !== 1,
      pencilStuck: !!p && p.status !== 'solved',
      pass: !!p && p.status === 'solved' && verify(p.st).ok === true && !c.stopped && c.count === 1,
    });
  }
  return out;
}
