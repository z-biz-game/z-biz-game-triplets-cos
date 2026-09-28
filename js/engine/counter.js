// 独立穷举计数器：按**区域**推进，数清一盘在三格区域规则下一共有几个解。
//
// 它与 pencil.js 互不相干：没有规则表、没有 nextDeduction、不 import 本仓任何别的引擎文件，
// 连"谁是邻格""区域怎么摊平成格子表""九种填法的顺序"都另写一份（见文件末尾的自白）。
// 它也不看答案 —— 答案就是它自己找出来的；generate.js 拿它的 return.count 当唯一性的裁判。
//
// ── 搜索方式 ─────────────────────────────────────────────────────────────
// 一个区域恰好三格、且必须"全同或全异"⇒ 每区恰好 9 种填法（3 个全同 + 6 个全异）。
// 于是解空间是"给每个区域挑一个模式"，每挑一次就把这个区域的三个格填满。
// 每个区域恰好被挑一次 ⇒ (区域模式组合) 与 (合法填法) 一一对应：不漏也不重。
// 剪枝只有两类，都是题面文字本身而不是 pencil.js 的规则：
//   P2 本格有给定符号时，只留第该位等于给定符号的模式；
//   P4 跨区邻格已定时，只留该位不等于那个符号的模式。
// 每条跨区边界的约束都在"后定的那一个区"被检查，所以两边都会被查到。
//
// ── 预算与 cap ───────────────────────────────────────────────────────────
// budget 数的是 DFS 节点数（不是毫秒、不是内存），超了立刻停并置 stopped=true。
// cap 是"数到几个就收工"，默认 2：出货只要区分 1 个 / 不止 1 个。
// **stopped 的盘永远不许上架**：调用方看 stopped 而不是 count —— 半路的 count 可能是 1，
// 但"还没数完"和"数出来是 1"是两件事。counter-test 的证人节就是专门抓这条的。
//
// 全整数运算：没有浮点累加，也没有拿浮点当判据的比较。

const SYMBOLS = 3;

// ── 本文件自己的一份几何（故意的重复，坐标约定见 grid.js 顶部注释）────────────
// 行优先 i = r*w + c；四方向按 上、右、下、左 固定顺序。
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

// 本文件自己的一份九种填法（顺序与 counter 内部一致即可，和 partition.js 那份是两套代码）。
function ninePatterns() {
  const out = [];
  for (let s = 0; s < SYMBOLS; s++) out.push([s, s, s]);
  for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) out.push(p);
  return out;
}

function cellsByRegion(reg, n) {
  const by = [];
  for (let i = 0; i < n; i++) {
    const r = reg[i];
    if (r < 0) throw new Error(`countByRegion：格 ${i} 不属于任何区域`);
    (by[r] ||= []).push(i);
  }
  for (const cs of by) if (cs.length !== 3) throw new Error(`countByRegion：有个区域是 ${cs.length} 格，不是 3 格`);
  return by;
}

// 整盘复核：把三条规则按**题面文字**再写一遍（不是 DFS 的增量判据，是第三种表达）。
// 出题器与 counter-test 都拿它当"最后一道眼"：DFS 说是解、satisfies 说不是 ⇒ 有一边写错了。
export function satisfies(w, h, reg, val) {
  const n = w * h;
  const by = cellsByRegion(reg, n);
  for (const cs of by) {
    const [a, b, c] = cs.map((i) => val[i]);
    if (a < 0 || b < 0 || c < 0) return false;
    const allSame = a === b && b === c;
    const allDiff = a !== b && a !== c && b !== c;
    if (!allSame && !allDiff) return false;
  }
  for (let i = 0; i < n; i++) {
    if (val[i] < 0) return false;
    for (const y of neighborsOf(w, h, i)) {
      if (reg[y] === reg[i]) continue; // 同区内不受 P4 约束
      if (val[y] === val[i]) return false;
    }
  }
  return true;
}

// 主计数器。puzzle = { w, h, reg: Int16Array, givens: Int8Array(-1 = 空格) }
// 返回 { count, nodes, stopped, truth }：truth 是**找到的第一个解**（没找到则 null）。
export function countByRegion(puzzle, opts = {}) {
  const cap = opts.cap ?? 2;
  const budget = opts.budget ?? 250_000;
  const w = puzzle.w;
  const h = puzzle.h;
  const reg = puzzle.reg;
  const n = w * h;
  const cellsOf = cellsByRegion(reg, n);
  const nr = cellsOf.length;
  const PATS = ninePatterns();

  const base = new Int8Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const g = puzzle.givens[i];
    if (g >= 0) base[i] = g;
  }
  const val = Int8Array.from(base);
  const assigned = new Uint8Array(nr);
  let nodes = 0;
  let count = 0;
  let stopped = false;
  let truth = null;

  // 区域 r 当前还能用哪些填法（只看已定的格：给定格 + 已分配区域）
  const liveOf = (r) => {
    const cs = cellsOf[r];
    const out = [];
    for (let p = 0; p < PATS.length; p++) {
      const pat = PATS[p];
      let good = true;
      for (let t = 0; t < 3 && good; t++) {
        const x = cs[t];
        if (base[x] >= 0 && base[x] !== pat[t]) {
          good = false;
          break;
        }
        for (const y of neighborsOf(w, h, x)) {
          if (reg[y] === r || val[y] < 0) continue;
          if (val[y] === pat[t]) {
            good = false;
            break;
          }
        }
      }
      if (good) out.push(pat);
    }
    return out;
  };

  const walk = () => {
    if (stopped) return;
    if (++nodes > budget) {
      stopped = true;
      return;
    }
    // MRV：活模式最少的区域先定；并列取区域号小的 —— 全程无随机，换机器同一个节点数。
    let best = -1;
    let bestLive = null;
    for (let r = 0; r < nr; r++) {
      if (assigned[r]) continue;
      const live = liveOf(r);
      if (!live.length) return; // 这个数字/这个形状凑不出来，这一支死了
      if (best < 0 || live.length < bestLive.length) {
        best = r;
        bestLive = live;
      }
    }
    if (best < 0) {
      count++;
      if (!truth) truth = Array.from(val);
      return;
    }
    assigned[best] = 1;
    const cs = cellsOf[best];
    for (const pat of bestLive) {
      for (let t = 0; t < 3; t++) if (val[cs[t]] < 0) val[cs[t]] = pat[t];
      walk();
      for (let t = 0; t < 3; t++) if (base[cs[t]] < 0) val[cs[t]] = -1;
      if (count >= cap || stopped) break;
    }
    assigned[best] = 0;
  };
  walk();
  return { count, nodes, stopped, truth };
}

// 朴素证人：**逐格**枚举（按格号顺序每格试三个符号），和主计数器的"逐区域挑模式"是两种搜法。
// 它存在的意义是：主计数器哪天数错了，这一份会当场不同意。
//
// 剪枝只允许"已经定下来的格能当场算出来的题面文字"：区域满了就查 P3、邻格定了就查 P4，
// 叶子再整盘复核一遍。没有 MRV、没有模式表、没有区域推进 —— 这三件事都故意不做。
// 它同样不 import 上面那份代码，连 satisfies 也不用（判据再写一遍）。
export function countNaive(puzzle, opts = {}) {
  const budget = opts.budget ?? 8_000_000;
  const cap = opts.cap ?? 2;
  const w = puzzle.w;
  const h = puzzle.h;
  const reg = puzzle.reg;
  const n = w * h;
  const val = new Int8Array(n).fill(-1);
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (puzzle.givens[i] >= 0) {
      val[i] = puzzle.givens[i];
      fixed[i] = 1;
    }
  }
  let nodes = 0;
  let count = 0;
  let stopped = false;
  let truth = null; // 第一个解（与主计数器的 truth 对账用：count===1 时两者必须逐格相同）

  const around = (i) => {
    const r = Math.floor(i / w);
    const c = i % w;
    const out = [];
    if (r > 0) out.push(i - w);
    if (r + 1 < h) out.push(i + w);
    if (c > 0) out.push(i - 1);
    if (c + 1 < w) out.push(i + 1);
    return out;
  };
  const regionOf = (r) => {
    const cs = [];
    for (let i = 0; i < n; i++) if (reg[i] === r) cs.push(i);
    return cs;
  };
  // 局部 P3：本格所在区域若三格都定了，就必须全同或全异
  const regionOk = (i) => {
    const cs = regionOf(reg[i]);
    if (cs.some((x) => val[x] < 0)) return true;
    const a = val[cs[0]];
    const b = val[cs[1]];
    const c = val[cs[2]];
    return (a === b && b === c) || (a !== b && a !== c && b !== c);
  };
  const borderOk = (i) => {
    for (const y of around(i)) if (reg[y] !== reg[i] && val[y] >= 0 && val[y] === val[i]) return false;
    return true;
  };
  // 叶子整盘复核（和上面那两条增量判据是两种写法，不一致就是 bug）
  const fullBoardOk = () => {
    for (let r = 0; r <= Math.max.apply(null, Array.from(reg)); r++) {
      const cs = regionOf(r);
      const a = val[cs[0]];
      const b = val[cs[1]];
      const c = val[cs[2]];
      if (!(a === b && b === c) && !(a !== b && a !== c && b !== c)) return false;
    }
    for (let i = 0; i < n; i++) if (val[i] < 0) return false;
    for (let i = 0; i < n; i++) for (const y of around(i)) if (reg[y] !== reg[i] && val[y] === val[i]) return false;
    return true;
  };
  const firstBlank = () => {
    for (let i = 0; i < n; i++) if (val[i] < 0) return i;
    return -1;
  };
  const go = () => {
    if (stopped) return;
    if (++nodes > budget) {
      stopped = true;
      return;
    }
    const i = firstBlank();
    if (i < 0) {
      if (fullBoardOk()) {
        count++;
        if (!truth) truth = Array.from(val);
      }
      return;
    }
    for (let s = 0; s < 3; s++) {
      val[i] = s;
      if (regionOk(i) && borderOk(i)) go();
      val[i] = -1;
      if (count >= cap || stopped) return;
    }
  };
  go();
  return { count, nodes, stopped, truth };
}

export const DEFAULT_BUDGET = 250_000;
export const DEFAULT_CAP = 2;
