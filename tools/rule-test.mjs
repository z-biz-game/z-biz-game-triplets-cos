#!/usr/bin/env node
// 规则表逐条验收：每条命名规则都要
//   ① 在一个手搓小局面上 **fire**，且核对是哪一格、哪一个符号（不许"大概推出来了"）
//   ② 那条结论由**独立计数器**复核（place ⇒ 钉上它解数不变、钉上别的符号 0 解；elim ⇒ 钉上它 0 解）
//   ③ near-miss（只差一颗符号的诱惑局面）上这条规则必须**闭嘴**，且只跑它自己必须**闷**
//   ④ 0 解盘上必须有人报矛盾（矛盾出口只落在真该报的规则上），且计数器独立说 0
// 外加 C1 的"不可替代证人"：真实 4×6 出货盘，A 组推到闷，第一口只能是 C1。
//
// 期望值全部是手写的（人话推理写在旁边），不是从当前输出抄的 —— 红了就修引擎。
import { createState, runRule, nextDeduction, applyDeduction, advance, RULE_ORDER, RULE_TEXT, RULE_WEIGHT, SYMBOL_TEXT } from '../js/engine/pencil.js';
import { countByRegion } from '../js/engine/counter.js';

// ── 断言台账 ──────────────────────────────────────────────────────────────
let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks++;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}

// ── 小局面构造：区域用字母、给定用数字、'.' 是空格 ─────────────────────────
function fx(regionRows, givenRows) {
  const h = regionRows.length;
  const w = regionRows[0].length;
  for (const r of regionRows) if (r.length !== w) throw new Error(`fx：区域行不等宽`);
  for (const r of givenRows) if (r.length !== w) throw new Error(`fx：给定行不等宽`);
  const map = new Map();
  const reg = [];
  for (const line of regionRows) for (const ch of line) { if (!map.has(ch)) map.set(ch, map.size); reg.push(map.get(ch)); }
  const givens = [];
  for (const line of givenRows) for (const ch of line) givens.push(ch === '.' ? -1 : Number(ch));
  return { w, h, reg: Int8Array.from(reg), givens: Int8Array.from(givens) };
}
const withGiven = (p, cell, sym) => {
  const givens = Int8Array.from(p.givens);
  givens[cell] = sym;
  return { ...p, givens };
};
const cnt = (p, cap = 4) => {
  const c = countByRegion({ ...p }, { cap, budget: 500_000 });
  if (c.stopped) throw new Error('counter 在小局面上 OVERBUDGET —— 这本身就该红');
  return c.count;
};

// ── ① 规则表自洽 ─────────────────────────────────────────────────────────
{
  const dup = new Set(RULE_ORDER);
  ok(dup.size === RULE_ORDER.length, '规则表：RULE_ORDER 无重复', `${RULE_ORDER.join(',')}`);
  for (const k of RULE_ORDER) {
    ok(typeof RULE_TEXT[k] === 'string' && RULE_TEXT[k].length > 8, `规则表：${k} 有人话`, RULE_TEXT[k] || '(缺)');
    ok(Number.isInteger(RULE_WEIGHT[k]) && RULE_WEIGHT[k] >= 1, `规则表：${k} 有权重`, String(RULE_WEIGHT[k]));
    let threw = false;
    try { runRule(`__nope__`, createState(fx(['aaa', 'bbb'], ['...', '...']))); } catch { threw = true; }
    ok(threw, `规则表：runRule 对未知规则名必须炸（不许静默返回 null）`);
  }
  ok(RULE_ORDER[RULE_ORDER.length - 1] === 'A5-naked-single', '规则表：A5 归因在最后（最机械的让位）', RULE_ORDER.join(' → '));
  // 空盘（零给定）上不许有任何规则开口：开口即"无中生有"
  const empty = fx(['aaa', 'bbb'], ['...', '...']);
  for (const k of RULE_ORDER) ok(runRule(k, createState(empty)) === null, `空盘上 ${k} 必须闭嘴`);
}

// ── ② 逐条规则：fire / 独立复核 / near-miss / 矛盾出口 ──────────────────────
// fixtures 里的期望全是手算的（人话理由写在 note 里）。
const FIXTURES = {
  'A2-same-lock': {
    fire: {
      p: fx(['aaa', 'bbb'], ['00.', '...']),
      cell: 2, kind: 'place', value: 0, first: true,
      note: 'P3：本区已有两个方块 ⇒ "全异"要三格互异，可这两格已经相同 ⇒ 全异死了 ⇒ 只剩全同 ⇒ 第三格方块',
    },
    nearMiss: { p: fx(['aaa', 'bbb'], ['01.', '...']), note: '区内两格是方块/圆圈（不同）⇒ 同形锁的条件根本不成立，不许把第三格锁成方块或圆圈' },
    contra: { p: fx(['aaa', 'bbb'], ['001', '...']), cell: 2, note: '两格方块 + 第三格给定圆圈 ⇒ 既不全同也不全异，A2 必须当场指名' },
  },
  'A3-all-diff-completion': {
    fire: {
      p: fx(['aaa', 'bbb'], ['01.', '...']),
      cell: 2, kind: 'place', value: 2, first: true,
      note: 'P3：本区已有方块与圆圈（两格不同）⇒ "全同"要三格一样，可这两格已经不同 ⇒ 全同死了 ⇒ 只剩全异 ⇒ 第三格是剩下的三角',
    },
    nearMiss: { p: fx(['aaa', 'bbb'], ['00.', '...']), note: '区内两格同为方块 ⇒ 全异补的条件不成立（这正是 A2 的局面），不许补出第三个符号' },
    contra: { p: fx(['aaa', 'bbb'], ['010', '...']), cell: 2, note: '方块/圆圈/方块：要全异则第三格得是三角，可它已定为方块 ⇒ A3 指名矛盾' },
  },
  'A4-border-exclude': {
    fire: {
      p: fx(['aaa', 'bbb'], ['0..', '...']),
      cell: 3, kind: 'elim', value: 0, first: true,
      note: 'P4 原文直译：跨区相邻两格符号必须不同，第 1 行第 1 列已是方块 ⇒ 正下方那格删掉方块',
    },
    fire2: {
      p: fx(['ab', 'ab', 'ab'], ['0.', '..', '..']),
      cell: 1, kind: 'elim', value: 0, first: true,
      note: '几何证人：2×3 竖条分区里，第 1 行第 1 列的**下方邻格同属本区**（P4 不管同区），只有右邻跨区 ⇒ 必须落在格 1 而不是格 2',
    },
    nearMiss: { p: fx(['aaa', 'bbb'], ['0..', '1..']), note: '两区的给定不同色且各区的邻格还没落子 ⇒ 无话可说；这个局面连整张规则表都闷（见 wholeStall）' },
    contra: { p: fx(['aaa', 'bbb'], ['0..', '0..']), cell: 3, note: '跨区域相邻两格同为方块 ⇒ 直接违反 P4' },
  },
  'A6-region-infeasible': {
    fire: {
      p: fx(['aaa', 'bbb'], ['00.', '...']),
      cell: 2, kind: 'elim', value: 1, first: false,
      note: '第三格取圆圈：全同要求另两格也收得下圆圈（它们是给定的方块，收不下），全异要求另两格收下剩下的方块+三角（两格都只有方块可选，收不下）⇒ 两条都死 ⇒ 删圆圈',
    },
    nearMiss: { p: fx(['aaa', 'bbb'], ['.0.', '...']), note: '单颗给定既没锁死全同也没锁死全异：本格任取一色时"全同"这条路还活着 ⇒ A6 不许动手' },
    contra: null, // A6 只有删值出口（见下面的 0 解盘一致性检查）
  },
  'C1-pair-block': {
    fire: {
      p: fx(['aaa', 'bbb'], ['0..', '...']),
      cell: 3, kind: 'elim', value: 0, first: false,
      note: '邻区第 1 格取方块时，本区九种填法里收得下方块的那三种（全同方块 + 两个全异）都必然让某个跨区邻格撞上方块 ⇒ 删。 tiny 盘上这与 A4 同结论 —— 两条独立实现同意，本身就是对账',
    },
    nearMiss: { p: fx(['aaa', 'bbb'], ['0..', '1..']), note: '两区各自的填法还互相配得上 ⇒ 跨区封锁不许动手' },
    contra: null, // 同上：C1 只有删值出口
  },
  'A5-naked-single': {
    fire: {
      // 先让 A6 把第三格的候选删到只剩方块（A6 永远不落子），再轮询 A5
      p: fx(['aaa', 'bbb'], ['00.', '...']),
      after: ['A6-region-infeasible'],
      cell: 2, kind: 'place', value: 0, first: false,
      note: '本格候选被删到只剩方块 ⇒ 落子。这一步是"人往格里写图形"那一下，A6 结构上给不出来',
    },
    nearMiss: { p: fx(['aaa', 'bbb'], ['0..', '...']), note: '空格候选还是三色（A4 才刚要开口）⇒ 唯一候选没有格子可落' },
    // A5 的矛盾出口是**链条**：根状态上它必须闭嘴（还没有候选被删），
    // 等别的规则把某格三色删光之后，报矛盾的只能是它。
    contra: {
      chain: true,
      p: fx(['aaa', 'bbb', 'ccc'], ['00.', '1..', '.1.']),
      cell: 4,
      note: '第 1 行两格方块 ⇒ 第三格方块；第 2 行第 1 列圆圈、第 3 行第 2 列圆圈 ⇒ 不动点推到第 2 行第 2 列三色全被删光 ⇒ A5 是唯一开口报矛盾的规则',
    },
  },
};

for (const key of RULE_ORDER) {
  const F = FIXTURES[key];
  if (!ok(F, `夹具：${key} 有条目`)) continue;

  // ① fire：核对是哪格哪色
  for (const slot of ['fire', 'fire2']) {
    const f = F[slot];
    if (!f) continue;
    const st = createState({ ...f.p });
    if (f.after) {
      const pre = advance(st, { rules: f.after });
      ok(pre.status === 'stuck', `${key} fire 前置：只跑 ${f.after.join(',')} 必须停在没落子的地方`, pre.status);
      ok(pre.hits[key] === undefined, `${key} 前置那轮不许把本规则的活干掉`, JSON.stringify(pre.hits));
    }
    const d = runRule(key, st);
    if (ok(d && !d.contradiction, `${key} 必须 fire`, d ? (d.contradiction ? '报的是矛盾' : 'null') : 'null')) {
      ok(d.cell === f.cell, `${key} fire 的格子`, `期望 ${f.cell}，实得 ${d.cell}`);
      ok(d.kind === f.kind, `${key} fire 的种类`, `期望 ${f.kind}，实得 ${d.kind}`);
      ok(d.value === f.value, `${key} fire 的符号`, `期望 ${f.value}(${SYMBOL_TEXT[f.value]})，实得 ${d.value}(${SYMBOL_TEXT[d.value]})`);
      ok(d.rule === key && d.ruleText === RULE_TEXT[key], `${key} fire 的归因`);
      ok(typeof d.why === 'string' && d.why.includes(SYMBOL_TEXT[f.value]), `${key} 的人话得点名符号`, d.why);
      // 固定顺序下的归因（first:true 的规则必须是 nextDeduction 的第一句话）
      if (f.first) {
        const nd = nextDeduction(createState({ ...f.p }));
        ok(nd.rule === key && nd.cell === f.cell && nd.kind === f.kind && nd.value === f.value,
          `${key}：nextDeduction 的第一句话必须归给本规则`, nd.stalled ? 'STALL' : `${nd.rule}@${nd.cell}`);
      }
      // ② 独立计数器复核这条结论
      const base = cnt(f.p);
      ok(base > 0, `${key} fire 的盘面必须有解`, String(base));
      const pinned = cnt(withGiven(f.p, d.cell, d.value));
      if (d.kind === 'place') {
        ok(pinned === base, `${key} 的落子必须不切掉解（计数器独立复核）`, `钉上 ${SYMBOL_TEXT[d.value]} 后 ${pinned} 解，本来 ${base} 解`);
        for (const s of [0, 1, 2].filter((x) => x !== d.value)) {
          const bad = cnt(withGiven(f.p, d.cell, s));
          ok(bad === 0, `${key} 的落子：本格取别的符号必须 0 解`, `取 ${SYMBOL_TEXT[s]} 还有 ${bad} 解`);
        }
      } else {
        ok(pinned === 0, `${key} 的删值必须被计数器独立确认（钉上它 0 解）`, `钉上 ${SYMBOL_TEXT[d.value]} 还剩 ${pinned} 解`);
      }
      notes.push(`${key} ${slot === 'fire2' ? '(几何)' : ''}fire：${d.kind === 'place' ? '格' : '删格'} ${d.cell} = ${SYMBOL_TEXT[d.value]}｜题面 ${base} 解｜${f.note}`);
    }
  }

  // ③ near-miss：本规则闭嘴 + 只跑它自己必须闷
  const nm = F.nearMiss;
  if (nm) {
    ok(runRule(key, createState({ ...nm.p })) === null, `${key} 的 near-miss 必须闭嘴`, nm.note);
    const alone = advance(createState({ ...nm.p }), { rules: [key] });
    ok(alone.status === 'stuck', `${key} 的 near-miss：只跑本规则必须推不完`, `${alone.status} steps=${alone.steps}`);
    ok(alone.steps === 0, `${key} 的 near-miss：只跑本规则连一步都迈不出去`, `实得 ${alone.steps} 步`);
  }

  // ④ 矛盾出口
  const ct = F.contra;
  if (ct && ct.chain) {
    ok(runRule(key, createState({ ...ct.p })) === null, `${key}：根状态上（还没删过候选）本规则必须闭嘴`);
    const r = advance(createState({ ...ct.p }), {});
    ok(r.status === 'contradiction' && r.rule === key && r.cell === ct.cell,
      `${key} 的链条矛盾出口必须归给本规则并指名格 ${ct.cell}`, `${r.status}/${r.rule}/${r.cell}`);
    ok(cnt(ct.p) === 0, `${key} 的链条矛盾盘：计数器必须独立说 0 解`, String(cnt(ct.p)));
    notes.push(`${key} contra(链)：${r.steps} 步后格 ${r.cell} 三色删光 ⇒ ${r.rule} 报矛盾｜计数器 0 解｜${ct.note}`);
  } else if (ct) {
    const d = runRule(key, createState({ ...ct.p }));
    if (ok(d && d.contradiction, `${key} 必须报矛盾`, d ? JSON.stringify({ kind: d.kind, cell: d.cell }) : 'null')) {
      ok(d.cell === ct.cell, `${key} 矛盾的指名格子`, `期望 ${ct.cell}，实得 ${d.cell}`);
      ok(cnt(ct.p) === 0, `${key} 的矛盾盘：计数器必须独立说 0 解`, String(cnt(ct.p)));
      notes.push(`${key} contra：格 ${d.cell}｜计数器 0 解｜${ct.note}`);
    }
  } else {
    // A6 / C1 只有删值出口：0 解盘上不许它们抢先报矛盾，但表里必须有人报
    const zero = fx(['aaa', 'bbb'], ['001', '...']);
    ok(runRule(key, createState({ ...zero })) === null || !runRule(key, createState({ ...zero })).contradiction,
      `${key} 不许把 0 解盘当自己的矛盾出口`);
    const r = advance(createState({ ...zero }), {});
    ok(r.status === 'contradiction' && cnt(zero) === 0, `${key}：0 解盘必须被表和计数器同时抓住`, `${r.status}/${cnt(zero)}`);
  }
}

// 整表级 near-miss：诱惑性最强的一手（每区一颗异色给定）必须**整张表都闷**
{
  const p = fx(['aaa', 'bbb'], ['0..', '1..']);
  const nd = nextDeduction(createState({ ...p }));
  ok(nd.stalled === true && nd.blank === 4, '整表 near-miss 必须闷（六条规则一圈无话）', JSON.stringify({ rule: nd.rule, blank: nd.blank }));
  const r = advance(createState({ ...p }), {});
  ok(r.status === 'stuck' && r.steps === 0, '整表 near-miss：advance 零步收工', `${r.status} steps=${r.steps}`);
  ok(cnt(p) === 3, '而这盘其实有 3 个解 ⇒ 闷不是错，是"线索不够"', String(cnt(p)));
  notes.push(`整表闷局：${JSON.stringify(Array.from(p.givens))} 六条规则零步、计数器 3 解 —— 这就是"必须猜"的形状`);
}

// ── ③ C1 不可替代证人（真实 4×6 出货盘）─────────────────────────────────────
// 这两盘是 makePuzzle('smoke|4x6|N') 出货的题面（写死在这里，证人就不依赖生成器的稳定性）。
// 断言：A 组（去掉 C1）推到不动点必须**闷**，此时 nextDeduction 的第一句话必须归给 C1，
//        而且这一口删的符号被独立计数器确认（钉上它 0 解）；留着 C1 则整盘推完且与唯一解逐格相同。
const WITNESSES = [
  {
    name: '4x6 证人 A（A 组停在 4 格）',
    reg: [2, 2, 0, 3, 2, 0, 0, 3, 7, 7, 7, 3, 4, 4, 5, 5, 4, 1, 6, 5, 1, 1, 6, 6],
    givens: [2, -1, 0, -1, -1, -1, -1, 2, -1, -1, -1, -1, -1, -1, 0, -1, 2, -1, 2, 0, -1, 0, -1, -1],
    aBlank: 4, cell: 12, value: 0, c1Hits: 6,
  },
  {
    name: '4x6 证人 B（A 组停在 18 格）',
    reg: [7, 7, 4, 4, 0, 7, 4, 3, 0, 0, 3, 3, 1, 5, 5, 2, 1, 5, 2, 2, 1, 6, 6, 6],
    givens: [0, -1, -1, 2, -1, -1, -1, -1, 1, -1, -1, 1, -1, -1, -1, -1, -1, -1, -1, 1, -1, 0, -1, -1],
    aBlank: 18, cell: 13, value: 2, c1Hits: 15,
  },
];
const A_ONLY = RULE_ORDER.filter((k) => k !== 'C1-pair-block');
for (const w of WITNESSES) {
  const p = { w: 4, h: 6, reg: Int8Array.from(w.reg), givens: Int8Array.from(w.givens) };
  const truth = countByRegion({ ...p }, { cap: 2, budget: 500_000 });
  if (!ok(!truth.stopped && truth.count === 1, `${w.name}：必须是唯一解盘（独立计数器）`, `${truth.count}/${truth.stopped}`)) continue;
  const a = advance(createState({ ...p }), { rules: A_ONLY });
  ok(a.status === 'stuck', `${w.name}：A 组必须推不完`, a.status);
  ok(a.blank === w.aBlank, `${w.name}：A 组闷住的形状（剩几格）`, `期望 ${w.aBlank}，实得 ${a.blank}`);
  const f = nextDeduction(a.st);
  ok(f.rule === 'C1-pair-block' && f.kind === 'elim' && f.cell === w.cell && f.value === w.value,
    `${w.name}：A 组闷住后的第一句话必须是 C1 删 ${w.cell} 的 ${SYMBOL_TEXT[w.value]}`,
    f.stalled ? 'STALL' : `${f.rule}@${f.cell} ${f.kind}=${f.value}`);
  const probe = countByRegion(withGiven(p, w.cell, w.value), { cap: 1, budget: 500_000 });
  ok(!probe.stopped && probe.count === 0, `${w.name}：独立计数器必须确认这一口删得对`, `钉上后 ${probe.count} 解`);
  const full = advance(createState({ ...p }), {});
  ok(full.status === 'solved', `${w.name}：留着 C1 必须推得完`, full.status);
  ok(full.hits['C1-pair-block'] === w.c1Hits, `${w.name}：C1 出场次数`, `期望 ${w.c1Hits}，实得 ${full.hits['C1-pair-block']}`);
  ok(full.out.every((v, i) => v === truth.truth[i]), `${w.name}：留 C1 推出来的盘必须与计数器唯一解逐格相同`);
  const resume = advance(applyDeduction(advance(createState({ ...p }), { rules: A_ONLY }).st, f), {});
  ok(resume.status === 'solved', `${w.name}：只补这一口 C1 之后必须能推完`, resume.status);
  notes.push(`${w.name}：A 组 ${a.steps} 步后剩 ${a.blank} 格 → 第一口 ${f.rule} 删 格${w.cell} 的 ${SYMBOL_TEXT[w.value]}（计数器独立确认 0 解）→ 全表推完`);
}

// ── ④ 提示通道 = 同一支铅笔（不许有第四条"替你猜"的分支）──────────────────────
for (const w of WITNESSES) {
  const p = { w: 4, h: 6, reg: Int8Array.from(w.reg), givens: Int8Array.from(w.givens) };
  const st = createState({ ...p });
  const batch = advance(createState({ ...p }), {});
  const log = [];
  let guard = 0;
  while (guard++ < 500) {
    const d = nextDeduction(st); // 提示走的就是这个函数
    if (d.contradiction) { log.push(`contra:${d.rule}`); break; }
    if (d.stalled) { log.push(`stall:${d.blank}`); break; }
    ok(RULE_ORDER.includes(d.rule) && Number.isInteger(d.cell) && [0, 1, 2].includes(d.value), '提示的每一条结论必须带规则名 + 格 + 符号', JSON.stringify(d));
    log.push(`${d.rule}@${d.cell}:${d.kind}=${d.value}`);
    applyDeduction(st, d);
  }
  ok(log.filter((x) => !x.startsWith('stall') && !x.startsWith('contra')).length === batch.steps,
    '逐条提示的次数必须与整盘批推的步数一致（同一条推理链，不是两套代码）', `${log.length} vs ${batch.steps}`);
  ok(blankSame(st, batch.st), '逐条提示走完的终局必须与批推一致');
}
function blankSame(a, b) {
  if (a.n !== b.n) return false;
  for (let i = 0; i < a.n; i++) if (a.cand[i] !== b.cand[i] || a.placed[i] !== b.placed[i]) return false;
  return true;
}

// ── 打印 ──────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
console.log(`\n规则表：${RULE_ORDER.join(' → ')}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT rule-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
