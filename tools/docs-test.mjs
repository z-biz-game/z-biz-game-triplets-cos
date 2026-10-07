#!/usr/bin/env node
// 文档行号对账（零依赖，纯 node）——README / DESIGN 里印着的每一个 `path:NN` 都被读回来对账。
//
// 为什么要有这一支：本文里有几十条「去看第 N 行」，而写这句话的时候没有任何机器核过它。
// 「文档说的是第 106 行」这句话的真假，全靠写文档那一刻有人手算过：改了代码不重编行号，文档不会响，
// 读者按图索骥找到的是别的东西。这一腿把那句话变成一条会红的断言。
//
// 口径与家族里其余几份（doublechoco / ferry / yajilin / floom / echo-location / creek / lightsout / tapa）
// 同一份，不是这一仓自创：
//   · 只有反引号里的 `path:NN` / `path:NN-MM` 算引用；
//   · 六种贴法都产出锚点——`name`（`path:NN`）、`path:NN`（`name`）、`path:NN` 的 `name`、
//     `path:NN`（`fn(a, b)`）、`path:NN`（`dir/file.js::symbol`）、`name` 在 `path:NN`；
//   · `::` 的切分排在 `/` 的拒绝**之前**，否则带目录限定的符号名会被当成路径而丢掉锚点；
//   · 带 `<占位>` 的模板 body 取字面量前缀（只有真写了占位符才这样拆，否则 `test:docs` 被砍成 `test`）；
//   · body 带空格是命令行（`npm test`），拿它第一个词去锚是一次凭空的假红；
//   · 纯标点间隔（`，`、`、`）不构成指认：它前面那个名字只是上一条列表项；
//   · 锚点认**整词**不认子串：短名字坐在声明长标识符的那一行上也会"出现"，子串口径把一次真的漂读成绿；
//   · 续引（完整引用后面只写 `:NN`）向同一句里最近的那条完整引用借路径；句号、分号、空行、新标题都截断这次借，
//     借不到的计入「无法定址」，由等式闸逐处钉住，不静默跳过；
//   · 跨仓引用（`../别的仓/…:NN`）按**形状**分出去：单仓 checkout 里读不到它，按"文件在不在"决定红不红
//     就是一条随环境漂的闸。这条腿只数它，不替别的仓担保行号；
//   · 两半主判据各防一种谎：范围半 = 文件在盘上、行号落在真实行数内、**被指的那几行不许整段是空白**
//     （"在界内"不等于"指到了代码"）；锚点半 = 贴着引用那个名字必须作为完整标识符出现在被指的那几行里。
//
// 这一腿不覆盖什么：它只证明印在纸上的行号还坐在它所描述的那几行上，不证明周围的句子。
// 跑法：`npm run doctest` —— 同一条命令住在 tools/verify.sh 的单元段与 .github/workflows/ci.yml 里。
// 它**不在** `npm test` 的链里：那一链的形状是「七套、RESULT 行数 = 7」的判据，把第八套塞进去而不动那条
// 判据会当场把 CI 点成恒红，所以最后一条腿钉的就是这两件事必须同时改。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CMD = 'node tools/docs-test.mjs';

const PATH_SRC = '[\\w./-]+?\\.(?:js|mjs|cjs|sh|json|yml|html|css|md)';
const CITE = new RegExp('^(' + PATH_SRC + '):([0-9]+(?:[,-][0-9]+)*)$');
const BARE = /^:([0-9]+(?:[,-][0-9]+)*)$/;
const STOP = /[。！？；]/;
const ID = /^[A-Za-z_$][A-Za-z0-9_$]{2,}(?:\.[A-Za-z_$][A-Za-z0-9_$]+)*$/;

const inheritedPath = (text, spans, i) => {
  for (let j = i - 1; j >= 0; j--) {
    const pc = spans[j].body.match(CITE);
    if (!pc) continue;
    const between = text.slice(spans[j].end, spans[i].s);
    if (between.includes('\n') && (STOP.test(between) || /\n[ \t]*\n/.test(between) || /\n#{1,6} /.test(between))) return null;
    return { path: pc[1] };
  }
  return null;
};
const tokOf = (body) => {
  const seg = body.includes('::') ? body.slice(body.lastIndexOf('::') + 2) : body;
  if (seg.includes('/')) return '';
  const tpl = /^([^<>]+?)<[^<>\s]+>/.exec(seg);
  if (tpl && ID.test(tpl[1].split(':')[0].trim())) return tpl[1].split(':')[0].trim();
  const head = seg.split('(')[0].trim();
  if (ID.test(head)) return head;
  const lhs = head.split(/[=:]\s/)[0].trim();
  return ID.test(lhs) ? lhs : '';
};

const lineCache = new Map();
const linesOf = (p) => {
  if (!lineCache.has(p)) {
    let arr = null;
    try {
      arr = fs.readFileSync(path.join(ROOT, p), 'utf8').split('\n');
      if (arr[arr.length - 1] === '') arr.pop();
    } catch {
      arr = null;
    }
    lineCache.set(p, arr);
  }
  return lineCache.get(p);
};

function parseRefs(text, orphans = null) {
  const spans = [];
  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(text))) spans.push({ body: m[1], s: m.index, end: m.index + m[0].length });
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const c = spans[i].body.match(CITE);
    const bare = c ? null : BARE.exec(spans[i].body);
    if (!c && !bare) continue;
    const owner = c ? { path: c[1] } : inheritedPath(text, spans, i);
    if (!owner) { if (orphans) orphans.push(bare[0]); continue; }
    let anchor = '';
    let consumed = false;
    const next = spans[i + 1];
    const gA = next ? text.slice(spans[i].end, next.s) : null;
    if (gA !== null && gA.length <= 4 && !gA.includes('\n')) {
      const gN = gA.replace(/\s+/g, '');
      if (/^[（(]/.test(gN) || gN === '的') { consumed = true; anchor = tokOf(next.body); }
    }
    // 前向没认出注解形状时才接着试后向。用 `else if` 挂在前向条件上，
    // 「`NAME` 在 `js/engine/grid.js:1`、」这种后面紧跟短间隔的写法就把后向那把弄哑了。
    if (!consumed && i > 0) {
      const prev = spans[i - 1];
      const gap = text.slice(prev.end, spans[i].s);
      const gT = gap.replace(/\s+/g, '');
      const shaped = /^[（(]/.test(gT) || /[\w一-鿿]/.test(gT);
      if (shaped && !/\s/.test(prev.body) && gap.length <= 4 && !gap.includes('\n')) anchor = tokOf(prev.body);
    }
    const range = c ? c[2] : bare[1];
    for (const seg of range.split(',')) {
      const parts = seg.split('-').map(Number);
      out.push({ path: owner.path, from: parts[0], to: parts[parts.length - 1] || parts[0], anchor, cont: !c });
    }
  }
  return out;
}

// 整词而不是子串：`node` 坐在 `let nodes = 0;` 那一行上也算"出现"，一次真的漂就被读成绿。
const wordCache = new Map();
const hasWord = (text, name) => {
  if (!wordCache.has(name)) {
    wordCache.set(name, new RegExp('(^|[^A-Za-z0-9_$])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_$])'));
  }
  return wordCache.get(name).test(text);
};

function audit(text) {
  const orphans = [];
  const refs = parseRefs(text, orphans);
  const outOfRange = [];
  const anchorBad = [];
  let foreign = 0;
  for (const r of refs) {
    if (r.path.startsWith('..')) { foreign++; continue; }
    const label = `${r.path}:${r.from}${r.to !== r.from ? '-' + r.to : ''}`;
    const lines = linesOf(r.path);
    if (!lines) { outOfRange.push(`${label} 文件不存在`); continue; }
    if (r.from < 1 || r.to > lines.length) {
      outOfRange.push(`${label} 越界（该文件共 ${lines.length} 行）`);
      continue;
    }
    if (lines.slice(r.from - 1, r.to).join('').trim() === '') {
      outOfRange.push(`${label} 那几行整段是空行`);
      continue;
    }
    if (r.anchor && !hasWord(lines.slice(r.from - 1, r.to).join('\n'), r.anchor)) {
      anchorBad.push(`${label} 那几行里没有 ${r.anchor}`);
    }
  }
  // `` `文件`（N 行）`` 这种实测值按等式收：写歪一格、文件不在，都算指不回实处。
  const cntRe = new RegExp('`(' + PATH_SRC + ')`（([0-9]+) 行）', 'g');
  let k;
  while ((k = cntRe.exec(text))) {
    const lines = linesOf(k[1]);
    if (!lines) outOfRange.push(`${k[1]}（${k[2]} 行）文件不存在`);
    else if (lines.length !== Number(k[2])) outOfRange.push(`${k[1]} 实测 ${lines.length} 行，文档写的是 ${k[2]}`);
  }
  return { refs, outOfRange, anchorBad, cont: refs.filter((r) => r.cont).length, unaddressed: orphans.length, foreign };
}

const anchorCount = (text) => parseRefs(text).filter((r) => r.anchor).length;

// ── 靶子全部现量，不写死行号 ────────────────────────────────────────────────────────────────
// 写死行号的夹具会在有人往那个文件上面插一行的那天停止测试（夹具自己漂走，而它照样绿）。
// 这里每把刀的靶子都由本文件当场从源码里数出来：符号名从声明行里读，空行行号从空白扫描里读，
// 前缀靶子从"子串命中而整词不命中"的真声明里挑。量不到靶子时相关那一格自己改口"没被证明过"并变红。
const declRe = /^\s*(?:export\s+)?(?:var|let|const|function|class)\s+([A-Za-z0-9_$]+)/;
const decls = (file) => {
  const lines = linesOf(file) || [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = declRe.exec(lines[i]);
    if (m && /^[A-Za-z_$][\w$]{3,}$/.test(m[1])) out.push({ file, line: i + 1, name: m[1], text: lines[i] });
  }
  return out;
};
const TARGET_FILES = ['js/engine/generate.js', 'js/engine/pencil.js', 'js/engine/grid.js',
  'js/engine/counter.js', 'js/engine/rng.js', 'tools/balance.mjs', 'tests/a5-contradiction.test.mjs'];
const ALL_DECLS = TARGET_FILES.flatMap(decls);
const SYM = ALL_DECLS.find((d) => /\(/.test(d.text) && d.text.indexOf(d.name) === d.text.lastIndexOf(d.name)) || null;
const PREFIX = ALL_DECLS.map((d) => ({ d, p: d.name.slice(0, -1) }))
  .find(({ d, p }) => p.length >= 4 && d.text.includes(p) && !hasWord(d.text, p)) || null;
const firstBlank = (file) => {
  const lines = linesOf(file) || [];
  for (let i = 1; i < lines.length; i++) if (String(lines[i]).trim() === '') return i + 1;
  return 0;
};
const BLANK = (SYM && firstBlank(SYM.file)) || firstBlank('js/engine/generate.js');

// ── 判定形状与本仓其余几套一致：ok(条件, 名字, 见证) + RESULT 行 ────────────────────────────
// 两种实参顺序都出现过（本仓其余几套是条件在前，这条腿从别族移植来时名字在前），而条件位置坐在
// 一个非空字符串上 ⇒ 那一条**永远绿**。所以顺序由类型判，不靠调用方的记性：两个位置凑不成
// (布尔, 字符串) 就是写坏了，当场抛而不是静默算一项通过。
let checks = 0;
const fails = [];
const notes = [];
function ok(a, b, detail = '') {
  let cond, name;
  if (typeof a === 'boolean' && typeof b === 'string') { cond = a; name = b; }
  else if (typeof a === 'string' && typeof b === 'boolean') { name = a; cond = b; }
  else throw new Error(`ok() 的实参形状不认识（第 ${checks + 1} 条：${typeof a}/${typeof b}）——` +
    '一条判据不许在"参数坐错位置"的情况下算通过');
  checks++;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return cond;
}

const docFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md'));
ok(docFiles.length >= 2 && docFiles.includes('README.md') && docFiles.includes('DESIGN.md'),
  'D1 输入集：本仓根下的 .md 都被这条腿读进来了（读的是整个目录，不是一份手抄名单）', docFiles.join(','));

let docText = '';
const bad = [];
const anchorBad = [];
let refs = 0, cont = 0, unaddressed = 0, foreign = 0;
for (const f of docFiles) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const a = audit(t);
  docText += t + '\n';
  refs += a.refs.length;
  cont += a.cont;
  unaddressed += a.unaddressed;
  foreign += a.foreign;
  for (const b of a.outOfRange) bad.push(`${f} · ${b}`);
  for (const b of a.anchorBad) anchorBad.push(`${f} · ${b}`);
}
const anchored = anchorCount(docText);
notes.push(`解析 ${refs} 条 · 续引 ${cont} 条 · 无法定址 ${unaddressed} 处 · 带指认 ${anchored} 条 · 跨仓引用 ${foreign} 处`);

ok(refs >= 60, 'D2a 覆盖面：这条腿从文档里解析到的引用数多到它自己算覆盖面（少于 60 条就是输入集缩了或引用格式改了）',
  `解析 ${refs} 条`);
ok(bad.length === 0, 'D2 边界：文档里每一条 `文件:行号` 都在盘上、在界内，且被指的那几行整段不许是空行（在界内不等于指到了代码）',
  `解析 ${refs} 条` + (bad.length ? ` · 不在的 ${bad.length} 处：${bad.slice(0, 6).join(' | ')}` : ' · 逐条开过文件'));
ok(anchorBad.length === 0, 'D3 锚点：贴着引用的那个名字真的作为完整标识符出现在被指的那几行里（漂到隔壁一行要红）',
  anchorBad.length ? `锚点漂 ${anchorBad.length} 处：${anchorBad.slice(0, 6).join(' | ')}` : `${anchored} 条带指认的全部落回原处`);
ok(anchored >= 6, 'D3a 锚点非空转：文档里确实有足够多的引用带指认（少于 6 条就是锚点那半在空转）', `${anchored} 条带指认`);

const eqn = (label, re, mine) => {
  const claims = [...docText.matchAll(re)].map((x) => Number(x[1]));
  ok(label, claims.length >= 1 && claims.every((c) => c === mine),
    `闸数到 ${mine} · 文档写了 ${claims.length} 处：${[...new Set(claims)].join('/') || '（一处都没写）'}`);
};
eqn('D4 等式「解析 N 条」', /解析 (\d+) 条/g, refs);
eqn('D4 等式「无法定址 N 处」（借不到出处的续引：不判错，也不静默跳过）', /无法定址 (\d+) 处/g, unaddressed);
eqn('D4 等式「N 条带指认」（只写下限抓不住"文档抄的是上一轮那个数"）', /(\d+) 条(?:贴着引用写了指认|带指认)/g, anchored);
eqn('D4 等式「续引 N 条」（同句内借到出处的条数）', /续引 (\d+) 条/g, cont);
eqn('D4 等式「跨仓引用 N 处」（本仓一份跨仓引用都没有，这个数就该是 0，写歪一样红）', /跨仓引用 (\d+) 处/g, foreign);

const cX = audit('这条分工照 `../z-biz-game-other-cos/tools/balance.mjs:99999` 那份');
ok('D5 跨仓引用不参与本仓的越界检查（否则单仓 checkout 里必红、CI 里红、换台机器绿）',
  cX.foreign === 1 && cX.outOfRange.length === 0 && cX.refs.length === 1,
  `foreign=${cX.foreign} refs=${cX.refs.length} 红=${cX.outOfRange.join(' | ') || '无'}`);
const cY = audit('本仓的假路径 `tools/nope-here.js:9`');
ok('D5 同一条腿对本仓路径照旧判红：上一条的绿不是"什么都不查"',
  cY.foreign === 0 && cY.outOfRange.length === 1 && cY.outOfRange[0].includes('文件不存在'),
  `foreign=${cY.foreign} 红=${cY.outOfRange.join(' | ') || '（没红）'}`);

if (!SYM) {
  ok('D6 续引控制腿的靶子：本仓源码里现量得到一个可当阳性的声明（量不到就没有一条控制腿被证明过）', false,
    '现量不到符号靶子 —— 这一整节的口径没被证明过');
} else {
  const F = SYM.file, N = SYM.name, L = SYM.line;
  const cite = '`' + `${F}:${L}` + '`';
  const cG = audit('`' + N + '`（' + cite + '）、`' + N + '`（`:' + L + '`）');
  ok('D6a 续引在同句内借到出处，并带上自己那一格的指认',
    cG.refs.length === 2 && cG.cont === 1 && cG.unaddressed === 0 &&
    cG.outOfRange.length + cG.anchorBad.length === 0 && cG.refs.every((r) => r.path === F) &&
    cG.refs.filter((r) => r.anchor === N).length === 2,
    [...cG.outOfRange, ...cG.anchorBad].join(' | ') + `（refs=${cG.refs.length} 借到=${cG.cont} 借不到=${cG.unaddressed}）`);
  const cW = audit('`' + N + '`（' + cite + '）。\n`X`（`:' + L + '`）');
  ok('D6b 句号把借的窗口关上：下一句的续引不许挂到上一句的出处上',
    cW.refs.length === 1 && cW.unaddressed === 1, `refs=${cW.refs.length} 借不到=${cW.unaddressed}`);
  const cP = audit('`' + N + '`（' + cite + '）、\n`X`（`:' + L + '`）');
  ok('D6c 软换行不算换句：同一句折行后续引照样借得到',
    cP.refs.length === 2 && cP.unaddressed === 0, `refs=${cP.refs.length} 借不到=${cP.unaddressed}`);
  const cH = audit('`' + N + '`（' + cite + '）\n\n## 续\n`X`（`:' + L + '`）');
  ok('D6d 空行与新标题同样截断这次借', cH.refs.length === 1 && cH.unaddressed === 1,
    `refs=${cH.refs.length} 借不到=${cH.unaddressed}`);
  const cB = audit('`' + N + '`（' + cite + '）、`X`（`:99999`）');
  ok('D6e 借来的路径喂进边界检查：续引写一个越界的行号必须红，并点名被借的那个文件',
    cB.outOfRange.length === 1 && cB.outOfRange[0].includes(F) && cB.outOfRange[0].includes('越界'),
    cB.outOfRange.join(' | ') || '（没红）');
  const cF = audit('这套实现住在 `' + F.split('/').pop() + '` 里，`X`（`:' + L + '`）');
  ok('D6f 正文里提到的文件名不是出处：这种写法必须算借不到，而不是在错的文件上判绿',
    cF.refs.length === 0 && cF.unaddressed === 1, `refs=${cF.refs.length} 借不到=${cF.unaddressed}`);
  const cC = audit('这套实现住在 `' + F.split('/').pop() + '` 里，`X`（' + cite + '）');
  ok('D6g 同一句改写成完整引用就读得回来：上一条红的是写法，不是解析器漏了这一句',
    cC.refs.length === 1 && cC.unaddressed === 0 && cC.outOfRange.length + cC.anchorBad.length === 0,
    [...cC.outOfRange, ...cC.anchorBad].join(' | ') + `（refs=${cC.refs.length} 借不到=${cC.unaddressed}）`);
}

if (!SYM || !BLANK || !PREFIX) {
  ok('D7 九把假引用：现量不出符号 / 空行 / 前缀靶子，这一整节没被证明过', false,
    `SYM=${!!SYM} BLANK=${BLANK || '无'} PREFIX=${PREFIX ? PREFIX.p : '无'}`);
} else {
  const F = SYM.file, L = SYM.line;
  const pkgLines = linesOf('package.json');
  const F9 = audit('出处 `tools/nope-here.js:1`、`' + `${F}:99999` + '`、`NoSuchNameZz` 在 `' + `${F}:${L}` + '`、' +
    '`package.json`（999 行）、`' + `${F}:${L}` + '`（`makeNothingAtAll`）、`' + `${F}:${L}` + '` 的 `makeNothingAtAll`、' +
    '`' + `${F}:${L}` + '`（`makeNothingAtAll(3, 4)`）' +
    '、`' + `${F}:${BLANK}` + '`' + '、`' + `${F}:${L}` + '`（`' + PREFIX.p + '`）');
  const reds = [...F9.outOfRange, ...F9.anchorBad];
  ok('D7 假引用九把全被抓到（不存在 / 越界 / 行数错 / 「在」式后向锚点漂 / 前向括号锚点漂 / 「的」锚点漂 / ' +
    '函数调用形式锚点漂 / 无锚点落在现量空行第 ' + BLANK + ' 行 / 前缀不算整词）',
    BLANK > 1 && reds.length === 9, reds.join(' | '));
  ok('D7b 前缀靶子确实是"子串命中而整词不命中"：这一把是整词口径的哨，口径退回 .includes 的那天它就红',
    PREFIX.d.text.includes(PREFIX.p) && !hasWord(PREFIX.d.text, PREFIX.p) &&
    F9.anchorBad.some((x) => x.includes(PREFIX.p)) && pkgLines !== null,
    `${PREFIX.d.file}:${PREFIX.d.line} 声明的是 ${PREFIX.d.name}，刀写的是 ${PREFIX.p}`);
}

// 牙齿的靶子现量：要挑一条**带指认**的引用，且"挪歪一格"之后的那一格必须真的有代码、
// 又真的不含那个名字——否则红的是"越界/空行"那一格，锚点这一半仍然没被证明过。
// （pencil.js:398-411 就是这个坑：412 是文件最后一行，挪过去先撞上的边界判据。）
const docRefs = parseRefs(docText).filter((r) => {
  if (!r.anchor) return false;
  const lines = linesOf(r.path);
  if (!lines || r.to + 1 > lines.length) return false;
  const land = String(lines[r.to]);
  return land.trim() !== '' && !hasWord(land, r.anchor);
});
const bite = docRefs.find((r) => {
  const span = new RegExp('`' + r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':' + r.from + '(?:-' + r.to + ')?`');
  return span.test(docText);
}) || null;
if (!bite) {
  ok('D8 这条腿对本文真有牙齿：现量不到"带指认、挪一格落在有代码且不含那个名字的行上"的引用，这一格没被证明过', false,
    '本轮现推锚点里挑不出可挪的靶子');
} else {
  const raw = '`' + `${bite.path}:${bite.from}${bite.to !== bite.from ? '-' + bite.to : ''}` + '`';
  const hits = docText.split(raw).length - 1;
  // 数的是**增量**：文档此刻若有别的红（比如某条引用的文件不在了），那些红归 D2 点名，
  // 不许顺带把这一格也弄红——一把刀只该红它该红的那一格。
  const clean = audit(docText);
  const poisoned = audit(docText.replace(raw, '`' + `${bite.path}:${bite.to + 1}` + '`'));
  const dAnchor = poisoned.anchorBad.length - clean.anchorBad.length;
  const dRange = poisoned.outOfRange.length - clean.outOfRange.length;
  ok('D8 把文档里一条真引用的行号挪歪一格，这条腿必须为它变红（"在界内"绿，锚点红）',
    hits >= 1 && dAnchor === 1 && dRange === 0,
    `needle ${raw}→${bite.path}:${bite.to + 1} 命中 ${hits} 处 · 锚点增 ${dAnchor} · 边界增 ${dRange}`);
}

// 接线：这条闸必须在本地整闸与 CI 里各跑一次，而 `npm test` 那条链的形状另有判据压着。
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const verify = fs.readFileSync(path.join(ROOT, 'tools/verify.sh'), 'utf8');
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const chain = pkg.scripts.test || '';
ok('D9a package.json 的 doctest 就是这一条命令', (pkg.scripts.doctest || '') === CMD, `${pkg.scripts.doctest}`);
ok('D9b 本地整闸 tools/verify.sh 里跑的就是这一条命令（只在 CI 跑的门不算门）', verify.includes(CMD),
  verify.split('\n').filter((l) => l.includes(CMD)).slice(0, 2).join(' / '));
ok('D9c CI 的那一步跑的也是这一条命令（与本地同一条，不是两份清单）', ci.includes(CMD),
  ci.split('\n').filter((l) => l.trim().startsWith('run:') && l.includes(CMD)).slice(0, 2).join(' / '));
const suitePin = /\[\s*"\$n"\s*=\s*(\d+)\s*\]/.exec(ci);
ok('D9d 这套不在 `npm test` 的链里，而 CI 那条「RESULT 行数 = N」的判据仍等于链里真的套数' +
  '（有人把第八套并进链里却不动那条判据，CI 会当场恒红——这一格就是拦这件事的）',
  !chain.includes(CMD) && !!suitePin && (() => {
    const names = chain.split('&&').map((s) => s.trim()).filter((s) => s.startsWith('node ')).length;
    return names === +suitePin[1];
  })(),
  `链里 node 套件 ${chain.split('&&').length} 环 · CI 判据 =${suitePin ? suitePin[1] : '读不出'} · 链含本闸=${chain.includes(CMD)}`);

// ── 打印 ──────────────────────────────────────────────────────────────────
// 条数台账：文档抄的是这条腿自己数的断言总数，所以这一条要算进它自己的数里——先拿 checks+1 去对文档，
// 再把它记成一项。有人删掉一条断言、或把输入集缩到只剩一份文档，都撞在这里。
const ledgerClaims = [...docText.matchAll(/docs-test ok=\w+ checks=(\d+)/g)].map((x) => Number(x[1]));
const totalChecks = checks + 1;
ok('D10 条数台账：文档印的「docs-test … checks=N」等于本轮实发的条数（删一条断言就撞在这里）',
  ledgerClaims.length >= 1 && ledgerClaims.every((c) => c === totalChecks),
  `本轮 ${totalChecks} 条 · 文档写了 ${ledgerClaims.length} 处：${[...new Set(ledgerClaims)].join('/') || '（一处都没写）'}`);

for (const n of notes) console.log(`  · ${n}`);
console.log(`\n文档行号对账：${docFiles.length} 份文档 · ${refs} 条引用 · ${anchored} 条带指认`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT docs-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
