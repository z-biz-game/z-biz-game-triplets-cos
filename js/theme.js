// 颜色、间距、动效的唯一来源。样式表通过 applyThemeVars() 读这些值，canvas 读的是同一批对象，
// 所以改一个令牌不可能只改到一边。
//
// 这一组的**取样色**（field / tintA / tintB / gridLine / border / given / player / note）都是
// 被门禁量过的：tools/scenarios.js 的 boot 场景逐条共边取中点切片、render 场景逐格取字形探针，
// 比的就是这里写的值。
//
// 可分性口径：countNear 用的是「三个通道**同时**落在 ±tol 内才算同色」（切比雪夫距离），
// 所以两种色只要有一个通道拉开 > tol 就不会互相冒充。本轮实测：这九色的最小 L∞ 距离 = 18
// （field ↔ gridLine 与 tintA ↔ tintB 两对同紧），取 tol = 8 ⇒ 每一对都留着两倍余量
// （这条数由 boot 场景的 palette 断言在浏览器里逐对重算，改了色值它自己会红）。
// ⚠ 改任何一个色都要重跑 `bash tools/verify.sh` 的 boot/render 两条腿，不要只看效果图。
export const Palette = {
  bgTop: '#070A14',
  bgBottom: '#121A2C',
  surface: '#0F1526',
  surfaceLift: '#182036',
  line: '#243050',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // ── 盘面色（只有这些会进画布，所以门禁可以在像素上把它们一一对上号）──────────────
  // 盘子最底下那一层：只在 pad 留白和圆角外面露出来，任何一格都不许是它。
  field: '#121B2E',
  // 区域底纹的两档。它只负责「一眼看出这几格是一伙的」的**辅助**线索：真正说这句话的是
  // border 那一圈轮廓线（见下），因为区域邻接图按贪心着色最多要 6 色（本轮实测 84 盘），
  // 两档底纹必然出现相邻同色——所以门禁只断「同一区三格同色 + 全盘至少两档都出现」，
  // 同色相邻的对数作为读数披露，不当红线（详见 README 的第二阶段那一节）。
  tintA: '#1C2740',
  tintB: '#223052',
  // 同区域内部的细分隔线（格还是格，但不说明分组）。它比两档底纹都暗，所以只会出现在
  // 格的边界上；与 field 的 L∞ 距离 18，是全表最紧的一对，tol 不许往上加。
  gridLine: '#0A0F1C',
  // **跨区域边界**：这一圈的有无就是分组的全部证据。每一条两格分属不同区域的共边都画它，
  // 每一条同区共边都不画它 ⇒ 门禁两腿都能红（画出格轮廓 = 负腿红，什么都不画 = 正腿红）。
  border: '#4E74C8',
  // 题面给的符号（玩家的和给的分色，否则「换一局换了什么」在屏幕上读不出来）。
  given: '#F2F5FB',
  // 玩家（或提示）落下的符号。**独占色**：一笔没画时全画布这个颜色的像素必须是 0，
  // 这一条抓的是答案泄漏——渲染层没有任何一条路能读到 solution。
  player: '#2ED573',
  // 候选笔记（铅笔删剩的那些符号，画成小 glyph）。它既不是题面给的也不是落定的。
  note: '#B8A88F',

  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  info: '#7BB8FF',
  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
};

// 门禁在像素上比的是**三个通道**（countNear 的切比雪夫距离），画布吃的却是 CSS 串，
// 所以这层转换只有这一处：Palette 仍然是唯一的色源，两边不可能长成两份不同的表。
// 非 # 开头的令牌（rgba 那些是页面用的，不进画布）当场抛——宁可红在这里，
// 也不要让 NaN 变成一条「量到了但没匹配上」的假阴性。
export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(s)) throw new Error(`不是 #rrggbb 的色令牌：${hex}`);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 18, button: 12, chip: 8, cell: 4 };

export const Font = {
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

export const Motion = {
  tap: 150,
  base: 220,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// 几何令牌：draw 与门禁取样**只有这一批数**（改了粗细，取样点跟着走，不会量到线外）。
// glyph / probe / note 三个数是字形形状证据的地基，口径写在 js/render/board.js 的 glyphProbe 上。
export const Board = {
  cellMin: 34,
  cellMax: 74,
  pad: 14,
  // 区域轮廓：宽度按格边长比例，最小 3 CSS px（见 board.js 的 edgeBand）。门禁的取样带是
  // 1 CSS px 钉在共边正中，所以描边最窄也要把它整条包住，两边各留 ≥1 CSS px 给抗锯齿。
  borderWidth: 0.085,
  // 字形半径 0.27 格 ⇒ 方块半边 0.27、圆半径 0.24、三角底边半宽 0.32 / 半高 0.28。
  squareHalf: 0.27,
  circleR: 0.24,
  triHalf: 0.32,
  triHalfHeight: 0.28,
  // 形状探针的四个对角偏移（口径与五种命中模式见 js/render/board.js 的 glyphProbe）。
  // 四笔余量（cellMin=34 处，CSS px，2026-09 量出来的）：方块角 1.70（最紧）、
  // 圆对角 2.42、三角下边两点 2.24（内）、三角上边两点 6.31（外）。
  // 全部大于一个取样像素 ⇒ 命中不依赖抗锯齿的边缘那一格。
  probe: 0.22,
  noteR: 0.1,
  noteSlot: 0.3,
};

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) root.setProperty('--' + kebab(k), v);
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

let motionReduced = false;
export function setReduceMotion(v) {
  motionReduced = !!v;
}
export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
