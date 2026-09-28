#!/usr/bin/env node
// 把 A5（唯一候选数 / naked single）的两个"只存在于临时探针里"的证人固化成测试。
//
// 为什么这些证人必须有个家：找"A5 报矛盾、独立计数器说 0 解"的那一盘，最初的探针
// `tools/_tmp-a5-fixture.mjs` 轮询了两轮才命中（该临时文件已删，证人就安在这个文件里），
// 而 `tools/rule-test.mjs` 里 A5 的出口只有 place。矛盾这一支要是哪天被改坏 ——
// A5 看见空掩码不报矛盾、改报"推不完"，或者更糟：假装推完并把别处的值抄进那一格 ——
// 四套测试会全体鼓掌。本文件跑通 ≠ 别删它；删了它，那条出口就又只剩注释在守护。
//
// 三条判据（都是"三方互相不信任"的口径）：
//   ① 铅笔说矛盾 ⇒ 独立计数器（js/engine/counter.js，不 import pencil）必须也说 0 解。
//   ② 判据不许拿"引擎的返回值"当事实：out/blank/hits 的自报口径全部另算一遍。
//   ③ A5 的两个已知误报形态必须被拒（本文件现场造，而不是引用曾经的运行记录）。
import { createState, advance, runRule, RULE_ORDER, RULE_WEIGHT } from '../js/engine/pencil.js';
import { countByRegion } from '../js/engine/counter.js';

let checks = 0;
const fails = [];
function check(ok, msg) {
  checks++;
  if (!ok) fails.push(msg);
}
const bit = (s) => 1 << s;
const mk = (w, h, reg, gv) => ({ w, h, reg: Int8Array.from(reg), givens: Int8Array.from(gv) });
const cnt = (p, cap = 2, budget = 500_000) => {
  const c = countByRegion({ ...p }, { cap, budget });
  return c.stopped ? null : c;
};

// ── ① 金标准盘面（取自本次重跑，不是设计出来的）──────────────────────────────
// 3×3 / 三个区域，给定 0,0,-1 / 1,-1,-1 / -1,1,-1：
// A2/A4/A6/C1 先跑完，第 5 格（行 2 列 2，0 基）三个符号被删光 ⇒ A5 报矛盾。
const GOLD = { w: 3, h: 3, reg: [0, 0, 0, 1, 1, 1, 2, 2, 2], gv: [0, 0, -1, 1, -1, -1, -1, 1, -1], cell: 4 };
{
  const p = mk(GOLD.w, GOLD.h, GOLD.reg, GOLD.gv);
  const r = advance(createState({ ...p }), {});
  check(r.status === 'contradiction', `金标准盘面应当判矛盾，实为 ${r.status}`);
  check(r.rule === 'A5-naked-single', `报矛盾的应当是 A5，实为 ${r.rule}`);
  check(r.cell === GOLD.cell, `矛盾格应为 ${GOLD.cell}，实为 ${r.cell}`);
  check(r.st.cand[GOLD.cell] === 0, `矛盾格的掩码应为空，实为 0b${r.st.cand[GOLD.cell].toString(2)}`);
  // 矛盾出口不许"推完"：没填的格在快照里必须是 -1
  check(r.out[GOLD.cell] === -1, 'out 不许给空掩码的格编一个符号');
  check(RULE_ORDER[RULE_ORDER.length - 1] === 'A5-naked-single', 'A5 必须是最后一条（兜底位）');
  check(RULE_WEIGHT['A5-naked-single'] === 1, `A5 权重应为 1（只看本格），实为 ${RULE_WEIGHT['A5-naked-single']}`);
  // A5 是"读别人的结论"，不进 hit 账（pencil.js:287 注释那条口径）
  check((r.hits['A5-naked-single'] || 0) === 0, `A5 报矛盾不该给自己计 hit，实为 ${r.hits['A5-naked-single']}`);
  const c = cnt(p);
  check(c !== null && c.count === 0, `独立计数器应当说 0 解，实为 ${c === null ? 'overbudget' : c.count}`);
  // 已填格的掩码必须是单元素：A5 落子时会把 cand[i]=bit(sym) 写回去（x6 那条陈旧项守卫的前提）
  let badSingleton = 0;
  for (let i = 0; i < r.st.n; i++) if (r.st.placed[i] && (r.st.cand[i] & (r.st.cand[i] - 1)) !== 0) badSingleton++;
  check(badSingleton === 0, `有 ${badSingleton} 个已填格的掩码不是单元素（A5 落子没写回 cand）`);
}

// ── ② 枚举复现：A5 报矛盾的每一盘，计数器必须都说 0 解 ──────────────────────
// 与金标准同一套判据，只是盘面换成穷举出来的。只跑合法分区（每区恰好 3 格连通），
// 不合法的一律跳过 —— 早先那版探针直接在 2×3 棋盘格分区上崩过
// （counter 抛"有个区域是 4 格，不是 3 格"），那是探针自己的 bug，不是引擎的。
const GRIDS = [
  { w: 3, h: 2, reg: [0, 0, 0, 1, 1, 1] },
  { w: 3, h: 3, reg: [0, 0, 0, 1, 1, 1, 2, 2, 2] },
  { w: 3, h: 3, reg: [0, 0, 1, 2, 1, 1, 2, 0, 0] },
  { w: 2, h: 3, reg: [0, 0, 0, 1, 1, 1] },
];
function isValidPartition(reg, n) {
  const size = new Map();
  for (let i = 0; i < n; i++) size.set(reg[i], (size.get(reg[i]) || 0) + 1);
  for (const [, k] of size) if (k !== 3) return false;
  return true;
}
function* boards(n, maxGivens) {
  for (let k = 1; k <= maxGivens; k++) {
    const idx = new Array(k).fill(0);
    const out = [];
    const assign = (t) => {
      if (t === k) {
        const g2 = new Int8Array(n).fill(-1);
        const fillSym = (u) => {
          if (u === k) {
            out.push(g2.slice());
            return;
          }
          for (let s = 0; s < 3; s++) {
            g2[idx[u]] = s;
            fillSym(u + 1);
          }
          g2[idx[u]] = -1;
        };
        fillSym(0);
        return;
      }
      for (let i = (t ? idx[t - 1] : -1) + 1; i <= n - (k - t); i++) {
        idx[t] = i;
        assign(t + 1);
      }
    };
    assign(0);
    for (const b of out) yield b;
  }
}
{
  let witnesses = 0;
  let contradicted = 0;
  let mismatchWithCounter = 0;
  let solvedWithZero = 0;
  for (const g of GRIDS) {
    const n = g.w * g.h;
    const reg = Int8Array.from(g.reg);
    if (!isValidPartition(reg, n)) continue;
    for (const gv of boards(n, 4)) {
      const p = mk(g.w, g.h, g.reg, Array.from(gv));
      const c = cnt(p);
      if (!c) continue; // 数不完的那盘不参与本判据
      const r = advance(createState({ ...p }), {});
      if (r.status === 'contradiction') {
        contradicted++;
        if (c.count !== 0) mismatchWithCounter++;
        if (r.rule === 'A5-naked-single') {
          witnesses++;
          check(c.count === 0, `A5 报矛盾但计数器有 ${c.count} 解：reg ${g.reg} gv ${Array.from(gv)}`);
          check(r.st.cand[r.cell] === 0, `A5 矛盾的格子掩码非空：reg ${g.reg} gv ${Array.from(gv)}`);
        }
      }
      if (r.status === 'solved' && c.count === 0) {
        solvedWithZero++; // 铅笔"推完"了一盘 0 解的题 ⇒ 引擎在编答案
      }
      if (r.status === 'solved') {
        check(c.count >= 1, `铅笔推完了但计数器 0 解：reg ${g.reg} gv ${Array.from(gv)}`);
        const v = c.truth ? r.out.every((x, k) => x === c.truth[k]) || c.count > 1 : true;
        check(v, `推完的结果不在计数器的真值里：reg ${g.reg} gv ${Array.from(gv)}`);
      }
    }
  }
  check(witnesses > 0, '穷举里一个 A5 矛盾证人都没找到（那 ① 的金标准就是孤儿）');
  check(contradicted > 0, '穷举里没有任何矛盾出口');
  check(mismatchWithCounter === 0, `有 ${mismatchWithCounter} 盘 A5 报矛盾而计数器不为 0`);
  check(solvedWithZero === 0, `有 ${solvedWithZero} 盘 0 解却被铅笔判成 solved（假完成）`);
  console.log(`   （枚举复现：A5 矛盾证人 ${witnesses} 盘，总矛盾 ${contradicted} 盘，全部与独立计数器一致）`);
}

// ── ③ 两个误报形态现场造，A5 必须闭嘴 ──────────────────────────────────────
// x6：A5 的扫描循环里那句"掩码是单元素就 continue"没有 placed 守卫，
//  cand[s] 里残留的旧位（陈旧项）会让它误报 contradiction。曾经真的这样（探针抓到过），
//  现在引擎在落子时把 cand[s]=bit(sym) 写回去了（pencil.js:355），所以这两个局面应当被拒。
function mk32(gv) {
  return mk(3, 2, [0, 0, 0, 1, 1, 1], gv);
}
{
  // (a) s=2 已填圆圈、cand[2] 陈旧地留着方块位；2 所在区只剩方块可填，而方块被邻区占死
  const p = mk32([-1, -1, 1, 1, 0, 0]);
  const st = createState({ ...p });
  st.placed[2] = 1;
  st.cand[2] = bit(1); // 正确形态：单元素（引擎落子后的样子）
  const r = advance(st, { rules: ['A5-naked-single'] });
  check(r.status !== 'contradiction', `(a) 规范落子后 A5 仍报矛盾：${r.why}`);
  const st2 = createState({ ...p });
  st2.placed[2] = 1;
  st2.cand[2] = bit(0) | bit(1); // 病态形态：已填但掩码里还留着旧位
  const r2 = advance(st2, { rules: ['A5-naked-single'] });
  check(
    r2.status !== 'contradiction' || /陈旧/.test(r2.why || ''),
    `(b) 陈旧项没被拒：A5 直接报"三个符号都被删光了" —— 落子的同时把 cand 写成单元素这一步是这条闸的前提，why=${r2.why}`
  );
  check(
    r2.status === 'contradiction' ? r2.rule === 'A5-naked-single' && !/三个符号都被删光了/.test(r2.why) : true,
    `(b) 空掩码判定把陈旧项当成空位：why=${r2.why}`
  );
  // (c) 开局满候选状态下直接问 A5：不许凭空报矛盾（那时没有任何空格）
  const st3 = createState({ ...p });
  const dup = runRule('A5-naked-single', st3);
  check(dup === null || !dup.contradiction || /陈旧/.test(dup.why || ''), `A5 在开局满候选状态下就报矛盾：${JSON.stringify(dup && dup.why)}`);
  // (d) placed 与 out 必须一致：snapshot（js/engine/pencil.js:418）只从 placed 出发造 out，
  //     所以"没填的格有自己的符号"这类幻象只可能来自 placed/cand 脱钩。全表推完后逐格对账。
  const st4 = advance(createState({ ...p }), {});
  let ghost = 0;
  for (let i = 0; i < st4.st.n; i++) if (!!st4.st.placed[i] !== (st4.out[i] !== -1)) ghost++;
  check(ghost === 0, `${ghost} 格的 placed 与 out 不一致（有格被凭空填上，或有格被凭空抹掉）`);
}

console.log(`RESULT a5-contradiction-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
for (const f of fails) console.error('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
