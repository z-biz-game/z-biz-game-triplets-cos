// 帧时钟：把「墙钟 dt」换成「定步长的仿真步」，这是全仓唯一一处吃帧 dt 的地方。
//
// 为什么要有这一层：HUD 的秒表、盘外那圈光晕、静音指示都是**随时间连续变化**的量。
// 直接写 `x += 0.016666` 只在 60Hz 成立，写 `x += dt` 又让每一帧的步长都不一样——
// 30/60/120Hz 下同一虚拟时长会走出不同的数。所以这里照 wave-collapse 的口径做定步长累加：
//   帧 dt 只进 `simAccumulator += dt` 这一行；
//   所有连续量都从 `simTime`（= simSteps × step）读，步长恒定 ⇒ 同一虚拟时长同一批数。
// ⚠ 上面那行累加器就是**阴性对照的靶子**：把它改成 `+= 1/60`，30/120Hz 的 simTime 立刻
//   与 60Hz 分家（tests/shell.test.mjs 里那一发变异就是这么打的，改完必须变红）。
//
// 两个已经踩过坑的口径也钉在这里：
//   · `lastTs < 0` 是「第一帧只记起点、不记位移」的哨兵，所以喂时钟不许从 0 起步
//     （沙箱/探针都从 1000ms 起，从 0 起步会被这个哨兵吃掉一帧、凭空造出 25ms 的假依赖）；
//   · 单帧 dt 上限 maxFrameDt：标签页切回来那一帧可能是几十秒，不封顶就会把光晕推到
//     几百步之外，读数没法看。封顶之后同一虚拟时长的步数仍然一致，只是补帧被截断。
//
// 暂停：`paused` 为真时**一帧都不推进**（simTime / simSteps 全冻住），恢复后接着走。
// 本文件不碰 DOM、不碰 requestAnimationFrame，所以 node 里可以直接喂假时钟对拍。

export const SIM_STEP = 1 / 120; // 定步长（秒）：120Hz 一帧一步，30Hz 一帧四步

export class FrameClock {
  constructor({ step = SIM_STEP, maxFrameDt = 0.25 } = {}) {
    this.step = step;
    this.maxFrameDt = maxFrameDt;
    this.simAccumulator = 0;
    this.simSteps = 0;
    this.simTime = 0;
    this.frames = 0;
    this.pausedFrames = 0;
    this.paused = false;
    this.lastTs = -1;
  }

  /**
   * 喂一帧。ts 是 rAF 的 timestamp（毫秒，单调）。
   * @returns {number} 这一帧走了几个定步长（暂停或被哨兵吃掉那一帧返回 0）
   */
  frame(ts) {
    if (!Number.isFinite(ts)) return 0;
    if (this.lastTs < 0) {
      this.lastTs = ts;
      return 0;
    }
    let dt = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    this.frames++;
    if (dt < 0) dt = 0;
    if (dt > this.maxFrameDt) dt = this.maxFrameDt;
    if (this.paused) {
      this.pausedFrames++;
      return 0;
    }
    this.simAccumulator += dt;
    let steps = 0;
    while (this.simAccumulator >= this.step) {
      this.simAccumulator -= this.step;
      this.simTime += this.step;
      this.simSteps++;
      steps++;
    }
    return steps;
  }

  /**
   * 重开 / 换一局：把这一台钟彻底归零。
   * 少清一样都会说谎 —— 漏了 simTime 就是「新局从上一局的时间接着走」，
   * 漏了累加器就是「同一虚拟时长在新局上多算出半步」，漏了 lastTs 就是把首帧哨兵留在那儿。
   */
  reset({ paused = false } = {}) {
    this.simAccumulator = 0;
    this.simSteps = 0;
    this.simTime = 0;
    this.frames = 0;
    this.pausedFrames = 0;
    this.paused = !!paused;
    this.lastTs = -1;
    return this;
  }

  setPaused(v) {
    const next = !!v;
    if (next === this.paused) return false;
    this.paused = next;
    return true;
  }

  pause() { return this.setPaused(true); }
  resume() { return this.setPaused(false); }

  /** 虚拟时长读数（秒）：所有连续量的唯一时间源。 */
  get time() { return this.simTime; }

  /**
   * 0..1 的呼吸量，由 simTime 推出：帧率无关（同一虚拟时长同一值），暂停时冻住。
   * @param {number} periodSec 周期
   */
  breathe(periodSec = 3.2) {
    const p = Math.max(0.25, periodSec);
    const phase = (this.simTime % p) / p;
    return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  }
}
