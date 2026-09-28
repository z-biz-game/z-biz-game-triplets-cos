#!/usr/bin/env node
// 计数器验收：三个互不信任的实现必须在每盘上给同一个数。
//   ① 暴力 3^N 枚举（tools 里现写，用 grid.js 的几何）—— 最笨、最不像会错的一份
//   ② 区域推进计数器 js/engine/counter.js:countByRegion（出货用的那台，零随机）
//   ③ 朴素逐格计数器 js/engine/counter.js:countNaive（叶子处第三次表达规则题面）
// 覆盖面必须含 0 解盘与多解盘（只测唯一解盘的"对账"等于没测）。
// 另加：OVERBUDGET 语义（数不完时不许说"唯一"）+ "OVERBUDGET 永不上架"的证人。
import { makePuzzle } from '../js/engine/generate.js';
import { countByRegion, countNaive, satisfies } from '../js/engine/counter.js';
import { makeBoard } from '../js/engine/partition.js';
import { makeRng } from '../js/engine/rng.js';
import { cellsOfRegions, borderPairs, regionTypeOf, REGION_ALL_SAME, REGION_ALL_DIFF } from '../js/engine/grid.js';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks++;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}

// ── ① 暴力 3^N：只用 grid.js 的几何，规则按题面文字直译 ────────────────────
function countBrute(puzzle) {
  const { w, h, reg, givens } = puzzle;
  const n = w * h;
  const regions = cellsOfRegions(reg, w * h);
  const pairs = borderPairs(w, h, reg);
  const val = new Int8Array(n);
  let count = 0;
  const walk = (i) => {
    if (i === n) {
      for (const cs of regions) {
        const t = regionTypeOf(cs, val);
        if (t !== REGION_ALL_SAME && t !== REGION_ALL_DIFF) return;
      }
      for (const [a, b] of pairs) if (val[a] === val[b]) return;
      count++;
      return;
    }
    const lo = givens[i] >= 0 ? givens[i] : 0;
    const hi = givens[i] >= 0 ? givens[i] : 2;
    for (let s = lo; s <= hi; s++) { val[i] = s; walk(i + 1); }
    if (givens[i] < 0) val[i] = 0;
  };
  walk(0);
  return count;
}

// ── 小盘穷举：3×2 / 2×3 的全部题面（每格 4 态），三台必须逐盘相同 ───────────
function sweepSmall(w, h, regArr, label) {
  const n = w * h;
  const reg = Int8Array.from(regArr);
  let boards = 0;
  let zero = 0;
  let multi = 0;
  let uniq = 0;
  const total = 4 ** n;
  const gv = new Int8Array(n);
  for (let code = 0; code < total; code++) {
    let t = code;
    let given = 0;
    for (let i = 0; i < n; i++) { const d = t & 3; t >>= 2; gv[i] = d === 3 ? -1 : d; if (d !== 3) given++; }
    if (given === 0) continue; // 空题面不在验收范围（它不是题）
    const p = { w, h, reg, givens: Int8Array.from(gv) };
    const b = countBrute(p);
    const dp = countByRegion({ ...p }, { cap: Infinity, budget: 2_000_000 });
    const nv = countNaive({ ...p }, { budget: 2_000_000, cap: Infinity });
    boards++;
    if (b === 0) zero++; else if (b === 1) uniq++; else multi++;
    if (!ok(dp.count === b, `${label}：DP 与暴力不一致`, `题面 ${Array.from(gv).join('')} 暴力 ${b}，DP ${dp.count}`)) break;
    if (!ok(nv.count === b, `${label}：朴素与暴力不一致`, `题面 ${Array.from(gv).join('')} 暴力 ${b}，朴素 ${nv.count}`)) break;
    if (!ok(!dp.stopped && !nv.stopped, `${label}：小盘不许 OVERBUDGET`)) break;
    if (b === 1 && !ok(dp.truth && nv.truth && dp.truth.every((v, i) => v === nv.truth[i]), `${label}：唯一解的两份真值不一致`)) break;
  }
  notes.push(`${label} 穷举 ${boards} 个题面：0 解 ${zero}｜唯一解 ${uniq}｜多解 ${multi}｜三台逐盘相同`);
  return { boards, zero, multi, uniq };
}
{
  sweepSmall(3, 2, [0, 0, 0, 1, 1, 1], '3×2 横条');
  sweepSmall(2, 3, [0, 1, 0, 1, 0, 1], '2×3 竖条');
  // 一个 L 形分区的 3×2（同区两格纵向、一格横向）—— 换几何再扫一遍
  sweepSmall(3, 2, [0, 0, 1, 1, 1, 0], '3×2 L 形');
}

// ── ② 中盘抽样：随机题面（含挖到多解 / 改坏到 0 解），三台对账 ───────────────
{
  const rnd = makeRng('counter-test|mid');
  let scanned = 0;
  let clueMin = 99;
  let zero = 0;
  let multi = 0;
  let uniq = 0;
  for (let round = 0; round < 260; round++) {
    const w = 3 + (round % 3); // 3..5
    const h = 2 + ((round >> 1) % 3); // 2..4
    if ((w * h) % 3) continue;
    const b = makeBoard(w, h, makeRng(`counter-test|${round}`), { dfsBudget: 20_000 });
    if (!b) continue;
    const givens = Int8Array.from(b.val);
    const keep = 1 + rnd.int(w * h); // 想留几颗线索（1..N）—— 少留就是多解盘的来源
    let alive = w * h;
    while (alive > keep) {
      const i = rnd.int(w * h);
      if (givens[i] < 0) continue;
      givens[i] = -1;
      alive--;
    }
    if (round % 4 === 0) { // 1/4 的盘改坏一颗还在的给定 ⇒ 0 解盘的来源
      const pool = [];
      for (let i = 0; i < w * h; i++) if (givens[i] >= 0) pool.push(i);
      if (pool.length) {
        const i = pool[rnd.int(pool.length)];
        givens[i] = (givens[i] + 1 + rnd.int(2)) % 3;
      }
    }
    const p = { w, h, reg: b.reg, givens };
    const left = Array.from(givens).filter((v) => v >= 0).length;
    clueMin = Math.min(clueMin, left);
    const brutish = w * h <= 15 ? countBrute(p) : null;
    const dp = countByRegion({ ...p }, { cap: Infinity, budget: 4_000_000 });
    const nv = countNaive({ ...p }, { budget: 4_000_000, cap: Infinity });
    if (dp.stopped || nv.stopped) { ok(false, '抽样中盘不该 OVERBUDGET', `${w}×${h} dp=${dp.count}/${dp.stopped} nv=${nv.count}/${nv.stopped}`); continue; }
    scanned++;
    ok(dp.count === nv.count, `中盘 ${w}×${h} 题面 ${Array.from(givens).join('')}：DP=${dp.count} 朴素=${nv.count}`);
    if (brutish !== null) ok(dp.count === brutish, `中盘 ${w}×${h}：暴力=${brutish} 与 DP=${dp.count} 必须相同`);
    if (dp.count === 1 && nv.count === 1) ok(dp.truth && nv.truth && dp.truth.every((v, i) => v === nv.truth[i]), '两份真值必须逐格相同');
    if (dp.count === 0) zero++; else if (dp.count === 1) uniq++; else multi++;
  }
  ok(zero > 0 && multi > 0, '抽样必须真的覆盖 0 解盘与多解盘（否则本节等于只测唯一解）', `0 解 ${zero}｜多解 ${multi}｜唯一 ${uniq}`);
  ok(clueMin <= 3, '抽样里必须真有"只剩几颗线索"的稀疏盘（多解的来源）', String(clueMin));
  notes.push(`中盘抽样 ${scanned} 盘（≤15 格另附暴力）：0 解 ${zero}｜唯一解 ${uniq}｜多解 ${multi}`);
}

// ── ③ cap 语义：数到第 cap 个就停，不许把"停"说成"就这么多" ────────────────
{
  const p = { w: 3, h: 2, reg: Int8Array.from([0, 0, 0, 1, 1, 1]), givens: Int8Array.from([-1, -1, -1, -1, -1, -1]) };
  // 空题面：3×2 的合法填法 = 每区 9 种 × 跨区相容，暴力给基准
  const all = countBrute(p);
  ok(all > 2, '基准盘必须是多解盘', String(all));
  for (const cap of [1, 2, 3, 5, 50]) {
    const c = countByRegion({ ...p }, { cap, budget: 500_000 });
    ok(c.count === Math.min(all, cap), `cap=${cap} 必须停在 ${Math.min(all, cap)}，实得 ${c.count}`);
    ok(c.stopped === false, `cap=${cap}：stopped 只表示"预算烧完"，cap 收工不许冒充它`, String(c.stopped));
  }
  // DEFAULT_CAP=2 是承重的：cap=1 时"多解盘"会被读成"唯一解"
  const one = countByRegion({ ...p }, { cap: 1, budget: 500_000 });
  ok(one.count === 1 && all > 1, '证人：cap=1 会在多解盘上报 1 ⇒ 出货必须用 cap≥2（DEFAULT_CAP）', `cap=1 报 ${one.count}，实有 ${all}`);
  const def = countByRegion({ ...p }, { budget: 500_000 });
  ok(def.count === 2 && def.count !== 1, '同一盘用默认 cap=2 立刻显出"不止一解"', String(def.count));
  notes.push(`cap 证人：基准盘实有 ${all} 解；cap=1 只报 ${one.count}（会被误读成唯一解），默认 cap=2 报 ${def.count}`);
  void p;
}

// ── ④ OVERBUDGET 语义 + "永不上架"证人 ─────────────────────────────────────
{
  const t0 = performance.now();
  const r = makePuzzle('counter-test|overbudget', '6x9', { maxTrials: 1, budget: 3 });
  const ms = performance.now() - t0;
  ok(!r.ok, '预算只有 3 个结点的管线必须出货失败（数不完 ⇒ 不许上架）', `${r.status} ms=${ms.toFixed(1)}`);
  ok(r.status === 'overbudgetFull' || r.status === 'trialsExhausted' || r.status === 'overbudget' || r.status === 'notUnique',
    '失败原因必须是"数不完/不唯一"这一族', r.status);
  ok(r.stats.draws === 1 && r.stats.gate0Overbudget === 1, '账本必须把这次 OVERBUDGET 记在 gate 0 上', JSON.stringify({ draws: r.stats.draws, g: r.stats.gate0Overbudget }));
  notes.push(`预算=3 的 6×9 抽卡：status=${r.status}，gate0Overbudget=${r.stats.gate0Overbudget}（${ms.toFixed(0)}ms）—— 数不完时它说的是"没数完"，不是"唯一"`);
  // 同一颗 seed、正常预算 ⇒ 必须出货（证明上一条红不是因为盘坏了）
  const g = makePuzzle('counter-test|overbudget', '6x9', { maxTrials: 1 });
  ok(g.ok, '同一 seed 给正常预算必须出货', g.status);
  ok(g.stats.gate0Overbudget === 0 && g.stats.overbudget === 0, '正常预算下 OVERBUDGET 计数必须为 0', JSON.stringify(g.stats));
}

// ── ⑤ 三份几何必须同意（grid.js 与 counter.js/pencil.js 各自的副本）────────
{
  const p = makePuzzle('counter-test|geom', '6x8', { maxTrials: 3 });
  ok(p.ok, '拿一张 6×8 出货盘做几何对账', 'no board');
  if (p.ok) {
    const { w, h, reg, givens } = p.puzzle;
    const sol = Int8Array.from(p.solution);
    const regions = cellsOfRegions(reg, w * h);
    ok(regions.length * 3 === w * h, 'grid.js：每区必须恰好 3 格', `${regions.length} 区 / ${w * h} 格`);
    // 参考解：三套实现都必须说合法
    ok(satisfies(w, h, reg, sol), 'counter.js 的 satisfies 必须认可参考解');
    let badRegion = 0;
    for (const cs of regions) {
      const t = regionTypeOf(cs, sol);
      if (t !== REGION_ALL_SAME && t !== REGION_ALL_DIFF) badRegion++;
    }
    ok(badRegion === 0, 'grid.js 的 regionTypeOf 必须认可参考解的每一区', String(badRegion));
    const pairs = borderPairs(w, h, reg);
    ok(pairs.every(([a, b]) => sol[a] !== sol[b]), 'grid.js 的 borderPairs 必须认可参考解的每一条边界');
    // 单格变异：三套实现必须同时说不合法（挑一种真的会破规则的改法）
    let mutated = 0;
    let agreed = 0;
    for (let i = 0; i < w * h; i++) {
      for (let s = 0; s < 3; s++) {
        if (s === sol[i]) continue;
        const val = Int8Array.from(sol); val[i] = s;
        const cs = regions.find((c) => c.includes(i));
        const tri = regionTypeOf(cs, val);
        const regionBroken = tri !== REGION_ALL_SAME && tri !== REGION_ALL_DIFF;
        const borderBroken = borderPairsOf(pairs, i).some(([a, b]) => val[a] === val[b]);
        const broken = regionBroken || borderBroken;
        const sat = satisfies(w, h, reg, val);
        const cnt1 = countByRegion({ w, h, reg, givens: val }, { cap: 2, budget: 500_000 });
        mutated++;
        const agree = broken === !sat && (broken ? cnt1.count === 0 : cnt1.count >= 1);
        if (agree) agreed++;
        ok(agree, `单格变异 格${i}=${s}：grid.js(${regionBroken ? '破区' : 'ok'}${borderBroken ? '+破边' : ''}) 与 counter.js 的 satisfies(${!sat}) 与解数(${cnt1.count}) 必须同时表态`);
      }
    }
    ok(mutated === 2 * (w * h), `变异数必须是 2N = ${2 * (w * h)}（每格 2 个替代符号）`, String(mutated));
    ok(agreed === mutated, '变异一致性：每一枚单格变异三处表态都要一致', `${agreed}/${mutated}`);
    notes.push(`几何对账（6×8 一张盘）：${mutated} 个单格变异，grid.js / counter.js 的 satisfies / 解数三处表态全一致`);
    void givens;
  }
}
function borderPairsOf(pairs, i) {
  return pairs.filter(([a, b]) => a === i || b === i);
}

// ── ⑥ 出货盘上两台计数器的规模账 ──────────────────────────────────────────
{
  const lines = [];
  for (const t of ['4x6', '6x6', '6x8', '6x9']) {
    let nodesMax = 0;
    let wallNaiveMax = 0;
    let scanned = 0;
    for (let i = 1; i <= 6; i++) {
      const r = makePuzzle(`counter-test|${t}|${i}`, t, { maxTrials: 6 });
      if (!r.ok) { ok(false, `${t} 第 ${i} 盘没出货`, r.status); continue; }
      const p = { ...r.puzzle };
      const dp = countByRegion(p, { cap: 2, budget: 500_000 });
      const t0 = performance.now();
      const nv = countNaive(p, { budget: 8_000_000 });
      wallNaiveMax = Math.max(wallNaiveMax, performance.now() - t0);
      scanned++;
      ok(dp.count === 1 && nv.count === 1, `${t} 第 ${i} 盘：两台都必须数出唯一解`, `DP=${dp.count} 朴素=${nv.count}`);
      ok(dp.truth.every((v, k) => v === nv.truth[k] && v === r.solution[k]), `${t} 第 ${i} 盘：三份真值必须逐格相同`);
      nodesMax = Math.max(nodesMax, dp.nodes);
    }
    lines.push(`${t} ${scanned} 盘：DP 节点 max ${nodesMax}｜朴素墙钟 max ${wallNaiveMax.toFixed(0)}ms`);
  }
  notes.push(...lines);
}

for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails.slice(0, 12)) console.log(`  ✗ ${f}`);
console.log(`RESULT counter-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
