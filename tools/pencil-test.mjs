#!/usr/bin/env node
// 铅笔验收：整条推理链逐口对账，外加"变异必须被拒收"的证人。
//   ① 每一口结论都要独立复核：落子的格子钉上这个符号 ⇒ 解数不变，钉上别的 ⇒ 0 解；
//      删值那一格钉上被删的符号 ⇒ 0 解。任何一口的参考解不一致 ⇒ wrong placement 计数 +1。
//   ② 结构证人：每一步必须**严格减少候选比特总数**（只会删信息、不会凭空加 ⇒ 没有试数/回溯的藏身处），
//      于是步数 ≤ 3N；solved 必须满盘落子；同一 seed 两次跑必须逐字同一串 log。
//   ③ 变异证人：单格改色（必须破 P3）与"把一条区域边界挪一刀"（P3 全好、只破 P4）都要被
//      verify 拒收，且拒收的理由必须是那一类；counter.js 的 satisfies 与 grid.js 的判据必须同意。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePuzzle, SIZE_TABLE, SIZES } from '../js/engine/generate.js';
import { createState, advance, nextDeduction, applyDeduction, verify, RULE_ORDER, blankCount, SYMBOL_TEXT } from '../js/engine/pencil.js';
import { countByRegion, satisfies } from '../js/engine/counter.js';
import { cellsOfRegions, borderPairs, regionTypeOf, REGION_ALL_SAME, REGION_ALL_DIFF } from '../js/engine/grid.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks++;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}
const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.round((a.length - 1) * p))] : NaN; };

// ── ② 结构证人（源码级）：两份实现各自独立，谁也不许偷看谁的判据 ───────────
{
  const src = (f) => readFileSync(join(HERE, '..', 'js', 'engine', f), 'utf8');
  for (const f of ['counter.js', 'pencil.js']) {
    const s = src(f);
    const imports = [...s.matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    ok(imports.length === 0, `${f} 必须零 import（几何/判据各写一份，不许共用引擎内代码）`, imports.join(','));
    ok(!/function\s+\w+\([^)]*\)[^{]*\{[\s\S]*?Math\.random/.test(s), `${f} 不许出现 Math.random`);
  }
  const stripComments = (t) => t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const f of ['counter.js', 'pencil.js', 'partition.js', 'generate.js', 'grid.js', 'rng.js']) {
    const code = stripComments(src(f));
    ok(!/Date\.now|performance\.now|Math\.random|new Date\(/.test(code), `${f} 的判定路径上不许出现墙上时钟/Math.random`);
    ok(!/\bsort\([^)]*\)[\s\S]{0,160}?(Math\.random|rnd\.next|next\(\))/.test(code), `${f} 的 sort 比较器里不许抽随机数`);
  }
  const gen = src('generate.js');
  ok(!/RULE_WEIGHT/.test(gen), 'generate.js 不许用难度权重做判定（权重只属于 balance）');
}

// ── 逐口对账 ──────────────────────────────────────────────────────────────
function auditBoard(label, puzzle, solution) {
  const base = countByRegion({ ...puzzle }, { cap: 2, budget: 500_000 });
  ok(!base.stopped && base.count === 1, `${label}：出货盘的题面必须被独立计数器判为唯一解`, `${base.count}/${base.stopped}`);
  const st = createState({ ...puzzle });
  let wrongPlace = 0;
  let wrongElim = 0;
  let steps = 0;
  // Φ = "还没落子的格的候选比特总数"。它必须每一步严格下降：
  //   删值 ⇒ 少一个比特；落子 ⇒ 这一格整个不再计入（哪怕它本来就只剩一个候选）。
  // Φ 只降不升 ⇒ 推理链上没有任何一步在"往回加信息"，也就是没有试数/回溯的藏身处。
  const phi = (x) => { let t = 0; for (let i = 0; i < x.n; i++) if (!x.placed[i]) for (let s = 0; s < 3; s++) if (x.cand[i] & (1 << s)) t++; return t; };
  let bits = phi(st);
  const logBatch = advance(createState({ ...puzzle }), {});
  let guard = 0;
  while (guard++ < 4 * st.n) {
    const d = nextDeduction(st); // 提示走的同一个函数
    if (d.stalled || d.contradiction) break;
    steps++;
    const before = bits;
    const cell = d.cell;
    // 参考解逐格对账（solution 是出题器那份真答案；base.truth 是计数器自己找到的解）
    if (d.kind === 'place') {
      if (d.value !== solution[cell] || d.value !== base.truth[cell]) wrongPlace++;
    } else if (d.value === solution[cell] || d.value === base.truth[cell]) {
      wrongElim++;
    }
    // 独立复核：这一口删掉/落下去的东西，穷举计数器同不同意
    const pinned = { ...puzzle, givens: Int8Array.from(puzzle.givens) };
    pinned.givens[cell] = d.value;
    const c = countByRegion(pinned, { cap: d.kind === 'place' ? 2 : 1, budget: 500_000 });
    if (d.kind === 'place') {
      ok(!c.stopped && c.count === 1, `${label} 第${steps}步 ${d.rule}@格${cell} 落子后必须仍是唯一解`, `${c.count}/${c.stopped}`);
      for (const s of [0, 1, 2].filter((x) => x !== d.value)) {
        const p2 = { ...puzzle, givens: Int8Array.from(puzzle.givens) };
        p2.givens[cell] = s;
        const c2 = countByRegion(p2, { cap: 1, budget: 500_000 });
        ok(!c2.stopped && c2.count === 0, `${label} 第${steps}步：格${cell} 取 ${SYMBOL_TEXT[s]} 必须 0 解`, String(c2.count));
      }
    } else {
      ok(!c.stopped && c.count === 0, `${label} 第${steps}步 ${d.rule} 删 格${cell} 的 ${SYMBOL_TEXT[d.value]}：钉上它必须 0 解`, String(c.count));
    }
    applyDeduction(st, d);
    const now = phi(st);
    ok(now < before, `${label} 第${steps}步必须让势能 Φ 严格下降（不许往回加信息 ⇒ 没有回溯的藏身处）`, `${before} → ${now}`);
    bits = now;
    if (bits === 0 && blankCount(st) > 0) {
      const nx = nextDeduction(st);
      ok(nx.contradiction === true, `${label}：Φ 归零却没落满时下一句必须是矛盾，不许是"闷"`, nx.stalled ? 'STALL' : nx.rule);
    }
  }
  const v = verify(st);
  const solvedAll = blankCount(st) === 0;
  ok(solvedAll && v.ok, `${label}：逐条提示走完必须满盘落子且自检通过`, `blank=${blankCount(st)} verify=${v.ok ? 'ok' : v.why}`);
  ok(steps === logBatch.steps, `${label}：逐条提示的步数必须等于批推步数`, `${steps} vs ${logBatch.steps}`);
  ok(steps <= 3 * st.n, `${label}：步数必须被 3N 卡住（每步至少删一个候选）`, `${steps} > ${3 * st.n}`);
  ok(wrongPlace === 0, `${label}：落错子必须为 0`, String(wrongPlace));
  ok(wrongElim === 0, `${label}：删错候选必须为 0`, String(wrongElim));
  return { steps, wrongPlace, wrongElim, hits: st.hits, n: st.n };
}

const sample = {};
for (const t of SIZES) {
  const rows = [];
  for (let i = 1; i <= 5; i++) {
    const r = makePuzzle(`pencil-test|${t}|${i}`, t, { maxTrials: 8 });
    if (!r.ok) { ok(false, `pencil-test ${t} 第 ${i} 盘没出货`, r.status); continue; }
    const label = `${t}#${i}`;
    rows.push({ label, ...auditBoard(label, r.puzzle, r.solution), puzzle: r.puzzle, solution: r.solution });
    // 同 seed 第二次跑必须逐字同一串 log（没有隐藏的非确定性）
    const again = advance(createState({ ...r.puzzle }), {});
    const once = advance(createState({ ...r.puzzle }), {});
    ok(again.st.log.join('|') === once.st.log.join('|'), `${label}：同一 seed 两次跑 log 必须逐字相同`);
    ok(again.out.every((v, k) => v === once.out[k]), `${label}：两次跑的输出必须相同`);
  }
  sample[t] = rows;
}
for (const t of SIZES) {
  const rows = sample[t];
  if (!rows.length) continue;
  notes.push(`${t}：${rows.length} 盘 × 平均 ${(rows.reduce((a, b) => a + b.steps, 0) / rows.length).toFixed(1)} 步/盘（≤${3 * rows[0].n}）；落错子 ${rows.reduce((a, b) => a + b.wrongPlace, 0)}、删错候选 ${rows.reduce((a, b) => a + b.wrongElim, 0)}；每口都过了穷举复核`);
}

// ── ③ 变异证人 ────────────────────────────────────────────────────────────
{
  let single = 0;
  let singleRejected = 0;
  let singleP3 = 0;
  let edge = 0;
  let edgeRejected = 0;
  let edgeKept = 0;
  let control = 0;
  for (const t of SIZES) {
    for (const row of sample[t]) {
      const { puzzle, solution } = row;
      const { w, h, reg } = puzzle;
      const n = w * h;
      const regions = cellsOfRegions(Int8Array.from(reg), n);
      // 对照：原样满线索必须被 verify 认可（否则下面的"拒收"全是假的）
      const ctl = createState({ w, h, reg, givens: Int8Array.from(solution) });
      if (verify(ctl).ok) control++;
      ok(ctl.n === n && blankCount(ctl) === 0, `${row.label}：对照组必须满盘`);

      // (M1) 单格改色：改任意一格的符号，P3 必须当场破（区域里每个格的颜色都被本区另两格钉死）
      for (let i = 0; i < n; i++) {
        for (let s = 0; s < 3; s++) {
          if (s === solution[i]) continue;
          const val = Int8Array.from(solution);
          val[i] = s;
          const st = createState({ w, h, reg, givens: val });
          const v = verify(st);
          single++;
          if (!v.ok) singleRejected++;
          const t1 = regionTypeOf(regions[reg[i]], val);
          if (t1 !== REGION_ALL_SAME && t1 !== REGION_ALL_DIFF) singleP3++;
          ok(!v.ok, `${row.label}：单格变异 格${i} ${SYMBOL_TEXT[solution[i]]}→${SYMBOL_TEXT[s]} 必须被 verify 拒收`, v.why);
          ok(v.why.includes('不全同也不全异') || v.why.includes('跨区域相邻'), `${row.label}：拒收理由必须点名破的是哪条`, v.why);
          ok(!satisfies(w, h, reg, val), `${row.label}：同一枚变异 counter.js 的 satisfies 必须也说不合法`);
          const cnt = countByRegion({ w, h, reg, givens: val }, { cap: 1, budget: 500_000 });
          ok(cnt.count === 0 && !cnt.stopped, `${row.label}：满线索的变异题面必须 0 解（两台一致）`, `${cnt.count}/${cnt.stopped}`);
        }
      }
      ok(singleRejected === single, `${row.label}：单格变异必须 100% 被拒收`, `${singleRejected}/${single}`);
      ok(singleP3 === single, `${row.label}：单格变异必须每一次都破 P3（区域里每格颜色都被本区钉死）`, `${singleP3}/${single}`);

      // (M2) 单边变异（只可能破 P4 的那一类）：整区换一种合法填法。
      //   逐格改色永远会先破 P3（单格变异那一节就是这个定理），所以"只破一条边界"的变异
      //   必须整区换：本区照样全同或全异，别的区一个没动 ⇒ 唯一可能破的是 P4。
      //   于是每一枚变异都被 grid.js 的 borderPairs 分成两类，两类都必须和 verify 表态一致：
      //     · 破了某条边界 ⇒ verify 必须拒收，而且理由必须点名"跨区域相邻"
      //     · 一条都没破  ⇒ verify 必须认可（否则上面那些"拒收"只是因为 verify 逢改必拒）
      const PATTERNS9 = [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
      for (let rId = 0; rId < regions.length; rId++) {
        const cs = regions[rId];
        const now = [solution[cs[0]], solution[cs[1]], solution[cs[2]]];
        for (const pat of PATTERNS9) {
          if (pat.join('') === now.join('')) continue;
          const val = Int8Array.from(solution);
          for (let t = 0; t < 3; t++) val[cs[t]] = pat[t];
          const broken = borderPairs(w, h, reg).filter(([a, b]) => val[a] === val[b]);
          edge++;
          const st = createState({ w, h, reg, givens: val });
          const v2 = verify(st);
          ok(p3all(regions, reg, val), `${row.label}：整区换填法之后每一区必须仍然全同/全异`, JSON.stringify({ rId, pat }));
          if (broken.length) {
            if (!v2.ok) edgeRejected++;
            ok(!v2.ok, `${row.label}：单边变异（区 ${rId} 换成 ${pat.join('/')}）破了 ${broken.length} 条边界，必须被 verify 拒收`, v2.why);
            ok(!v2.ok && v2.why.includes('跨区域相邻'), `${row.label}：单边变异的拒收理由必须点名跨区域相邻（不是别的）`, v2.why);
            ok(!satisfies(w, h, reg, val), `${row.label}：单边变异 counter.js 的 satisfies 也必须说不合法`);
            const cnt = countByRegion({ w, h, reg, givens: val }, { cap: 1, budget: 500_000 });
            ok(cnt.count === 0, `${row.label}：单边变异成了满线索题面 ⇒ 必须 0 解`, String(cnt.count));
          } else {
            edgeKept++;
            ok(v2.ok, `${row.label}：没破任何边界的整区换填法必须被 verify 认可（对照）`, v2.why);
            ok(satisfies(w, h, reg, val), `${row.label}：同一枚对照变异 satisfies 也必须说合法`);
            const cnt = countByRegion({ w, h, reg, givens: val }, { cap: 2, budget: 500_000 });
            ok(cnt.count === 1, `${row.label}：满线索的对照变异必须正好 1 解`, String(cnt.count));
          }
        }
      }
    }
  }
  ok(control > 0, '对照组必须有盘被 verify 认可', String(control));
  ok(single > 0 && singleRejected === single, `单格变异：${singleRejected}/${single} 被拒收`, '');
  ok(edgeRejected > 0 && edgeKept > 0, '必须两类都真出现过：破边界的单边变异 + 一条都没破的对照变异', `破 ${edgeRejected}/${edge}｜对照 ${edgeKept}`);
  ok(edgeRejected + edgeKept === edge, `单边变异总数对不上：${edgeRejected}+${edgeKept} vs ${edge}`);
  notes.push(`变异证人：单格改色 ${singleRejected}/${single} 全部拒收（每一次都破 P3 —— 这是定理：区里每格的颜色都被本区另两格钉死）；整区换填法 ${edge} 枚，其中 ${edgeRejected} 枚真破了边界 ⇒ verify 全部以"跨区域相邻"拒收，另 ${edgeKept} 枚一条没破 ⇒ verify 全部认可（对照，防止 verify 逢改必拒）；对照 ${control} 盘原样通过`);
}

// ── ④ 闷的盘不许上架：题面不够时铅笔必须老实说"推不动" ────────────────────
{
  let stalledSeen = 0;
  let guessedSeen = 0;
  for (const t of SIZES) {
    for (const row of sample[t]) {
      const p = row.puzzle;
      const pool = [];
      for (let i = 0; i < p.w * p.h; i++) if (p.givens[i] >= 0) pool.push(i);
      for (let tries = 0; tries < 3 && pool.length > 1; tries++) {
        const givens = Int8Array.from(p.givens);
        givens[pool[(tries * 7 + 3) % pool.length]] = -1;
        givens[pool[(tries * 11 + 5) % pool.length]] = -1;
        const r = advance(createState({ w: p.w, h: p.h, reg: p.reg, givens }), {});
        const c = countByRegion({ w: p.w, h: p.h, reg: p.reg, givens }, { cap: 3, budget: 500_000 });
        if (r.status === 'stuck') stalledSeen++;
        // 关键证人：铅笔说"推不完"的那些盘，必须确实是"不唯一"或"确实需要猜"——
        // 它不许在推不动时随便落一个子（那正是第四条"替你猜"的分支）
        if (r.status === 'stuck') {
          const placedWrong = Array.from(r.out).filter((v, i) => v >= 0 && v !== row.solution[i]).length;
          ok(placedWrong === 0, `${row.label}：闷住的盘里落下的子也必须全对`, String(placedWrong));
        }
        if (r.status === 'solved' && c.count !== 1) guessedSeen++;
      }
    }
  }
  ok(stalledSeen > 0, '必须真出现"挖掉两颗线索就推不动"的盘（否则本节没有证人）', String(stalledSeen));
  ok(guessedSeen === 0, '铅笔不许把多解盘"推完"（推完的必须仍是唯一解盘）', String(guessedSeen));
  notes.push(`闷盘证人：挖线索后 ${stalledSeen} 次老实说 stuck（且已落子全对），把多解盘推完的次数 ${guessedSeen}`);
}

// ── ⑤ 尺寸表自述与代码一致（文档里的档位不能是拍脑袋）──────────────────────
{
  for (const t of SIZES) ok(SIZE_TABLE[t], `SIZE_TABLE 必须有 ${t}`);
  const nFor = (t) => { const [w, h] = t.split('x').map(Number); return w * h; };
  ok(SIZES.every((t) => nFor(t) % 3 === 0), '每档的格数必须能被 3 整除（三格一区的硬前提）', SIZES.map((t) => `${t}=${nFor(t)}`).join(' '));
  notes.push(`档位：${SIZES.map((t) => `${t}(N=${nFor(t)}, 区数 ${nFor(t) / 3})`).join(' ')}`);
  const walls = [];
  for (const t of SIZES) for (const row of sample[t]) walls.push(row.steps);
  notes.push(`每盘步数 p50 ${q(walls, 0.5)}｜max ${Math.max(...walls)}`);
}

for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails.slice(0, 10)) console.log(`  ✗ ${f}`);
console.log(`RESULT pencil-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);

function p3all(regions, reg, val) {
  return regions.every((cs) => {
    const t = regionTypeOf(cs, val);
    return t === REGION_ALL_SAME || t === REGION_ALL_DIFF;
  });
}

function neighborsOf(w, h, i) {
  const r = Math.floor(i / w);
  const c = i % w;
  const out = [];
  if (r > 0) out.push(i - w);
  if (r + 1 < h) out.push(i + w);
  if (c > 0) out.push(i - 1);
  if (c + 1 < w) out.push(i + 1);
  return out;
}
