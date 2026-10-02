// node 侧的 DOM 壳：只给 tests/ 那两套壳层测试用（浏览器那几趟归 tools/verify.sh + 真 Chrome）。
//
// 为什么要有这一份而不是「字符串里查一下有没有 addEventListener」：本目录要判的是**行为**——
// 暂停期间仿真一步都不走、静音态不建任何发声节点、重开把时钟与笔迹全部归零、
// 同一虚拟时长在 30/60/120Hz 下读到同一批数。这些都必须真喂事件、真喂 rAF 才量得出来。
//
// 三条口径：
//   1) 事件表是真的（addEventListener 存进 Map，fire() 逐条调用，capture 参数参与去重），
//      所以「装了监听但没人派发」这种假绿在这里会红。
//   2) requestAnimationFrame 不自己跑：由 pump() 按给定间隔手工喂，虚拟时钟从 START_MS 起
//      （从 0 起会被 js/fx.js 的首帧哨兵吃掉一帧，凭空造出 25ms 的假帧率依赖 —— 已踩过）。
//   3) AudioContext 桩把 suspend/resume 计了数：静音要能证明「真挂起 + 之后不建节点」，
//      只看 gain=0 是抓不住的。
const START_MS = 1000;

function classList(owner) {
  const s = new Set();
  return {
    add: (...c) => c.forEach((x) => s.add(x)),
    remove: (...c) => c.forEach((x) => s.delete(x)),
    toggle: (c, f) => { const w = f === undefined ? !s.has(c) : !!f; if (w) s.add(c); else s.delete(c); return w; },
    contains: (c) => s.has(c),
    _set: s,
    _owner: owner,
  };
}

function styleStub() {
  const p = {};
  return {
    _p: p,
    setProperty(k, v) { p[k] = String(v); },
    getPropertyValue(k) { return p[k] === undefined ? '' : p[k]; },
    removeProperty(k) { delete p[k]; },
  };
}

function ctx2d() {
  // 画布上下文：任何方法都存在（返回 undefined），属性可读写。绘制内容不参与这里的判断，
  // 像素与模型的一致性由 tools/verify.sh 在真 Chrome 里量。
  return new Proxy({ canvas: null }, {
    get: (o, k) => (k in o ? o[k] : (..._a) => undefined),
    set: (o, k, v) => { o[k] = v; return true; },
  });
}

function makeEl(id, tag = 'div') {
  const el = {
    id, tagName: tag.toUpperCase(), dataset: {}, attrs: {}, listeners: new Map(),
    style: styleStub(), classList: null, textContent: '', innerHTML: '', value: '',
    hidden: false, disabled: false, checked: false, children: [],
    width: 800, height: 800, clientWidth: 800, clientHeight: 800,
    tabIndex: 0, focused: false,
    getContext: () => el._ctx || (el._ctx = ctx2d()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: el.width, height: el.height, right: el.width, bottom: el.height }),
    addEventListener(type, fn, opts) {
      const cap = !!(opts === true || (opts && opts.capture));
      const list = el.listeners.get(type) || [];
      if (!list.some((h) => h.fn === fn && h.cap === cap)) list.push({ fn, cap });
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn, opts) {
      const cap = !!(opts === true || (opts && opts.capture));
      const list = (el.listeners.get(type) || []).filter((h) => !(h.fn === fn && h.cap === cap));
      el.listeners.set(type, list);
    },
    setAttribute(k, v) { el.attrs[k] = String(v); if (k === 'class') el.className = String(v); },
    getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
    removeAttribute(k) { delete el.attrs[k]; },
    hasAttribute(k) { return el.attrs[k] !== undefined; },
    append(c) { el.children.push(c); },
    appendChild(c) { el.children.push(c); return c; },
    replaceChildren(...n) { el.children = n; },
    focus() { el.focused = true; },
    blur() { el.focused = false; },
    scrollIntoView() { el.scrolledIntoView = true; },
    querySelector: () => null,
    querySelectorAll: () => [],
    parentElement: null,
    click() { fire(el, 'click', {}); },
  };
  el.classList = classList(el);
  return el;
}

// 派发一个事件：capture 组先跑（document 上的解锁监听就是 capture），冒泡组从 target 往 parentElement 走。
function fire(target, type, init = {}) {
  const ev = {
    type, target, currentTarget: target, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; },
    button: 0, clientX: 0, clientY: 0, key: '', bubbles: true, ...init,
  };
  const path = [];
  for (let n = target; n; n = n.parentElement) path.push(n);
  for (const node of path.slice().reverse()) {
    for (const h of node.listeners.get(type) || []) if (h.cap) h.fn(ev);
  }
  for (const node of path) {
    for (const h of node.listeners.get(type) || []) if (!h.cap) h.fn(ev);
  }
  return ev;
}

export function createDomEnv({ reducedMotion = false, pointer = true } = {}) {
  const ids = new Map();
  const el = (id, tag) => {
    if (!ids.has(id)) ids.set(id, makeEl(id, tag));
    return ids.get(id);
  };
  // HUD 上真实存在的那批 id（index.html 有，这里也必须有 —— 少一个就是「按钮引用了不存在的 id」）
  for (const id of ['board', 'board-wrap', 'win-veil', 'win-meta', 'state-line', 'sr-cell', 'size-select',
    'stat-face', 'stat-seed', 'stat-time', 'stat-paused', 'stat-givens', 'stat-placed', 'stat-notes',
    'stat-blank', 'stat-moves', 'stat-verify', 'stat-totals', 'btn-pause', 'btn-mute', 'btn-fullscreen',
    'btn-new', 'btn-again', 'btn-close-veil', 'btn-hint', 'btn-undo', 'btn-clear', 'btn-reset', 'btn-restart',
    'pen-square', 'pen-circle', 'pen-triangle', 'pen-note', 'pen-erase', 'brand-mark', 'app']) el(id);
  for (const [id, pen] of [['pen-square', '0'], ['pen-circle', '1'], ['pen-triangle', '2'], ['pen-note', 'note'], ['pen-erase', 'erase']]) {
    el(id).dataset.pen = pen;
  }
  const penButtons = ['pen-square', 'pen-circle', 'pen-triangle', 'pen-note', 'pen-erase'].map((i) => el(i));
  const root = el('html');
  const body = el('body');
  el('app').parentElement = body;
  el('board').parentElement = el('board-wrap');
  el('board-wrap').parentElement = el('view-game', 'section');
  el('state-line').parentElement = el('view-game');
  for (const n of penButtons) n.parentElement = el('modes');

  const mq = {
    matches: reducedMotion,
    media: '(prefers-reduced-motion: reduce)',
    listeners: [],
    addEventListener(t, fn) { if (t === 'change') mq.listeners.push(fn); },
    _set(v) { mq.matches = !!v; mq.listeners.forEach((fn) => fn({ matches: !!v })); },
  };

  const audio = { contexts: [], suspendCalls: 0, resumeCalls: 0, oscillators: 0, gains: 0 };
  function AudioContextStub() {
    const ctx = {
      state: 'running', currentTime: 0, sampleRate: 44100, destination: {},
      suspend() { ctx.state = 'suspended'; audio.suspendCalls++; return Promise.resolve(); },
      resume() { ctx.state = 'running'; audio.resumeCalls++; return Promise.resolve(); },
      createOscillator() {
        audio.oscillators++;
        return { type: 'sine', frequency: { value: 0, setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
      },
      createGain() {
        audio.gains++;
        return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
      },
      createBuffer() { return { getChannelData: () => new Float32Array(8) }; },
    };
    audio.contexts.push(ctx);
    return ctx;
  }

  const store = new Map();
  const doc = {
    documentElement: root, head: el('head'), body, hidden: false, fullscreenElement: null,
    getElementById: (id) => (ids.has(id) ? ids.get(id) : null),
    createElement: (tag) => makeEl('', tag),
    querySelector(sel) {
      if (sel === '.rules') return el('rules-list', 'ol');
      if (sel === '#app' || sel === '.topbar') return el('app');
      return null;
    },
    querySelectorAll(sel) { return sel === '.modes button' ? penButtons.slice() : []; },
  };
  // document 级监听挂在一个虚拟节点上（fire 的 capture/冒泡两趟都会走到它）
  const docNode = makeEl('#document');
  doc.addEventListener = (t, fn, o) => docNode.addEventListener(t, fn, o);
  doc.removeEventListener = (t, fn, o) => docNode.removeEventListener(t, fn, o);

  const raf = { queue: [], id: 0, now: START_MS };

  const win = makeEl('window');
  win.innerWidth = 1200;
  win.innerHeight = 900;
  win.devicePixelRatio = 2;
  win.matchMedia = () => mq;
  win.PointerEvent = pointer ? function PointerEvent() {} : undefined;
  if (!pointer) delete win.PointerEvent;
  win.requestFullscreenCalls = 0;
  const app = el('app');
  app.requestFullscreen = () => { app.requestFullscreenCalls = (app.requestFullscreenCalls || 0) + 1; doc.fullscreenElement = app; fire(docNode, 'fullscreenchange', { bubbles: false }); return Promise.resolve(); };
  app.webkitRequestFullscreen = undefined;
  doc.exitFullscreen = () => { doc.fullscreenElement = null; fire(docNode, 'fullscreenchange', { bubbles: false }); return Promise.resolve(); };

  const g = globalThis;
  g.document = doc;
  g.window = win;
  g.location = { href: 'https://localhost/', search: '', protocol: 'https:', hostname: 'localhost', pathname: '/' };
  g.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  g.matchMedia = () => mq;
  g.devicePixelRatio = win.devicePixelRatio;
  g.innerWidth = win.innerWidth;
  g.innerHeight = win.innerHeight;
  g.PointerEvent = win.PointerEvent;
  g.AudioContext = AudioContextStub;
  g.requestAnimationFrame = (fn) => { raf.queue.push(fn); return ++raf.id; };
  g.cancelAnimationFrame = (id) => { raf.queue = []; void id; };
  g.performance = g.performance || { now: () => raf.now };
  g.getComputedStyle = () => ({ display: 'block', getPropertyValue: () => '' });

  const env = {
    doc, win, el, app, mq, audio, raf, store, docNode, fire,
    // 手工喂 frames 帧，每帧推进 intervalMs（默认 1000/60）；时钟从 START_MS 起。
    pump(frames = 1, intervalMs = 1000 / 60) {
      for (let i = 0; i < frames; i++) {
        const due = raf.queue.splice(0, raf.queue.length);
        raf.now += intervalMs;
        for (const fn of due) fn(raf.now);
      }
      return raf.now;
    },
    key(k, init = {}) { return fire(docNode, 'keydown', { key: k, bubbles: false, ...init }); },
    pointerAt(clientX, clientY, button = 0) {
      fire(el('board'), 'pointerdown', { clientX, clientY, button });
      fire(el('board'), 'pointerup', { clientX, clientY, button });
    },
    read() { return g.window.triplets ? g.window.triplets.readout() : null; },
  };
  return env;
}

export const ENV_START_MS = START_MS;

// 固定随机种子（LCG）：对拍不许靠 Math.random，否则两趟跑的本来就不是同一局。
export function makeLcg(seed = 20261003) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
