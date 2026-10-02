#!/usr/bin/env node
// 壳层行为与帧率对拍（npm test 里的一套）。判据全部靠**真派发事件、真喂假时钟**量出来，
// 不是把源码字符串里有没有 `suspend()` / `dt` 查一遍：
//
//   1 暂停   —— 按下 P 之后 simSteps / simTime / 秒表一字不动，三条写入口一律拒收，恢复后接着走且不丢笔迹。
//   2 静音   —— setMuted(true) 真把 AudioContext suspend()；静音态再落子，发声节点一格不建（只把 gain 设 0 的假静音抓不住这一条）。
//   3 重开   —— 同一张题面（seed 不动），时钟、笔迹、步数、撤销、提示计数、光标、覆盖层全部归零（打印前后数）。
//   4 三档   —— 同一份源码、同一个 LCG 剧本、同样 3000ms 虚拟时长，30/60/120Hz 读到同一批数。
//   5 减动效 —— prefers-reduced-motion: reduce 时光晕恒 0（动效退化为静图）。
//   6 阴性对照 —— 把 js/fx.js 累加器那一行 `accum += dt` 换成 `accum += 1/60`（定步长改造之后
//                 全仓唯一还在吃帧 dt 的行，规范 §6 指定的靶子），第 4 条必须换红。不红说明尺是空跑的。
//
// 两条已实测踩过的坑钉在这里：三档对齐既看**虚拟时长**也看**仿真步号**（只看墙钟会被 1000/60 的
// 浮点亏损凭空判红，只看步号则对累加策略免疫 —— 两头都量才抓得住真缺陷）；假时钟从 1000ms 起步
// （从 0 起步会被首帧哨兵吃掉一帧，凭空造出 25ms 的假依赖，见 js/fx.js 顶部）。
import assert from 'node:assert/strict';
import { createDomEnv, makeLcg } from './dom-env.mjs';
import { FrameClock, SIM_STEP } from '../js/fx.js';

const SEED = 'gold-6x6-3-0';
const SIZE = '6x6';
const DURATION_MS = 3000;
const RATES = [30, 60, 120];
const EXPECT_STEPS = Math.round(DURATION_MS / 1000 / SIM_STEP); // 360 步

let checks = 0;
const log = (name, detail) => { checks++; console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`); };

let caseCounter = 0;
async function boot(opts = {}) {
  const env = createDomEnv(opts);
  // 每个用例一套全新的全局桩 + 全新的模块实例：main.js 带模块态（game / clock / sfx 都在闭包里），
  // 同一路径第二次 import 拿到的是同一份态，用例之间会互相串。
  await import(`../js/main.js?case=${++caseCounter}`);
  const t = globalThis.window.triplets;
  for (let i = 0; t.busy && i < 600; i++) await new Promise((r) => setTimeout(r, 50)); // 启动那趟 newGame 是真出题
  assert.ok(t.playSeed(SEED, SIZE), `playSeed(${SEED}) 没出货`);
  return { env, t };
}

// 用 LCG 选格落几笔（不许用 Math.random：两趟跑的必须是同一个剧本）。
// 命中已填的格是**空操作**，空操作不排音 —— 所以从随机起点往后线性找下一个「非题面且没落笔」的格，
// 保证每一笔都真落得下去：静音那一组量的才是「静音挡不挡得住建节点」，不是「这一笔有没有生效」。
function scriptStrokes(t, n = 10, seed = 20261003) {
  const rnd = makeLcg(seed);
  const g = t.game;
  let placed = 0;
  for (let i = 0; i < n; i++) {
    t.setPen(String(Math.floor(rnd() * 3)));
    const start = Math.floor(rnd() * g.n);
    let cell = -1;
    for (let k = 0; k < g.n; k++) {
      const c = (start + k) % g.n;
      if (!g.isGiven(c) && g.symbolAt(c) < 0) { cell = c; break; } // symbolOf 的没落定是 -1，不是 falsy
    }
    if (cell < 0) break;
    if (t.applyCell(cell, {})) placed++;
  }
  return placed;
}

// 按 fps 喂满 DURATION_MS。两头都记：
//   · samples：仿真步号 → 连续量读数。三档在同一号步上必须读到同一批数 —— 这一头抓的是
//     「某个量偷偷吃了帧 dt」（ glow 之类若按帧累加，同号步数就会走出不同值）。
//   · simSteps：同样 3000ms 虚拟时长末尾的步数。这一头抓的是「累加策略本身错」
//     （定值累加的写法在三档下攒出的步数会分家，见下面第 6 组那发变异）。
function runRate(t, env, fps) {
  const interval = 1000 / fps;
  const frames = Math.round(DURATION_MS / interval);
  const samples = new Map();
  // 先喂一帧**只喂哨兵**的帧（lastTs<0 那一支不吃 dt）：不这么做，被哨兵吃掉的那一帧就是
  // 每档不同的时长（30Hz 4 步 / 60Hz 2 步 / 120Hz 1 步），量出来的「同一虚拟时长」根本不是同一个时长。
  env.pump(1, interval);
  for (let f = 0; f < frames; f++) {
    env.pump(1, interval);
    const r = t.readout();
    if (!samples.has(r.simSteps)) samples.set(r.simSteps, [r.simTime, r.glow, r.elapsedMs, r.clockText]);
  }
  return { frames, simSteps: t.readout().simSteps, samples };
}

// 公共步号上的逐点对比（不同档每帧走的步数不同，可达步号自然是子集，所以比交集）
function compareSamples(runs) {
  const ref = runs[60];
  let common = 0;
  for (const fps of RATES) {
    const cur = runs[fps];
    for (const [step, row] of cur.samples) {
      if (!ref.samples.has(step)) continue;
      common++;
      assert.deepEqual(ref.samples.get(step), row,
        `${fps}Hz 在第 ${step} 步读到 ${JSON.stringify(row)}，60Hz 同一号步读到 ${JSON.stringify(ref.samples.get(step))}`);
    }
  }
  return common;
}

console.log(`shell.test  seed=${SEED} size=${SIZE} 时长=${DURATION_MS}ms（期望 ${EXPECT_STEPS} 步）`);

// ---- 1 暂停 ---------------------------------------------------------------------------
{
  const { env, t } = await boot();
  env.pump(120); // 2 虚拟秒
  const before = t.readout();
  assert.ok(before.simSteps > 0, '暂停前仿真本该推进');
  scriptStrokes(t, 6);
  t.setPaused(true);
  const at = t.readout();
  env.pump(600); // 暂停里再喂 10 虚拟秒
  const mid = t.readout();
  assert.equal(mid.simSteps, at.simSteps, '暂停期间 simSteps 必须一字不动');
  assert.equal(mid.simTime, at.simTime, '暂停期间 simTime 必须一字不动');
  assert.equal(mid.elapsedMs, at.elapsedMs, '暂停期间秒表必须停住');
  assert.equal(mid.glow, 0, '暂停时光晕退化成静图（恒 0）');
  assert.ok(mid.frames > before.frames, '暂停期间帧计数照走 —— 冻住的只有仿真');
  env.pointerAt(40, 40, 0);
  env.key('Enter');
  assert.equal(t.applyCell(0, {}), null, '暂停时 applyCell 必须返回 null');
  assert.equal(t.hint(), null, '暂停时提示必须一笔都不落');
  assert.equal(t.readout().moves, at.moves, '暂停期间步数不许涨');
  assert.equal(t.readout().placed, at.placed, '暂停期间不许出现新笔迹');
  env.key('p');
  assert.equal(t.paused, false, 'P 再把暂停掀掉');
  env.pump(120);
  const after = t.readout();
  assert.ok(after.simSteps > mid.simSteps, '恢复后仿真接着走');
  assert.equal(after.placed, at.placed, '恢复后笔迹不丢');
  log('暂停', `simSteps ${at.simSteps} 冻结，暂停里喂 600 帧仍 ${mid.simSteps}（frames ${before.frames}→${mid.frames}），恢复后 ${after.simSteps}`);
}

// ---- 2 静音 ---------------------------------------------------------------------------
{
  const { env, t } = await boot();
  const s = t.sfx;
  env.key('Shift'); // 首手势（document 捕获那趟）解锁 AudioContext，Shift 在玩法上没有第二义
  assert.equal(s.unlocked, true, '首手势之后必须解锁（构造时不建上下文）');
  assert.equal(s.muted, false, '未静音基线');
  const ctx = env.audio.contexts[0];
  assert.ok(ctx, '解锁之后才该有 AudioContext');
  scriptStrokes(t, 8);
  const nodesAfterPlay = env.audio.oscillators + env.audio.gains;
  assert.ok(nodesAfterPlay > 0, '未静音落子该建节点');
  assert.equal(s.nodes, nodesAfterPlay, 'sfx.nodes 该等于桩里真建出来的节点数');
  const playedBefore = s.played;
  t.toggleMute();
  assert.equal(s.muted, true, 'M 真的翻成静音');
  assert.equal(ctx.state, 'suspended', '静音必须把上下文挂起，不是把 gain 设 0');
  assert.equal(env.audio.suspendCalls, 1, 'suspend() 该被真调一次');
  scriptStrokes(t, 8, 777); // 静音态再落八笔
  const nodesWhileMuted = env.audio.oscillators + env.audio.gains;
  assert.equal(nodesWhileMuted, nodesAfterPlay, '静音态不得再新建任何节点');
  assert.equal(s.played, playedBefore, '静音态一个音都没排出去');
  assert.ok(s.blocked > 0, '被挡掉的次数要记在案');
  env.pointerAt(40, 40, 0);
  assert.equal(t.paused, false, '静音不该顺手把局也停了');
  t.toggleMute();
  assert.equal(ctx.state, 'running', '取消静音要把上下文放回来');
  assert.equal(env.audio.resumeCalls >= 1, true, 'resume() 该被真调');
  scriptStrokes(t, 4, 4242);
  assert.ok(env.audio.oscillators + env.audio.gains > nodesAfterPlay, '恢复之后节点数才继续涨');
  log('静音', `未静音落 8 笔建 ${nodesAfterPlay} 个节点 → 静音再落 8 笔节点仍 ${nodesWhileMuted}（blocked ${s.blocked}，ctx=suspended，suspend 调用 ${env.audio.suspendCalls} 次）→ 恢复后再落 4 笔 ${env.audio.oscillators + env.audio.gains}（resume 调用 ${env.audio.resumeCalls} 次）`);
}

// ---- 3 重开（复位是否真的发生：打印前后数） -------------------------------------------
{
  const { env, t } = await boot();
  env.pump(240); // 2 虚拟秒
  scriptStrokes(t, 10);
  t.hint();
  env.key('ArrowDown'); // 键盘光标也得上场，才能验它被归零
  const before = t.readout();
  assert.ok(before.moves > 0 && before.simSteps > 0 && before.cursor >= 0, '重开前该有东西可复位');
  const { after } = t.restart();
  assert.equal(after.simSteps, 0, '时钟步数归零');
  assert.equal(after.simTime, 0, '积分钟归零');
  assert.equal(after.simAccumulator, 0, '累加器归零');
  assert.equal(after.elapsedMs, 0, '秒表归零');
  assert.equal(after.clockText, '00:00', '屏上那句该是 00:00');
  assert.equal(after.glow, 0, '光晕归零');
  assert.equal(after.moves, 0, '步数归零');
  assert.equal(after.undo, 0, '撤销栈清空');
  assert.equal(after.placed, 0, '玩家笔迹清空');
  assert.equal(after.notes, 0, '候选笔记清空');
  assert.equal(after.hints, 0, '提示计数归零');
  assert.equal(after.cursor, -1, '键盘光标复位');
  assert.equal(after.veilHidden, true, '胜利覆盖层收起');
  assert.equal(after.blank, before.blank + before.placed, '重开之后玩家那几笔不再算填过的格（还空着的数回到题面本义）');
  assert.equal(after.given, before.given, '题面给的符号一颗不少');
  assert.equal(after.seed, before.seed, '重开 = 同一张题面（seed 不许换）');
  assert.equal(after.frames, 0, '帧计数归零');
  env.pump(60);
  assert.ok(t.readout().simSteps > 0, '复位之后时钟照样能走（不是把循环饿死了）');
  log('重开', `笔迹 ${before.placed}→${after.placed}，步数 ${before.moves}→${after.moves}，撤销 ${before.undo}→${after.undo}，提示 ${before.hints}→${after.hints}，simSteps ${before.simSteps}→${after.simSteps}，秒表 ${before.clockText}→${after.clockText}，光标 ${before.cursor}→${after.cursor}`);
}

// ---- 4 三档对拍 -----------------------------------------------------------------------
let honestSpread = 0;
{
  const runs = {};
  for (const fps of RATES) {
    const { env, t } = await boot();
    scriptStrokes(t, 10); // 同一份 LCG 剧本，三档落的是同一批笔
    runs[fps] = runRate(t, env, fps);
  }
  const steps = RATES.map((f) => runs[f].simSteps);
  honestSpread = Math.max(...steps) - Math.min(...steps);
  const common = compareSamples(runs);
  console.log(`  三档 simSteps=${RATES.map((f) => `${f}Hz:${runs[f].simSteps}`).join(' ')} 极差=${honestSpread} 公共步号=${common} 个`);
  assert.ok(common >= 80, `公共步号只有 ${common} 个，样本不够（三档喂的帧数 = ${RATES.map((f) => runs[f].frames).join('/')}）`);
  assert.ok(honestSpread <= 1, `同一虚拟时长的仿真步数极差 ${honestSpread} > 1（1 步 = 8.3ms 是量化边界，超过就是帧率依赖）`);
  assert.ok(Math.abs(runs[120].simSteps - EXPECT_STEPS) <= 1, `120Hz 喂满 ${DURATION_MS}ms 该走 ${EXPECT_STEPS}±1 步，实际 ${runs[120].simSteps}`);
  const refKeys = [...runs[60].samples.keys()];
  const ref = runs[60].samples.get(Math.max(...refKeys));
  log('三档对拍', `${common} 个公共步号逐点全等（[simTime, glow, ms, 秒表] 末点=${JSON.stringify(ref)}），时长末尾 simSteps 极差 ${honestSpread}`);
}

// ---- 5 reduceMotion -------------------------------------------------------------------
{
  const { env, t } = await boot({ reducedMotion: true });
  env.pump(240);
  const r = t.readout();
  assert.equal(r.reducedMotion, true, '系统偏好该被读到');
  assert.equal(r.glow, 0, '减动效时光晕恒 0');
  assert.equal(env.el('board-wrap').style.getPropertyValue('--fx-glow'), '0.0000', '写进 DOM 的那一笔也是 0');
  assert.ok(r.simSteps > 0, '减动效只关装饰，仿真照走（秒表不能跟着停）');
  const midGlow = r.glow;
  env.mq._set(false); // 中途取消减动效偏好（系统偏好是会变的，判据不能只在启动时读一次）
  env.pump(240);
  const after = t.readout();
  assert.equal(after.reducedMotion, false, '偏好变化要能被接住');
  assert.ok(after.glow > midGlow, '取消减动效之后光晕才回来');
  log('reduceMotion', `偏好 on：240 帧 glow=${r.glow}（simSteps ${r.simSteps} 照走）→ 偏好 off：glow=${after.glow}`);
}

// ---- 6 阴性对照：累加器那一行改成定值，第 4 条必须换红 --------------------------------
{
  // 与 js/fx.js 同构，只把 `simAccumulator += dt` 换成 `+= 1/60`：每帧补一份定值，
  // 30Hz 走得慢、120Hz 走得快 —— 这正是「只在 60Hz 成立」的写法。
  class MutantClock extends FrameClock {
    frame(ts) {
      if (!Number.isFinite(ts)) return 0;
      if (this.lastTs < 0) { this.lastTs = ts; return 0; }
      this.lastTs = ts;
      this.frames++;
      if (this.paused) { this.pausedFrames++; return 0; }
      this.simAccumulator += 1 / 60; // ← 变异
      let steps = 0;
      while (this.simAccumulator >= this.step) {
        this.simAccumulator -= this.step;
        this.simTime += this.step;
        this.simSteps++;
        steps++;
      }
      return steps;
    }
  }
  const perRate = RATES.map((fps) => {
    const c = new MutantClock();
    let ts = 1000; // 与正尺同一口径：沙箱时钟从 1000ms 起
    for (let f = 0; f < Math.round(DURATION_MS / (1000 / fps)); f++) { ts += 1000 / fps; c.frame(ts); }
    return { fps, simSteps: c.simSteps, glowAtEnd: c.breathe(3.2) };
  });
  const spread = Math.max(...perRate.map((r) => r.simSteps)) - Math.min(...perRate.map((r) => r.simSteps));
  console.log(`  变异（accum += 1/60）三档 simSteps=${perRate.map((r) => `${r.fps}Hz:${r.simSteps}`).join(' ')} 极差=${spread}`);
  assert.ok(spread > 1, `阴性对照没红：变异后极差只有 ${spread}，说明这把尺是空跑的`);
  assert.ok(honestSpread <= 1 && spread > 1, '正尺绿 + 变异红 才是这一条要的配对');
  log('阴性对照', `accum += 1/60 → 极差 ${spread}（正尺 ${honestSpread}）⇒ 尺子真吃得到帧 dt`);
}

console.log(`shell.test 全绿：${checks} 组断言`);
