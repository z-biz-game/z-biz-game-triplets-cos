#!/usr/bin/env node
// 垃圾档实测（规范 §2「存档两段式解码」那条硬要求）。
//
// 一把 `Object.assign(default, JSON.parse(raw))` 的读法会把「一条坏记录」放大成「整局冻死」：
// parsed 是 null 时 `parsed.totals` 直接抛，读档失败连带把好的那一半也报废。
// 这里逐条钉住四种坏法，每种都问两件事：**坏的那一条丢了吗？好的那一条还在吗？**
//
//   A resume 是 null / 数组 / 字符串（类型错）    → resume=null，totals 一个数不少
//   B resume 缺字段（没有 marks / 没有 fp）        → 同上
//   C resume 长度与 w×h 不符（越界）              → 同上
//   D totals 里有 NaN / 负数 / 字符串 / Infinity   → 那一个字段回 0，其余三个照原样
//   E 整包不可用（"null" / "[]" / "123" / 截断的 JSON）→ 回到 defaults，但不炸
//   F 端到端：带着最脏的一条档把页面跑起来，仍能开局、仍能落子（读档失败不许变成开局失败）
//
// 每个用例换一次 import（store.js 在模块顶层读一次 localStorage，同一路径第二次 import 拿到的是同一份态）。
import assert from 'node:assert/strict';
import { createDomEnv } from './dom-env.mjs';

const KEY = 'triplets.save.v1';
const goodResume = () => {
  const w = 4, h = 6;
  return { seed: 'gold-4x6-3-0', sizeKey: '4x6', marks: 'G'.repeat(w * h), moves: 3, w, h, fp: '4x6|x|y', elapsedMs: 12345, at: 1 };
};
const goodTotals = { solved: 2, games: 7, moves: 41, hints: 3 };

let n = 0;
async function loadWith(payload) {
  globalThis.localStorage.clear();
  if (payload !== undefined) globalThis.localStorage.setItem(KEY, typeof payload === 'string' ? payload : JSON.stringify(payload));
  const mod = await import(`../js/store.js?case=${++n}`);
  return mod.Store;
}

console.log('save-corruption.test：垃圾档逐条定罪（坏一条只丢一条）');
// A–E 那一半不需要真页面，但需要 localStorage —— 先把壳层桩挂上（F 那组再换一套全新的）。
createDomEnv();

// ---- A resume 类型错 -------------------------------------------------------------------
for (const bad of [null, [], 'nope', 42, true]) {
  const S = await loadWith({ resume: bad, totals: { ...goodTotals } });
  assert.equal(S.resume(), null, `resume=${JSON.stringify(bad)} 该被判 null`);
  assert.deepEqual(S.totals(), goodTotals, `resume 坏不许带走 totals（当前 totals=${JSON.stringify(S.totals())}）`);
}
console.log('  ✓ A resume 为 null / [] / "nope" / 42 / true → resume 判 null，totals 四个数原样保住');

// ---- B resume 缺字段 -------------------------------------------------------------------
for (const drop of ['marks', 'fp', 'seed', 'w', 'h']) {
  const r = goodResume();
  delete r[drop];
  const S = await loadWith({ resume: r, totals: { ...goodTotals } });
  assert.equal(S.resume(), null, `缺 ${drop} 的 resume 该被判 null，而不是半截着跑`);
  assert.deepEqual(S.totals(), goodTotals, `缺 ${drop} 只报废这一条`);
}
console.log('  ✓ B resume 缺 marks / fp / seed / w / h → 只丢这一条，totals 原样');

// ---- C resume 越界（marks 长度对不上 w×h、尺寸为零、秒表负数与 Infinity） ----------------
{
  const cases = [];
  const r1 = goodResume(); r1.marks = 'G'.repeat(23); cases.push(r1); // 少一格
  const r2 = goodResume(); r2.w = 0; cases.push(r2);
  const r3 = goodResume(); r3.elapsedMs = -99999; r3.moves = -5; cases.push(r3);
  const r4 = goodResume(); r4.elapsedMs = Infinity; r4.moves = 'many'; cases.push(r4);
  const r5 = goodResume(); r5.sizeKey = 123; cases.push(r5);
  for (const r of [r1, r2]) assert.equal((await loadWith({ resume: r, totals: { ...goodTotals } })).resume(), null, '格数不对的档不许喂引擎');
  const s3 = await loadWith({ resume: r3, totals: { ...goodTotals } });
  assert.equal(s3.resume().elapsedMs, 0, '负秒表夹回 0（不是 -99999 一路带到显示层）');
  assert.equal(s3.resume().moves, 0, '负步数夹回 0');
  const s4 = await loadWith({ resume: r4, totals: { ...goodTotals } });
  assert.equal(s4.resume().elapsedMs, 0, 'Infinity 秒表回 0，不许被 Math.min 夹成看起来合法的 7 天');
  assert.equal(s4.resume().moves, 0, '字符串步数回 0');
  const s5 = await loadWith({ resume: r5, totals: { ...goodTotals } });
  assert.equal(s5.resume().sizeKey, '4x6', 'sizeKey 类型错就用 w×h 推一个，不必整条报废');
  console.log('  ✓ C marks 长度不符 / w=0 / 负数 / Infinity / 类型错 → 该丢的丢，该夹的夹，sizeKey 还能推回来');
}

// ---- D totals 的四个字段各自坏 ---------------------------------------------------------
{
  const S = await loadWith({ resume: goodResume(), totals: { solved: 'two', games: -3, moves: NaN, hints: 4 } });
  assert.deepEqual(S.totals(), { solved: 0, games: 0, moves: 0, hints: 4 }, `四个字段各自消毒，hints 该留着：${JSON.stringify(S.totals())}`);
  assert.equal(S.resume().seed, 'gold-4x6-3-0', 'totals 坏不许带走 resume');
  const S2 = await loadWith({ resume: goodResume(), totals: [1, 2] });
  assert.deepEqual(S2.totals(), { solved: 0, games: 0, moves: 0, hints: 0 }, 'totals 是数组 → 回默认');
  assert.equal(S2.resume().marks.length, 24, '数组版 totals 也只报废自己');
  console.log('  ✓ D totals 坏字段回 0，好字段留着，且 resume 完好');
}

// ---- E 整包不可用 ----------------------------------------------------------------------
for (const raw of ['null', '[]', '123', '"abc"', '{ 截断的', '']) {
  const S = await loadWith(raw);
  assert.equal(S.resume(), null, `整包 ${JSON.stringify(raw)} 该等于没有存档`);
  assert.deepEqual(S.totals(), { solved: 0, games: 0, moves: 0, hints: 0 });
  S.recordGame(); // 读档失败之后照样能记账（不许冻死）
  assert.equal(S.totals().games, 1, `整包坏之后记账能力还在（raw=${JSON.stringify(raw)}）`);
}
console.log('  ✓ E 整包 null / [] / 123 / "abc" / 截断 / 空串 → 当没有存档，recordGame 照记');

// ---- F 端到端：最脏的一条档不许让整局冻死 ------------------------------------------------
{
  const env = createDomEnv();
  globalThis.localStorage.setItem(KEY, JSON.stringify({
    resume: { seed: 'gold-6x6-3-0', sizeKey: '6x6', marks: 'G'.repeat(10), w: 6, h: 6, fp: 'x', moves: 'lots', elapsedMs: -1 },
    totals: { solved: 5, games: 9, moves: 'many', hints: null },
  }));
  await import('../js/main.js?savecase=1');
  const t = globalThis.window.triplets;
  for (let i = 0; t.busy && i < 600; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(t.game, '垃圾档没能把开局挡死：屏上必须有一张盘');
  assert.equal(t.state, 'ready');
  assert.ok(t.readout().given > 0, '正常开局：题面至少该给几颗符号');
  assert.notEqual(t.game.seed, 'gold-6x6-3-0', '坏档里那条 seed 不许被采信（marks 长度对不上就是没有存档）');
  const before = t.readout().moves;
  const g = t.game;
  let cell = -1;
  for (let k = 0; k < g.n; k++) if (!g.isGiven(k) && g.symbolAt(k) < 0) { cell = k; break; }
  assert.ok(cell >= 0, '新局里总该找得到一格没落笔');
  assert.ok(t.applyCell(cell, {}), '落子这一条路还通');
  assert.equal(t.readout().moves, before + 1);
  // games 是 9 + 本局开局记的那一次：坏的两个字段回 0，好的两个字段照原样往下走
  assert.deepEqual(t.store.totals(), { solved: 5, games: 10, moves: 0, hints: 0 }, `两个坏字段回 0、两个好字段留着：${JSON.stringify(t.store.totals())}`);
  env.pump(60);
  assert.ok(t.clock.simSteps > 0, '时钟也照常走（读档失败不该顺手把仿真饿死）');
  console.log(`  ✓ F 端到端：marks 只有 10 格（声称 6×6）+ moves:"lots" + elapsedMs:-1 → 该条丢弃、另开新局（seed ${t.game.seed}、题面给 ${t.readout().given} 颗）、落子生效（步数 ${before}→${t.readout().moves}）、totals ${JSON.stringify(t.store.totals())}`);
}

console.log(`save-corruption.test 全绿：${n + 1} 包档、6 组定罪`);
