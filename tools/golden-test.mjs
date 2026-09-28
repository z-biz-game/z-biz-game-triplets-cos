// golden 的另一边：**node 侧逐条复核冻结夹具**。
//
// tools/golden.mjs 是纯数据（浏览器也吃同一批字节，见 tools/playtest.cjs 的注入），
// 本文件才是允许 import 引擎、允许有退出码的那半边。npm test 跑它，所以「换一局端上来的
// 那一盘能不能被引擎独立重证」在**没有 Chrome 的机器上**也有一条红/绿可说；浏览器轮
// （tools/scenarios.js 的 reproof 场景）量的是同一件事在 Chrome 里成立。
//
// 每条夹具要过的五道（一条记录 = 一个固定 seed）：
//   1 出货      makePuzzle(seed, key).ok 必须为真，且 draws 与冻结值相同
//   2 题面      reg/givens 与冻结串逐格相同；引擎自己的 fingerprint() 与 fingerprintOf() 同串
//   3 唯一解    独立穷举计数器 countByRegion 在预算内数出 1，且没被预算停住
//   4 零猜测    solveWithRules 的 status 是 solved（铅笔不需要猜一步）
//   5 玩家路径  **经由界面那三个写入口**（Game.place / Game.toggleNote，不是 applyDeduction）
//              把 nextDeduction 的结论一笔一笔落完，最后 verify() 说 ok，且逐格等于冻结的那份
//
// 第 5 道是这一条链上唯一证明「界面上按提示按到底，真能解完」的账：它不许碰 advance()
// 也不许碰 applyDeduction()——那两个是引擎内部原地推进用的，界面一次都不调用（纪律见
// js/main.js 文件头）。如果界面上的「提示」按钮其实解不完出货盘，红在这里就该红。
//
// 刻意**不**在这里跑 auditClueNecessity：那是逐颗摘线索的账（每颗都要重跑两道门），
// 属于 npm run balance 与 npm run probe 的范围，塞进 npm test 会把一个语法级快的门变成
// 分钟级的门。这里的五道全是「一次跑完」的量。

import { performance } from 'node:perf_hooks';

import { GOLDEN, GOLDEN_SCHEMA, fingerprintOf, regOf, givensOf, fillOf } from './golden.mjs';
import { SIZES, TIERS, parseSize, fingerprint, makePuzzle } from '../js/engine/generate.js';
import { countByRegion } from '../js/engine/counter.js';
import { solveWithRules, nextDeduction, createState } from '../js/engine/pencil.js';
import { Game } from '../js/ui/game.js';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, test, detail = '') {
  checks++;
  if (cond) return;
  fails.push(`${test}${detail ? ' —— ' + detail : ''}`);
  console.log(`  ✗ ${test}${detail ? ' :: ' + detail : ''}`);
}

const arrEq = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

function runOne(rec) {
  const t0 = performance.now();
  const { key, seed, w, h } = rec;
  const reg = regOf(rec);
  const givens = givensOf(rec);
  const fill = fillOf(rec);

  // 0 形状：串长、尺寸、菜单身份
  ok(SIZES.includes(key), `${key} 必须是菜单档（generate.js 的 SIZES 里有它）`, `SIZES=${SIZES.join(',')}`);
  ok(!!TIERS.find((t) => t.key === key && t.inMenu), `${key} 在 TIERS 里必须还挂着 inMenu`);
  const size = parseSize(key);
  ok(size.w === w && size.h === h, `${key} parseSize 与冻结的 w/h 必须相同`, `parseSize=${size.w}x${size.h} 冻结=${w}x${h}`);
  ok(rec.reg.length === w * h && rec.givens.length === w * h && rec.fill.length === w * h, `${key} 三个串都必须和盘面同长`);
  ok(fingerprintOf(rec) === rec.fp, `${key} 冻结的 fp 必须等于 fingerprintOf(记录)`);

  // 1 出货
  const made = makePuzzle(seed, key);
  ok(made.ok === true, `${key} seed ${seed} 必须出货`, `status=${made.status} draws=${made.draws}`);
  if (!made.ok) return;
  ok(made.draws === rec.draws, `${key} 抽卡次数必须与冻结值相同`, `实测=${made.draws} 冻结=${rec.draws}`);

  // 2 题面逐格相同（含引擎那侧的指纹口径）
  const p = made.puzzle;
  ok(arrEq(Int8Array.from(p.reg), reg), `${key} reg 必须与冻结的分区表逐格相同`);
  ok(arrEq(Int8Array.from(p.givens), givens), `${key} givens 必须与冻结的题面逐格相同`);
  ok(fingerprint(p.w, p.h, p.reg, p.givens) === rec.fp, `${key} 引擎的 fingerprint() 必须与冻结 fp 同串`,
    `引擎=${fingerprint(p.w, p.h, p.reg, p.givens)}`);
  let clues = 0;
  for (let i = 0; i < givens.length; i++) if (givens[i] >= 0) clues++;
  ok(clues === rec.clues, `${key} 线索数必须与冻结值相同`, `实测=${clues} 冻结=${rec.clues}`);

  // 3 唯一解（独立计数器，不共用铅笔的任何代码路径）
  const puzzle = { w, h, reg, givens };
  const dp = countByRegion(puzzle);
  ok(!dp.stopped, `${key} 计数器不许被预算停住（停住就等于没数过）`, `nodes=${dp.nodes}`);
  ok(dp.count === 1, `${key} 计数器必须数出恰好 1 个解`, `count=${dp.count}`);
  ok(dp.truth.every((v, i) => v === fill[i]), `${key} 计数器的真值必须与冻结的那份逐格相同`);

  // 4 零猜测推得完
  const pen = solveWithRules(puzzle);
  ok(pen.status === 'solved', `${key} 铅笔必须在零猜测下推到底`, `status=${pen.status} steps=${pen.steps}`);

  // 5 玩家路径：只用界面的写入口 + 引擎的 nextDeduction
  const g = new Game({ sizeKey: key, w, h, seed, reg, givens, fp: rec.fp });
  ok(g.fp === rec.fp, `${key} Game 自己算的 fp 必须与冻结值相同`);
  const cap = w * h * 12; // 每一步要么落子要么删候选，删除总量有上界；到不了就是死循环
  let steps = 0;
  let stuck = null;
  let contra = null;
  for (; steps < cap; steps++) {
    const d = nextDeduction(g.st);
    if (d.contradiction) { contra = d; break; }
    if (d.stalled) { stuck = d; break; }
    const rec2 = d.kind === 'place' ? g.place(d.cell, d.value) : g.toggleNote(d.cell, d.value);
    if (rec2 === null) {
      // 引擎说这一步是新的，界面却说这一笔什么都没改 —— 两边对「已经落了什么」的理解分家了
      ok(false, `${key} 第 ${steps} 步：引擎给的结论界面落不下去`, `${d.rule}@${d.cell} kind=${d.kind} value=${d.value}`);
      break;
    }
  }
  ok(!contra, `${key} 沿提示走的过程中不许出现矛盾`, contra ? contra.why : '');
  // 「推不动」和「推完了」是两件事（pencil.js 在 nextDeduction 上面就是这么分的）：
  // stalled.blank === 0 是**推完了**，>0 才是真的卡住。把它们混成一条断言，
  // 每个夹具都会假红 —— 满盘之后引擎只会再报一次「轮询一圈，还剩 0 格没定」。
  ok(!stuck || stuck.blank === 0, `${key} 沿提示走必须推到底（这正是「零猜测」在界面上的含义）`, stuck ? stuck.why : '');
  ok(steps < cap, `${key} 沿提示走不许死循环`, `steps=${steps}`);
  const st = g.status();
  ok(st.ok === true, `${key} 沿提示走完之后 verify() 必须说 ok`, st.why);
  const sym = [];
  for (let i = 0; i < g.n; i++) sym.push(g.symbolAt(i));
  ok(arrEq(Int8Array.from(sym), fill), `${key} 沿提示走定出的那一份必须与冻结的唯一解逐格相同`);
  notes.push(`${key} seed=${seed} 线索 ${clues} 抽卡 ${made.draws} 提示 ${steps} 步 墙钟 ${(performance.now() - t0).toFixed(0)}ms`);
}

ok(GOLDEN_SCHEMA === 1, 'GOLDEN_SCHEMA 必须是 1（夹具形状改过就要换 schema 号）');
ok(GOLDEN.length === SIZES.length, `夹具必须覆盖菜单每一档（各一条）`, `GOLDEN=${GOLDEN.length} SIZES=${SIZES.length}`);
for (const key of SIZES) ok(GOLDEN.some((r) => r.key === key), `夹具缺档 ${key}`);
for (const r of GOLDEN) ok(r.v === GOLDEN_SCHEMA, `${r.key} 记录的 v 必须等于 schema 号`);
// 同一颗 seed 不许在夹具里出现两次：两条记录共用 seed 就等于其中一条没有独立见证。
const seen = new Set();
for (const r of GOLDEN) {
  ok(!seen.has(r.seed), `seed 不许在夹具里重复：${r.seed}`);
  seen.add(r.seed);
}

for (const r of GOLDEN) runOne(r);

for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails.slice(0, 12)) console.log(`  ✗ ${f}`);
console.log(`RESULT golden-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
