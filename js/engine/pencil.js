// 铅笔推理核：只吃题面（尺寸 + 区域 + 给定符号），**不知道答案、不回溯、不猜**。
//
// 每条规则都必须是题面文字的直接推论，规则名旁边写着它从哪句话来。规则按 RULE_ORDER
// 固定顺序轮询，nextDeduction 一次只给一条结论，并附人话 why —— 提示通道用的就是它，
// 所以"提示只给下一步可证的事实"这句话，靠的就是这里不许有第四条"替你猜一个"的分支。
//
// 本文件刻意不 import partition.js / counter.js：出题那边先有解再挖线索，推理这边不许偷看，
// 三方（铅笔 / 计数器 / 出题器）互相不信任，共用的只有 rng。几何/邻接编码在这里另写一份
// （grid.js 是约定的文档，不是本文件的依赖）—— 同一套语义写两遍，一份写错测试会当场不同意。
//
// 规则表（六条，逐条都在出货盘上出过场，出场盘数由 tools/balance.mjs 量）：
//   A2 同形锁      区内两格已定为同一符号 ⇒ 第三格也是这个符号          （P3 的"全异"分支死了）
//   A3 全异补      区内两格已定为不同符号 ⇒ 第三格是剩下的那个符号      （P3 的"全同"分支死了）
//   A4 邻界排除    跨区邻格已定为 s ⇒ 本格删掉 s                          （P4 原文直译）
//   A6 区内放不下  本格取 s 时本区既凑不齐全同也凑不齐全异 ⇒ 删掉 s      （P3 + 本区候选）
//   C1 跨区配对封锁 本格取 s 时本区的每种填法都和某个邻区配不上 ⇒ 删掉 s  （P3 + P4 的两区联立）
//   A5 唯一候选    本格候选只剩 1 ⇒ 落子
// A5 排在最后：它最机械（只看一格），把命中让给更有信息量的规则才好谈难度。
//
// 为什么只有这六条（试过的另外两条去哪了）：
//   B1「区域必全异」（三区候选交集为空 ⇒ 只能全异）与 B2「区域必全同」（本区凑不出任何
//   全异 ⇒ 只能全同）都实现过、量过：7 档 × 12 盘 = 84 盘出货上出场 **0/84**，
//   原因是两者的判据本身就是 A6 的逐格判据之和 —— B1 成立时 A6 会把另两格的那个符号逐个删掉，
//   B2 成立时同理。删了。
//   A5「唯一候选」在原型里出场 0 盘（`_tmp` 复量记录），那是一条恒假分支（single() 之后
//   又要求 popcount===1）；本文件把"候选塌成单个"当成一次真正的落子来记，出场 12/12 盘每档都是。
//
// 全整数位运算（候选 = 3 位掩码），没有浮点累加，也没有拿浮点当判据的比较。

const SYMBOLS = 3;
const ALL = 0b111;
export const BLANK = -1;

// 单一候选 ⇔ 已落子。用位运算判 popcount，不依赖 Math.log2 的浮点精度。
const singleBit = (m) => (m !== 0 && (m & (m - 1)) === 0 ? m : -1);
const bitToSymbol = (m) => (m === 1 ? 0 : m === 2 ? 1 : m === 4 ? 2 : -1);

// ── 本文件自己的一份几何（约定见 grid.js 顶部；这里是故意的第二份实现）──────────
function nbrs(w, h, i) {
  const r = Math.floor(i / w);
  const c = i % w;
  const out = [];
  if (r > 0) out.push(i - w);
  if (r + 1 < h) out.push(i + w);
  if (c > 0) out.push(i - 1);
  if (c + 1 < w) out.push(i + 1);
  return out;
}
const cellName = (w, i) => `第 ${Math.floor(i / w) + 1} 行第 ${(i % w) + 1} 列`;
export const SYMBOL_TEXT = ['方块', '圆圈', '三角'];

export function createState(puzzle) {
  const w = puzzle.w;
  const h = puzzle.h;
  const n = w * h;
  const reg = puzzle.reg;
  const cellsOf = [];
  for (let i = 0; i < n; i++) {
    if (reg[i] < 0) throw new Error(`createState：格 ${i} 没有区域`);
    (cellsOf[reg[i]] ||= []).push(i);
  }
  for (const cs of cellsOf) if (cs.length !== 3) throw new Error(`createState：有区域是 ${cs.length} 格，不是 3 格`);
  const cand = new Uint8Array(n).fill(ALL);
  const placed = new Uint8Array(n);
  // 给定格：候选压成它自己、直接算已落子（A1 给定即事实，不是推理，不进 RULE_ORDER）
  for (let i = 0; i < n; i++) {
    const g = puzzle.givens[i];
    if (g >= 0) {
      cand[i] = 1 << g;
      placed[i] = 1;
    }
  }
  const st = { w, h, n, reg, cellsOf, nr: cellsOf.length, cand, placed, log: [], hits: {}, rounds: 0, steps: 0 };
  return st;
}

export const symbolOf = (st, i) => (st.placed[i] ? bitToSymbol(st.cand[i]) : -1);
export const blankCount = (st) => {
  let k = 0;
  for (let i = 0; i < st.n; i++) if (!st.placed[i]) k++;
  return k;
};
export const candidatesOf = (st, i) => st.cand[i];

// ── 区域层面的可行性 ──────────────────────────────────────────────────────
// 九个填法（3 全同 + 6 全异）是本区全部合法形状；A6 与 C1 的判据都从这里出发。
const TUPLES = [
  [0, 0, 0],
  [1, 1, 1],
  [2, 2, 2],
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
// 本区还活得下来的填法：9 种里挑出与当前候选相容的那些（C1 用）。
function regionTuples(st, cs) {
  const out = [];
  for (const p of TUPLES) if (cs.every((x, t) => st.cand[x] & (1 << p[t]))) out.push(p);
  return out;
}
// 区域 r 的第 tr 格与区域 q 的第 tq 格跨区域相邻 ⇒ 这一对位置受 P4 管（固定顺序）。
// 区域几何在整个求解过程中不变，所以按 (r,q) 记忆化 —— 不记就是每轮 O(NR^2*9) 的白工。
function borderPairsBetween(st, r, q) {
  st.bpMemo ||= new Map();
  const hit = st.bpMemo.get(r * st.nr + q);
  if (hit) return hit;
  const out = [];
  const cs = st.cellsOf[r];
  const ds = st.cellsOf[q];
  for (let tr = 0; tr < 3; tr++) {
    for (let tq = 0; tq < 3; tq++) {
      if (nbrs(st.w, st.h, cs[tr]).includes(ds[tq])) out.push([tr, tq]);
    }
  }
  st.bpMemo.set(r * st.nr + q, out);
  return out;
}
// 固定 cs[k] = s 之后，本区还能不能全异（给 A6 用）
function diffFeasibleWith(st, cs, k, s) {
  const rest = [0, 1, 2].filter((q) => q !== s);
  const others = [0, 1, 2].filter((q) => q !== k);
  const a = others[0];
  const b = others[1];
  return (
    (st.cand[cs[a]] & (1 << rest[0]) && st.cand[cs[b]] & (1 << rest[1])) ||
    (st.cand[cs[a]] & (1 << rest[1]) && st.cand[cs[b]] & (1 << rest[0]))
  );
}

// ── 规则实现 ───────────────────────────────────────────────────────────────
// 每条规则返回：null（无话可说）/ {cell, kind, value, why}（一条结论）/ {contradiction:true, cell, why}
// 扫描顺序全固定（区域号升序、格序升序、符号 0→2），所以 node 与 Chrome 得到同一串结论。

const RULES = {
  'A2-same-lock': (st) => {
    for (let r = 0; r < st.nr; r++) {
      const cs = st.cellsOf[r];
      for (let a = 0; a < 3; a++) {
        for (let b = a + 1; b < 3; b++) {
          if (!st.placed[cs[a]] || !st.placed[cs[b]]) continue;
          const sa = bitToSymbol(st.cand[cs[a]]);
          const sb = bitToSymbol(st.cand[cs[b]]);
          if (sa !== sb) continue; // 交给 A3
          const third = cs[3 - a - b];
          if (st.placed[third]) {
            const sv = bitToSymbol(st.cand[third]);
            if (sv !== sa) {
              return { contradiction: true, cell: third, why: `${cellName(st.w, third)}已定为${SYMBOL_TEXT[sv]}，但同区另两格都是${SYMBOL_TEXT[sa]}：三格既不全同也不全异` };
            }
            continue;
          }
          if (!(st.cand[third] & (1 << sa))) {
            return { contradiction: true, cell: third, why: `同区两格已是${SYMBOL_TEXT[sa]} ⇒ 第三格只能是${SYMBOL_TEXT[sa]}，可它的候选里已经没有这个符号了` };
          }
          return { cell: third, kind: 'place', value: sa, why: `本区已有两格定为${SYMBOL_TEXT[sa]} ⇒ "全异"这条路死了 ⇒ 本区必须全同，第三格也是${SYMBOL_TEXT[sa]}` };
        }
      }
    }
    return null;
  },

  'A3-all-diff-completion': (st) => {
    for (let r = 0; r < st.nr; r++) {
      const cs = st.cellsOf[r];
      for (let a = 0; a < 3; a++) {
        for (let b = a + 1; b < 3; b++) {
          if (!st.placed[cs[a]] || !st.placed[cs[b]]) continue;
          const sa = bitToSymbol(st.cand[cs[a]]);
          const sb = bitToSymbol(st.cand[cs[b]]);
          if (sa === sb) continue; // 交给 A2
          const third = cs[3 - a - b];
          const rest = [0, 1, 2].find((s) => s !== sa && s !== sb);
          if (st.placed[third]) {
            if (bitToSymbol(st.cand[third]) !== rest) {
              return { contradiction: true, cell: third, why: `本区两格是${SYMBOL_TEXT[sa]}与${SYMBOL_TEXT[sb]} ⇒ 必须全异 ⇒ 第三格只能是${SYMBOL_TEXT[rest]}，可它已定为${SYMBOL_TEXT[bitToSymbol(st.cand[third])]}` };
            }
            continue;
          }
          if (!(st.cand[third] & (1 << rest))) {
            return { contradiction: true, cell: third, why: `本区两格是${SYMBOL_TEXT[sa]}与${SYMBOL_TEXT[sb]} ⇒ 第三格只能是${SYMBOL_TEXT[rest]}，可它的候选里已经没有这个符号了` };
          }
          return { cell: third, kind: 'place', value: rest, why: `本区已有两格定为不同的 ${SYMBOL_TEXT[sa]}/${SYMBOL_TEXT[sb]} ⇒ "全同"这条路死了 ⇒ 必须全异，第三格是剩下的${SYMBOL_TEXT[rest]}` };
        }
      }
    }
    return null;
  },

  'A4-border-exclude': (st) => {
    for (let i = 0; i < st.n; i++) {
      if (!st.placed[i]) continue;
      const s = bitToSymbol(st.cand[i]);
      for (const y of nbrs(st.w, st.h, i)) {
        if (st.reg[y] === st.reg[i]) continue; // 同区内不受 P4 约束
        if (!(st.cand[y] & (1 << s))) continue;
        if (st.placed[y]) {
          return { contradiction: true, cell: y, why: `${cellName(st.w, i)}是${SYMBOL_TEXT[s]}，跨区域相邻的${cellName(st.w, y)}也定了${SYMBOL_TEXT[s]} ⇒ 违反"跨区相邻必须不同"` };
        }
        return { cell: y, kind: 'elim', value: s, why: `${cellName(st.w, i)}是${SYMBOL_TEXT[s]}，与本格跨区域相邻 ⇒ 本格不能是${SYMBOL_TEXT[s]}` };
      }
    }
    return null;
  },

  'A6-region-infeasible': (st) => {
    for (let r = 0; r < st.nr; r++) {
      const cs = st.cellsOf[r];
      for (let t = 0; t < 3; t++) {
        const j = cs[t];
        if (st.placed[j]) continue;
        for (let s = 0; s < SYMBOLS; s++) {
          if (!(st.cand[j] & (1 << s))) continue;
          const others = cs.filter((x) => x !== j);
          const canSame = others.every((x) => st.cand[x] & (1 << s));
          const canDiff = diffFeasibleWith(st, cs, t, s);
          if (canSame || canDiff) continue;
          return { cell: j, kind: 'elim', value: s, why: `若本格取${SYMBOL_TEXT[s]}：本区要么全同（另两格得都收得下${SYMBOL_TEXT[s]}）要么全异（另两格得收下剩下两色）—— 两条都凑不齐 ⇒ 本格删掉${SYMBOL_TEXT[s]}` };
        }
      }
    }
    return null;
  },


  // C1 跨区配对封锁：本格取 s 时，若"本区某个收得下 s 的填法"与"每个邻区的任何一种填法"都配不上
  //             （跨区相邻的那几格必撞同色）⇒ 本格删掉 s。
  // 这是**区域与区域之间**的相容性检查：A4 只在"邻格已经落子"时才动手，A6 只看本区自己的两支。
  // 它是不是被 A 组蕴含，不看感觉：tools/rule-test.mjs 里那盘写死的 4×6 证人，摘掉 C1 推不完、
  // 留着 C1 推得完且结论与独立计数器给的唯一解逐格相同；逐档救援率（摘掉 C1 后推不完的盘数）
  // 由 tools/balance.mjs 印。
  'C1-pair-block': (st) => {
    const live = st.cellsOf.map((cs) => regionTuples(st, cs));
    for (let r = 0; r < st.nr; r++) {
      const cs = st.cellsOf[r];
      if (!live[r].length) continue; // 本区自己已经死了：那是 A6/A5 报矛盾的职责，C1 不越权
      const nb = [];
      for (let q = 0; q < st.nr; q++) {
        if (q === r) continue;
        const pairs = borderPairsBetween(st, r, q);
        if (pairs.length) nb.push({ q, pairs });
      }
      if (!nb.length) continue;
      for (let t = 0; t < 3; t++) {
        const j = cs[t];
        if (st.placed[j]) continue;
        for (let s = 0; s < SYMBOLS; s++) {
          if (!(st.cand[j] & (1 << s))) continue;
          const here = live[r].filter((p) => p[t] === s);
          if (!here.length) continue; // 本区就放不下 s，那是 A6 的活儿
          let supported = false;
          for (const p of here) {
            let allOk = true;
            for (const { q, pairs } of nb) {
              if (!live[q].length) {
                allOk = false;
                break;
              }
              let any = false;
              for (const u of live[q]) {
                if (pairs.every(([tr, tq]) => p[tr] !== u[tq])) {
                  any = true;
                  break;
                }
              }
              if (!any) {
                allOk = false;
                break;
              }
            }
            if (allOk) {
              supported = true;
              break;
            }
          }
          if (supported) continue;
          return { cell: j, kind: 'elim', value: s, why: `本格取${SYMBOL_TEXT[s]}时，本区收得下它的每种填法都和某个邻区配不上（跨区相邻的格必撞同色）⇒ 本格删掉${SYMBOL_TEXT[s]}` };
        }
      }
    }
    return null;
  },

  'A5-naked-single': (st) => {
    for (let i = 0; i < st.n; i++) {
      if (st.placed[i]) continue;
      if (st.cand[i] === 0) {
        return { contradiction: true, cell: i, why: `${cellName(st.w, i)}三个符号都被删光了 ⇒ 这盘没有解` };
      }
      const one = singleBit(st.cand[i]);
      if (one < 0) continue;
      return { cell: i, kind: 'place', value: bitToSymbol(one), why: `本格的候选被删到只剩 ${SYMBOL_TEXT[bitToSymbol(one)]} ⇒ 本格就是${SYMBOL_TEXT[bitToSymbol(one)]}` };
    }
    return null;
  },
};

export const RULE_ORDER = ['A2-same-lock', 'A3-all-diff-completion', 'A4-border-exclude', 'A6-region-infeasible', 'C1-pair-block', 'A5-naked-single'];

export const RULE_TEXT = {
  'A2-same-lock': '同形锁：区内两格已同为某符号 ⇒ 第三格也是它（每区全同或全异）',
  'A3-all-diff-completion': '全异补：区内两格已为不同符号 ⇒ 第三格是剩下的那个（每区全同或全异）',
  'A4-border-exclude': '邻界排除：跨区域相邻的格符号必须不同',
  'A6-region-infeasible': '区内放不下：本格取某符号时本区既凑不齐全同也凑不齐全异 ⇒ 删掉它',
  'C1-pair-block': '跨区配对封锁：本格取某符号时，本区收得下它的每种填都和某个邻区配不上 ⇒ 删掉它',
  'A5-naked-single': '唯一候选：本格只剩一个符号 ⇒ 落子',
};

// 难度权重（**balance 的度量口径，不是引擎给的数**）：用这条规则要"看多远"。
// 本格 1 / 共边 2 / 区域可行性 3。
export const RULE_WEIGHT = {
  'A2-same-lock': 3,
  'A3-all-diff-completion': 3,
  'A4-border-exclude': 2,
  'A6-region-infeasible': 3,
  'C1-pair-block': 4,
  'A5-naked-single': 1,
};

export function ruleKeys() {
  return RULE_ORDER.slice();
}

// 单条规则跑一遍（tools/rule-test.mjs 用它做"选中性"检查：该发的 case 要发、
// 只差一点的 near-miss case 必须闷 —— 逢发必挂的规则没有选择性）。
export function runRule(key, st) {
  const fn = RULES[key];
  if (!fn) throw new Error(`未知规则 ${key}`);
  const d = fn(st);
  if (!d) return null;
  if (d.contradiction) return { contradiction: true, rule: key, ruleText: RULE_TEXT[key], cell: d.cell, why: d.why };
  if (!st.placed[d.cell] && d.kind === 'place' && !(st.cand[d.cell] & (1 << d.value))) {
    throw new Error(`${key} 想往格 ${d.cell} 落 ${d.value}，但那个符号早被删掉了 —— 规则自己写错了`);
  }
  if (d.kind === 'elim' && !(st.cand[d.cell] & (1 << d.value))) return null; // 已经删过了
  return { rule: key, ruleText: RULE_TEXT[key], cell: d.cell, kind: d.kind, value: d.value, why: d.why };
}

// 下一条**被迫**的结论。返回三态之一：
//   { rule, ruleText, cell, kind, value, why }  —— 一条新结论（落子或删候选）
//   { contradiction: true, rule, cell, why }    —— 盘上已经自己打脸
//   { stalled: true, blank, why }               —— 推不动了（不是错，只是不够）
export function nextDeduction(st, order = RULE_ORDER) {
  for (const key of order) {
    const d = runRule(key, st);
    if (d) return d;
  }
  return { stalled: true, blank: blankCount(st), why: `${order.length} 条规则轮询一圈，还剩 ${blankCount(st)} 格没定` };
}

export function applyDeduction(st, d) {
  if (d.kind === 'place') {
    st.cand[d.cell] = 1 << d.value;
    st.placed[d.cell] = 1;
  } else {
    st.cand[d.cell] &= ~(1 << d.value);
    // 删到空集不当场报错：那是"这盘没有解"，由下一轮 A5-naked-single 或 verify 报出来，
    // 这样矛盾只有一条出口，rule-test 才能核对到底是哪条规则在指名。
  }
  st.hits[d.rule] = (st.hits[d.rule] || 0) + 1;
  st.steps++;
  st.log.push(`${d.rule}@${cellName(st.w, d.cell)}: ${d.why}`);
  return st;
}

// 整盘自检：只在推完以后用，不参与推理（不偷看答案）。判据是题面文字第三次表达。
export function verify(st) {
  for (let i = 0; i < st.n; i++) {
    if (!st.placed[i]) return { ok: false, why: `还有 ${blankCount(st)} 格没定` };
    if (singleBit(st.cand[i]) < 0) return { ok: false, why: `格 ${i} 已落子但候选不是单一符号` };
  }
  for (let r = 0; r < st.nr; r++) {
    const cs = st.cellsOf[r];
    const a = bitToSymbol(st.cand[cs[0]]);
    const b = bitToSymbol(st.cand[cs[1]]);
    const c = bitToSymbol(st.cand[cs[2]]);
    const allSame = a === b && b === c;
    const allDiff = a !== b && a !== c && b !== c;
    if (!allSame && !allDiff) return { ok: false, why: `区域 ${r} 三格 ${SYMBOL_TEXT[a]}/${SYMBOL_TEXT[b]}/${SYMBOL_TEXT[c]} 既不全同也不全异` };
  }
  for (let i = 0; i < st.n; i++) {
    const s = bitToSymbol(st.cand[i]);
    for (const y of nbrs(st.w, st.h, i)) {
      if (st.reg[y] === st.reg[i]) continue;
      if (bitToSymbol(st.cand[y]) === s) return { ok: false, why: `${cellName(st.w, i)} 与 ${cellName(st.w, y)} 跨区域相邻却同为 ${SYMBOL_TEXT[s]}` };
    }
  }
  return { ok: true, why: '每格一个符号；每区全同或全异；跨区相邻格互异' };
}

// 在**已有状态**上跑到不动为止。零猜测：只调用 nextDeduction，不回溯、不试数。
// opts.rules 可以传一个规则子集 —— rule-test 拿它做"这条规则是不是被别的规则蕴含"的证人：
// 同一个局面，去掉 C1 推不动、留着 C1 推得动 ⇒ C1 有不可替代的贡献。
// 注意"推不动"和"推完了"是两件事：满线索盘一步都不用推，但它算 solved（blank === 0）。
// 返回 status: 'solved' | 'stuck' | 'contradiction' | 'tooDeep'
export function advance(st, opts = {}) {
  const order = opts.rules || RULE_ORDER;
  const maxSteps = opts.maxSteps ?? 20000;
  while (true) {
    if (st.steps >= maxSteps) return { status: 'tooDeep', st, out: snapshot(st), hits: st.hits, steps: st.steps, why: `步数超过 maxSteps=${maxSteps}` };
    const d = nextDeduction(st, order);
    if (d.contradiction) return { status: 'contradiction', st, out: snapshot(st), hits: st.hits, steps: st.steps, rule: d.rule, cell: d.cell, why: d.why };
    if (d.stalled) {
      const solved = blankCount(st) === 0;
      return { status: solved ? 'solved' : 'stuck', st, out: snapshot(st), hits: st.hits, steps: st.steps, blank: d.blank, why: solved ? `${order.length} 条规则推满 ${st.n} 格` : d.why };
    }
    applyDeduction(st, d);
  }
}

// 从题面建新状态再跑（生成器与 balance 走这条路）。
export function solveWithRules(puzzle, opts = {}) {
  return advance(createState(puzzle), opts);
}

function snapshot(st) {
  const out = new Int8Array(st.n).fill(-1);
  for (let i = 0; i < st.n; i++) if (st.placed[i]) out[i] = bitToSymbol(st.cand[i]);
  return out;
}
export { snapshot as stateToValues };
