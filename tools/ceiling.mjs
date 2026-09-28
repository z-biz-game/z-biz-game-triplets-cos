#!/usr/bin/env node
// 尺寸天花板普查：量"抽一张能出货的盘到底要等多久、要到哪一档开始出不起"，
// 把结论写进 js/engine/generate.js 的档位表（SIZES / TIERS.unshippable），而不是写进感觉。
//
// 和 tools/balance.mjs 的分工：balance 量**质量口径**（已证、逐颗必要性、规则出场、分数分布），
// 本文件量**成本口径**（抽卡数、墙钟分位、计数器结点、OVERBUDGET），并且刻意去量
// 那些**不在出货表里**的探测档 —— 天花板这条线只能由"量过的失败"画出来。
//
// 两条红线（写死在这里，红了 exit 1，不许"看情况"）：
//   WALL_MENU_P95_MS —— 菜单档：玩家点一次"换一局"到看见盘。makePuzzle 是**同步**的、
//     不可中断（js/engine/generate.js:206-241 一个 for 跑到底），所以这一档的等待就是主线程
//     被占住的等待。菜单只挂 p95 在线内的档；12×12 实测 p95 504ms（TARGET=6 的普查）⇒ 它就是被这条线挡在菜单外的。
//   WALL_SHIP_P95_MS —— 出货上限（房子口径同 z-biz-game-slither-cos：p95 过 2s 就叫"浏览器
//     承诺不起点一下等多久"）。越过这条线的档记 unshippable，不进 SIZE_TABLE 的菜单身份。
// 为什么这两条都盯 p95 而不是 p50：本仓墙钟不是双峰，但 12×12 起偶尔整张剖分重来
// （stats.noBoard），p50 会把那条尾巴抹掉；玩家撞上的正是尾巴。
//
// 用法：
//   node tools/ceiling.mjs                       默认普查（菜单档 target=10、对照 target=6、探测档 target=4，
//                                                探测梯子量到第一次撞线为止）
//   TARGET=24 node tools/ceiling.mjs             加样本（p95 要 20 个以上样本才叫量过）
//   CEIL_ALL=1 node tools/ceiling.mjs            探测梯子一口气量到底（撞线之后继续，18×18 那档 ~50s）
import { makePuzzle, SIZE_TABLE, SIZES, TIERS, parseSize } from '../js/engine/generate.js';
import { countByRegion, DEFAULT_BUDGET } from '../js/engine/counter.js';
import { solveWithRules, verify } from '../js/engine/pencil.js';
import { loadavg } from 'node:os';

// ── 红线（来历见文件头注释；改这两个数就是改承诺，必须在 README 里跟着改口径）────
export const WALL_MENU_P95_MS = 300;
export const WALL_SHIP_P95_MS = 2000;

// 表外探测档（升序）：这些尺寸**不进货表**，只用来把天花板那条线夹在两个实测点之间。
// 挑 3 的倍数（三格区域铺得满，js/engine/generate.js:72-75 那条 sizeAllowed 硬前提）。
export const PROBE_LADDER = ['12x15', '12x18', '15x15', '12x21', '18x18'];

const TARGET_MENU = Number(process.env.TARGET || 10);
const TARGET_CONTROL = Number(process.env.TARGET || 6);
const TARGET_PROBE = Number(process.env.TARGET || 4);
const PROBE_MAX_TRIALS = Number(process.env.PROBE_TRIALS || 6); // 探测档不许把普查挂住：抽 6 张不出货就判"这档出不起"
const RUN_ALL = process.env.CEIL_ALL === '1';

// nearest-rank 分位（真实排序后取，不由中位数推算）。比较器只读实参，不抽随机数。
const q = (arr, p) => {
  const a = arr.slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
};

// 一档普查：出货 target 盘（或抽卡用尽），每盘都独立复核"预算内唯一 + 铅笔推完 + verify"。
// 探测档额外带一条墙钟预算：普查工具不许把 operator 挂住 —— 被截断时如实打 capped，
// 那一档的"出货 x/target"就是**下界**，不是一句结论（结论由 reasons 里那几行 status 给）。
const PROBE_WALL_BUDGET_MS = Number(process.env.PROBE_WALL_MS || 120000);

function probeTier(sizeKey, target, maxDraws, wallBudgetMs = Infinity) {
  const { w, h } = parseSize(sizeKey);
  const N = w * h;
  const wall = [];
  const nodes = [];
  const clues = [];
  const drawsEach = [];
  const reasons = [];
  let ship = 0;
  let attempts = 0;
  let capped = false;
  let recheckStopped = 0; // 独立复核数不完的盘（OVERBUDGET）
  let recheckBad = 0; // 复核不认账（非唯一 / 推不完 / verify 不过）
  let dropOverbudget = 0; // 挖珠时数不完放回的颗数
  let maxNodesSeen = 0;
  const tierT0 = Date.now();
  for (let d = 0; d < maxDraws * 8 && ship < target; d++) {
    if (Date.now() - tierT0 > wallBudgetMs) {
      capped = true;
      reasons.push(`capped@${d}`);
      break;
    }
    const r = makePuzzle(`ceiling|${sizeKey}|${d}`, sizeKey, { maxTrials: maxDraws, budget: DEFAULT_BUDGET, now: () => Number(process.hrtime.bigint() / 1000n) / 1000 });
    attempts += r.draws;
    drawsEach.push(r.draws);
    dropOverbudget += r.stats.dropByOverbudget || 0;
    if (!r.ok) {
      reasons.push(`#${d}:${r.status}`);
      if (attempts >= maxDraws * 8) break;
      continue;
    }
    const c = countByRegion({ ...r.puzzle }, { cap: 2, budget: DEFAULT_BUDGET });
    const p = solveWithRules({ ...r.puzzle });
    if (c.stopped) recheckStopped++;
    if (c.stopped || c.count !== 1 || p.status !== 'solved' || !verify(p.st).ok) {
      recheckBad++;
      reasons.push(`#${d}:recheckFail`);
      continue;
    }
    maxNodesSeen = Math.max(maxNodesSeen, c.nodes);
    ship++;
    wall.push(r.ms);
    nodes.push(c.nodes);
    clues.push(Array.from(r.puzzle.givens).filter((v) => v >= 0).length);
  }
  const p95 = q(wall, 0.95);
  return {
    tier: sizeKey, N, regions: N / 3, target, ship, attempts, maxDraws, capped,
    drawsMax: drawsEach.length ? Math.max(...drawsEach) : 0,
    wallP50: q(wall, 0.5), wallP95: p95, wallMax: wall.length ? Math.max(...wall) : NaN,
    nodeP50: q(nodes, 0.5), nodeMax: maxNodesSeen,
    clueP50: q(clues, 0.5),
    recheckStopped, recheckBad, dropOverbudget,
    reasons,
    shipsAll: ship === target,
    withinMenuLine: Number.isFinite(p95) && p95 <= WALL_MENU_P95_MS,
    withinShipLine: Number.isFinite(p95) && p95 <= WALL_SHIP_P95_MS,
  };
}

// ── 普查：菜单档 + 表外对照档 + 探测梯子 ────────────────────────────────────
export async function measureLadder(opts = {}) {
  const menuRows = [];
  for (const k of SIZES) menuRows.push(probeTier(k, opts.menuTarget ?? TARGET_MENU, (TIERS.find((t) => t.key === k) || { maxDraws: 40 }).maxDraws));
  const controlRows = [];
  for (const k of Object.keys(SIZE_TABLE)) {
    if (SIZES.includes(k)) continue;
    controlRows.push(probeTier(k, opts.controlTarget ?? TARGET_CONTROL, (TIERS.find((t) => t.key === k) || { maxDraws: 40 }).maxDraws));
  }
  const probeRows = [];
  for (const k of PROBE_LADDER) {
    const row = probeTier(k, opts.probeTarget ?? TARGET_PROBE, PROBE_MAX_TRIALS, PROBE_WALL_BUDGET_MS);
    probeRows.push(row);
    // 量到撞线为止：出货不满、或墙钟 p95 越过出货上限，就已经拿到那条线了，再大的档只是烧墙钟。
    if (!RUN_ALL && (!row.shipsAll || !row.withinShipLine)) break;
  }
  return { menuRows, controlRows, probeRows };
}

export function formatRow(r, kind) {
  const f = (x, n = 0) => (Number.isFinite(x) ? x.toFixed(n) : '—');
  return [
    `${r.tier}${kind === 'menu' ? '★' : kind === 'control' ? '·' : '?'}`.padEnd(7),
    String(r.N).padStart(3), String(r.regions).padStart(3),
    ` ${r.ship}/${r.target}`.padEnd(9),
    `${r.attempts}(最多${r.drawsMax})`.padEnd(11),
    `${f(r.nodeP50)}/${f(r.nodeMax)}`.padStart(11).padEnd(13),
    `${f(r.wallP50)} / ${f(r.wallP95)} / ${f(r.wallMax)}`.padEnd(21),
    `${f(r.clueP50)}(${r.N ? ((100 * r.clueP50) / r.N).toFixed(0) : '—'}%)`.padEnd(11),
    String(r.recheckStopped),
    r.reasons.length ? `没出货：${r.reasons.slice(0, 6).join(' ')}${r.reasons.length > 6 ? `…共 ${r.reasons.length} 条` : ''}` : '',
  ].join(' ');
}

export function formatLadder(rows) {
  const head = '档位    格数 区数 出货      抽卡(单盘最大)  结点 p50/max  墙钟 p50/p95/max(ms)   线索 p50(占格%) OVERBUDGET';
  return [head, ...rows.map((r) => formatRow(r.row, r.kind))].join('\n');
}

const isMain = process.argv[1] && process.argv[1].endsWith('ceiling.mjs');
if (isMain) {
  const la = loadavg();
  const { menuRows, controlRows, probeRows } = await measureLadder();
  console.log(`尺寸天花板普查（菜单 target=${TARGET_MENU}、对照 target=${TARGET_CONTROL}、探测 target=${TARGET_PROBE} 且每档最多抽 ${PROBE_MAX_TRIALS} 张；` +
    `计数器预算 ${DEFAULT_BUDGET} 结点；菜单线 p95 ≤ ${WALL_MENU_P95_MS}ms、出货线 p95 ≤ ${WALL_SHIP_P95_MS}ms）`);
  console.log(`本机 load average（1/5/15）= ${la.map((x) => x.toFixed(2)).join(' / ')} ⇒ 墙钟绝对值带争用，线是"数量级跑飞"探测器，不是 SLA。`);
  const grouped = [...menuRows.map((row) => ({ row, kind: 'menu' })), ...controlRows.map((row) => ({ row, kind: 'control' })), ...probeRows.map((row) => ({ row, kind: 'probe' }))];
  console.log(formatLadder(grouped));

  let bad = 0;
  const fail = (msg) => { console.log(`  ✗ ${msg}`); bad++; };
  const note = (msg) => console.log(`  · ${msg}`);
  console.log('\n菜单身份复核（这一节就是"SIZES 按这条线定档"那句的代码形态）：');
  for (const r of [...menuRows, ...controlRows]) {
    const tier = TIERS.find((t) => t.key === r.tier);
    const inMenu = SIZES.includes(r.tier);
    const qualifies = r.shipsAll && r.withinMenuLine && r.recheckStopped === 0 && r.recheckBad === 0;
    if (inMenu && !qualifies) {
      fail(`${r.tier} 在菜单里但过不了线：出货 ${r.ship}/${r.target}、p95 ${f0(r.wallP95)}ms（线 ${WALL_MENU_P95_MS}ms）、复核不过 ${r.recheckBad}、数不完 ${r.recheckStopped} ⇒ 这一档必须从 SIZES 摘下来，或修引擎`);
    }
    if (!inMenu && qualifies) {
      fail(`${r.tier} 不在菜单里但**过得了线**（p95 ${f0(r.wallP95)}ms ≤ ${WALL_MENU_P95_MS}ms、出货 ${r.ship}/${r.target}）⇒ 菜单表落后于实测，补进 SIZES 或说明为什么不挂`);
    }
    if (!inMenu && r.withinShipLine && !r.withinMenuLine) note(`${r.tier}：能出货但等待 ${f0(r.wallP95)}ms 越过菜单线 ${WALL_MENU_P95_MS}ms ⇒ 只当对照档。TIERS 记的是「${tier ? tier.unshippable : '(无条目)'}」（本轮实测 p95 ${f0(r.wallP95)}ms）`);
    if (!r.withinShipLine) note(`${r.tier}：p95 ${f0(r.wallP95)}ms 越过出货线 ${WALL_SHIP_P95_MS}ms ⇒ 这一档浏览器承诺不起等待`);
  }
  console.log('探测梯子（不进货表的档，用来把天花板夹在两个实测点之间）：');
  for (const r of probeRows) {
    const why = !r.shipsAll ? `抽 ${PROBE_MAX_TRIALS} 张内出不起货（${r.ship}/${r.target}，${r.reasons.slice(0, 4).join(' ')}）` : !r.withinShipLine ? `墙钟 p95 ${f0(r.wallP95)}ms > ${WALL_SHIP_P95_MS}ms` : `p95 ${f0(r.wallP95)}ms 仍在线内（还没撞线）`;
    console.log(`  ${r.tier}（${r.N} 格）：${why}${r.recheckStopped ? `｜另有 ${r.recheckStopped} 盘复核数不完` : ''}`);
  }
  const lastOk = [...menuRows, ...controlRows].filter((r) => r.shipsAll && r.withinShipLine).pop();
  const firstBad = probeRows.find((r) => !r.shipsAll || !r.withinShipLine);
  const maxNodes = Math.max(0, ...grouped.map((g) => g.row.nodeMax));
  console.log(`\n天花板结论（本轮实测）：最贵还能出货的档 = ${lastOk ? `${lastOk.tier}（p95 ${f0(lastOk.wallP95)}ms）` : '无'}；` +
    `第一个撞线的探测档 = ${firstBad ? `${firstBad.tier}（${!firstBad.shipsAll ? '出货 ' + firstBad.ship + '/' + firstBad.target : 'p95 ' + f0(firstBad.wallP95) + 'ms'}）` : RUN_ALL ? '无（梯子跑完都没撞）' : '未量（用 CEIL_ALL=1 跑到底）'}。`);
  console.log(`撞的是哪条线：**墙钟 / 抽卡不出货**，不是计数器预算 —— 全普查最大结点 ${f0(maxNodes)} 对预算 ${DEFAULT_BUDGET}（离预算 ${(DEFAULT_BUDGET / Math.max(1, maxNodes)).toFixed(0)} 倍），` +
    `dropByOverbudget 合计 ${grouped.reduce((a, g) => a + g.row.dropOverbudget, 0)} 颗、复核数不完 ${grouped.reduce((a, g) => a + g.row.recheckStopped, 0)} 盘。`);
  console.log(`RESULT ceiling ok=${bad === 0} sizes=${grouped.length} menuFails=${bad}`);
  process.exit(bad ? 1 : 0);
}
function f0(x) {
  return Number.isFinite(x) ? String(Math.round(x)) : '—';
}
