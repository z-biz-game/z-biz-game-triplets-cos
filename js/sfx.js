// 音效层。三条硬口径，都是「假静音/假暂停」最容易糊过去的地方：
//
// 1) **真静音**：muted 时 `tone()` 在创建任何节点之前就返回（`blocked++`，`nodes` 不涨），
//    并且把 AudioContext `suspend()` 掉。只把 gain 设 0 不算静音——振荡器还在建、
//    上下文还在跑，能耗和「有没有声音」两件事都没被这件事改变。
// 2) **懒建上下文**：浏览器要求音频必须在用户手势之后才允许起播。所以这里没有构造函数里的
//    new AudioContext()，第一次 unlock()（pointerdown/keydown/click）之后才有节点。
//    页面刚打开就静音的玩家可以安静地玩一整局，一个节点都不会建。
// 3) **可判**：nodes / played / blocked / suspendCalls / resumeCalls 五个计数器挂在实例上，
//    tests/shell.test.mjs 用假上下文（一个只实现这四个方法的桩）逐条断言。
//
// 音色就是三种符号的形状语言：方块低、圆圈中、三角高，笔记是两声短促的下滑，
// 判胜是那三个音的琶音。没有采样文件，全部由振荡器现算 —— 这个仓零运行时依赖的口径不破。

const defaultCreate = () => {
  const Ctor = typeof AudioContext !== 'undefined' ? AudioContext
    : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
  if (!Ctor) return null;
  return new Ctor();
};

// 每个音色：[频率, 时长, 波形, 峰值增益]
const VOICES = {
  place: [392.0, 0.075, 'triangle', 0.16],
  erase: [233.1, 0.06, 'sine', 0.13],
  note: [523.3, 0.045, 'square', 0.07],
  hint: [659.3, 0.09, 'triangle', 0.14],
  deny: [155.6, 0.1, 'sawtooth', 0.08],
  win: [523.3, 0.16, 'triangle', 0.18],
};

export class Sfx {
  constructor(createContext = defaultCreate) {
    this.createContext = createContext;
    this.ctx = null;
    this.muted = false;
    this.nodes = 0;      // 真实创建过的振荡器/增益节点数（静音态必须一格不涨）
    this.played = 0;     // 真的排出去的音
    this.blocked = 0;    // 因为静音/没解锁被挡掉的次数
    this.suspendCalls = 0;
    this.resumeCalls = 0;
    this.unlocked = false;
  }

  /** 用户手势里调一次：把上下文建起来并 resume。没有 WebAudio 的环境安静地什么都不做。 */
  unlock() {
    this.unlocked = true;
    if (this.muted) return null;
    const ctx = this._ensure();
    if (ctx && ctx.resume) { this.resumeCalls++; ctx.resume(); }
    return ctx;
  }

  _ensure() {
    if (this.ctx) return this.ctx;
    const ctx = this.createContext();
    this.ctx = ctx || null;
    return this.ctx;
  }

  /**
   * 播一个音色。静音或未解锁时**不建任何节点**，只把 blocked 抬一下。
   * @param {keyof typeof VOICES} name
   * @param {number} detune 半音偏移（三种符号落子时用来区分音高）
   */
  tone(name, detune = 0) {
    const voice = VOICES[name] || VOICES.place;
    if (this.muted || !this.unlocked) {
      this.blocked++;
      return false;
    }
    const ctx = this._ensure();
    if (!ctx || !ctx.createOscillator) { this.blocked++; return false; }
    const [freq, dur, type, peak] = voice;
    const t0 = ctx.currentTime || 0;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    this.nodes += 2;
    osc.type = type;
    osc.frequency.value = freq * Math.pow(2, detune / 12);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.4));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    if (ctx.destination && gain.connect) gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
    this.played++;
    return true;
  }

  /** 判胜的三音琶音：还是走 tone()，所以静音态同样一个节点都不建。 */
  fanfare() {
    return [0, 4, 7].map((semi) => this.tone('win', semi));
  }

  /**
   * 静音开关。true = 挂起上下文 + 之后不再建节点；false = 恢复。
   * @returns {boolean} 状态是否真的变了
   */
  setMuted(v) {
    const next = !!v;
    if (next === this.muted) return false;
    this.muted = next;
    if (!this.ctx) return true;
    if (next) {
      this.suspendCalls++;
      if (this.ctx.suspend) this.ctx.suspend();
    } else {
      this.resumeCalls++;
      if (this.ctx.resume) this.ctx.resume();
    }
    return true;
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** 页面切到后台/暂停时挂起，回来再放：省电，也让「暂停没声音」是真的。 */
  hold(on) {
    if (!this.ctx) return;
    if (on) { this.suspendCalls++; if (this.ctx.suspend) this.ctx.suspend(); }
    else if (!this.muted) { this.resumeCalls++; if (this.ctx.resume) this.ctx.resume(); }
  }

  get state() {
    return { muted: this.muted, unlocked: this.unlocked, nodes: this.nodes, played: this.played, blocked: this.blocked, ctxState: this.ctx ? this.ctx.state : 'none' };
  }
}

export const VOICE_NAMES = Object.keys(VOICES);
