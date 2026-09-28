// 浏览器里的场景套件，由 tools/playtest.cjs 注入真实页面后跑。七个场景：
//   boot / render / play / sizes / reproof / resume-set / resume-check
//
// 这里只认三种证据：DOM 的矩形与文本、画布的像素、真指针事件打进去之后的读数。
// `.hidden=false` 说的是代码想干什么，一个零矩形 + elementFromPoint 打到画布上才是玩家看见了什么；
// 「st.cand[7]===1」说的是模型，格子里那颗 ■ 的像素才是屏幕。
// 这个仓最容易出的事故恰好是「引擎里对、屏幕上错」：区域轮廓少画一条共边（玩家看到的是一堆
// 没有分组意义的格子）、参考解偷偷漏到盘上、胜利卡片 display:grid 盖掉了 [hidden] 还在吃点击。
//
// 两批坐标绝不能混：
//   · getImageData 要的是**画布本地 CSS 坐标 × dpr**，一律由 view.cellRect / view.glyphProbe /
//     view.sharedEdgeSlice / view.noteSlotPos 产出（它们和 draw 用的是同一批数）。拿 client 坐标
//     去喂，会量到整个盘宽之外的面板底色上，然后「量」出一个绿。
//   · PointerEvent / elementFromPoint / view.hitCell 要的是 client 坐标，所以走 clientOf()
//     （加了 canvas.getBoundingClientRect() 的偏移）。
//
// 断言的**条数**是被算过的：每一条都要配一张「把哪一行改坏它就红」的变异证据（写在 commit
// message 里）。verify.sh 刻意不放断言、也不放变异表，它只管生命周期。
// 这里一行就是一句话，合得上就合、合不上就删——写不出变异证据的断言不留。
//
// window.triplets.engine 就是玩家加载的那张模块图，所以这里绿一次，等于页面那侧的出题器/
// 铅笔/判胜同时绿一次。reproof 场景另用 `import(new URL('js/engine/…', document.baseURI))`
// 走一遍**服务出来的 URL**：Pages 子路径下只要有任何一个写死的 `/` 路径，这里就先红。
// 夹具全部来自 tools/golden.mjs 的冻结数据，由 playtest.cjs 随本文件一起带进页面
// （Pages 只发 index.html/css/js，答案不上线，页面也不该去线上 fetch 它）。
//
// ⚠ 游玩路径读冻结的 fill 只用来「算出屏幕上该点哪一格、该换哪支笔」；测试没有任何一条路把
//   答案写进模型（界面的写入口只有 Game.place / erase / toggleNote 三个）。所以
//   「少填一格就不赢」量的确实是玩家的笔，不是测试替玩家落笔。

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 注入得比 app 的模块执行还早，所以这两个收集器能抓到启动期的异常
  const errs = [];
  w.addEventListener('error', (e) => errs.push(`${e.message} @ ${e.filename || ''}:${e.lineno || 0}`));
  w.addEventListener('unhandledrejection', (e) => errs.push(`rejection: ${e && e.reason}`));
  w.__tripletsErrs = errs;

  const A = () => w.triplets;
  const E = () => w.triplets.engine;
  const BT = () => w.triplets.boardTokens;
  const $ = (sel) => document.querySelector(sel);
  const text = (sel) => (($.call(document, sel) || {}).textContent || '').trim();
  const num = (sel) => Number(text(sel).replace(/[^\d.+-]/g, '') || '0');
  const C = () => A().view.colors();

  // 读一个色成 [r,g,b]。两种写法都得能读：画布/Palette 那一侧是 '#4E74C8'，
  // 而 getComputedStyle 会把 var(--border) 归一化成 'rgb(78, 116, 200)'。
  // 只认 hex 的那一版会拿 'rg'、'(,' 去 parseInt，读出 [NaN,…] —— 于是「图例色块与画布同数」
  // 永远红，红的还是一句读不出来的话，指不到真正的色差。
  const rgb = (val) => {
    const s = String(val).trim();
    const m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) return m[1].split(/[,/\s]+/).filter(Boolean).slice(0, 3).map((x) => Math.round(Number(x)));
    const h = s.replace('#', '');
    const t = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
  };
  const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const show3 = (a) => `[${a[0]},${a[1]},${a[2]}]`;
  const linf = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

  // ---- 画布本地坐标取样（CSS 像素 × dpr，全部经 view 的几何函数）----------------
  const sample = (pt) => A().view.pixelAt(pt.x, pt.y);
  const countNear = (colorArr, tol, rect) => A().view.countNear(colorArr, tol == null ? 8 : tol, rect);
  // 取样带在设备上占几个像素：和 countNear 一样按 dpr 取整，两条腿才用同一批数
  const sliceArea = (r) => {
    const d = A().view.geo.dpr;
    return Math.round(r.w * d) * Math.round(r.h * d);
  };

  // ---- 真指针（client 坐标）----------------------------------------------------
  function clientOf(lx, ly) {
    const b = A().view.canvas.getBoundingClientRect();
    return { x: b.left + lx, y: b.top + ly };
  }
  function pointer(type, x, y, button) {
    A().view.canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button,
        buttons: type === 'pointerdown' ? (button === 2 ? 2 : 1) : 0,
        clientX: x,
        clientY: y,
      })
    );
  }
  // 点一格的正中：左键 button=0（当前那支笔），右键 button=2（擦掉）
  async function tapCell(cell, button = 0) {
    const c = A().view.centerOf(cell);
    const p = clientOf(c.x, c.y);
    pointer('pointerdown', p.x, p.y, button);
    pointer('pointerup', p.x, p.y, button);
    await wait(8);
    return true;
  }
  async function clickSel(sel) {
    const el = $(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    el.click();
    await wait(30);
    return true;
  }
  const PEN_BTN = ['square', 'circle', 'triangle'];

  // ---- 等页面真的把一局开出来（出题是异步的：抽卡要时间）------------------------
  async function ready(timeoutMs = 240000) {
    const t0 = Date.now();
    for (;;) {
      const a = w.triplets;
      if (a && a.game && a.state === 'ready' && !a.busy) return a;
      if (a && a.state === 'failed') throw new Error('页面报称这一档开不出局：' + text('#state-line'));
      if (Date.now() - t0 > timeoutMs) throw new Error('页面一直没 ready（state=' + (a && a.state) + '）');
      await wait(60);
    }
  }

  // 夹具不靠页面去 fetch：tools/ 不在 Pages 的部署名单里（答案不能上线），线上那趟 fetch
  // 只会拿到 404，然后把 play / resume 两条腿一起变成「少跑了几条断言的绿色」。
  // __tripletsGolden 由驱动器在文档建立之前就装好，所以三个 URL 形态吃的是同一批冻结字节。
  let goldenMod = null;
  const golden = async () => {
    if (goldenMod) return goldenMod;
    if (typeof w.__tripletsGolden !== 'function') {
      throw new Error('页面上没有 __tripletsGolden —— 这个场景必须由 tools/playtest.cjs 注入跑（它把 tools/golden.mjs 一起带进来）');
    }
    goldenMod = await w.__tripletsGolden();
    return goldenMod;
  };

  // 引擎模块走**服务出来的 URL**（document.baseURI 解析），不是走 window 上的那份引用：
  // reproof 那一步要的是「独立 import 一遍引擎再重证」，顺带证明 Pages 子路径下这条相对路径打得开。
  const modCache = {};
  async function eng(rel) {
    if (!modCache[rel]) modCache[rel] = await import(new URL(rel, document.baseURI).href);
    return modCache[rel];
  }

  // ---- 题面从 DOM 上收（不是从 window.triplets.game 的对象图里摘）---------------
  // 门禁要重证的是「屏幕上这一张盘」，所以 reg/givens 必须从 canvas.dataset 读回来。
  async function faceFromDom() {
    const d = $('#board').dataset;
    const G = await golden();
    const raw = { w: Number(d.w), h: Number(d.h), reg: d.reg, givens: d.givens };
    return {
      w: raw.w,
      h: raw.h,
      n: Number(d.n),
      regions: Number(d.regions),
      cell: Number(d.cell),
      reg: G.regOf(raw),
      givens: G.givensOf(raw),
      regStr: d.reg,
      givensStr: d.givens,
      fpDom: d.fp,
      fpCalc: G.fingerprintOf(raw),
    };
  }

  // ---- 形状签名：五点探针按 [tl, tr, bl, br, c] 顺序读成五位 ----------------------
  // 口径来自 js/render/board.js 的 glyphProbe（■=11111 / ●=00001 / ▲=00111 / 空=00000）。
  const SHAPE = { '-1': '00000', 0: '11111', 1: '00001', 2: '00111' };
  function shapeOf(cell, wantRgb) {
    const v = A().view;
    const p = v.glyphProbe(cell);
    const hit = (pt) => (near(sample(pt), wantRgb, 12) ? '1' : '0');
    return [p.tl, p.tr, p.bl, p.br, p.c].map(hit).join('');
  }

  const veilInfo = () => A().veilInfo();

  function expectFromHash() {
    const h = String(location.hash || '');
    if (!h.startsWith('#expect=')) return null;
    try {
      return JSON.parse(decodeURIComponent(h.slice('#expect='.length)));
    } catch {
      return null;
    }
  }

  // 结构纪律的 grep 口径：**只剥整行注释**（行首只有空白 + `//`），其余字节一个都不动。
  // 为什么只剥这种：board.js 顶上那条纪律说明自己写着「本文件不许出现答案」，
  // 逐行 grep 会把这句宣言当成泄漏——那不是证据，是一条永远不会为真的「红灯」。
  // 行尾注释、字符串、真代码全部保留：`const leak = made.solution // 答案` 这种照样命中。
  const stripLineComments = (s) => s.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
  const ANSWER_SRC = '\\bsolution\\b|\\.solution|\\bfullGrid\\b|applyDeduction|advance\\(';
  const answerRe = new RegExp(ANSWER_SRC); // 判定用（不带 g：带 g 的 .test 会跟着 lastIndex 走）
  const answerReAll = new RegExp(ANSWER_SRC, 'g'); // 读数用：把命中的到底是哪几个字印出来
  const answerHitsIn = (name, src) => {
    const hits = stripLineComments(src).match(answerReAll) || [];
    return hits.length ? `${name}=${hits.join('/')}` : '';
  };
  const PAGE_SRC = ['js/main.js', 'js/ui/game.js', 'js/render/board.js', 'js/store.js', 'js/theme.js'];

  // 逐格把盘面数一遍（只读界面那三个入口给的东西 + 引擎的 candidatesOf）
  const faceCounts = (g) => {
    let placed = 0;
    let notes = 0;
    let blank = 0;
    for (let i = 0; i < g.n; i++) {
      if (g.isGiven(i)) continue;
      if (g.st.placed[i]) placed++;
      else if (g.st.cand[i] !== E().ALL) notes++;
      else blank++;
    }
    return { placed, notes, blank };
  };

  // ==========================================================================
  // boot：开屏画面真画出来了 + 答案没漏 + 每一格都点得到自己
  // ==========================================================================
  async function boot() {
    const a = await ready();
    const g = a.game;
    const v = a.view;
    const rect = v.canvas.getBoundingClientRect();
    const d = v.canvas.dataset;

    ck('boot:启动无未捕获异常，并且开出了菜单里的一局', errs.length === 0 && a.state === 'ready' && !!g && E().SIZES.includes(g.sizeKey),
      `异常=${errs.slice(0, 2).join(' | ')} state=${a.state} 档=${g && g.sizeKey} 菜单=${E().SIZES.join('/')}`);

    // DOM 里的盘面几何 == 引擎几何，而且后备缓冲 = CSS 尺寸 × dpr。
    // 这一条不成立时，下面所有取到的像素都是插值出来的假数。
    const nRegions = new Set(Array.from(g.reg)).size;
    ck(
      'boot:DOM 几何与引擎同数（w/h/n/区域数/格边长/后备缓冲×dpr）',
      d.w === String(g.w) && d.h === String(g.h) && d.n === String(g.n) && d.regions === String(nRegions) &&
        Number(d.cell) === v.geo.cell && v.geo.cell >= BT().cellMin && v.geo.cell <= BT().cellMax &&
        Math.abs(v.canvas.width - Math.round(rect.width * v.geo.dpr)) <= 1 &&
        Math.abs(v.canvas.height - Math.round(rect.height * v.geo.dpr)) <= 1,
      `dataset=${JSON.stringify(d)} 引擎=${g.w}x${g.h} n=${g.n} 区域=${nRegions} 格=${v.geo.cell} backing=${v.canvas.width}x${v.canvas.height} css=${rect.width.toFixed(1)}x${rect.height.toFixed(1)} dpr=${v.geo.dpr}`
    );

    // 区域必须是三格的：题面的定义就在这一条上（nr*3 === n）。DOM 上的区域数也要自洽。
    ck('boot:每一块区域恰好三格（nr×3 = 格数，且题面区域号连续）', nRegions * 3 === g.n && d.regions === String(nRegions) && (() => {
      for (let i = 0; i < g.n; i++) if (!(g.reg[i] >= 0 && g.reg[i] < nRegions)) return false;
      return true;
    })(), `区域数=${nRegions} 格数=${g.n} 区域号=${Array.from(new Set(Array.from(g.reg))).sort((x, y) => x - y).join(',')}`);

    // 盘底 / 格线 / 区域轮廓 / 题面符号，四样都真的在像素里
    const nField = countNear(C().field, 8);
    const nGrid = countNear(C().gridLine, 8);
    const nBorder = countNear(C().border, 8);
    const nGiven = countNear(C().given, 8);
    ck('boot:盘面画出来了（盘底/格线/区域轮廓/题面符号都在像素里）',
      nField > rect.width * rect.height * 0.05 && nGrid > 200 && nBorder > 200 && nGiven > 40,
      `field=${nField} gridLine=${nGrid} border=${nBorder} given=${nGiven}（画布 ${Math.round(rect.width)}×${Math.round(rect.height)}）`);

    // 盘底必须**铺满盘子**。上面那条是按面积数像素的：roundRect 少一条 arcTo 时 fill() 并不
    // 报错，它只是把一角留成透明——几十万 field 色像素照样能过比例阈值。
    // 探针钉在**每一格**的左上角内侧（离共边 ≥0.12 格，离字形 ≥0.13 格），必须是底色之一。
    const tintBad = [];
    for (let i = 0; i < g.n; i++) {
      const r = v.cellRect(i);
      const k = v.geo.cell;
      const got = sample({ x: r.x + k * 0.12, y: r.y + k * 0.12 });
      if (!near(got, v.tintRgb(g.reg[i]), 8)) tintBad.push(`${i}=${show3(got)} 想要 ${show3(v.tintRgb(g.reg[i]))}`);
    }
    ck('boot:每一格左上角取到的都是那一号的底色（底纹铺满、没有透明楔）', tintBad.length === 0, tintBad.slice(0, 6).join(' '));

    // ⚠ 答案没漏①：一笔没画时整张画布上 player 色像素必须为 0。
    // 这个颜色在盘上是独占的：只有玩家（或提示）落下的那一笔用它画（见 js/render/board.js 文件头）。
    const nPlayer = countNear(C().player, 8);
    const c0 = faceCounts(g);
    ck('boot:未落笔时 player 色像素为 0（答案没漏到盘上）', nPlayer === 0 && c0.placed === 0 && c0.notes === 0,
      `player=${nPlayer} placed=${c0.placed} notes=${c0.notes}`);

    // ⚠ 答案没漏②：发出去的 UI 字节里没有答案字段，也没有绕开撤销栈的原地推进函数
    const srcs = {};
    for (const rel of PAGE_SRC) srcs[rel] = await (await fetch(new URL(rel, document.baseURI).href)).text();
    const appSrc = Object.values(srcs).map(stripLineComments).join('\n');
    const hitWhere = PAGE_SRC.map((rel) => answerHitsIn(rel, srcs[rel])).filter(Boolean).join(' ');
    ck('boot:UI 一侧拿不到答案也没有绕过撤销的原地推进',
      !answerRe.test(appSrc) && g.st.solution === undefined && g.puzzle === undefined && !('fill' in g) && !('answer' in g),
      `源码命中=${hitWhere || '无'} game.keys=${Object.keys(g).join(',')} st.keys=${Object.keys(g.st).join(',')}`);

    // 命中盒先行：每一格的正中 + 四个对角探针 + 四个内缩角点都点得到自己，
    // 而且那一点上最上方的元素真是 canvas（hidden 的覆盖层没在吃点击）——先证明控件到得了，
    // 之后才有资格说「点不动」是谁的锅。
    const missed = [];
    const occluded = [];
    for (let i = 0; i < g.n; i++) {
      const pts = [v.centerOf(i), ...Object.values(v.glyphProbe(i))];
      const r = v.cellRect(i);
      const m = Math.min(4, r.size * 0.12);
      pts.push({ x: r.x + m, y: r.y + m }, { x: r.x + r.size - m, y: r.y + m }, { x: r.x + m, y: r.y + r.size - m }, { x: r.x + r.size - m, y: r.y + r.size - m });
      for (const pt of pts) {
        const p = clientOf(pt.x, pt.y);
        if (v.hitCell(p.x, p.y) !== i) {
          missed.push(`${i}→${v.hitCell(p.x, p.y)}`);
          break;
        }
      }
      const c = clientOf(v.centerOf(i).x, v.centerOf(i).y);
      const top = document.elementFromPoint(c.x, c.y);
      if (top !== v.canvas) occluded.push(`${i}→${top ? top.id || top.tagName : 'null'}`);
    }
    ck(`boot:命中盒先行——${g.n} 格每一格在她画出来的盒子里都点得到自己（正中/四对角/四内缩角）`,
      missed.length === 0 && occluded.length === 0,
      `点不到/点错格的取样点：${missed.slice(0, 6).join(' ')}；被别的元素挡住的：${occluded.slice(0, 6).join(' ')}`);

    const unhittable = ['#btn-new', '#btn-hint', '#btn-undo', '#btn-clear', '#pen-note', '#pen-erase', '#size-select'].filter((sel) => {
      const el = $(sel);
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 16) return true;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !(top === el || el.contains(top));
    });
    ck('boot:七个控件都在最上层且矩形非零', unhittable.length === 0, `点不到的控件：${unhittable.join(',')}`);

    // hidden 的那张胜利卡片必须真的既不画也不吃点击（display/矩形/elementFromPoint 三样一起看）
    const vi = veilInfo();
    ck('boot:未开局时胜利遮罩是隐藏的（display:none、零矩形、盘中心打到的是画布）',
      vi.hidden === true && vi.display === 'none' && vi.rect.w === 0 && vi.rect.h === 0 && vi.hitsVeil === false && vi.hitId === 'board',
      `veil=${JSON.stringify(vi)}`);

    // 调色板分离度：画布上会同时出现的九种颜色，两两 L∞ 必须 > 2×tol（tol=8 ⇒ >16）。
    // 这条是**下面所有「按颜色数像素」断言的地基**：两色一旦可混，countNear 的读数就没有意义。
    const named = { ...C(), tintA: C().tint[0], tintB: C().tint[1] };
    delete named.tint;
    const keys = Object.keys(named);
    let minSep = Infinity;
    let minPair = '';
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const s = linf(named[keys[i]], named[keys[j]]);
        if (s < minSep) {
          minSep = s;
          minPair = `${keys[i]}+${keys[j]}`;
        }
      }
    }
    ck('boot:画布上九种颜色的分离度 ≥ 17（按颜色数像素的前提成立）', minSep >= 17, `最紧的一对是 ${minPair} L∞=${minSep}（tol=8）`);

    // 图例的颜色和画布用的是同一批数（CSS 与 canvas 不会长成两个不同游戏的调色板）
    const swatchBad = [];
    for (const [sel, key] of [['.sw-border', 'border'], ['.sw-grid', 'gridLine'], ['.sw-given', 'given'], ['.sw-player', 'player'], ['.sw-note', 'note']]) {
      const el = $(sel);
      if (!el) {
        swatchBad.push(`${sel} 不存在`);
        continue;
      }
      const got = rgb(getComputedStyle(el).backgroundColor);
      if (!near(got, C()[key], 2)) swatchBad.push(`${sel}=${show3(got)} 画布=${show3(C()[key])}`);
    }
    ck('boot:图例色块与画布取色同数', swatchBad.length === 0, swatchBad.join(' '));

    // seed 的形状：可以直接敲回来，而且不是日期派生的（真正的可复现性由 play/reproof 两条腿证）
    const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    ck('boot:默认 seed 可以直接敲回来，且不含今天/本年（不是日期派生）',
      /^[A-Za-z0-9#._:-]+$/.test(g.seed) && g.seed.indexOf(today) === -1 && g.seed.indexOf(String(new Date().getFullYear())) === -1 && g.seed.length <= 40,
      `seed=${g.seed} 今天=${today}`);

    return report({ board: { w: g.w, h: g.h, n: g.n, regions: nRegions, cell: v.geo.cell, dpr: v.geo.dpr, seed: g.seed, fp: g.fp }, errs: errs.slice(0, 2), minSep, givenPx: nGiven, playerPx: nPlayer });
  }

  // ==========================================================================
  // render：落一笔之后，屏幕、DOM 读数与引擎状态三者一致
  // ==========================================================================
  async function render() {
    const a = await ready();
    const g = a.game;
    const v = a.view;
    const playerRgb = C().player;
    const givenRgb = C().given;

    // 三种字形各挑一个「不在区域轮廓上、也不在盘边缘」的空格来点，免得一笔盖住另一笔的取样点
    const free = g.blankCells();
    const pick = [];
    for (const i of free) {
      if (pick.length >= 3) break;
      if (pick.some((p) => Math.abs((p % g.w) - (i % g.w)) + Math.abs(Math.floor(p / g.w) - Math.floor(i / g.w)) < 2)) continue;
      pick.push(i);
    }
    ck('render:盘上有可写的空格（题面没把整盘填满）', pick.length === 3 && free.length >= 3, `空格=${free.length} 挑到=${pick.length}`);

    // ⚠ Game.counts() 里**没有** moves 这一项（步数是 g.moves，两份账不是一回事），
    // 所以这里把起点单独记下来。下面那条「题面给的格子改不动」要验的步数是**数出来的**：
    // 三笔落子（pick 0/1/2）+ 两笔笔记（翻掉再翻回）+ 一次右键擦掉 = 6 组，
    // 而 given 那两笔（左键改、右键擦）一组都不许添。
    const movesAtStart = g.moves;
    const sigs = [];
    for (let k = 0; k < 3; k++) {
      const cell = pick[k];
      await clickSel('#pen-' + PEN_BTN[k]);
      await tapCell(cell, 0);
      const got = shapeOf(cell, playerRgb);
      sigs.push(got);
      ck(`render:${['■ 方块', '● 圆圈', '▲ 三角'][k]}那一笔：屏幕上形状签名对、颜色是 player、引擎状态里就是它、DOM +1`,
        got === SHAPE[k] && g.symbolAt(cell) === k && g.st.cand[cell] === (1 << k) && !g.isGiven(cell),
        `签名=${got} 想要=${SHAPE[k]} symbolAt=${g.symbolAt(cell)} 想要=${k} cand=${g.st.cand[cell]}`);
    }
    ck('render:三种字形的形状签名互不相同（像素能把它们认出来）', new Set(sigs).size === 3, `签名=${sigs.join('/')}`);

    // 读数三方一致：DOM 文本 = verify 那一份 st 数出来的 = 逐格数出来的
    const c = faceCounts(g);
    const cnt = g.counts();
    ck('render:DOM 读数与界面 counts() 与逐格数出来同数（placed/notes/blank）',
      num('#stat-placed') === cnt.placed && cnt.placed === c.placed && num('#stat-notes') === cnt.notes && cnt.notes === c.notes &&
        num('#stat-blank') === cnt.blank && cnt.blank === c.blank && num('#stat-givens') === cnt.given &&
        num('#stat-moves') === g.moves && cnt.placed + cnt.notes + cnt.blank + cnt.given === g.n,
      `DOM=${text('#stat-placed')}/${text('#stat-notes')}/${text('#stat-blank')}/${text('#stat-givens')} counts=${JSON.stringify(cnt)} 逐格=${JSON.stringify(c)} n=${g.n}`);

    // 「一笔落进引擎」的往返：屏幕上的形状来自 st.cand，st.cand 又只由 Game.place 改；
    // 这里额外用引擎自己的 candidatesOf 读一遍（界面 re-export 的那一个，不是第二份实现）
    const rt = pick.map((i) => E().candidatesOf(g.st, i));
    ck('render:落子真的往返进了引擎状态（candidatesOf 读回单一候选，symbolOf 同数）',
      rt.every((m, i) => (m & (m - 1)) === 0 && m === (1 << i)) && pick.every((i, k) => E().symbolOf(g.st, i) === k),
      `掩码=${rt.join('/')} 想要=1/2/4`);

    // 笔记那支笔：翻掉一个候选 → 那一槽的小 glyph **像素没了**、另两槽还在、DOM +1。
    // ⚠ 取样必须按槽取，不能「数一分数格里的 note 色」：删掉 ■ 之后 ●▲ 还在原地 ⇒
    //   整格计数照样 >0，那一条断言就永远是空的。
    // ⚠ 「没记」在屏幕上的定义是**三槽都空**（口径见 js/render/board.js 第 5 步：候选全在 =
    //   这格什么都没记，必须读起来是空的）。所以翻之前与翻回来之后都断 0，而不是断「三槽都有墨」：
    //   后者会把「每一格都画三个候选」这种画法当成正确，而那正好让 #stat-notes（数的是
    //   cand!==ALL 的格）与屏幕各说一套，还会让 resume 那条「note 色像素>0」恒真。
    const noteCell = free.find((i) => !pick.includes(i));
    await clickSel('#pen-note');
    const notesBefore = g.counts().notes;
    const slotR = (cell, sym) => {
      const p = v.noteSlotPos(cell, sym);
      return { x: p.x - p.r - 1, y: p.y - p.r - 1, w: p.r * 2 + 2, h: p.r * 2 + 2 };
    };
    const candBefore = g.st.cand[noteCell];
    const inkOn = () => [0, 1, 2].map((s) => countNear(C().note, 8, slotR(noteCell, s)));
    const inkBefore = inkOn();
    await tapCell(noteCell, 0);
    const inkAfter = inkOn();
    ck('render:笔记一笔 → 候选少一位、那一槽的墨没了、另两槽还在、DOM +1',
      candBefore === E().ALL && inkBefore.every((n) => n === 0) &&
        g.st.cand[noteCell] === (candBefore & ~1) && g.counts().notes === notesBefore + 1 &&
        inkAfter[0] === 0 && inkAfter[1] > 0 && inkAfter[2] > 0 && num('#stat-notes') === g.counts().notes,
      `cand=${g.st.cand[noteCell]} 想要=${candBefore & ~1} 各槽 note 像素 没记时=${inkBefore.join('/')} 想要=0/0/0，翻之后=${inkAfter.join('/')} 想要=0/>0/>0，DOM=${text('#stat-notes')}`);
    await tapCell(noteCell, 0);
    const inkBack = inkOn();
    ck('render:笔记再点一次把候选放回原位（翻，不是加），那一格也一起回到「没记=三槽都空」',
      g.st.cand[noteCell] === candBefore && inkBack.every((n) => n === 0) && g.counts().notes === notesBefore,
      `cand=${g.st.cand[noteCell]} 想要=${candBefore} 各槽 note 像素 放回后=${inkBack.join('/')} 想要=0/0/0 notes=${g.counts().notes} 想要=${notesBefore}`);

    // 右键擦掉：回到「没落笔 + 候选全在」，屏上那颗 player 色消失
    await clickSel('#pen-erase');
    await tapCell(pick[0], 2); // 右键也走擦掉（玩家的两只手都要能擦）
    const sigErase = shapeOf(pick[0], playerRgb);
    ck('render:右键那一格 → 擦回空白（形状签名 00000、候选全在、placed 归 0）',
      sigErase === SHAPE[-1] && g.st.cand[pick[0]] === E().ALL && !g.st.placed[pick[0]] && g.symbolAt(pick[0]) === E().BLANK,
      `签名=${sigErase} cand=${g.st.cand[pick[0]]} placed=${g.st.placed[pick[0]]}`);

    // 擦掉不能越界：题面给的那一格既擦不掉也不许改
    const givenCell = Array.from({ length: g.n }, (_, i) => i).find((i) => g.isGiven(i));
    const gvBefore = g.symbolAt(givenCell);
    await clickSel('#pen-square');
    await tapCell(givenCell, 0);
    await tapCell(givenCell, 2);
    const gvSig = shapeOf(givenCell, givenRgb);
    ck('render:题面给的格子擦不掉也改不了（符号没变、given 色还在、不记步数）',
      g.symbolAt(givenCell) === gvBefore && g.moves === movesAtStart + 6 && gvSig === SHAPE[gvBefore],
      `符号 ${g.symbolAt(givenCell)} 想要 ${gvBefore} 步数=${g.moves} 想要=${movesAtStart + 6}（三笔落子+两笔笔记+一笔擦掉，given 那两笔不许记账）签名=${gvSig} 想要=${SHAPE[gvBefore]}`);

    // 区域分组的**两条腿**：跨区共边那一条取样带上每一个像素都是 border 色；
    // 同区共边那条取样带上一个 border 色像素都不许有。两腿用同一个矩形（view.sharedEdgeSlice）。
    const grid = await eng('js/engine/grid.js');
    const pairs = grid.borderPairs(g.w, g.h, g.reg);
    const edgeBad = [];
    let edgePx = 0;
    for (const [x, y] of pairs) {
      const r = v.sharedEdgeSlice(x, y);
      const area = sliceArea(r);
      const got = countNear(C().border, 8, r);
      edgePx += got;
      if (got !== area) edgeBad.push(`${x}-${y}:${got}/${area}`);
    }
    ck(`render:分组正腿——${pairs.length} 条跨区共边的取样带全是 border 色`,
      pairs.length > 0 && edgeBad.length === 0, `取样带不满的边：${edgeBad.slice(0, 6).join(' ')}（border 像素合计 ${edgePx}）`);

    const sameBad = [];
    let sameEdges = 0;
    for (let i = 0; i < g.n; i++) {
      for (const j of grid.neighbors(g.w, g.h, i)) {
        if (j <= i || g.reg[j] !== g.reg[i]) continue;
        sameEdges++;
        const r = v.sharedEdgeSlice(i, j);
        const got = countNear(C().border, 8, r);
        if (got !== 0) sameBad.push(`${i}-${j}:${got}/${sliceArea(r)}`);
      }
    }
    ck(`render:分组腿二——${sameEdges} 条同区共边的取样带一个 border 色像素都没有`,
      sameEdges > 0 && sameBad.length === 0, `漏描的边：${sameBad.slice(0, 6).join(' ')}`);

    // 第三条腿：同区三格底色同数（底纹确实按区域走，不是按格子随机）
    const tintBad = [];
    for (const cells of g.cellsOf) {
      const got = cells.map((i) => {
        const r = v.cellRect(i);
        return show3(sample({ x: r.x + v.geo.cell * 0.12, y: r.y + v.geo.cell * 0.12 }));
      });
      if (new Set(got).size !== 1) tintBad.push(`${cells.join(',')}=${got.join('|')}`);
    }
    ck('render:同区三格的底色同数（底纹按区域铺）', tintBad.length === 0, tintBad.slice(0, 4).join(' '));

    // 撤销是一组一组退的：一组一次点击，退到栈空为止（下面那条断言负责说清退没退干净）。
    let undoGuard = 0;
    while (g.undoStack.length && undoGuard < 40) {
      await clickSel('#btn-undo');
      undoGuard++;
    }
    const emptied = g.counts();
    ck(`render:撤销一组是一次点击，退到栈空时盘回到没落笔（上面共 ${undoGuard} 组）`,
      g.undoStack.length === 0 && emptied.placed === 0 && emptied.notes === 0 && num('#stat-placed') === 0 && num('#stat-notes') === 0,
      `栈里还剩 ${g.undoStack.length} 组（点了 ${undoGuard} 次撤销）placed=${emptied.placed} notes=${emptied.notes} DOM=${text('#stat-placed')}/${text('#stat-notes')}`);

    // 提示走的就是玩家那三个写入口（place / toggleNote），不是 advance()：
    // 所以「引擎说的这一步真在盘上」和「这一步记进了撤销栈与步数」两句话都得量。
    const movesBefore = g.moves;
    const d = A().hint();
    const dOk = !!d && !d.stalled && !d.contradiction && !d.refused && E().RULE_ORDER.includes(d.rule) &&
      d.cell >= 0 && d.cell < g.n &&
      (d.kind === 'place' ? g.st.placed[d.cell] === 1 && g.symbolAt(d.cell) === d.value
        : d.kind === 'elim' && (g.st.cand[d.cell] & (1 << d.value)) === 0);
    ck('render:提示端出来的是引擎的下一条被迫结论（规则在 RULE_ORDER 里），而且那一笔真在盘上',
      dOk && g.moves === movesBefore + 1,
      `d=${JSON.stringify(d).slice(0, 220)} 步数 ${movesBefore}→${g.moves}`);
    const sigHint = dOk ? shapeOf(d.cell, d.kind === 'place' ? C().player : C().note) : 'no-step';
    ck('render:提示那一笔在屏幕上也是它（place 是 player 色的字形、elim 是 note 色的候选）',
      dOk && (d.kind === 'place' ? sigHint === SHAPE[d.value] : countNear(C().note, 8, v.cellRect(d.cell)) > 0),
      `签名/墨=${sigHint} 想要=${d && d.kind === 'place' ? SHAPE[d.value] : 'note 色像素>0'}`);
    const hintMoves = g.moves;
    await clickSel('#btn-undo');
    const undone = dOk && d.kind === 'place' ? g.symbolAt(d.cell) !== d.value : dOk && (g.st.cand[d.cell] & (1 << d.value)) !== 0;
    ck('render:提示那一笔可撤销（撤销栈记得住提示，不是偷偷推进）',
      undone && g.moves > hintMoves && g.undoStack.length === 0,
      `提示前步数=${movesBefore} 提示后=${hintMoves} 撤销后=${g.moves} 栈=${g.undoStack.length} d=${JSON.stringify(d).slice(0, 160)}`);

    return report({ picks: pick, sigs, edges: pairs.length, sameEdges, edgePx, hintRule: d && d.rule, undoGroups: undoGuard });
  }

  // ==========================================================================
  // play：冻结夹具 → 只用鼠标点完一盘 → 判胜；少点一格 → 不判胜
  // ==========================================================================
  async function play() {
    const a0 = await ready();
    const G = await golden();
    const rec = G.GOLDEN.find((r) => r.key === '4x6');
    if (!rec) throw new Error('golden 里没有 4x6 的夹具');

    // 把页面切到冻结的那张盘上：同一个 seed 在 node 与 Chrome 里画同一张盘
    // （node 侧由 tools/golden-test.mjs 逐条对账；这里量的是浏览器真走通了同一条路）
    await A().playSeed(rec.seed, rec.key);
    await wait(30);
    const g1 = A().game;
    const v = A().view;
    let vi = veilInfo();
    const domFp = (await faceFromDom()).fpDom;
    ck('play:按 seed 切到冻结题面（DOM 上的指纹就是冻结那一份、此时一片空白、长不出横幅）',
      g1.fp === rec.fp && domFp === rec.fp && g1.counts().placed === 0 && vi.hidden && vi.rect.w === 0 && vi.rect.h === 0,
      `fp=${g1.fp} DOM=${domFp} 想要=${rec.fp} placed=${g1.counts().placed} veil=${JSON.stringify(vi)}`);

    // 同一个 seed 再切一次必须画出同一张盘（界面上「seed 可以直接敲回来」那句话的可验部分）
    await A().playSeed(rec.seed, rec.key);
    ck('play:同一个 seed 敲回来就是同一张盘（题面指纹逐字符相同）', A().game.fp === rec.fp && A().game.counts().placed === 0, `第二次 fp=${A().game.fp}`);

    // ⚠ 往下所有笔迹都必须落在**页面上活着的那一个** Game 上：playSeed 每次切的都是一局新的
    //   （新对象），抓着第一次切盘时的句柄去读，读到的是一张没人写过的空盘。实测出来的形状
    //   正是本仓最防的那一种分家：画布上 player 色按冻结解铺满（像素对），旧句柄的 status() 却
    //   说「还有 17 格没定」（模型是另一个对象）——所以这里重取一次句柄，并把「两次确实是两个
    //   对象、题面却是同一张盘」钉成一条断言（把 playSeed 改成复用旧对象它就红）。
    const g = A().game;
    ck('play:两次切盘 = 两局新的 Game、同一张题面（后面落的每一笔都写在这一份里）',
      g !== g1 && g.fp === g1.fp && g.n === g1.n, `新旧同一个对象=${g === g1} fp同=${g.fp === g1.fp}`);

    // —— 少填一格：不许赢，而且引擎要说清死在哪一条上 ——
    const fill = G.fillOf(rec);
    let skipped = -1;
    for (let i = 0; i < rec.w * rec.h; i++) {
      if (g.isGiven(i)) continue;
      if (skipped < 0) {
        skipped = i; // 第一格故意空着
        continue;
      }
      await clickSel('#pen-' + PEN_BTN[fill[i]]);
      await tapCell(i, 0);
    }
    const stAlmost = g.status();
    vi = veilInfo();
    ck('play:少填一格 → verify 说不赢、横幅不出、DOM 那格也写着没赢、状态行是引擎那句话',
      stAlmost.ok === false && /还有 \d+ 格没定/.test(stAlmost.why) && text('#stat-verify') === '没赢' && vi.hidden && vi.rect.w === 0 &&
        text('#state-line') === stAlmost.why,
      `verify=${JSON.stringify(stAlmost)} DOM=${text('#stat-verify')} veil=${JSON.stringify(vi)} 状态行=${text('#state-line')}`);

    // 补上那一格 → 同一盘立刻该赢，且横幅只由 verify 说 ok 才长出来
    await clickSel('#pen-' + PEN_BTN[fill[skipped]]);
    await tapCell(skipped, 0);
    const stWin = g.status();
    vi = veilInfo();
    ck('play:点齐冻结的唯一解 → verify 说赢、横幅真的长出来（非零矩形、display:grid）',
      stWin.ok === true && text('#stat-verify') === '赢了' && !vi.hidden && vi.rect.w > 100 && vi.rect.h > 60 && vi.display === 'grid',
      `verify=${JSON.stringify(stWin)} DOM=${text('#stat-verify')} veil=${JSON.stringify(vi)}`);

    // 赢了的那一张遮罩必须真的挡在画布上面（否则「点得到格子」和「看得见横幅」会同时为真）
    ck('play:横幅出来之后，盘中心打到的是遮罩（不是还能点的画布）',
      vi.hitsVeil === true && vi.canvasMid && vi.hitId !== 'board', `veil=${JSON.stringify(vi)}`);

    // 逐格核对：屏幕上每一格的形状签名都等于那格的符号（赢的盘面也不许有一格画错）
    const sigBad = [];
    for (let i = 0; i < g.n; i++) {
      const sym = g.symbolAt(i);
      const want = g.isGiven(i) ? C().given : C().player;
      const got = shapeOf(i, want);
      if (got !== SHAPE[sym]) sigBad.push(`${i}=${got} 想要=${SHAPE[sym]}(${g.isGiven(i) ? 'given' : 'player'})`);
    }
    ck('play:赢的盘面上每一格的形状签名都等于那格现在该是什么', sigBad.length === 0, sigBad.slice(0, 6).join(' '));

    const nPlayer = countNear(C().player, 8);
    const nGiven = countNear(C().given, 8);
    ck('play:赢的盘面上 player 色真的铺开了（而且 given 色还在，两色不互认）',
      nPlayer > (g.n - g.counts().given) * 30 && nGiven > g.counts().given * 30 && near(C().player, C().given, 16) === false,
      `player=${nPlayer} given=${nGiven} 每格下界=30px`);

    // 「只点提示」也能把这盘推到底：出货的每一盘都是零猜测可推的，界面上的提示按钮就是这条路
    await clickSel('#btn-clear');
    await wait(20);
    ck('play:全清把每一笔归零、横幅收掉、DOM 跟着归零',
      A().game.counts().placed === 0 && num('#stat-placed') === 0 && veilInfo().hidden && num('#stat-notes') === 0,
      `placed=${A().game.counts().placed} DOM=${text('#stat-placed')}/${text('#stat-notes')} veil=${JSON.stringify(veilInfo())}`);
    await clickSel('#btn-undo');
    const backCount = A().game.counts().placed;
    ck('play:全清是一组可撤销的（按错一次不该赔掉整局）',
      backCount === g.n - g.counts().given, `退回之后填了 ${backCount} 格，想要 ${g.n - g.counts().given}`);

    await clickSel('#btn-clear'); // 再清一次，从空盘开始只点提示
    let guard = 0;
    let last = null;
    while (guard < 900 && !A().game.status().ok) {
      last = A().hint();
      guard++;
      // 四种「这一步没落成」都得停：不点下去就交给下面的断言去说红，
      // 而不是在这里靠循环条件把它糊成一次「推到 ok」。
      if (!last || last.stalled || last.contradiction || last.refused) break;
      await wait(2);
    }
    const stHint = A().game.status();
    ck('play:只点「提示」把这盘推到 verify 说 ok（出货的每一盘都是零猜测可推的）',
      stHint.ok === true, `走了 ${guard} 次提示之后 verify=${JSON.stringify(stHint)} blank=${A().game.counts().blank} 最后一步=${JSON.stringify(last).slice(0, 200)}`);
    ck('play:沿提示走出来的那一份就是冻结的唯一解（逐格同）',
      Array.from({ length: g.n }, (_, i) => g.symbolAt(i)).join('') === Array.from(fill).join(''),
      `界面=${Array.from({ length: g.n }, (_, i) => g.symbolAt(i)).join('')} 冻结=${Array.from(fill).join('')}`);

    // 换一局必须真的换一张盘（seed 与题面都换，而且从空白盘开始）
    const seedBefore = A().game.seed;
    const fpBefore = A().game.fp;
    await clickSel('#btn-new');
    await ready();
    const g3 = A().game;
    ck('play:换一局换了 seed 也换了题面，而且从空白盘开始',
      g3.seed !== seedBefore && g3.fp !== fpBefore && g3.counts().placed === 0 && g3.moves === 0,
      `seed 两次都是 ${g3.seed}；题面没变=${g3.fp === fpBefore} placed=${g3.counts().placed} moves=${g3.moves}`);

    return report({ seed: rec.seed, skipped, hintSteps: guard, playerPx: nPlayer, givenPx: nGiven, edges: (await faceFromDom()).regions });
  }

  // ==========================================================================
  // sizes：菜单七档都开得出、点得动；UI 没有表外那条路
  // ==========================================================================
  async function sizes() {
    const a = await ready();
    const sizes = E().SIZES;
    const sel = $('#size-select');

    // 选择器里的档**必须**与 generate.js 导出的 SIZES 逐字符同序（菜单是 import 来的，不是抄的）
    const values = Array.from(sel.options).map((o) => o.value).join(',');
    ck('sizes:选择器里的档与引擎导出的 SIZES 同序同数（界面没另抄一份尺寸表）',
      values === sizes.join(','), `value=${values} SIZES=${sizes.join(',')}`);
    ck('sizes:12×12 那档（对照档）不在选择器里', Array.from(sel.options).every((o) => o.value !== '12x12') && !sizes.includes('12x12'),
      `options=${values} SIZE_TABLE=${Object.keys(E().SIZE_TABLE).join(',')}`);

    for (const key of sizes) {
      sel.value = key;
      sel.dispatchEvent(new Event('change'));
      const a2 = await ready();
      const g = a2.game;
      const { w, h } = E().parseSize(key);
      const d = a2.view.canvas.dataset;
      // 挑一格点一下：这一档的命中盒与画色都得真的能用，不是「开得出局就算」。
      // ⚠ 必须挑**没被题面给的**那一格，而且不能死盯几何正中：正中那格是不是线索由这一盘的
      //   seed 决定（6x8、6x9 两档实测就撞在线索上，于是断言读到的签名是 00000「没画」——
      //   线索格本来就不许改），跟着随机 seed 走的断言不配当门禁。取「空格里的正中那一格」：
      //   每一档都点得动，红的时候说的一定是几何或上色，不是运气。
      const blanks = g.blankCells().filter((i) => !g.isGiven(i));
      const cell = blanks[Math.floor(blanks.length / 2)];
      await clickSel('#pen-circle');
      await tapCell(cell, 0);
      const got = shapeOf(cell, C().player);
      const nr = new Set(Array.from(g.reg)).size;
      ck(`sizes:${key} 这一档：几何/区域数/题面/点击全对得上（点的是第 ${cell} 格这一支 ●）`,
        `${g.w}x${g.h}` === `${w}x${h}` && g.n === w * h && nr * 3 === w * h && d.w === String(w) && d.h === String(h) &&
          d.regions === String(nr) && g.counts().given > 0 && got === SHAPE[1] && !g.isGiven(cell),
        `盘=${g.w}x${g.h} dataset=${d.w}x${d.h}/${d.regions}区 区域=${nr} 线索=${g.counts().given} 点了第${cell}格(线索格=${g.isGiven(cell)}) 签名=${got} 想要=${SHAPE[1]}`);
      // 每一格都点得到自己（这一档的几何在这一档的格边长下成立）
      const missed = [];
      for (let i = 0; i < g.n; i++) {
        const p = clientOf(a2.view.centerOf(i).x, a2.view.centerOf(i).y);
        if (a2.view.hitCell(p.x, p.y) !== i) missed.push(i);
      }
      ck(`sizes:${key} 每一格正中点得到自己（${g.n} 格）`, missed.length === 0, `点不到的格：${missed.slice(0, 8).join(',')}`);
      await tapCell(cell, 2);
    }

    // 选择值被换成表外的东西时，UI 也只能开菜单里的盘
    sel.value = 'not-a-size';
    const picked = A().currentSize();
    ck('sizes:表外的选择值开不出表外的盘', sizes.includes(picked), `currentSize() 拿到 ${picked}，菜单=${sizes.join(',')}`);

    sel.value = sizes[1];
    sel.dispatchEvent(new Event('change'));
    await ready();
    return report({ sizes: sizes.join(',') });
  }

  // ==========================================================================
  // reproof：换一局端上来的那一盘，由引擎在浏览器里**独立重证**
  // ==========================================================================
  // 独立性的两处关键：
  //   ① 题面从 canvas.dataset 收（屏幕上是什么就重证什么），不从 window.triplets.game 的对象图里摘；
  //   ② 计数器与铅笔用 `import(new URL('js/engine/…', document.baseURI))` 现取（走的是服务出来的
  //      URL，Pages 子路径下但凡有一个写死的 `/` 就先红在这里），用的也不是界面手里那份引用。
  async function reproof() {
    const a0 = await ready();
    const fpBefore = a0.game.fp;
    await clickSel('#btn-new');
    const a = await ready();
    const face = await faceFromDom();
    const g = a.game;

    ck('reproof:换了一局确实换了题面（DOM 指纹变了，界面手里的也一样）',
      face.fpDom === g.fp && face.fpDom !== fpBefore, `DOM=${face.fpDom} 界面=${g.fp} 上一盘=${fpBefore}`);
    // 线索数先算出来：detail 是**先求值再传参**的，塞在条件里就印不出自己刚算的那个值
    face.clues = 0;
    for (let i = 0; i < face.n; i++) if (face.givens[i] >= 0) face.clues++;
    ck('reproof:DOM 上收回来的题面自洽（reg/givens 串长 = 格数，fp 串就是引擎那一份口径）',
      face.reg.length === face.n && face.givens.length === face.n && face.fpCalc === face.fpDom && face.n % 3 === 0 &&
        face.clues > 0 && face.reg.every((r) => r >= 0 && r < face.regions) &&
        (() => {
          const size = new Map();
          for (const r of face.reg) size.set(r, (size.get(r) || 0) + 1);
          return [...size.values()].every((c) => c === 3);
        })(),
      `串长=${face.regStr.length}/${face.givensStr.length} 格数=${face.n} fp算=${face.fpCalc} fp盘=${face.fpDom} 线索=${face.clues}`);

    const counter = await eng('js/engine/counter.js');
    const pencil = await eng('js/engine/pencil.js');
    const gen = await eng('js/engine/generate.js');
    const puzzle = { w: face.w, h: face.h, reg: face.reg, givens: face.givens };
    // 唯一解：独立穷举计数器在预算内数出 1，而且没被预算停住（停住就等于没数过）。
    // 两份计数器互不信任：countByRegion 逐区域挑那九个填法，countNaive 逐格试三个符号 ——
    // 同一道题两种搜法，结点序列毫无关系，它们对上了才算「唯一」。
    const dp = counter.countByRegion(puzzle);
    const dn = counter.countNaive(puzzle);
    let naiveDiff = 0;
    if (dp.truth && dn.truth && dp.truth.length === dn.truth.length) {
      for (let i = 0; i < face.n; i++) if (dp.truth[i] !== dn.truth[i]) naiveDiff++;
    } else naiveDiff = -1;
    ck('reproof:两道独立计数器都数出唯一解（逐区域 / 逐格，且都没被预算停住、真值逐格相同）',
      dp.stopped === false && dp.count === 1 && dn.stopped === false && dn.count === 1 && naiveDiff === 0,
      `逐区域 count=${dp.count} stopped=${dp.stopped} nodes=${dp.nodes}；逐格 count=${dn.count} stopped=${dn.stopped} nodes=${dn.nodes}；两份真值不一致的格=${naiveDiff}`);

    // 零猜测：铅笔（RULE_ORDER 全开）推得完
    const solved = pencil.solveWithRules(puzzle);
    ck('reproof:铅笔在零猜测下推到底', solved.status === 'solved', `status=${solved.status} steps=${solved.steps} blank=${solved.blank} why=${solved.why}`);

    // 三方对上了同一份真值：计数器的 truth、铅笔自己推出来的那一份（solved.out ——
    // advance 交出的值数组叫 out，不叫 values）、以及「把 truth 当盘面交给 verify」的裁决。
    // ⚠ st.cand 是**位掩码**、dp.truth 是**符号值**，两者不能直接比：这里现造一份只装 truth 的
    //   状态让铅笔的 verify() 去裁决它，再和铅笔自己推出来的 out 逐格对。
    const st = pencil.createState(puzzle);
    let diff = 0;
    // dp.truth 在数出 0 个解时是 null —— 不守一下就是一场 TypeError 把红变成 fatal
    if (dp.truth) for (let i = 0; i < face.n; i++) {
      st.cand[i] = 1 << dp.truth[i];
      st.placed[i] = 1;
      if (pencil.symbolOf(st, i) !== dp.truth[i]) diff++;
      if (solved.out[i] !== dp.truth[i]) diff++;
    }
    const vv = pencil.verify(st);
    ck('reproof:计数器交出的那一份，铅笔的 verify 认它，而且和铅笔自己推出来的逐格相同',
      diff === 0 && vv.ok === true && solved.out.length === face.n,
      // ⚠ detail 是**先算**再传进去的：count=0 时 truth 是 null，这里不留神就是一条 TypeError
      //   把「数出 0 个解」这个红变成一场 fatal。
      `不一致的格=${diff} verify=${JSON.stringify(vv)} 铅笔值=${Array.from(solved.out || []).slice(0, 8).join('')} 计数器值=${(dp.truth || []).slice(0, 8).join('')}`);

    // 题面与屏幕画的必须是同一份：每一格的 given 色/形状都等于 dataset 上那个字符
    const g2 = a.game;
    const sigBad = [];
    for (let i = 0; i < face.n; i++) {
      const ch = face.givensStr[i];
      const isG = ch !== '.';
      if (isG !== g2.isGiven(i) || (isG && Number(ch) !== g2.givens[i])) {
        sigBad.push(`${i}:dom=${ch} game=${g2.isGiven(i) ? g2.givens[i] : '-'}`);
        continue;
      }
      if (!isG) continue;
      const got = shapeOf(i, C().given);
      if (got !== SHAPE[Number(ch)]) sigBad.push(`${i}:签名=${got} 想要=${SHAPE[Number(ch)]}`);
    }
    ck('reproof:DOM 上写的题面就是屏幕上画的（given 逐格对，形状签名也对）', sigBad.length === 0, sigBad.slice(0, 6).join(' '));

    // 指纹口径两侧一致：界面 import 的那一个、独立 import 的那一个、夹具那一个，三个同函数同结果
    ck('reproof:fingerprint 三处同口径（界面 / 独立 import / 夹具的 fingerprintOf）',
      gen.fingerprint(face.w, face.h, face.reg, face.givens) === face.fpCalc && E().fingerprint(face.w, face.h, face.reg, face.givens) === face.fpCalc,
      `引擎=${gen.fingerprint(face.w, face.h, face.reg, face.givens)} 界面=${E().fingerprint(face.w, face.h, face.reg, face.givens)} 夹具=${face.fpCalc}`);

    // 这一盘必须是菜单档：尺寸在 SIZES 里，seed 是可以敲回来的字符串
    ck('reproof:这一盘是菜单档、seed 可直接敲回（换一局不给表外的盘）',
      E().SIZES.includes(g2.sizeKey) && g2.sizeKey === `${face.w}x${face.h}` && /^[A-Za-z0-9#._:-]+$/.test(g2.seed),
      `sizeKey=${g2.sizeKey} 盘面=${face.w}x${face.h} seed=${g2.seed}`);

    return report({ sizeKey: g2.sizeKey, fp: face.fpDom, clues: face.clues, dpCount: dp.count, dpNodes: dp.nodes, pencilSteps: solved.steps, seed: g2.seed });
  }

  // ==========================================================================
  // resume：存档存的是 seed + 每格一个字符 + 步数，重载之后接得上同一张盘
  // ==========================================================================
  // 这两段之间隔着一次真导航（tools/verify.sh 跑完 resume-set，再带着 #expect= 跑
  // resume-check，playtest 每次都重新导航）。场景里不放 location.reload()：
  // 那会把自家的 eval 上下文一起 reload 掉，谁也没法把话说完。
  //
  // ⚠ 「重新导航」不等于「换了一个文档」：同一个 URL 只多一个 #expect= 片段时，
  //   Page.navigate 走的是**同文档片段跳转**，window.triplets 还是上一个场景那一个，
  //   于是 resume-check 量的其实是自己刚画完的那笔——存档根本没被读过。所以 set 侧把
  //   performance.timeOrigin 一起交出去，check 侧第一件事就是证明两次的 timeOrigin 不同。
  const SAVE_KEY = 'triplets.save.v1';

  async function resumeSet() {
    await ready();
    const G = await golden();
    const rec = G.GOLDEN.find((r) => r.key === '6x6');
    if (!rec) throw new Error('golden 里没有 6x6 的夹具');
    await A().playSeed(rec.seed, rec.key);
    await wait(30);
    const g = A().game;
    const fill = G.fillOf(rec);

    // 六格落子 + 两格笔记 + 一次撤销：恢复必须连笔记和步数一起接回来。
    // 期望值是从这张动作单子上**数**出来的，不是从界面上抄回来的（抄回来的那条断言恒真）：
    //   6 笔落子 + 2 笔笔记 = 8 组，撤销再记一步 ⇒ moves = 9；
    //   撤销退掉的是最后那一笔笔记 ⇒ placed 仍是 6、notes 只剩 1。
    // 刻意**不**在这里点提示：提示走的是同一批写入口，但它端出来的是哪一条规则由盘面决定，
    // 期望值就会变成「这一张盘形状的一部分」——那不是在验恢复，是在背当前输出。
    let done = 0;
    for (let i = 0; i < g.n && done < 6; i++) {
      if (g.isGiven(i)) continue;
      await clickSel('#pen-' + PEN_BTN[fill[i]]);
      await tapCell(i, 0);
      done++;
    }
    let noted = 0;
    for (let i = 0; i < g.n && noted < 2; i++) {
      if (g.isGiven(i) || g.st.placed[i]) continue;
      await clickSel('#pen-note');
      await tapCell(i, 0);
      noted++;
    }
    await clickSel('#btn-undo'); // 撤掉最后一格笔记那一笔：步数必须因此**增加**而不是回退
    const wantMoves = 6 + 2 + 1;
    const marks = g.encode();
    const raw = JSON.parse(w.localStorage.getItem(SAVE_KEY) || '{}');
    const cnt = g.counts();
    const st = g.status();
    const expect = {
      seed: g.seed,
      sizeKey: g.sizeKey,
      marks,
      w: g.w,
      h: g.h,
      moves: g.moves,
      fp: g.fp,
      notes: cnt.notes,
      placed: cnt.placed,
      verify: { ok: st.ok, why: st.why },
      timeOrigin: String(performance.timeOrigin),
    };
    ck('resume-set:落了几笔之后存档里就是这一局（seed + 每格一字符 + 步数，没有答案字段）',
      !!raw.resume && raw.resume.seed === g.seed && raw.resume.marks === marks && Number(raw.resume.moves) === g.moves &&
        raw.resume.fp === g.fp && !/solution|"fill"|reg":|givens":/.test(JSON.stringify(raw)),
      `存档=${JSON.stringify(raw.resume || null).slice(0, 260)} 答案字段命中=${(JSON.stringify(raw).match(/solution|"fill"|reg":|givens":/g) || []).join(',') || '无'}`);
    ck('resume-set:交出去的期望与这一局同数（6 格填、1 格笔记剩、步数不是 0、题面指纹就是冻结那张）',
      expect.placed === 6 && expect.notes === 1 && g.moves > 0 && g.fp === rec.fp && marks.length === g.n &&
        num('#stat-placed') === cnt.placed && num('#stat-notes') === cnt.notes && num('#stat-moves') === g.moves,
      `placed=${expect.placed} notes=${expect.notes} moves=${g.moves} marks长=${marks.length}/${g.n} fp同=${g.fp === rec.fp} DOM=${text('#stat-placed')}/${text('#stat-notes')}/${text('#stat-moves')}`);
    ck('resume-set:撤销不是倒退——它自己也算一步（界面上没有第二份账）',
      g.moves === wantMoves && cnt.placed === 6 && cnt.notes === 1,
      `步数=${g.moves} 想要=${wantMoves}（6 落子 + 2 笔记 + 1 撤销），撤销退掉的是最后一笔笔记 ⇒ 填 6 剩 1 笔记`);
    return report({ expect });
  }

  async function resumeCheck() {
    const exp = expectFromHash() || {};
    await wait(60);
    const a = await ready();
    const g = a.game;
    const st = g.status();
    const cnt = g.counts();
    const vi = veilInfo();
    const nPlayer = countNear(C().player, 8);
    const nNote = countNear(C().note, 8);
    const expKeys = Object.keys(exp).length;

    ck('resume-check:期望从 URL 的 #expect= 进来，而且这一场跑在**另一个文档**里（真导航过，不是同文档改片段）',
      expKeys > 0 && !!exp.timeOrigin && String(performance.timeOrigin) !== String(exp.timeOrigin),
      `hash=${String(location.hash).slice(0, 48)} 期望键=${expKeys} 本场 timeOrigin=${performance.timeOrigin} 上一场=${exp.timeOrigin}`);
    ck('resume-check:接上的是同一张盘（同 seed、同档、同题面指纹）',
      !!exp.seed && g.seed === exp.seed && g.sizeKey === exp.sizeKey && g.fp === exp.fp,
      `seed=${g.seed} 想要=${exp.seed} 档=${g.sizeKey} 想要=${exp.sizeKey} fp同=${g.fp === exp.fp}`);
    ck('resume-check:每一笔都接上了（逐格编码同、笔记数同、步数不是 0 且同、verify 读数与 DOM 同）',
      g.encode() === exp.marks && cnt.notes === Number(exp.notes) && cnt.placed === Number(exp.placed) &&
        g.moves > 0 && g.moves === Number(exp.moves) && !!exp.verify && st.ok === exp.verify.ok && st.why === exp.verify.why &&
        num('#stat-placed') === cnt.placed && num('#stat-notes') === cnt.notes && num('#stat-moves') === g.moves,
      `marks同=${g.encode() === exp.marks} notes=${cnt.notes} 想要=${exp.notes} placed=${cnt.placed} 想要=${exp.placed} moves=${g.moves} 想要=${exp.moves} verify=${JSON.stringify({ ok: st.ok, why: st.why })} 想要=${JSON.stringify(exp.verify || null)} DOM=${text('#stat-placed')}/${text('#stat-notes')}/${text('#stat-moves')}`);
    ck('resume-check:恢复出来的盘真的画在屏幕上半（player 色与 note 色都在，而没赢就不许有横幅）',
      nPlayer > 0 && nNote > 0 && st.ok === false && vi.hidden && vi.rect.w === 0 && vi.hitsVeil === false,
      `player=${nPlayer} note=${nNote} verify.ok=${st.ok} veil=${JSON.stringify(vi)}`);

    await clickSel('#btn-reset');
    const after = JSON.parse(w.localStorage.getItem(SAVE_KEY) || '{}');
    ck('resume-check:清空存档就没有存档了（总成绩也归零）',
      !after.resume && after.totals && after.totals.solved === 0 && after.totals.games === 0,
      `存档=${JSON.stringify(after).slice(0, 200)}`);
    return report({ seed: g.seed, moves: g.moves, notes: cnt.notes, placed: cnt.placed, playerPx: nPlayer, notePx: nNote });
  }

  // verify.sh 喊的是 resume-set / resume-check（带连字符，日志里读得清），这里就得按那个名字给。
  w.__tripletsGate = { boot, render, play, sizes, reproof, 'resume-set': resumeSet, 'resume-check': resumeCheck };
})(window);
