// Canvas 渲染层。它读 Game 手里那份引擎状态（st.cand / st.placed）来画，自己不判断任何东西——
// 没有哪一格在这里被宣布「对」，也没有哪一盘在这里被宣布「赢」——所以画面不可能和判胜用的
// verify 打架。
//
// 布局（格边长、盘面原点、DPR、命中盒、字形半径、探针偏移）也住在这里，因为 hitCell 必须回答
// 「玩家点的那一下是哪一格」，用的必须是 draw 刚刚用过的那批数。这两处分家就会出现
// 「盘画对了、点击偏一格」的事故。
//
// 题面的形状（区域在哪、共边哪条是跨区的）一律经 grid.js 的 borderPairs / cellsOfRegions
// 与 Game 手里的 reg 拿，本文件不重算任何邻接公式。
//
// ⚠ 本文件不许出现参考解那一份数组，也不许 import counter.js / generate.js：
//   player 色（Palette.player）在盘上**只**代表玩家或提示落下的那一笔。门禁有一条
//   「一笔没画时全画布 player 色像素 = 0」的断言，靠的就是这个独占性抓答案泄漏。

import { Palette, Board, Radius, hexToRgb } from '../theme.js';
import { borderPairs, cellsOfRegions, neighbors } from '../engine/grid.js';
import { ALL } from '../ui/game.js';

const TRIAD = 3; // 一块区域恰好三格（题面的定义，画面上就是「一伙」的范围）

// 跨区轮廓的**描边宽度**：draw 用它当 lineWidth，取样用比它窄的一条（见 edgeBand/EDGE_SAMPLE），
// 两处都从这个函数出发，所以「画在多宽」和「量多宽」不会分家。
function edgeBand(k) {
  return Math.max(3, k * Board.borderWidth);
}

// 取样用的宽度：1 CSS px，钉在共边正中。edgeBand 至少 3 CSS px，所以这一条**整条**落在
// 描出来的轮廓里，两边各留 ≥1 CSS px 给抗锯齿——门禁因此可以断「取样点上每一个像素都是
// border 色」，而不是断一个经不起像素网格的比例。
const EDGE_SAMPLE = 1;

export function layoutFor(w, h, availW, availH) {
  const pad = Board.pad;
  const size = Math.max(0, Math.min((availW - pad * 2) / w, (availH - pad * 2) / h));
  const cell = Math.max(Board.cellMin, Math.min(Board.cellMax, Math.floor(size)));
  return { cell, boardW: cell * w, boardH: cell * h, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    // willReadFrequently：门禁每步都要 getImageData 取样，没这个提示时 Chrome 会把画布
    // 留在 GPU 上，每次 readback 同步回传一次整张位图。
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1, pad: 0 };
    this.game = null;
    this.tintOf = []; // 区域号 → 0/1（画进像素、也交给门禁断同区三格同色）
  }

  resize(game, availW, availH) {
    const l = layoutFor(game.w, game.h, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr, pad: l.pad };
    this.game = game;
    this.tintOf = this._paintRegions();
    const d = this.canvas.dataset;
    d.w = String(game.w);
    d.h = String(game.h);
    d.n = String(game.n);
    d.regions = String(game.nr);
    d.cell = String(l.cell);
    d.dpr = String(dpr);
    // 题面就从 DOM 上交出去：门禁的「换一局那盘要被引擎独立重证」读的是这两个串，
    // 不是 window.triplets.game 里的对象——DOM 说的是什么，引擎就得重证什么。
    d.reg = regToString(game.reg);
    d.givens = givensToString(game.givens);
    d.fp = game.fp;
    return this.geo;
  }

  // 区域底纹 + 邻接表都在这里算一次，draw 与门禁读数共用这一份。
  _paintRegions() {
    const g = this.game;
    const cellsOf = cellsOfRegions(g.reg, g.n);
    const nr = cellsOf.length;
    const adj = Array.from({ length: nr }, () => new Set());
    for (const [x, y] of borderPairs(g.w, g.h, g.reg)) {
      adj[g.reg[x]].add(g.reg[y]);
      adj[g.reg[y]].add(g.reg[x]);
    }
    const tint = new Array(nr).fill(0);
    for (let r = 0; r < nr; r++) {
      const used = new Set();
      for (const q of adj[r]) if (q < r) used.add(tint[q]);
      // 两个邻区把两档都占了就退回 0：底纹只是装饰，分组不靠它。
      tint[r] = used.has(0) ? used.has(1) ? 0 : 1 : 0;
    }
    this.adj = adj;
    this.cellsOf = cellsOf;
    return tint;
  }

  // ---- 几何读数（CSS 像素，画布本地）-------------------------------------------
  // 门禁取样只许用这几个函数产出的坐标。page/client 坐标里带着画布自己的
  // getBoundingClientRect 偏移，喂给 getImageData 会量到整个盘宽之外的面板底色上，
  // 然后「量」出一个绿。
  centerOf(cell) {
    const { cell: k, x, y } = this.geo;
    return { x: (cell % this.game.w) * k + x + k / 2, y: (((cell / this.game.w) | 0) * k) + y + k / 2 };
  }

  cellRect(cell) {
    const { cell: k, x, y } = this.geo;
    const w = this.game.w;
    const px = (cell % w) * k + x;
    const py = (((cell / w) | 0) * k) + y;
    return { x: px, y: py, w: k, h: k, size: k, cx: px + k / 2, cy: py + k / 2 };
  }

  // 字形形状证据的五个采样点（画布本地 CSS 坐标）：中心 + 四个对角。
  // 门禁按 [tl, tr, bl, br, c] 的顺序读成五位签名（glyphProbe 返回的是对象，顺序在这里定）：
  //   ■ 方块（半边 0.27 格）→ 11111（四个对角都还在方块内）
  //   ● 圆圈（半径 0.24 格）→ 00001（对角离圆心 0.22√2 = 0.311 格 > 0.24，只有正中）
  //   ▲ 三角（顶点朝上）    → 00111（上面两点在腰外，下面两点在底边内，正中在内）
  //   空格 / 只有笔记的格    → 00000（笔记小 glyph 的纵向范围是 0.1 格 < 探针的 0.22 格）
  // 探针偏移 0.22 格；最紧的一处是方块的四个角，余量 0.05 格 = 1.70 CSS px（cellMin=34）
  // ⇒ 判定不靠抗锯齿边缘。改动任何一边的比例都要重跑 render 场景。
  glyphProbe(cell) {
    const { cell: k } = this.geo;
    const c = this.centerOf(cell);
    const d = k * Board.probe;
    return { c, tl: { x: c.x - d, y: c.y - d }, tr: { x: c.x + d, y: c.y - d }, bl: { x: c.x - d, y: c.y + d }, br: { x: c.x + d, y: c.y + d } };
  }

  // 笔记小 glyph 的位置：本格还活着的候选各占一格槽位（3 个槽，横向），半径 0.1 格。
  noteSlotPos(cell, sym) {
    const { cell: k } = this.geo;
    const c = this.centerOf(cell);
    return { x: c.x + (sym - 1) * k * Board.noteSlot, y: c.y, r: k * Board.noteR };
  }

  // 两格共边的那一条**取样带**：宽 EDGE_SAMPLE（1 CSS px）钉在共边正中、长 0.5 格居中。
  // 正腿（跨区那条必须全是 border 色）与腿二（同区那条一个 border 色像素都不许有）用的是
  // 同一个矩形，所以两腿量的是同一批数。
  sharedEdgeSlice(a, b) {
    const k = this.geo.cell;
    const ra = this.cellRect(a);
    const rb = this.cellRect(b);
    const len = k * 0.5;
    if (ra.x !== rb.x) { // 左右相邻 ⇒ 共边是竖的
      const x = ra.x + ra.w; // = rb.x
      return { x: x - EDGE_SAMPLE / 2, y: ra.cy - len / 2, w: EDGE_SAMPLE, h: len };
    }
    const y = ra.y + ra.h; // = rb.y
    return { x: ra.cx - len / 2, y: y - EDGE_SAMPLE / 2, w: len, h: EDGE_SAMPLE };
  }

  // 指针的 client 坐标 → 格号（画布外的点返回 -1）。
  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return this.hitCellLocal(clientX - rect.left, clientY - rect.top);
  }

  hitCellLocal(lx, ly) {
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return -1;
    const gx = Math.floor((lx - x) / cell);
    const gy = Math.floor((ly - y) / cell);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return -1;
    return gy * g.w + gx;
  }

  // ---- 取色（门禁断言用，全部走画布本地坐标 × dpr）--------------------------------
  pixelAt(lx, ly) {
    const d = this.geo.dpr;
    const p = this.ctx.getImageData(Math.round(lx * d), Math.round(ly * d), 1, 1).data;
    return [p[0], p[1], p[2]];
  }

  // 整张画布（或 rect 那一片，CSS 本地坐标）里与 want 同色（L∞ ≤ tol）的像素个数。
  countNear(want, tol = 8, rect = null) {
    const d = this.geo.dpr;
    const x0 = rect ? Math.round(rect.x * d) : 0;
    const y0 = rect ? Math.round(rect.y * d) : 0;
    const w = rect ? Math.round(rect.w * d) : this.canvas.width;
    const h = rect ? Math.round(rect.h * d) : this.canvas.height;
    if (w <= 0 || h <= 0) return 0;
    const img = this.ctx.getImageData(x0, y0, w, h).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (Math.abs(img[i] - want[0]) <= tol && Math.abs(img[i + 1] - want[1]) <= tol && Math.abs(img[i + 2] - want[2]) <= tol) n++;
    }
    return n;
  }

  // 取色逻辑自己回答「这一格现在该是什么色」，免得门禁里另抄一份调色板
  // （抄了就会有一个「改了主题、断言还在绿」的窗口）。
  //
  // ⚠ 这里有**两种表示**，各服务一侧，而且只有这一处转换：
  //   · 进 ctx 的（下面的 fillStyle/strokeStyle、colorOfGlyph、tintHex）必须是 CSS 串；
  //   · 交出门禁量的（colors()、tintRgb()）必须是 [r,g,b] 三元组——countNear/near 比的
  //     是三个通道，把串递过去时 `'#2ED573'[0]` 是 '#'，于是每次比较都得 NaN ⇒ 每条像素
  //     断言都读成 0 个命中像素，红得像「盘面是空的」。两个色源永远来自同一个 Palette。
  colorOfGlyph(cell) {
    const g = this.game;
    if (g.isGiven(cell)) return Palette.given;
    return g.st.placed[cell] ? Palette.player : null;
  }
  colors() {
    return {
      field: hexToRgb(Palette.field),
      tint: [hexToRgb(Palette.tintA), hexToRgb(Palette.tintB)],
      gridLine: hexToRgb(Palette.gridLine),
      border: hexToRgb(Palette.border),
      given: hexToRgb(Palette.given),
      player: hexToRgb(Palette.player),
      note: hexToRgb(Palette.note),
    };
  }
  tintHex(r) {
    return [Palette.tintA, Palette.tintB][this.tintOf[r]];
  }
  tintRgb(r) {
    return hexToRgb(this.tintHex(r));
  }

  draw(game, { cursor = -1 } = {}) {
    this.game = game;
    if (!this.geo.cell) return;
    if (this.tintOf.length !== game.nr) this.tintOf = this._paintRegions();
    const { ctx, geo } = this;
    const k = geo.cell;
    const w = game.w;
    const h = game.h;
    const cells = w * h;
    ctx.clearRect(0, 0, geo.w, geo.h);

    // 1) 面板底 + 盘子底（pad 那一圈露出来的就是 field）
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();
    roundRect(ctx, geo.x - k * 0.4, geo.y - k * 0.4, k * w + k * 0.8, k * h + k * 0.8, Radius.cell);
    ctx.fillStyle = Palette.field;
    ctx.fill();

    // 2) 区域底纹：同一区的三格一个色。⚠ 逐格 fillRect，不用 region 路径——区域是 L 形时
    //    路径要自己拼，拼漏一格就正是「底纹说有、轮廓说没有」那种不一致。
    for (let i = 0; i < cells; i++) {
      const r = this.cellRect(i);
      ctx.fillStyle = this.tintHex(game.reg[i]);
      ctx.fillRect(r.x, r.y, k, k);
    }

    // 3) 格线：每一条共边都先画细线（格还是格），随后跨区那几条被第 4 步的粗轮廓盖掉。
    ctx.strokeStyle = Palette.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < cells; i++) {
      for (const y of neighbors(w, h, i)) {
        if (y <= i) continue; // 每条共边只画一次
        const a = this.cellRect(i);
        const b = this.cellRect(y);
        const x = Math.round((a.x + a.w + b.x) / 2) + 0.5;
        const yy = Math.round((a.y + a.h + b.y) / 2) + 0.5;
        if (a.x === b.x) ctx.moveTo(a.x, yy), ctx.lineTo(a.x + k, yy);
        else ctx.moveTo(x, a.y), ctx.lineTo(x, a.y + k);
      }
    }
    ctx.stroke();

    // 4) 区域轮廓：只画**跨区**共边 + 盘子外框。这一圈就是「这是一伙的」那句话的证据。
    //    ⚠ 方向必须和第 3 步的格线同源：同列（上下相邻）⇒ 共边是**横**的，异列（左右相邻）⇒
    //    共边是**竖**的。这两个分支一旦写反，描出来的就是穿过格子正中的那条**中轴**——
    //    盘面上照样有几十条粗蓝线（boot 的「border 像素 > 200」仍然绿），但它们一条都不在共边上，
    //    玩家看到的就是一堆没有分组意义的格子；门禁那两腿（跨区那条取样带整条都是 border 色、
    //    同区那条一个都不许有）会同时读到同一个「6/37」——那 6 个像素是中轴线横穿取样带留下的。
    //    ⚠ 线必须钉在共边正中（不加 0.5 的像素对齐偏移）：取样带是按共边对称放的 1 CSS px，
    //    描边偏半格就会把取样带推到轮廓外，门禁会读到一个「线明明画了却量不到」的假阴。
    //    半像素对齐只对 1 px 细线有意义，这里是 ≥3 CSS px 的粗线。
    const bw = edgeBand(k);
    ctx.strokeStyle = Palette.border;
    ctx.lineWidth = bw;
    ctx.lineCap = 'square';
    ctx.beginPath();
    for (const [x, y] of borderPairs(w, h, game.reg)) {
      const a = this.cellRect(x);
      const b = this.cellRect(y);
      if (a.x === b.x) {
        const yy = Math.max(a.y, b.y); // 上格的下边 = 下格的上边
        ctx.moveTo(a.x, yy);
        ctx.lineTo(a.x + k, yy);
      } else {
        const xx = Math.max(a.x, b.x); // 左格的右边 = 右格的左边
        ctx.moveTo(xx, a.y);
        ctx.lineTo(xx, a.y + k);
      }
    }
    // 外框：盘子的四条边对区域来说也是「跨区边界」（外面没有第四块区域，但线要收口）。
    ctx.rect(geo.x + bw / 2, geo.y + bw / 2, k * w - bw, k * h - bw);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // 5) 笔记（没落定的格上还剩的候选）——画在落子之下、空白之上，因为它不是答案。
    const noteR = k * Board.noteR;
    ctx.fillStyle = Palette.note;
    for (let i = 0; i < cells; i++) {
      if (game.isGiven(i) || game.st.placed[i]) continue;
      const m = game.st.cand[i];
      if (m === ALL) continue; // 候选全在 = 这格什么都没记，必须读起来是空的
      for (let s = 0; s < TRIAD; s++) {
        if (!(m & (1 << s))) continue;
        const p = this.noteSlotPos(i, s);
        drawGlyph(ctx, s, p.x, p.y, noteR);
      }
    }

    // 6) 符号。题面给的用 given 色、玩家（或提示）落的用 player 色——形状都是同一批。
    const gr = k * Board.squareHalf;
    for (let i = 0; i < cells; i++) {
      const col = this.colorOfGlyph(i);
      if (!col) continue;
      const c = this.centerOf(i);
      ctx.fillStyle = col;
      drawGlyph(ctx, game.symbolAt(i), c.x, c.y, gr);
    }

    // 7) 键盘光标：虚线圈，指针玩家看不到它（cursor 只在键盘操作时才 ≥ 0）
    if (cursor >= 0) {
      const c = this.centerOf(cursor);
      ctx.strokeStyle = Palette.info;
      ctx.lineWidth = Math.max(2, k * 0.06);
      ctx.setLineDash([Math.max(4, k * 0.2), Math.max(3, k * 0.14)]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, k * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

// 三种符号的唯一画法：0=方块 ■、1=圆圈 ●、2=三角 ▲（口径见 grid.js 顶部的符号约定）。
// 半径 r 是「外接尺度」：方块半边 r、圆半径 r*circleR/squareHalf、三角半高 r*triHalfHeight/squareHalf。
// ⚠ 这几个比例必须和 glyphProbe 的那五个采样点一起成立，改动任何一边都要重跑 render 场景。
function drawGlyph(ctx, sym, x, y, r) {
  ctx.beginPath();
  if (sym === 0) {
    ctx.rect(x - r, y - r, r * 2, r * 2);
  } else if (sym === 1) {
    ctx.arc(x, y, r * (Board.circleR / Board.squareHalf), 0, Math.PI * 2);
  } else {
    const hh = r * (Board.triHalfHeight / Board.squareHalf);
    const hw = r * (Board.triHalf / Board.squareHalf);
    ctx.moveTo(x, y - hh);
    ctx.lineTo(x + hw, y + hh);
    ctx.lineTo(x - hw, y + hh);
    ctx.closePath();
  }
  ctx.fill();
}

function regToString(reg) {
  let s = '';
  for (let i = 0; i < reg.length; i++) s += reg[i].toString(36);
  return s;
}

function givensToString(givens) {
  let s = '';
  for (let i = 0; i < givens.length; i++) s += givens[i] < 0 ? '.' : String(givens[i]);
  return s;
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
