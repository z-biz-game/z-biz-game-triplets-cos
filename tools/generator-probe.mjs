#!/usr/bin/env node
// 出题器账本验收：把 attemptOnce 记的每一笔账摊开，红线分两类——
//   必须为 0：非法参考解 / 参考解被推翻 / 铅笔与参考解不一致 / 复核不一致 / 挖完仍有多余线索
//   必须 > 0：挖循环真的在挖（dropTried/dropKept）、被拒的分支真的走到过（不唯一、推不完）
// 第二条是给"死代码不算证人"用的：一条从没走过的分支等于没有那道门。
import { makePuzzle, auditClueNecessity, SIZE_TABLE, SIZES, TIERS, parseSize } from '../js/engine/generate.js';
import { countByRegion } from '../js/engine/counter.js';
import { solveWithRules, verify, RULE_ORDER } from '../js/engine/pencil.js';

const REP = Number(process.env.REP || 24); // 抽样量：dropByPencil 这类分支在小样本上可能一次都不走（4x6 实测 6/960）
let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks++;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}

const MUST_ZERO = [
  ['illegalRef', '参考解自己不合法（P3/P4 直接破）'],
  ['refRejected', '满线索就被推翻（参考解不是唯一解）'],
  ['dropByMismatch', '挖了一颗线索后铅笔推出与参考解不同的盘（铅笔不 sound）'],
  ['truthMismatch', '计数器 truth 与参考解逐格对不上'],
  ['pencilStuckFull', '满线索盘铅笔推不完（那说明读盘本身不成立）'],
  ['overbudget', '正常预算下 OVERBUDGET（本档改为逐档披露，这里只许为 0）'],
  ['gate0Overbudget', 'gate 0 就 OVERBUDGET'],
];
const MUST_ALIVE = [
  ['dropTried', '挖循环一颗都没试过'],
  ['dropKept', '没有任何一颗线索被成功删掉'],
  ['dropByCounter', '没有任何一次删除被计数器拒过（多解/无解）'],
  ['dropByPencil', '没有任何一次删除被铅笔拒过（推不完）'],
];

const rows = [];
for (const t of SIZES) {
  const { w, h } = parseSize(t);
  const tier = TIERS.find((x) => x.key === t);
  const maxTrials = tier ? tier.maxDraws : 40;
  const N = w * h;
  const agg = {};
  const drawsList = [];
  const shipped = [];
  let shipOk = 0;
  for (let d = 0; d < REP; d++) {
    const r = makePuzzle(`probe|${t}|${d}`, t, { maxTrials });
    for (const [k, v] of Object.entries(r.stats)) agg[k] = (agg[k] || 0) + v;
    drawsList.push(r.draws);
    if (!r.ok) { ok(false, `${t} 第 ${d} 抽没出货`, `status=${r.status} 用了 ${r.draws} 次 attempt`); continue; }
    shipOk++;
    // 出货盘独立复核（不用出题器的返回值，重新跑一遍两台机器）
    const c = countByRegion({ ...r.puzzle }, { cap: 2, budget: 500_000 });
    const p = solveWithRules({ ...r.puzzle });
    ok(c.count === 1 && !c.stopped, `${t}#${d}：独立计数器必须数出唯一解`, `${c.count}/${c.stopped}`);
    ok(p.status === 'solved' && verify(p.st).ok, `${t}#${d}：独立铅笔必须推完且自检通过`, p.status);
    ok(p.out.every((v, i) => v === c.truth[i] && v === r.solution[i]), `${t}#${d}：三份答案必须逐格相同`);
    ok(Array.from(r.puzzle.givens).every((v, i) => v < 0 || v === r.solution[i]), `${t}#${d}：题面必须与参考解一致`);
    shipped.push({ d, clue: Array.from(r.puzzle.givens).filter((v) => v >= 0).length, nodes: c.nodes });
  }
  // 逐颗线索的必要性审计（unnecessary 必须为 0，否则"极小"这句话是吹的）
  let audited = 0;
  let unnecessary = 0;
  let auditOverbudget = 0;
  for (const s of shipped) {
    const r = makePuzzle(`probe|${t}|${s.d}`, t, { maxTrials });
    if (!r.ok) continue;
    const audit = auditClueNecessity(r.puzzle, { budget: 500_000 });
    audited += audit.length;
    unnecessary += audit.filter((a) => a.pass).length;
    auditOverbudget += audit.filter((a) => a.overbudget).length;
  }
  for (const [k, why] of MUST_ZERO) ok((agg[k] || 0) === 0, `${t}：${k} 必须为 0 —— ${why}`, String(agg[k] || 0));
  if (shipOk === REP) {
    for (const [k, why] of MUST_ALIVE) ok((agg[k] || 0) > 0, `${t}：${k} 必须被走到过 —— ${why}`, String(agg[k] || 0));
  }
  ok(unnecessary === 0, `${t}：审计必须一颗多余线索都找不到`, String(unnecessary));
  ok(audited > 0, `${t}：审计必须真跑过`, String(audited));
  const clueP50 = shipped.map((s) => s.clue).sort((a, b) => a - b)[Math.floor(shipped.length / 2)] ?? 0;
  rows.push({
    tier: t, N, inMenu: tier ? tier.inMenu : null, ship: `${shipOk}/${REP}`,
    draws: drawsList.slice(0, 6).join(',') + (drawsList.length > 6 ? ',…' : ''), maxDraw: Math.max(...drawsList),
    attempts: agg.draws, restarts: agg.partitionRestarts,
    clueP50, sparsity: `${Math.round(((N - clueP50) / N) * 100)}%`,
    dropTried: agg.dropTried, dropKept: agg.dropKept,
    byCounter: agg.dropByCounter, byPencil: agg.dropByPencil, byOverbudget: agg.dropByOverbudget,
    zeros: MUST_ZERO.map(([k]) => `${k}=${agg[k] || 0}`).join(' '),
    audit: `${audited} 颗逐颗审计，多余 ${unnecessary}，数不完 ${auditOverbudget}`,
    maxNodes: Math.max(0, ...shipped.map((s) => s.nodes)),
  });
}

console.log('出题器账本（REP 次出货尝试 × 每档）：');
for (const r of rows) {
  console.log(`  ${r.tier}（N=${r.N}，菜单${r.inMenu ? '内' : '外'}）出货 ${r.ship}｜每次出货平均抽卡 ${(r.attempts / Math.max(1, Number(r.ship.split('/')[0]))).toFixed(1)}（各抽 ${r.draws}，最多 ${r.maxDraw}）`);
  console.log(`    剖分重启累计 ${r.restarts}｜挖：试 ${r.dropTried} 次、删成 ${r.dropKept} 颗、被计数器拒 ${r.byCounter}、被铅笔拒 ${r.byPencil}、数不完 ${r.byOverbudget}`);
  console.log(`    线索 p50 ${r.clueP50}/${r.N}（占 ${r.sparsity}）｜逐颗审计 ${r.audit}`);
  console.log(`    必须为 0 的账：${r.zeros}`);
}
notes.push(`规则表共 ${RULE_ORDER.length} 条；SIZE_TABLE 共 ${Object.keys(SIZE_TABLE).length} 档，菜单 ${SIZES.join('/')}`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails.slice(0, 10)) console.log(`  ✗ ${f}`);
console.log(`RESULT generator-probe ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
