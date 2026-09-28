// 对局状态。这一层**不含任何同或异规则**：它只做三件事——把玩家落下的那一笔写进引擎
// 自己的那份候选数组（js/engine/pencil.js 的 state.cand / state.placed）、记撤销栈、
// 把盘面交给 verify() 问一句「这算赢了吗」。UI 里没有第二份记分板：面板上「题面给的 /
// 你填的 / 删剩的候选 / 还空着 / 引擎说」五个读数全部取自这一份引擎状态，
// 所以画面和判胜不可能各说一套。
//
// 索引与区域几何一律经 pencil.js 的 createState() 建出来的 st（cellsOf / reg / n），
// 本文件不重算任何邻接或区域公式——重算一次就多一个「画对了但点偏一格」的来源。
//
// ⚠ 构造函数只收 {w, h, seed, sizeKey, reg, givens} 这六个数：出题器返回值里的那份
//   参考解（=答案）在 js/main.js 就被剥掉了，根本传不进来。Game / BoardView / main.js
//   都不持有 puzzle 引用，所以 window.triplets.game 的对象图里没有任何一条能读到答案的路；
//   门禁那条「一笔没画时全画布 player 色像素 = 0」的断言负责抓任何绕过这个写法的实现。
//
// ⚠ 这里**不**调用 advance() / applyDeduction()：那两条路会把「被迫的结论」直接写进候选数组，
//   绕过撤销栈与 moves。提示走 nextDeduction() 拿结论、再由本文件的 place / toggleNote
//   落笔——和玩家自己点的那一下是同一条写入路径（见 js/main.js 的 hint()）。

import { createState, verify, symbolOf, candidatesOf, BLANK } from '../engine/pencil.js';

export const ALL = 0b111; // 三个候选都在 = 没落笔也没笔记
export { BLANK, symbolOf, candidatesOf };

// 一格一个字符的存档表：
//   'G'    题面给的格（值由 seed 重建，不经过存储搬运）
//   '1'/'2'/'3' 玩家落下的符号 0/1/2
//   '0'    没落笔、候选全在
//   'A'..'F'  没落笔、候选掩码 = 字符码 - 64（'D' 就是「只剩圆圈」）
// 掩码 7（=ALL）走 '0'，所以 'G' 这一格永远只表示题面给的格，两者不重合。
export const MARK_GIVEN = 'G';

export class Game {
  constructor(face) {
    if (!face || !face.reg || !face.givens) throw new Error('拿不到题面（reg / givens），开不了局');
    this.sizeKey = face.sizeKey || `${face.w}x${face.h}`;
    this.w = face.w;
    this.h = face.h;
    this.seed = face.seed;
    this.n = face.w * face.h;
    // 题面的只读副本：givens 用来挡住「擦掉一颗线索」，reg 是渲染层画区域轮廓的唯一依据。
    this.givens = Int8Array.from(face.givens);
    this.reg = Int8Array.from(face.reg);
    this.fp = face.fp || '';
    // 权威状态：cand/placed 就是玩家（或提示）干的事，和引擎推理用的是同一份数组。
    this.st = createState({ w: this.w, h: this.h, reg: this.reg, givens: this.givens });
    this.nr = this.st.nr;
    this.cellsOf = this.st.cellsOf;
    this.undoStack = [];
    this._group = null;
    this.moves = 0;
  }

  isGiven(cell) {
    return this.givens[cell] >= 0;
  }

  // 这一格现在落定的符号（没落定 = -1）。读的是引擎的 symbolOf，不是自己那份副本。
  symbolAt(cell) {
    return symbolOf(this.st, cell);
  }

  candAt(cell) {
    return candidatesOf(this.st, cell);
  }

  blankCells() {
    const out = [];
    for (let i = 0; i < this.n; i++) if (!this.st.placed[i]) out.push(i);
    return out;
  }

  // ── 唯一的三个写入入口 ─────────────────────────────────────────────────────
  // 三条路（左键、键盘回车、提示）都从这里过，所以撤销栈和 moves 记的就是玩家干的活。
  // 不在手势里 = 自己就是一组（可单独撤销）；在手势里 = 并进 beginGesture/endGesture 那一组。

  place(cell, sym) {
    if (!(cell >= 0 && cell < this.n)) return null;
    if (!(sym === 0 || sym === 1 || sym === 2)) return null;
    if (this.isGiven(cell)) return null; // 线索不许改：它是题面，不是笔迹
    const prev = this.st.cand[cell];
    const prevPlaced = this.st.placed[cell];
    if (prevPlaced && prev === 1 << sym) return null; // 已经就是这个符号：空操作
    this.st.cand[cell] = 1 << sym;
    this.st.placed[cell] = 1;
    return this._record({ cell, prev, prevPlaced, cand: 1 << sym, placed: 1 });
  }

  erase(cell) {
    if (!(cell >= 0 && cell < this.n) || this.isGiven(cell)) return null;
    const prev = this.st.cand[cell];
    const prevPlaced = this.st.placed[cell];
    if (!prevPlaced && prev === ALL) return null; // 本来就是空的
    this.st.cand[cell] = ALL;
    this.st.placed[cell] = 0;
    return this._record({ cell, prev, prevPlaced, cand: ALL, placed: 0 });
  }

  // 笔记那支笔：在没落定的格上**翻**一个候选位——这一位还在就删掉，已经不在了就放回来。
  // 「只删不放」的写法会让屏幕上那句「点一下删掉，再点一下放回来」（index.html 的 title 与
  // announce 的文案）变成假话，而且 render 场景第二次点击之后读到的 cand 会停在删剩的那一份。
  // 删到空集等于宣布「这格放不下任何符号」，那是矛盾的出口、由引擎的 A5/verify 说，
  // 不是一支笔该干的事——所以删除那一支翻完是 0 就回到全在。
  toggleNote(cell, sym) {
    if (!(cell >= 0 && cell < this.n) || this.isGiven(cell)) return null;
    if (!(sym === 0 || sym === 1 || sym === 2)) return null;
    if (this.st.placed[cell]) return null; // 已经落子的格没有候选可翻：先用擦掉那支笔
    const prev = this.st.cand[cell];
    const bit = 1 << sym;
    const next = (prev & bit ? prev & ~bit : prev | bit) || ALL;
    if (next === prev) return null;
    this.st.cand[cell] = next;
    return this._record({ cell, prev, prevPlaced: 0, cand: next, placed: 0 });
  }

  _record(rec) {
    if (this._group) this._group.push(rec);
    else {
      this.undoStack.push([rec]);
      this.moves++;
    }
    return rec;
  }

  beginGesture() {
    this._group = [];
  }

  endGesture() {
    const g = this._group || [];
    this._group = null;
    if (!g.length) return false;
    this.undoStack.push(g);
    this.moves++;
    return true;
  }

  undo() {
    const g = this.undoStack.pop();
    if (!g) return false;
    // 逐条退回落笔前的那个 (cand, placed)：落子、擦掉、笔记三种笔迹照原样退，
    // 不存在「撤销把笔记变成落子」这种偷偷的第二义。
    for (let i = g.length - 1; i >= 0; i--) {
      const r = g[i];
      this.st.cand[r.cell] = r.prev;
      this.st.placed[r.cell] = r.prevPlaced;
    }
    this.moves++;
    return true;
  }

  // 全清：每一格玩家笔迹（落子和笔记）都回到没落笔。它自己是一组可撤销的动作——
  // 按错「全清」不该赔掉整局。题面给的格不在清扫范围内。
  clearAll() {
    const group = [];
    for (let i = 0; i < this.n; i++) {
      if (this.isGiven(i)) continue;
      const prev = this.st.cand[i];
      const prevPlaced = this.st.placed[i];
      if (!prevPlaced && prev === ALL) continue;
      group.push({ cell: i, prev, prevPlaced, cand: ALL, placed: 0 });
      this.st.cand[i] = ALL;
      this.st.placed[i] = 0;
    }
    if (!group.length) return 0;
    this.undoStack.push(group);
    this.moves++;
    return group.length;
  }

  // ── 读数：全部由这一份引擎状态数出来，没有任何一条是 UI 自己记的账 ──────────
  counts() {
    let given = 0;
    let placed = 0;
    let notes = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.isGiven(i)) given++;
      else if (this.st.placed[i]) placed++;
      else if (this.st.cand[i] !== ALL) notes++;
    }
    return { given, placed, notes, blank: this.n - given - placed, cells: this.n, regions: this.nr };
  }

  // 唯一的判胜入口：整盘交给引擎的 verify（它要每一格都落定、每区全同或全异、跨区相邻互异）。
  status() {
    return verify(this.st);
  }

  // ── 存档：只存原始 seed + 尺寸 + 每格一个字符，题面从来不经过存储搬运 ─────────
  encode() {
    let s = '';
    for (let i = 0; i < this.n; i++) {
      if (this.isGiven(i)) s += MARK_GIVEN;
      else if (this.st.placed[i]) s += String(this.st.cand[i] === 1 ? 1 : this.st.cand[i] === 2 ? 2 : 3);
      else if (this.st.cand[i] !== ALL) s += String.fromCharCode(64 + this.st.cand[i]);
      else s += '0';
    }
    return s;
  }

  // 读档。第二个参数是**存档里记着的步数**：以前这种写法是「只搬笔迹不搬步数」，
  // 于是刷新一次画面就谎称「这局还没动过」。长度对不上（换过尺寸、串被截断）一律当没有存档。
  decode(s, moves = 0) {
    if (typeof s !== 'string' || s.length !== this.n) return false;
    let touched = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.isGiven(i)) continue; // 题面那几格由 seed 重建，存档里那个字符不参与
      const c = s.charCodeAt(i);
      if (c >= 49 && c <= 51) {
        this.st.cand[i] = 1 << (c - 49);
        this.st.placed[i] = 1;
        touched++;
      } else if (c >= 65 && c <= 70) {
        this.st.cand[i] = c - 64;
        this.st.placed[i] = 0;
        touched++;
      } else {
        this.st.cand[i] = ALL;
        this.st.placed[i] = 0;
      }
    }
    this.undoStack = [];
    this._group = null;
    this.moves = Number.isFinite(moves) && moves > 0 ? Math.floor(moves) : 0;
    return touched > 0 || this.moves > 0;
  }

  // 无障碍/状态行的一句话读数：这一格现在什么样，全部来自引擎的 symbolOf/candidatesOf。
  cellReport(cell) {
    const r = Math.floor(cell / this.w) + 1;
    const c = (cell % this.w) + 1;
    const NAME = ['方块', '圆圈', '三角'];
    const reg = this.cellsOf[this.reg[cell]];
    const at = reg.indexOf(cell);
    const sym = this.symbolAt(cell);
    if (sym >= 0) {
      return `第 ${r} 行第 ${c} 列（第 ${this.reg[cell] + 1} 区第 ${at + 1} 格）${this.isGiven(cell) ? '，题面给的' : ''}：${NAME[sym]}`;
    }
    const left = [0, 1, 2].filter((s) => this.st.cand[cell] & (1 << s)).map((s) => NAME[s]);
    return `第 ${r} 行第 ${c} 列（第 ${this.reg[cell] + 1} 区第 ${at + 1} 格）：空格，候选 ${left.join('/')}`;
  }
}
