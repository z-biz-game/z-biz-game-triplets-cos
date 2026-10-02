// 存档。所有东西挂在同一个键下，所以「清空存档」是一行。
//
// 进行中的一局存的是 (原始 seed, 尺寸, 玩家在这一格里落下的每一笔的编码, 步数)，
// 不是题面或答案的副本——出题器只吃 seed，所以同一个 seed 在 node 与 Chrome 上都画出
// 同一张盘（确定性口径见 js/engine/rng.js），恢复一局只有几百字节。
// 存的是**原始 seed**，不是 generate.js 内部派生过的那一个：内部值一改，旧存档就重建不出
// 同一张盘。冻结进 tools/golden.mjs 的也是同一个原始 seed，两边口径一致。
//
// 为什么不存 reg / givens：那两份是题面，题面由 seed 决定。存了就有第二条真相，
// 引擎改了分区算法时它会静静地骗人。所以这里带一个 fp（fingerprint），恢复时对一遍：
// 对不上就是「这个存档属于另一张盘」，丢掉、重开，而不是拿半截 marks 去喂新题面。
//
// 键里带 v1：数据结构改了要换键名，不许让旧存档把新代码喂进半截状态。

const KEY = 'triplets.save.v1';
// 秒表的可信上界：7 天。越界当没记过 —— 那通常是手改或别的版本写进来的数。
const MAX_ELAPSED_MS = 7 * 24 * 3600 * 1000;

const defaults = () => ({
  resume: null,
  totals: { solved: 0, games: 0, moves: 0, hints: 0 },
});

const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// 第一段：整包可用性。JSON 坏掉 / 隐私模式 / 配额 = 「没有存档」，不许变成开局失败。
// 这一段**只**判整包，一条记录的坏不在这里判 —— 在这里判会牵连另一条好的。
function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 第二段之一：总成绩。四个数各自消毒，坏的那一个回 0，其余三个不跟着陪葬。
function sanitizeTotals(t) {
  const base = defaults().totals;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return base;
  return {
    solved: Number.isFinite(t.solved) ? count(t.solved) : base.solved,
    games: Number.isFinite(t.games) ? count(t.games) : base.games,
    moves: Number.isFinite(t.moves) ? count(t.moves) : base.moves,
    hints: Number.isFinite(t.hints) ? count(t.hints) : base.hints,
  };
}

// 第二段之二：进行中的一局。回来的要么是完整可用的一局，要么是 null（null 就正常开局，
// 绝不拿半截 marks 喂引擎）。它的报废不带走 totals。
function sanitizeResume(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.seed !== 'string' || !r.seed) return null;
  if (typeof r.marks !== 'string' || !r.marks) return null;
  if (!Number.isFinite(r.w) || !Number.isFinite(r.h)) return null;
  const w = Math.floor(r.w);
  const h = Math.floor(r.h);
  if (w < 1 || h < 1 || w * h !== r.marks.length) return null; // 格数不是它声称的那个数
  if (typeof r.fp !== 'string' || !r.fp) return null;
  return {
    seed: r.seed,
    sizeKey: typeof r.sizeKey === 'string' && r.sizeKey ? r.sizeKey : `${w}x${h}`,
    marks: r.marks,
    moves: count(r.moves),
    w,
    h,
    fp: r.fp,
    elapsedMs: Number.isFinite(r.elapsedMs) ? count(Math.min(r.elapsedMs, MAX_ELAPSED_MS)) : 0,
    at: Number.isFinite(r.at) ? r.at : 0,
  };
}

function load() {
  const parsed = readRaw();
  if (!parsed) return defaults();
  return { resume: sanitizeResume(parsed.resume), totals: sanitizeTotals(parsed.totals) };
}

export const Store = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* 隐私模式 / 配额超了 —— 游戏照样能玩，只是记不住事 */
    }
  },

  // game: Game 实例；elapsedMs: 这一局已经走到的秒表（它不是判断量，是个读数）
  saveResume(game, elapsedMs = 0) {
    this.data.resume = {
      seed: game.seed,
      sizeKey: game.sizeKey,
      marks: game.encode(),
      moves: game.moves,
      w: game.w,
      h: game.h,
      fp: game.fp,
      elapsedMs,
      at: Date.now(), // 只给人看的「什么时候存的」；判断路径上没有一处读它
    };
    this.save();
  },

  // 回来的要么是完整可用的一局，要么是 null。null 就正常开局，别拿半截存档喂引擎。
  resume() {
    const r = this.data.resume;
    if (!r || typeof r.seed !== 'string' || !r.seed) return null;
    if (typeof r.marks !== 'string' || typeof r.w !== 'number' || typeof r.h !== 'number') return null;
    if (r.marks.length !== r.w * r.h) return null;
    if (typeof r.fp !== 'string' || !r.fp) return null;
    return r;
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  recordGame() {
    this.data.totals.games++;
    this.save();
  },

  recordSolve(moves, hints) {
    this.data.totals.solved++;
    this.data.totals.moves += moves;
    this.data.totals.hints += hints;
    this.save();
  },

  totals() {
    return this.data.totals;
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
