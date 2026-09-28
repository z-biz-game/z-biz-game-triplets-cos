// 剖分与造解：把 w×h 切成"恰好三格且连通"的区域（P1），再挑一组满足 P3/P4 的符号当参考解。
//
// 这一块属于**出题器**，它知道答案；pencil.js 与 counter.js 都不许读这里的产物当推理依据
// （generate.js 只把 reg + 线索交给它们）。
//
// ── 为什么不用"整盘切不满就重来"的贪心 ────────────────────────────────
// 原型（选型测量用的 _tmp-triplets-lib.mjs）里 partition3 是"逐格播种、每次往前沿挑一个空格长
// 到三格，任何一次挑不到邻居就整盘作废"。实测它的失败率随尺寸爆炸：
//   4×6 0.0% / 6×6 0.2% / 6×8 30.9% / 6×9 56.4% / 8×9 95.8%（各 3000 抽，2026-09-28 本机复测）
// 于是"8×9 抽 480 张出货 0 张"量的其实是这个贪心的运气，不是谜题的难度。本文件换成
// **先驱格 + 可行 placements 枚举 + 三格整块落子**，配合下面那条不变式，把浪费抽卡这件事从
// 判定路径上摘掉，让 ceiling / balance 量到的抽卡数真正反映"唯一 + 铅笔"两道门。
//
// ── 维护的不变式：未分配格的每个连通块，格数 ≡ 0 (mod 3) ──────────────────
// 区域是 3 格、且区域之间不共享格 ⇒ 剩余空格必须能被若干个三格区域正好分完。
// 一个连通块若格数不是 3 的倍数，它永远分不干净，所以这种落子当场否决。
// 每步落 3 个格 ⇒ 总数恒 ≡ 0，只需检查被切开的那几块。这条既便宜（每次落子 O(N) BFS）又厉害，
// 它就是"8×9 也能一次切满"的原因。它只是**必要条件**不是充分条件，所以还留整盘重启兜底，
// 重启次数进 stats.partitionRestarts，让"生成器自己有多别扭"这件事可被量、可被红。

import { SYMBOLS, neighbors, cellIndex, rowOf, colOf, cellsOfRegions } from './grid.js';

// 22 个"含先驱格"的三格骨牌形状（以先驱格为原点 (0,0) 的 [dr,dc] 偏移表），固定顺序枚举。
// 直条 I：水平/竖直各 3 个相位 = 6；拐角 L：包含先驱格的 2×2 块有 4 个，每块去掉一个非先驱角 = 16。
const STRAIGHT = [
  [[0, 0], [0, 1], [0, 2]],
  [[0, -1], [0, 0], [0, 1]],
  [[0, -2], [0, -1], [0, 0]],
  [[0, 0], [1, 0], [2, 0]],
  [[-1, 0], [0, 0], [1, 0]],
  [[-2, 0], [-1, 0], [0, 0]],
];
const BLOCK_ANCHORS = [[-1, -1], [-1, 0], [0, -1], [0, 0]]; // 2×2 块左上角相对先驱格的四个位置
const CORNERS = [[0, 0], [0, 1], [1, 0], [1, 1]];

// 所有含 (0,0) 的连通三格形状（去重、固定顺序）。
export function triadShapes() {
  const seen = new Set();
  const out = [];
  const push = (tri) => {
    const key = tri
      .map(([r, c]) => `${r},${c}`)
      .sort((a, b) => (a < b ? -1 : 1))
      .join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tri);
  };
  for (const s of STRAIGHT) push(s.map(([r, c]) => [r, c]));
  for (const [br, bc] of BLOCK_ANCHORS) {
    for (let miss = 0; miss < 4; miss++) {
      const tri = [];
      for (let k = 0; k < 4; k++) {
        if (k === miss) continue;
        tri.push([CORNERS[k][0] + br, CORNERS[k][1] + bc]);
      }
      // 去掉的那个角不能是先驱格本身（那样先驱格就不在区域里了）
      if (tri.some(([r, c]) => r === 0 && c === 0)) push(tri);
    }
  }
  return out;
}
const SHAPES = triadShapes();

// 落子之后，**贴着这次落子的**每个未分配连通块的格数必须 ≡ 0 (mod 3)。
// 只有这些块被这次落子改变过：其余块上一次已检查、这次一个格都没少。
// （先驱格这次已经被划走了，所以不能拿它当 BFS 起点 —— 起点只能是落子格的未分配邻格。）
// 落子之后，**贴着这次落子的**每个未分配连通块的格数必须 ≡ 0 (mod 3)。
// 只有这些块被这次落子改变过：其余块上一次已检查、这次一个格都没少。
// （先驱格已被这次落子划走，不能拿它当起点 —— 起点只能是落子格的未分配邻格。）
// 两个起点可能同属一块，所以 visited 跨起点共用，一块只量一次。
function componentsOk(w, h, used, placed) {
  const n = w * h;
  const done = new Uint8Array(n);
  const starts = [];
  for (const x of placed) {
    for (const y of neighbors(w, h, x)) if (!used[y]) starts.push(y);
  }
  for (const s of starts) {
    if (done[s]) continue; // 同一块可能有多个起点，只量第一个
    let size = 0;
    const stack = [s];
    done[s] = 1;
    while (stack.length) {
      const x = stack.pop();
      size++;
      for (const y of neighbors(w, h, x)) {
        if (!used[y] && !done[y]) {
          done[y] = 1;
          stack.push(y);
        }
      }
    }
    if (size % 3 !== 0) return false;
  }
  return true;
}

// 随机剖分：返回 Int16Array reg（区域号按落子顺序 0..NR-1），失败（重启用尽）返回 null。
//
// 随机只在两处：先驱格的选取顺序（预抽一个格序）与形状候选的顺序（预抽键后排序）。
// 比较器只读预抽好的键和格号，不抽随机数。
export function makePartition(w, h, rnd, opts = {}) {
  const maxRestarts = opts.maxRestarts ?? 12;
  const n = w * h;
  if (n % SYMBOLS !== 0) return null; // 三格区域铺不满 ⇒ 这个尺寸根本不作出货档
  for (let restart = 0; restart < maxRestarts; restart++) {
    const reg = new Int16Array(n).fill(-1);
    const used = new Uint8Array(n);
    const order = rnd.keyed(Array.from({ length: n }, (_, i) => i)).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.v);
    let oi = 0;
    let nr = 0;
    let ok = true;
    while (true) {
      while (oi < n && used[order[oi]]) oi++;
      if (oi >= n) break;
      const pioneer = order[oi];
      const pr = rowOf(w, pioneer);
      const pc = colOf(w, pioneer);
      // 可行的三格：全部在盘内且全部未分配
      const live = [];
      for (let s = 0; s < SHAPES.length; s++) {
        const cells = [];
        let bad = false;
        for (const [dr, dc] of SHAPES[s]) {
          const r = pr + dr;
          const c = pc + dc;
          if (r < 0 || c < 0 || r >= h || c >= w) {
            bad = true;
            break;
          }
          const idx = cellIndex(w, r, c);
          if (used[idx]) {
            bad = true;
            break;
          }
          cells.push(idx);
        }
        if (!bad) live.push({ s, cells, k: rnd.next() });
      }
      // 逐个试：先满足连通块 mod 3 不变式的才算可行
      live.sort((a, b) => a.k - b.k || a.s - b.s);
      let placed = null;
      for (const cand of live) {
        for (const x of cand.cells) used[x] = 1;
        if (componentsOk(w, h, used, cand.cells)) {
          placed = cand;
          break;
        }
        for (const x of cand.cells) used[x] = 0;
      }
      if (!placed) {
        ok = false;
        break;
      }
      for (const x of placed.cells) reg[x] = nr;
      nr++;
    }
    if (ok) {
      let checks = 0;
      for (let i = 0; i < n; i++) if (reg[i] < 0) checks++;
      if (checks === 0) return { reg, nr, restarts: restart };
    }
  }
  return null;
}

// 一个三格区域的 9 种合法填法（P3）：3 个"全同" + 6 个"全异"。
// 顺序固定，下标与本仓 cellsOf[r] 的格序对齐 —— 改了这里等于改了答案。
export function regionPatterns() {
  const out = [];
  for (let s = 0; s < SYMBOLS; s++) out.push([s, s, s]);
  for (const p of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) out.push(p);
  return out;
}
const PATTERNS = regionPatterns();
export const PATTERNS_PER_REGION = PATTERNS.length;

// 造参考解：区域内满足 P3、跨区域邻格满足 P4 的一次符号赋值。
//
// 搜索：按 MRV（活模式最少的区域先定）递归 + 回溯，模式顺序由预抽随机键决定。
// 与 counter.js 的区别不是"更聪明"，而是**职责**：这里要的是"随便一个合法盘"，
// 那里要的是"合法盘有几个"，两份代码故意各写各的。
// DFS 节点数封顶（dfsBudget），超了返回 null 让调用方换一张剖分 —— 不许在这里无界空转。
export function makeSolution(w, h, reg, rnd, opts = {}) {
  const dfsBudget = opts.dfsBudget ?? 20000;
  const n = w * h;
  const cellsOf = cellsOfRegions(reg, n);
  const nr = cellsOf.length;
  // 每个区域的邻区表（跨区边界的两端）
  const touches = Array.from({ length: nr }, () => []);
  for (let r = 0; r < nr; r++) {
    for (const x of cellsOf[r]) {
      for (const y of neighbors(w, h, x)) {
        if (reg[y] !== r && !touches[r].includes(reg[y])) touches[r].push(reg[y]);
      }
    }
  }
  const val = new Int8Array(n).fill(-1);
  const keys = rnd.keyed(PATTERNS.map((_, i) => i));
  let nodes = 0;
  const liveOf = (r) => {
    const cs = cellsOf[r];
    const out = [];
    for (let p = 0; p < PATTERNS.length; p++) {
      let good = true;
      for (let t = 0; t < 3 && good; t++) {
        if (val[cs[t]] >= 0 && val[cs[t]] !== PATTERNS[p][t]) {
          good = false;
          break;
        }
        for (const y of neighbors(w, h, cs[t])) {
          if (reg[y] === r) continue; // 同区内不受 P4 约束
          if (val[y] >= 0 && val[y] === PATTERNS[p][t]) {
            good = false;
            break;
          }
        }
      }
      if (good) out.push(p);
    }
    return out;
  };
  // 区域之间的并列裁决用**预抽**的键（入口处一次抽完），比较逻辑里没有随机数。
  const regionKey = new Float64Array(nr);
  for (let r = 0; r < nr; r++) regionKey[r] = rnd.next();
  const walk = () => {
    if (++nodes > dfsBudget) return false;
    let best = -1;
    let bestLive = null;
    for (let r = 0; r < nr; r++) {
      if (val[cellsOf[r][0]] !== -1) continue;
      const live = liveOf(r);
      if (!live.length) return false;
      // MRV；并列时比预抽的区域键，再比区域号
      if (best < 0 || live.length < bestLive.length || (live.length === bestLive.length && regionKey[r] < regionKey[best])) {
        best = r;
        bestLive = live;
      }
    }
    if (best < 0) return true;
    const ordered = bestLive.slice().sort((a, b) => keys[a].k - keys[b].k || a - b);
    const cs = cellsOf[best];
    for (const p of ordered) {
      for (let t = 0; t < 3; t++) val[cs[t]] = PATTERNS[p][t];
      if (walk()) return true;
      for (let t = 0; t < 3; t++) val[cs[t]] = -1;
    }
    return false;
  };
  if (!walk()) return null;
  return { val, cellsOf, nr, dfsNodes: nodes };
}

// 一张完整的题面底：剖分 + 参考解。任何一步没成就返回 null（调用方换 seed）。
export function makeBoard(w, h, rnd, opts = {}) {
  const p = makePartition(w, h, rnd, opts);
  if (!p) return null;
  const s = makeSolution(w, h, p.reg, rnd, opts);
  if (!s) return null;
  return { w, h, reg: p.reg, nr: p.nr, partitionRestarts: p.restarts, val: s.val, dfsNodes: s.dfsNodes };
}
