// 接线层：DOM、指针、键盘、时钟、存档，以及门禁驱动的 window.triplets 那层门面。
//
// 四条纪律写在这个文件顶上，因为它们都是「这一层多干一件事就多一个说谎的地方」：
//
// 1) 随机只发生在**挑种子**这一步。mintSeed() 用 crypto.getRandomValues 抽 6 个字节，再拼上
//    一个进程内计数器（同一毫秒里连点两次「换一局」也不会撞车）。seed 里**不含日期**：
//    日期派生的 seed 会让屏幕上那句「同一个 seed 在 node 和 Chrome 里画同一张盘」变成假话——
//    明天再敲同一个 seed 就不是那张盘了。往后走的全是确定性流水线：makePuzzle(seed, sizeKey)
//    只吃这个字符串，中间没有 Date、没有 Math.random（口径见 js/engine/rng.js）。
//    想直接开某一张盘：地址栏加 ?seed=…（可再带 &size=…），或 window.triplets.playSeed()。
//
// 2) 答案传不进来。makePuzzle 的返回值里除了题面还带着一份完整填法，本文件一个字段都不读：
//    只把 puzzle 里的 {w,h,reg,givens} 交给 Game，再算一份 fingerprint 当对账用的指纹。
//    Game / BoardView / 本文件都不持有 puzzle 引用，所以 window.triplets.game 的对象图里
//    没有一条路能走到那份填法；门禁另有一条「一笔没画时全画布 player 色像素 = 0」的断言，
//    负责抓任何绕过这个写法的实现（player 色在画布上只代表玩家或提示落下的那一笔）。
//
// 3) UI 没有第二份记分板。屏上「题面给的 / 你填的 / 删剩的候选 / 还空着 / 步数 / 引擎说」
//    六个读数全部数自 Game 手里那份铅笔状态（st.cand / st.placed），赢不赢只由 verify(st)
//    决定。提示也是同一套路：它问引擎要 nextDeduction(st)，落回盘面走的仍是 Game.place /
//    Game.toggleNote 那两个写入口——所以撤销栈和步数记下的还是「玩家干过的事」，提示可撤销。
//
// 4) 引擎里那两个**原地推进**的函数（advance / applyDeduction）在这里一次都不许调用。
//    它们直接改 st、不经过撤销栈，调了就等于「屏幕上有、撤销里没有」，那是一笔退不掉的账。
//    所以 window.triplets.engine 也没把它们挂出去（门禁要自己跑求解会直接 import 模块，
//    不需要经由页面）。
//
// 路径口径：本文件所有 import 都是**相对**说明符，相对的是 main.js 自己被服务出来的 URL，
// 也就是 document.baseURI 那条链——仓库根 / 与 Pages 子路径 /<repo>/ 下解析结果不同但都对。
// 这里没有任何以 / 开头的路径；写死一条，Pages 子路径下就会 404，而那正是最该测的形状。

import { applyThemeVars, Palette, Board } from './theme.js';
import { Store } from './store.js';
import { Game, ALL, BLANK } from './ui/game.js';
import { BoardView, layoutFor } from './render/board.js';
import { SYMBOL_TEXT, createState, symbolOf, blankCount, candidatesOf, nextDeduction, verify, RULE_ORDER } from './engine/pencil.js';
import { SIZES, TIERS, SIZE_TABLE, parseSize, sizeAllowed, fingerprint, makePuzzle } from './engine/generate.js';

const VERSION = '0.2.0';

// 一局最多换几个 seed。这是 **seed 次数**的上界，不是毫秒上界：本轮不新增任何 ms 红线。
// 出货率是量出来的（npm run balance / tools/ceiling.mjs）：菜单七档每档都在 maxDraws=40 的
// 抽卡预算内出过货，所以这里给 6 次换 seed 的机会；用完就是引擎的问题，屏幕上一句实话。
const MAX_SEED_TRIES = 6;
const DEFAULT_SIZE = '6x6';
const GLYPH = ['■', '●', '▲'];
const PEN_KEYS = ['0', '1', '2', 'note', 'erase']; // 与 index.html 上 data-pen 的取值同一套

const $ = (id) => document.getElementById(id);
const canvas = $('board');
const wrap = $('board-wrap');
const veil = $('win-veil');
const stateLine = $('state-line');
const srCell = $('sr-cell');
const sizeSelect = $('size-select');

const view = new BoardView(canvas);

let game = null;
let busy = false;
let seedCounter = 0;
let drawsTotal = 0; // 开局到出货一共抽了几次卡（读数，不参与任何判断）
let hintCount = 0;
let wonAt = -1; // 胜利横幅长出来那一刻的步数：没有它，「就看不动」会在下次重画时被顶回来
let veilDismissed = false;
let solvedRecorded = false; // 总成绩里「赢过几盘」每盘只记一次
let pen = '0'; // 当前这支笔：'0'/'1'/'2' 落子、'note' 翻候选、'erase' 擦掉
let noteSym = 0; // 笔记那支笔翻的是哪个符号（1/2/3 在笔记笔下改的是它，不是笔）
let cursor = -1; // 键盘光标；指针玩家永远看不到它（-1）
let clockBase = 0; // 这一局已经走到的毫秒（存档恢复时带回来的那截）
let clockStart = 0; // 本段计时的起点（performance.now，只用来读秒，不参与判断）
let announceT = 0;
const state = { state: 'boot' };

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

// ---- 种子：全站唯一的随机源 ----------------------------------------------------------
function mintSeed(sizeKey) {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  seedCounter++;
  // 前缀是尺寸 + 进程内计数器：肉眼能看出「这是 8x9 的第 3 次换一局」，
  // 计数器和 6 字节随机一起保证不撞车。没有任何一位来自日期。
  return `${sizeKey}#${seedCounter.toString(36)}-${hex}`;
}

// ---- 时钟（只有读数，没有判断） ------------------------------------------------------
function resetClock(baseMs = 0) {
  clockBase = Math.max(0, Math.floor(baseMs) || 0);
  clockStart = performance.now();
  // 换一局＝新的一局，新局一定在走：带着上一局的 paused=true 进来会让时钟和按钮各说各话
  if (paused) { paused = false; paintPause(); }
}
function elapsedMs() {
  // clockStart 是哨兵：暂停时它是 0，还去减 performance.now() 会凭空多出整段虚拟时间
  return clockBase + (clockStart ? Math.max(0, performance.now() - clockStart) : 0);
}

// ---- 暂停 ---------------------------------------------------------------------------
// 暂停是**真冻结时钟**，不是挂个标签：暂停那一瞬把还在跑的那一段折进 clockBase，
// 再把 clockStart 清零 —— elapsedMs() 于是恒等于 clockBase，一毫秒都不再涨。
// 恢复时重新盖上 clockStart，时钟从冻结处续走；因为 clockBase 已经是累计值，
// 恢复后第一帧的 dt 就是一个正常帧间隔，不会把暂停那几秒一次性吃掉（不跳步）。
let paused = false;
function setPaused(next) {
  next = !!next;
  if (paused === next) return paused;
  if (next) {
    clockBase = elapsedMs();   // 先结算到此刻，再停表
    clockStart = 0;
  } else {
    clockStart = performance.now();
  }
  paused = next;
  paintPause();
  return paused;
}
function paintPause() {
  const btn = document.getElementById('btn-pause');
  if (!btn) return;
  btn.textContent = paused ? '继续' : '暂停';
  btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
}
function clockText() {
  const s = Math.floor(elapsedMs() / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
function tickClock() {
  if (!game || busy) return;
  $('stat-time').textContent = clockText();
  if (!veil.hidden) $('win-meta').textContent = winMetaText();
}
setInterval(tickClock, 1000);

// ---- 说一句话（给玩家看的），五秒后交还给引擎的读数 ----------------------------------
// #state-line 平时写的是 verify() 的 why（引擎的话）；announce() 是**暂时的**一句人话，
// 带着 hint 类，paintStats 看见这个类就不抢这句。抢了就会出现「点了全清，屏幕上写着
// 还有 24 格没定」那种看起来像没生效的画面。
function announce(msg) {
  stateLine.classList.add('hint');
  stateLine.textContent = msg;
  srCell.textContent = msg;
  clearTimeout(announceT);
  announceT = setTimeout(() => stateLine.classList.remove('hint'), 5000);
}

// ---- 题面：只取 reg/givens，指纹用来对账（fingerprint 是引擎那份口径，不是第二套）----
function faceOf(made, seed, sizeKey) {
  const p = made.puzzle;
  return {
    w: p.w,
    h: p.h,
    seed,
    sizeKey,
    reg: p.reg,
    givens: p.givens,
    fp: fingerprint(p.w, p.h, p.reg, p.givens),
  };
}

// ---- 开局 / 恢复 -------------------------------------------------------------------
function startWith(face, opts = {}) {
  game = new Game(face);
  // 选择器跟着盘面走（赋值不触发 change 事件，所以不会自己点自己重开一局）：
  // 门禁可以用 playSeed 把页面切到任意一档，切完之后屏上写着的尺寸必须是真的那一档。
  if (SIZES.includes(face.sizeKey)) sizeSelect.value = face.sizeKey;
  veil.hidden = true;
  veilDismissed = false;
  wonAt = -1;
  solvedRecorded = false;
  hintCount = 0;
  cursor = -1;
  resetClock(opts.elapsedMs || 0);
  layout();
  render();
  return game;
}

// 抽一张出货盘：随机只在 seed 里，所以这个循环是「换一个 seed 再问一次」，不是「再赌一次运气」。
async function newGame(sizeKey) {
  const key = sizeKey || currentSize();
  if (!SIZES.includes(key)) {
    state.state = 'failed';
    announce(`尺寸 ${key} 不在菜单里（菜单只有 ${SIZES.join(' / ')}，那张表是引擎量出来的）`);
    return null;
  }
  busy = true;
  state.state = 'busy';
  announce(`正在出题（${key}）—— 唯一解与「零猜测推得完」要在引擎里验完才发货…`);
  await yieldFrame();
  let made = null;
  let seed = null;
  for (let i = 0; i < MAX_SEED_TRIES; i++) {
    seed = mintSeed(key);
    made = makePuzzle(seed, key);
    drawsTotal += made.draws || 0;
    if (made.ok) break;
    await yieldFrame();
  }
  busy = false;
  if (!made || !made.ok) {
    state.state = 'failed';
    announce(`连换 ${MAX_SEED_TRIES} 个 seed 都没出货（引擎给的 status=${made ? made.status : '无'}）。这一档今天开不了局，不是我藏了一张盘没画。`);
    return null;
  }
  const g = startWith(faceOf(made, seed, key));
  Store.recordGame();
  Store.clearResume();
  persist();
  state.state = 'ready';
  const c = g.counts();
  announce(`已开局 ${key}：${c.regions} 块三格区域 · 题面给了 ${c.given} 个符号 · 抽卡 ${made.draws} 次出货 · seed ${g.seed}`);
  return g;
}

// 门禁与「地址栏敲 seed」都走这条路：把页面切到一个**给定**的 seed 上。
// 它和 newGame 共用同一段开局代码，区别只有 seed 不是这里抽的。
// 第二个参数是尺寸档（'6x6' 这种），不传就跟着选择器走。
function playSeed(seed, sizeKey) {
  const key = sizeKey || currentSize();
  if (!SIZES.includes(key)) {
    state.state = 'failed';
    announce(`playSeed 只认菜单里的档（${SIZES.join(' / ')}），${key} 不在表里`);
    return null;
  }
  const made = makePuzzle(String(seed), key);
  drawsTotal += made.draws || 0;
  if (!made.ok) {
    state.state = 'failed';
    announce(`seed ${seed} 在 ${key} 上不出货（status=${made.status}，${made.draws} 次抽卡用尽）`);
    return null;
  }
  const g = startWith(faceOf(made, String(seed), key));
  Store.recordGame();
  Store.clearResume();
  persist();
  state.state = 'ready';
  const c = g.counts();
  announce(`已切到 seed ${g.seed}：${key} · ${c.regions} 块区域 · 题面 ${c.given} 个符号`);
  return g;
}

// 存档里的 seed 重建题面 → 指纹对得上才敢往上盖玩家的笔迹 → 盖上。
// 任何一步不对就当没有存档（开新的一局），绝不拿半截状态喂引擎。
function resumeLast() {
  const r = Store.resume();
  if (!r) return null;
  const key = r.sizeKey && SIZES.includes(r.sizeKey) ? r.sizeKey : `${r.w}x${r.h}`;
  if (!SIZES.includes(key)) return null;
  const made = makePuzzle(r.seed, key);
  drawsTotal += made.draws || 0;
  if (!made.ok) return null;
  const face = faceOf(made, r.seed, key);
  // 指纹不对 = 这个存档属于另一张盘（引擎改过分区或挖珠口径）。丢掉重开，不半推半就。
  if (r.fp && face.fp !== r.fp) {
    Store.clearResume();
    return null;
  }
  const g = startWith(face, { elapsedMs: r.elapsedMs });
  g.decode(r.marks, r.moves);
  state.state = 'ready';
  announce(`接上存档：seed ${g.seed} · 记着 ${g.moves} 步 · 你填的 ${g.counts().placed} 格 · 删剩的候选 ${g.counts().notes} 格`);
  render();
  return g;
}

function persist() {
  if (game) Store.saveResume(game, elapsedMs());
  $('stat-totals').textContent = totalsText();
}

function totalsText() {
  const t = Store.totals();
  return `累计 开局 ${t.games} · 赢 ${t.solved} · 步数 ${t.moves} · 提示 ${t.hints}`;
}

function winMetaText() {
  const c = game.counts();
  return `${c.cells} 格全定 · ${c.regions} 块区域每块要么三同号要么三全异 · ${game.moves} 步 · ${clockText()} · 提示 ${hintCount} 次 · seed ${game.seed}`;
}

// ---- 布局与绘制 ---------------------------------------------------------------------
function avail() {
  const w = Math.max(240, wrap.clientWidth || 520);
  const h = Math.max(240, Math.min(w + 80, window.innerHeight - 230));
  return { w, h };
}

function layout() {
  if (!game) return;
  const a = avail();
  view.resize(game, a.w, a.h);
}

// 每一笔都重画 + 重读数：读数只数自 st，画也只画 st 里那些东西，判胜用的还是同一个 st。
// 「屏幕上有的」和「verify 看见的」是同一批数，不可能一个说赢一个说没赢。
function render() {
  if (!game) return;
  view.draw(game, { cursor });
  paintStats(game.status());
}

function paintStats(st) {
  const c = game.counts();
  $('stat-face').textContent = `区域 ${c.regions} · 线索 ${c.given}`;
  $('stat-givens').textContent = String(c.given);
  $('stat-placed').textContent = String(c.placed);
  $('stat-notes').textContent = String(c.notes);
  $('stat-blank').textContent = String(c.blank);
  $('stat-moves').textContent = String(game.moves);
  $('stat-verify').textContent = st.ok ? '赢了' : '没赢';
  $('stat-verify').className = `mono ${st.ok ? 'good' : 'bad'}`;
  $('stat-seed').textContent = `seed ${game.seed}`;
  $('stat-time').textContent = clockText();
  $('stat-totals').textContent = totalsText();
  $('btn-undo').disabled = game.undoStack.length === 0;
  stateLine.classList.toggle('won', st.ok);
  stateLine.classList.toggle('bad', !st.ok && c.placed + c.notes > 0);

  if (!st.ok) {
    // 「没赢」时那句进度是引擎的 why，不是 UI 自己编的记分板
    if (!stateLine.classList.contains('hint')) stateLine.textContent = st.why;
    veil.hidden = true;
    veilDismissed = false;
    wonAt = -1;
    return;
  }
  if (veilDismissed || wonAt === game.moves) return;
  $('win-meta').textContent = winMetaText();
  veil.hidden = false;
  wonAt = game.moves;
  if (!solvedRecorded) {
    solvedRecorded = true;
    Store.recordSolve(game.moves, hintCount);
  }
  if (!stateLine.classList.contains('hint')) stateLine.textContent = st.why;
}

// ---- 写入口：一支笔 → 一次引擎状态变更 ----------------------------------------------
// 三条路（左键、键盘回车、提示）都汇到这里，所以「屏上画的」「存档里的」「撤销栈里的」
// 是同一笔账。pen 是 DOM 上那五个按钮的 data-pen，不是本文件另抄的一份表。
function applyCell(cell, { erase = false } = {}) {
  if (!game || cell < 0 || cell >= game.n) return null;
  if (erase || pen === 'erase') return game.erase(cell);
  if (pen === 'note') return game.toggleNote(cell, noteSym);
  return game.place(cell, Number(pen));
}

// 写完一笔之后：读数、画、存档，外加如果这一笔是空操作就说是**为什么**空。
function afterWrite(cell, rec) {
  if (cell >= 0) srCell.textContent = game.cellReport(cell);
  // 笔真的落下去了，那句**暂时的** announce（「当前 ■ 方块：点格子落下它。」）就该让位给
  // 引擎那句话：#state-line 平时念的是 verify 的 why（见 announce 上方的注释），而 announce 的
  // 五秒倒计时会把这一句顶掉——于是出现「盘已经填满了、屏上还写着选笔」那种画面。门禁的
  // 「状态行是引擎那句话」量的就是这一处。空操作**不**抢：那一句正是「这一笔为什么没生效」。
  if (rec !== null) {
    clearTimeout(announceT);
    stateLine.classList.remove('hint');
  }
  render();
  persist();
  if (rec === null) {
    announce(game.isGiven(cell)
      ? '那一格是题面给的符号，不许擦也不许改——它是题面，不是笔迹。'
      : '这一笔没有改变任何东西（已经就是这个了），所以也不记步数。');
  }
}

// ---- 指针：格子的矩形就是它的按钮 ----------------------------------------------------
let dragging = false;
let lastCell = -1;

canvas.addEventListener('pointerdown', (ev) => {
  if (!game || busy) return;
  if (ev.button !== 0 && ev.button !== 2) return;
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0) return; // 盘外、留白——什么都不做，绝不「就近吸附」到别的格
  ev.preventDefault();
  canvas.focus({ preventScroll: true });
  game.beginGesture();
  dragging = true;
  lastCell = cell;
  const rec = applyCell(cell, { erase: ev.button === 2 });
  if (!rec) {
    // 空操作不留下一组空的撤销记录
    game.endGesture();
    dragging = false;
    lastCell = -1;
  }
  afterWrite(cell, rec);
});

canvas.addEventListener('pointermove', (ev) => {
  if (!dragging || !game) return;
  if (pen === 'note') return; // 笔记是「翻」，拖动会来回翻同一格——只许一次一点
  const cell = view.hitCell(ev.clientX, ev.clientY);
  if (cell < 0 || cell === lastCell) return;
  lastCell = cell;
  if (applyCell(cell, { erase: ev.button === 2 })) render();
});

function endDrag() {
  if (!dragging || !game) return;
  dragging = false;
  lastCell = -1;
  if (game.endGesture()) {
    // 一组真的落了笔 ⇒ 和 afterWrite 同一套：状态行交还给引擎那句话（拖动只在 pointermove 里
    // 画，不走 afterWrite，少了这一句就会出现「拖了一路、屏上还写着选笔」）。
    clearTimeout(announceT);
    stateLine.classList.remove('hint');
    render();
    persist();
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
window.addEventListener('pointerup', endDrag);
// 右键要把上下文菜单挡住，否则那一下点下去弹的是浏览器菜单，玩家看见的是「擦掉没生效」。
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ---- 键盘 ---------------------------------------------------------------------------
function moveCursor(dr, dc) {
  const w = game.w;
  const c = cursor < 0 ? 0 : cursor;
  const r = Math.floor(c / w) + dr;
  const col = (c % w) + dc;
  if (r < 0 || col < 0 || r >= game.h || col >= w) return;
  cursor = r * w + col;
  srCell.textContent = game.cellReport(cursor);
  render();
}

function typeKey(ev) {
  if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT' || ev.target.isContentEditable)) return;
  const k = ev.key;
  if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
    ev.preventDefault();
    if (!game) return;
    if (cursor < 0) cursor = 0;
    if (k === 'ArrowUp') moveCursor(-1, 0);
    else if (k === 'ArrowDown') moveCursor(1, 0);
    else if (k === 'ArrowLeft') moveCursor(0, -1);
    else moveCursor(0, 1);
    return;
  }
  if (k === 'p' || k === 'P') {
    // 空格已被上面的落子占用，同键两义会一按两响，暂停只挂 P
    ev.preventDefault();
    setPaused(!paused);
    return;
  }
  if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
    if (!game || cursor < 0) return;
    ev.preventDefault();
    afterWrite(cursor, applyCell(cursor));
    return;
  }
  if (k === 'Backspace' || k === 'Delete') {
    if (!game || cursor < 0) return;
    ev.preventDefault();
    afterWrite(cursor, game.erase(cursor));
    return;
  }
  if (k === '1' || k === '2' || k === '3') {
    const sym = Number(k) - 1;
    if (pen === 'note') {
      noteSym = sym;
      syncPenUI();
      announce(`笔记这支笔现在翻的是 ${SYMBOL_TEXT[sym]} ${GLYPH[sym]}`);
    } else {
      setPen(String(sym));
    }
    return;
  }
  if (k === 'e' || k === 'E') {
    setPen(PEN_KEYS[(PEN_KEYS.indexOf(pen) + 1) % PEN_KEYS.length]);
    return;
  }
  if (k === 'h' || k === 'H') {
    ev.preventDefault();
    hint();
    return;
  }
  if (k === 'z' || k === 'Z') {
    if (!game) return;
    if (game.undo()) {
      render();
      persist();
      announce('撤销了一组笔迹（拖动算一组，提示也算一组）。');
    }
    return;
  }
  if (k === 'n' || k === 'N') {
    ev.preventDefault();
    newGame(currentSize());
  }
}

// ---- 笔 -----------------------------------------------------------------------------
function setPen(next) {
  if (!PEN_KEYS.includes(next)) return;
  pen = next;
  syncPenUI();
  announce(penLabel() + (pen === 'note' ? '：点一下把这个候选从本格删掉，再点一下放回来。' : '：点格子落下它。'));
}

function penLabel() {
  if (pen === 'erase') return '当前 ⌫ 擦掉';
  if (pen === 'note') return `当前 ✎ 笔记（${SYMBOL_TEXT[noteSym]} ${GLYPH[noteSym]}）`;
  return `当前 ${GLYPH[Number(pen)]} ${SYMBOL_TEXT[Number(pen)]}`;
}

function syncPenUI() {
  for (const b of document.querySelectorAll('.modes button')) {
    b.setAttribute('aria-pressed', b.dataset.pen === pen ? 'true' : 'false');
  }
  const noteBtn = $('pen-note');
  noteBtn.textContent = `✎ 笔记 ${GLYPH[noteSym]}`;
  noteBtn.title = `笔记：点一下把 ${SYMBOL_TEXT[noteSym]} 从本格候选里删掉，再点一下放回来（1/2/3 换符号）`;
}

// ---- 提示：问引擎要下一条被迫的结论 --------------------------------------------------
// 落回盘面仍走 applyCell 那两个写入口，所以提示可撤销、算步数、进存档。
// 返回引擎给的那个对象（门禁读的是它），推不动时也返回它——那句「推不动」是证据不是故障。
function hint() {
  if (!game || busy) return null;
  const d = nextDeduction(game.st);
  if (d.contradiction) {
    announce(`矛盾：${d.why}（规则 ${d.rule}）——擦掉几笔再问一次。`);
    return d;
  }
  if (d.stalled) {
    // 「推不动」和「推完了」是两件事（pencil.js 在 nextDeduction 上面就是这么分的）：
    // blank === 0 是每一格都定了，那句「还剩 0 格没定」不该当失败念给玩家听。
    if (d.blank === 0) announce(`每一格都定了——铅笔没有下一步可给，赢没赢归 verify() 说：${game.status().why}`);
    else announce(`推不动了：${d.why}。铅笔只会说「这一步是被迫的」，它不会替你猜，这一层也没有一条路能读到答案。`);
    return d;
  }
  // ⚠ 有一条结论界面**落不下去**：把最后一个候选也删掉的 elim。引擎那边的出口是 cand=0，
  //   下一轮由 A5-naked-single / verify 报「这盘没有解」；而界面的候选数组只有「没落笔 +
  //   一个位掩码」这一种表示法，装不下 cand=0 —— Game.toggleNote 遇到这种一笔会翻回候选全在
  //   （一支笔不该把格子涂成「什么都不许」）。真按它落，界面就比引擎**多**了候选：那才是分家。
  //   所以这里当场拒绝落它并说清为什么：宁可提示停一步，也不让两边对「盘上现在是什么」各说一套。
  //   什么时候会撞上：玩家自己落错子、把某格最后一个候选顶掉了 —— 那本来就是没解的局面。
  if (d.kind === 'elim' && (game.st.cand[d.cell] & ~(1 << d.value)) === 0) {
    announce(`提示停在这一步：${d.rule} 要把这一格的最后一个候选也删掉 —— 那是「这盘没有解」的出口，` +
      `界面上没有「候选为空」这一态（引擎会判 cand=0，再由 A5/verify 指名）。先撤销或擦掉几笔，再问提示。`);
    return { ...d, refused: 'elim-empties-cell' };
  }
  // 笔记那支笔是**翻**（见 js/ui/game.js 的 toggleNote）：那一位已经不在了，翻它就会把它**加回来**。
  // 提示的语义是「端出下一条被迫的结论」，引擎给的 elim 一定是删 —— 所以这种一步当场停住并说清，
  // 而不是让提示替玩家把候选放回去（那会记一步、进撤销栈，屏幕上却写着「删掉」）。
  if (d.kind === 'elim' && (game.st.cand[d.cell] & (1 << d.value)) === 0) {
    announce(`提示停在这一步：${d.rule} 要删的这个候选本来就不在（这一格现在剩的候选里没有它），没有可落的结论。`);
    return { ...d, refused: 'elim-already-gone' };
  }
  const rec = d.kind === 'place' ? game.place(d.cell, d.value) : game.toggleNote(d.cell, d.value);
  hintCount++;
  srCell.textContent = game.cellReport(d.cell);
  render();
  persist();
  announce(`${d.rule}：${d.why}${rec ? '' : '（这一笔盘上已经有了，所以没记步数）'}`);
  return d;
}

// ---- 按钮与选择器 -------------------------------------------------------------------
function currentSize() {
  if (SIZES.includes(sizeSelect.value)) return sizeSelect.value;
  return SIZES.includes(DEFAULT_SIZE) ? DEFAULT_SIZE : SIZES[0];
}

// 尺寸档**只从 generate.js 的 SIZES 里长出来**：这里写死一档就能绕过引擎量的墙钟红线，
// 所以 index.html 里一个尺寸都没有，全部在这个 map 里（门禁断言 options === SIZES）。
function buildSizes() {
  sizeSelect.innerHTML = '';
  for (const key of SIZES) {
    if (!sizeAllowed(key)) continue; // 引擎自己不许上桌的档，连进选择器的机会都不给
    const { w, h } = parseSize(key);
    const tier = TIERS.find((t) => t.key === key) || null;
    const o = document.createElement('option');
    o.value = key;
    o.textContent = `${key}（${w}×${h}）`;
    o.title = tier ? `maxDraws ${tier.maxDraws} · 墙钟 ${tier.unshippable ? '撞线：' + tier.unshippable : '在菜单红线内'}` : '';
    sizeSelect.appendChild(o);
  }
  sizeSelect.value = SIZES.includes(DEFAULT_SIZE) ? DEFAULT_SIZE : SIZES[0];
}

sizeSelect.addEventListener('change', () => newGame(currentSize()));
$('btn-new').addEventListener('click', () => newGame(currentSize()));
$('btn-again').addEventListener('click', () => newGame(currentSize()));
$('btn-close-veil').addEventListener('click', () => {
  veil.hidden = true;
  veilDismissed = true;
});
$('btn-hint').addEventListener('click', hint);
$('btn-undo').addEventListener('click', () => {
  if (!game) return;
  if (game.undo()) {
    render();
    persist();
    announce('撤销了一组笔迹。');
  }
});
$('btn-clear').addEventListener('click', () => {
  if (!game) return;
  const n = game.clearAll();
  render();
  persist();
  announce(n ? `擦掉了 ${n} 格的笔迹（题面给的 ${game.counts().given} 个符号擦不掉）——撤销能把它整个退回来。` : '盘上没有你的笔迹可擦。');
});
$('btn-reset').addEventListener('click', () => {
  Store.reset();
  announce('存档已清空（进行中的一局和总成绩都归零）。下一次换一局就是新的一笔账。');
  $('stat-totals').textContent = totalsText();
});
for (const b of document.querySelectorAll('.modes button')) {
  b.addEventListener('click', () => setPen(b.dataset.pen));
}
// ---- 暂停按钮（#btn-pause，与 P 同一个入口）----
(function bindPause() {
  const btn = document.getElementById('btn-pause');
  if (!btn) return;   // HUD 里没这个 id 就不装，别让量具算出"已实现"的假绿
  btn.addEventListener('click', () => setPaused(!paused));
})();
document.addEventListener('keydown', typeKey);

window.addEventListener('resize', () => {
  layout();
  render();
});

// ---- 门面 ---------------------------------------------------------------------------
// window.triplets.engine 挂的就是**页面自己 import 的那批模块**，不是为测试另抄一份，
// 所以门禁在这里绿一次，等于浏览器那侧的出题器/铅笔/判胜同时绿一次。
// 刻意不挂 advance / applyDeduction（纪律 4）；门禁要整盘求解会自己 import 模块。
window.triplets = {
  get state() {
    return state.state;
  },
  set state(v) {
    state.state = v;
  },
  version: VERSION,
  view,
  palette: Palette,
  boardTokens: Board,
  store: Store,
  engine: {
    SIZES, TIERS, SIZE_TABLE, parseSize, sizeAllowed, fingerprint, makePuzzle, layoutFor,
    createState, nextDeduction, verify, RULE_ORDER, SYMBOL_TEXT,
    symbolOf, blankCount, candidatesOf, BLANK, ALL,
  },
  get game() {
    return game;
  },
  get pen() {
    return pen;
  },
  get noteSym() {
    return noteSym;
  },
  get cursor() {
    return cursor;
  },
  get draws() {
    return drawsTotal;
  },
  get hints() {
    return hintCount;
  },
  get busy() {
    return busy;
  },
  get veilHidden() {
    return veil.hidden;
  },
  newGame,
  playSeed,
  resumeLast,
  hint,
  applyCell,
  setPen,
  currentSize,
  render,
  layout,
  avail,
  announce,
  mintSeed,
  elapsedMs,
  clockText,
  faceOf,
  // 门禁读覆盖层用这个：它量的既是 DOM（hidden/display/矩形）也是命中测试
  // （elementFromPoint 打在最上层的是谁）——「hidden 还在吃点击」只有这两样一起看才抓得住。
  veilInfo: () => {
    const r = veil.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const mid = { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) };
    const hit = document.elementFromPoint(mid.x, mid.y);
    return {
      hidden: veil.hidden,
      display: getComputedStyle(veil).display,
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      canvasMid: mid,
      hitId: hit ? hit.id || hit.tagName.toLowerCase() : null,
      hitsVeil: !!hit && (hit === veil || veil.contains(hit)),
    };
  },
};

// —— 暂停：给闸台读的那张脸 ——
Object.defineProperty(window.triplets, 'paused', { get: () => paused });
window.triplets.setPaused = setPaused;
/** 正在推进的那个数（毫秒）。暂停时它必须一毫秒不动 —— 这就是"真冻结"的判据。 */
window.triplets.simClock = () => elapsedMs();

// ---- 启动 ---------------------------------------------------------------------------
applyThemeVars();
buildSizes();
syncPenUI();
state.state = 'boot';

// ?seed= 优先于存档：它是「我要看这一张盘」的显式请求，不能被上一次玩的东西顶掉。
(() => {
  const q = new URLSearchParams(location.search);
  const seed = q.get('seed');
  const sizeKey = q.get('size') || undefined;
  if (seed) {
    if (playSeed(seed, sizeKey)) return;
    newGame(sizeKey || currentSize());
    return;
  }
  const g = resumeLast();
  if (g) return;
  newGame(currentSize());
})();

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    if (supported) btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();
