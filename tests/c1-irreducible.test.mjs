#!/usr/bin/env node
// C1（跨区配对封锁）值不值得留在规则表里 —— 用"摘掉它就推不完"的真实出货盘回答。
//
// 为什么这是本仓最硬的一组断言：规则表里每一条都必须是"现象"，不是设计者希望存在的规则。
// C1 是表里唯一的两区联立推理（js/engine/pencil.js:234），也是权重最高的一条（W=4）。
// 它的证人来自 `tools/_tmp-c1-fixture.mjs`（已固化到此文件、临时探针删除）：四张 4×6 出货盘，A 组规则推到闷，
// 第一口结论由 C1 给出，而那一格的候选被**独立计数器**复核成 0 解 —— 三方互不信任。
//
// 断言的形状（每条都在说"少了 C1 就有一段推理没人做"）：
//   ① 金标准：seed 串必须复现出同样的分区与给定（否则整个测量口径就飘了）。
//   ② A 组（摘掉 C1 的五条）推到 stuck，且闷住的格数 = 记录值。
//   ③ 那一步 nextDeduction 报的必须是 C1，格号/种类/被删符号与记录一致。
//   ④ 独立计数器复核：把那一格钉成被删的那个符号 ⇒ 全盘 0 解 ⇒ 这一步推理是对的。
//   ⑤ 全表推到 solved，且答案与计数器唯一解逐格相等（不是"推完"就算过）。
//   ⑥ 反命题：A 组自己跑不出 C1 的 hit（rules 过滤真的生效）。
import { makePuzzle } from '../js/engine/generate.js';
import { createState, advance, nextDeduction, applyDeduction, RULE_ORDER } from '../js/engine/pencil.js';
import { countByRegion, DEFAULT_CAP } from '../js/engine/counter.js';

let checks = 0;
const fails = [];
function check(ok, msg) {
  checks++;
  if (!ok) fails.push(msg);
}
const A_ONLY = RULE_ORDER.filter((k) => k !== 'C1-pair-block');
check(A_ONLY.length === 5 && !A_ONLY.includes('C1-pair-block'), 'A 组应当是"全表摘掉 C1"的那五条');

// 夹具来自本次重跑（seed smoke|4x6|i，makePuzzle 的随机只在选 seed 那一步 ⇒ 逐字节可复现）
const FIXTURES = [
  { seed: 'smoke|4x6|3', aBlank: 4, aSteps: 38, fact: { cell: 12, kind: 'elim', value: 0 }, fullStatus: 'solved', count: 1, outEqTruth: true },
  { seed: 'smoke|4x6|4', aBlank: 18, aSteps: 11, fact: { cell: 13, kind: 'elim', value: 2 }, fullStatus: 'solved', count: 1, outEqTruth: true },
  { seed: 'smoke|4x6|9', aBlank: 8, aSteps: 38, fact: { cell: 17, kind: 'elim', value: 1 }, fullStatus: 'solved', count: 1, outEqTruth: true },
  { seed: 'smoke|4x6|10', aBlank: 17, aSteps: 13, fact: { cell: 5, kind: 'elim', value: 2 }, fullStatus: 'solved', count: 1, outEqTruth: true },
];

for (const F of FIXTURES) {
  const r = makePuzzle(F.seed, '4x6', { maxTrials: 1 });
  if (!r.ok) {
    check(false, `${F.seed} 不再出货（status=${r.status}）—— 金标准夹具失效，要么改引擎要么改夹具，不许改判据`);
    continue;
  }
  const p = { ...r.puzzle };
  // ② A 组推到闷
  const a = advance(createState({ ...p }), { rules: A_ONLY });
  check(a.status === 'stuck', `${F.seed}：A 组应当推不完，实为 ${a.status}`);
  check(a.blank === F.aBlank, `${F.seed}：A 组闷住的格数应=${F.aBlank}，实为 ${a.blank}`);
  check(a.steps === F.aSteps, `${F.seed}：A 组步数应=${F.aSteps}，实为 ${a.steps}（引擎的推理顺序变了，夹具要重跑）`);
  check((a.hits['C1-pair-block'] || 0) === 0, `${F.seed}：摘掉 C1 之后仍有它的 hit ⇒ rules 选项没生效`);
  // ③ 第一口结论来自 C1
  const f = nextDeduction(a.st);
  check(!f.stalled, `${F.seed}：A 组闷住后 nextDeduction 直接说没有下一步`);
  check(f.rule === 'C1-pair-block', `${F.seed}：下一步应当是 C1，实为 ${f.rule}`);
  check(f.cell === F.fact.cell && f.kind === F.fact.kind && f.value === F.fact.value, `${F.seed}：结论与夹具不符 ${JSON.stringify(f)}`);
  // ④ 独立计数器复核：那一格取那个符号 ⇒ 全盘 0 解
  const probe = { ...p, givens: Int8Array.from(p.givens) };
  probe.givens[f.cell] = f.value;
  const bad = countByRegion(probe, { cap: 1, budget: 500_000 });
  check(!bad.stopped && bad.count === 0, `${F.seed}：钉上被删符号后计数器不该还能解（实为 ${bad.stopped ? 'overbudget' : bad.count}）`);
  // ⑤ 全表推到 solved 且答案就是计数器的唯一解
  const full = advance(createState({ ...p }), {});
  check(full.status === F.fullStatus, `${F.seed}：全表应当 ${F.fullStatus}，实为 ${full.status}`);
  const truth = countByRegion({ ...p }, { cap: DEFAULT_CAP, budget: 500_000 });
  check(truth.count === F.count && !truth.stopped, `${F.seed}：夹具说唯一解，实测 ${truth.stopped ? 'overbudget' : truth.count}`);
  check(!!truth.truth && full.out.every((v, i) => v === truth.truth[i]), `${F.seed}：铅笔的答案不在计数器真值里`);
  check((full.hits['C1-pair-block'] || 0) > 0, `${F.seed}：全表跑完却没有一次 C1 ⇒ 它不在主循环里`);
  // ⑥ 先 A 组、手动补一口 C1、再全表 —— 必须推到完（C1 是那一步唯一缺口）
  const st = createState({ ...p });
  advance(st, { rules: A_ONLY });
  const applied = applyDeduction(st, f);
  check(applied === st, `${F.seed}：applyDeduction 返回的不是状态本身（口径变了）`);
  check((st.hits[f.rule] || 0) === 1, `${F.seed}：那一口 C1 没进 hit 账（实为 ${st.hits[f.rule]}）`);
  check(f.kind === 'place' ? st.cand[f.cell] === 1 << f.value : (st.cand[f.cell] & (1 << f.value)) === 0, `${F.seed}：那一口 C1 没作用到格 ${f.cell}`);
  const g = advance(st, {});
  check(g.status === 'solved', `${F.seed}：补上 C1 之后仍推不完（实为 ${g.status}，剩 ${g.blank ?? '-'} 格）`);
}

console.log(`RESULT c1-irreducible-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
for (const f of fails) console.error('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
