#!/usr/bin/env node
// 规则表的"每条都得留"证人：谁也不蕴含谁，而且表里没有死规则。
//
// 三条判据（手法承自临时探针 tools/_tmp-search-c1.mjs，探针已删、判据固化在此；档位读数来自本次重跑）：
//   ① C1 不被 A 组蕴含：3×2 盘穷举六格候选掩码（7^6 = 117649 个局面），
//      比较"A 组不动点"与"全表不动点"删掉的候选位数。C1 能多删的局面数实测 74835 ——
//      不是 1 个、不是偶发，是**六成以上**。
//   ② 反方向也要成立：A 组决不能删掉全表删不掉的东西（规则表是单调的，加规则只会删得更多）。
//      这一条一旦破了，说明 rules 选项有状态泄漏。
//   ③ A2 与 A4 互不蕴含（本次重跑里它们各自的出场率都不是 0，但出场率不等于不可替代性）：
//      找"只开 A2 能删、只开 A4 删不掉"和反过来两类的证人局面。
//   ④ 表里没有死规则：RULE_ORDER 就是那六条，B1/B2 已从引擎与全部工具里删掉
//      （它们在 84 张盘上出场 0 盘 —— 见 README 的"难度是量出来的"一节）。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createState, advance, RULE_ORDER } from '../js/engine/pencil.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const fails = [];
function check(ok, msg) {
  checks++;
  if (!ok) fails.push(msg);
}
const A_ONLY = RULE_ORDER.filter((k) => k !== 'C1-pair-block');
const MASKS = [1, 2, 3, 4, 5, 6, 7]; // 三符号的非空子集

const regOf = (rows) => {
  const reg = [];
  const map = new Map();
  for (const line of rows) for (const ch of line) {
    if (!map.has(ch)) map.set(ch, map.size);
    reg.push(map.get(ch));
  }
  return Int8Array.from(reg);
};
function popcount(m) {
  let k = 0;
  for (let b = 0; b < 3; b++) if (m & (1 << b)) k++;
  return k;
}

// 掩码 → 该规则子集的不动点删掉了几个候选位。手法与 tools/_tmp-search-c1.mjs 一致：
// createState 只会给满候选，所以逐格把 cand 覆写成要测的掩码（没有任何给定，纯掩码局面）。
// 这里比的只是"谁删得多"，不是"谁删得对"，所以不校验掩码本身是否出自合法盘面。
function bitsRemoved(rows, maskArr, order) {
  const reg = regOf(rows);
  const n = maskArr.length;
  const st = createState({ w: rows[0].length, h: rows.length, reg, givens: new Int8Array(n).fill(-1) });
  for (let i = 0; i < n; i++) st.cand[i] = maskArr[i];
  const before = maskArr.reduce((a, m) => a + popcount(m), 0);
  advance(st, { rules: order });
  let after = 0;
  for (let i = 0; i < n; i++) after += popcount(st.cand[i]);
  return before - after;
}

// ①② 3×2（两区各三格）穷举全部 7^6 = 117649 个掩码局面
{
  const rows = ['aaa', 'bbb'];
  const n = 6;
  let total = 0;
  let c1More = 0;
  let aMore = 0;
  let equal = 0;
  let firstWitness = null;
  const mk = new Array(n).fill(1);
  const enumAll = (t) => {
    if (t === n) {
      total++;
      const a = bitsRemoved(rows, mk, A_ONLY);
      const f = bitsRemoved(rows, mk, RULE_ORDER);
      if (f > a) {
        c1More++;
        if (!firstWitness) firstWitness = mk.slice();
      } else if (a > f) aMore++;
      else equal++;
      return;
    }
    for (const v of MASKS) {
      mk[t] = v;
      enumAll(t + 1);
    }
  };
  enumAll(0);
  check(total === 117649, `3×2 穷举的局面数应为 117649，实为 ${total}`);
  check(c1More > 0, 'C1 一个多删的局面都没找到 ⇒ 它被 A 组蕴含，该从表里删掉它');
  // 金标准：63.6% 的局面里 C1 都能在 A 组不动点之后继续删（两次独立测量都是 74835）
  check(c1More === 74835, `C1 多删的局面数应为金标准 74835，实为 ${c1More}（引擎的推理顺序变了 ⇒ 本测试与 balance 都要重跑）`);
  check(aMore === 0, `有 ${aMore} 个局面 A 组删得比全表还多 ⇒ rules 选项有状态泄漏`);
  console.log(`   （① 3×2 全表 ${total} 局面：C1 多删 ${c1More}、两者相等 ${equal}、A 组多删 ${aMore}）`);
  check(!!firstWitness, '没有可打印的 C1 证人局面');
  if (firstWitness) console.log(`   （第一个证人：掩码 ${firstWitness.join(',')} —— A 组不动点之后 C1 还能继续删）`);
}

// ③ A2 与 A4 互不蕴含：三种分区 × 全掩码，比较两个**带动作规则 A5** 的单规则不动点。
//    为什么必须带上 A5：A2 与 A4 都只在"已填格"上工作，两条规则自己永远不开口
//    （现场核对过：不带 A5 时两类证人局面都是 0 个，那测的是掩码写法而不是蕴含关系）。
//    A5 只做"只剩一个符号就落子"这一件事，两边都给，于是比的就是"同形锁 vs 邻界排除"本身。
{
  const A5 = 'A5-naked-single';
  const cases = [
    { rows: ['aaa', 'bbb'], name: '3×2 两横区', gold: { two: 4572, four: 85923 } },
    { rows: ['ab', 'ab', 'ab'], name: '2×3 两竖区' },
    { rows: ['aab', 'abb'], name: '3×2 斜分区' },
  ];
  for (const c of cases) {
    const n = c.rows.join('').length;
    const mk = new Array(n).fill(1);
    let two = 0;
    let four = 0;
    let total = 0;
    const enumAll = (t) => {
      if (t === n) {
        total++;
        const a = bitsRemoved(c.rows, mk, ['A2-same-lock', A5]);
        const b = bitsRemoved(c.rows, mk, ['A4-border-exclude', A5]);
        if (a > b) two++;
        if (b > a) four++;
        return;
      }
      for (const v of MASKS) {
        mk[t] = v;
        enumAll(t + 1);
      }
    };
    enumAll(0);
    check(two > 0, `${c.name}：找不到"只有 A2 能删、A4 删不掉"的局面 ⇒ A2 可能是冗余的`);
    check(four > 0, `${c.name}：找不到"只有 A4 能删、A2 删不掉"的局面 ⇒ A4 可能是冗余的`);
    check(total === 117649, `${c.name} 穷举了 ${total} 个局面`);
    if (c.gold) check(two === c.gold.two && four === c.gold.four, `${c.name} 的互不蕴含计数与金标准不符：A2 更强 ${two}（应 ${c.gold.two}）、A4 更强 ${four}（应 ${c.gold.four}）`);
    console.log(`   （③ ${c.name} 全 ${total} 局面：A2+A5 更强 ${two}、A4+A5 更强 ${four} ⇒ 两条都不被对方蕴含）`);
  }
}

// ④ 死规则：表就是那六条；B1/B2 在引擎与工具里都不再出现
{
  check(RULE_ORDER.length === 6, `RULE_ORDER 应为 6 条，实为 ${RULE_ORDER.length}`);
  const want = ['A2-same-lock', 'A3-all-diff-completion', 'A4-border-exclude', 'A6-region-infeasible', 'C1-pair-block', 'A5-naked-single'];
  check(JSON.stringify(RULE_ORDER) === JSON.stringify(want), `RULE_ORDER 与本次重跑的表不符：${RULE_ORDER.join(',')}`);
  const files = [];
  for (const d of ['js/engine', 'tools']) for (const f of readdirSync(join(ROOT, d))) if (!f.startsWith('_tmp-') && /\.(js|mjs)$/.test(f)) files.push(join(ROOT, d, f));
  for (const dead of ['B1-forced-all-diff', 'B2-forced-all-same']) {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(dead));
    check(hits.length === 0, `死规则 ${dead} 还出现在 ${hits.map((f) => f.replace(ROOT + '/', '')).join('、')}（84 张盘出场 0 盘的规则不该留在仓里）`);
  }
  // 出场率的红线在 balance 里（T.deadRuleIsRed），这里只核对那句承诺还在
  const bal = readFileSync(join(ROOT, 'tools', 'balance.mjs'), 'utf8');
  check(/deadRuleIsRed/.test(bal), 'balance 里的死规则红线不见了 ⇒ 以后加规则没人查出场');
}

console.log(`RESULT rule-subsumption-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
for (const f of fails) console.error('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
