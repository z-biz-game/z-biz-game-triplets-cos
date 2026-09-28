// 格盘几何：只做"编号、邻接、区域"这三件事，不含任何游戏规则。
//
// ── 坐标约定（本仓唯一的真相来源）────────────────────────────────────────
//   · 盘面是 w×h 个格，格 (r,c)：r = 0..h-1 是行（自上而下），c = 0..w-1 是列（自左而右）。
//   · 格索引 i = r*w + c，0 ≤ i < N = w*h。行优先。
//   · 四方向常量 UP=0 / RIGHT=1 / DOWN=2 / LEFT=3，DR=[-1,0,1,0]、DC=[0,1,0,-1]，
//     对向 d^2。任何按方向遍历的代码都按这个顺序走，保证 node 与 Chrome 同序。
//   · 区域用 reg[i] ∈ [0, NR) 表示；区域 i 的格子表 cellsOf[r] 按 i 升序（**固定顺序**，
//     模式的第 0/1/2 项就是按这个顺序对齐的，改了顺序等于改了答案）。
//   · 符号 0=方块 square、1=圆圈 circle、2=三角 triangle，候选用位掩码 bit0/1/2（ALL = 0b111）。
//
// 谁 import 本文件：partition.js / generate.js / 未来的 render 与 UI。
// 谁**故意不** import：counter.js 与 pencil.js 各自内联一份同语义的邻接/区域编码。
// 这不是疏忽，是派工里那条"同一套语义写两遍"的纪律：一份写错时 rule-test /
// counter-test / pencil-test 会当场不同意，独立实现之间的分歧比单份代码的整洁值钱。
// 坐标约定改了，那两份必须跟着改，改漏就会红。

export const SYMBOLS = 3;
export const ALL = (1 << SYMBOLS) - 1; // 0b111
export const SYMBOL_TEXT = ['方块', '圆圈', '三角'];

export const UP = 0;
export const RIGHT = 1;
export const DOWN = 2;
export const LEFT = 3;
export const DIRS = [UP, RIGHT, DOWN, LEFT];
export const DR = [-1, 0, 1, 0];
export const DC = [0, 1, 0, -1];
export const DIR_TEXT = ['上', '右', '下', '左'];

export const opp = (d) => d ^ 2;

export const rowOf = (w, i) => Math.floor(i / w);
export const colOf = (w, i) => i % w;
export const cellIndex = (w, r, c) => r * w + c;

export function inBounds(w, h, r, c) {
  return r >= 0 && c >= 0 && r < h && c < w;
}

// 越界返回 -1（"那里没有邻格"），和"有邻格但 index 就是 0"是两件事，别混。
export function neighbor(w, h, i, d) {
  const r = rowOf(w, i) + DR[d];
  const c = colOf(w, i) + DC[d];
  return inBounds(w, h, r, c) ? r * w + c : -1;
}

// 正交邻格，按 UP/RIGHT/DOWN/LEFT 固定顺序给出。
export function neighbors(w, h, i) {
  const out = [];
  for (const d of DIRS) {
    const y = neighbor(w, h, i, d);
    if (y >= 0) out.push(y);
  }
  return out;
}

// reg[i] = 区域号 ⇒ cellsOf[r] = 该区域的格子（升序）。要求 reg 已铺满（无 -1）。
export function cellsOfRegions(reg, n) {
  const byRegion = [];
  for (let i = 0; i < n; i++) {
    const r = reg[i];
    if (r < 0) throw new Error(`cellsOfRegions：格 ${i} 没有区域`);
    (byRegion[r] ||= []).push(i);
  }
  return byRegion;
}

export function regionCount(reg, n) {
  let max = -1;
  for (let i = 0; i < n; i++) max = Math.max(max, reg[i]);
  return max + 1;
}

// 跨区域边界的正交相邻格对（P4 约束的作用点）。同一对只报一次（x < y）。
export function borderPairs(w, h, reg) {
  const out = [];
  for (let i = 0; i < w * h; i++) {
    for (const y of neighbors(w, h, i)) {
      if (reg[y] !== reg[i] && i < y) out.push([i, y]);
    }
  }
  return out;
}

// 一格的区域号 + 它在本区域内的"第几个格"（提示文案要说"本区第三个格"时用）。
export function cellName(w, i) {
  return `第 ${Math.floor(i / w) + 1} 行第 ${(i % w) + 1} 列`;
}

// 三个格是否两两以内连通（区域必须连通，规则原文 "regions of exactly three cells"）。
export function isConnectedTriad(w, h, cells) {
  if (cells.length !== 3) return false;
  const set = new Set(cells);
  const seen = new Set([cells[0]]);
  const stack = [cells[0]];
  while (stack.length) {
    const x = stack.pop();
    for (const y of neighbors(w, h, x)) {
      if (set.has(y) && !seen.has(y)) {
        seen.add(y);
        stack.push(y);
      }
    }
  }
  return seen.size === 3;
}

// 区域类型（P3 的两个分支）。
export const REGION_ALL_SAME = 1;
export const REGION_ALL_DIFF = 2;

export function regionTypeOf(cells, val) {
  const [a, b, c] = cells.map((i) => val[i]);
  if (a < 0 || b < 0 || c < 0) return 0;
  if (a === b && b === c) return REGION_ALL_SAME;
  if (a !== b && b !== c && a !== c) return REGION_ALL_DIFF;
  return -1; // 既不同也不全异 ⇒ 这盘自己打脸
}
