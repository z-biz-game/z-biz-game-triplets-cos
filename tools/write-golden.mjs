#!/usr/bin/env node
// tools/write-golden.mjs —— 金标准铸造器：把 tools/golden.mjs 里那段冻结数据**重跑一遍**。
//
// 为什么它必须进仓而不是留在 `_tmp-` 探针里：golden.mjs 的抬头写着「数据段由某某脚本重生成」，
// 而 `_tmp-*` 在 .gitignore 里——一次 clone 之后那句话就指向一个不存在的文件。冻结的靶要是没人
// 能重铸，「金标准」就退化成一份追问不出出处的粘贴板。
//
// 两种用法：
//   node tools/write-golden.mjs            # 打印 GOLDEN-BEGIN/END 之间该放的那几行（人拿去替换）
//   node tools/write-golden.mjs --check    # 不打印数据，只断言「现在重铸的每一行与仓里那一份逐字节相同」
//
// --check 进 CI：它证明的是这批夹具**现在**还铸得出来、且与冻结的完全一致，而不是"当初铸过"。
// 口径与 tools/golden-test.mjs 互补——那个用引擎复算对账，这个比字节。
//
// 铸造配方（与冻结数据同形，一个字都不许多）：每档取 `gold-<key>-3-<t>`，t 从 0 起抽到出货为止
// （上限 40 次，上限内不出货就红）。字段序固定成 v,key,seed,w,h,reg,givens,fill,clues,fp,draws——
// 因为这里比的是字节，不是对象相等；换个键序就是假红。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePuzzle, SIZES, parseSize, fingerprint } from '../js/engine/generate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_FILE = join(ROOT, 'tools', 'golden.mjs');
const MAX_TRIES = 40;
const CHECK = process.argv.includes('--check');

// 一档：从 t=0 抽到出货，把引擎给的东西压成冻结数据的那几个串字段。
function mintOne(key) {
  const { w, h } = parseSize(key);
  for (let t = 0; t < MAX_TRIES; t++) {
    const seed = `gold-${key}-3-${t}`;
    const r = makePuzzle(seed, key);
    if (!r.ok) continue;
    const { reg, givens } = r.puzzle;
    let regS = '';
    let givS = '';
    let fillS = '';
    let clues = 0;
    for (let i = 0; i < w * h; i++) {
      regS += reg[i].toString(36);
      givS += givens[i] < 0 ? '.' : String(givens[i]);
      fillS += String(r.solution[i]);
      if (givens[i] >= 0) clues++;
    }
    return JSON.stringify({
      v: 1, key, seed, w, h, reg: regS, givens: givS, fill: fillS, clues,
      fp: fingerprint(w, h, reg, givens), draws: r.draws,
    });
  }
  return null;
}

const cast = [];
const misses = [];
for (const key of SIZES) {
  const line = mintOne(key);
  if (line === null) misses.push(key);
  else cast.push(line);
}

if (!CHECK) {
  cast.forEach((line, i) => console.log(`  ${line}${i + 1 < cast.length ? ',' : ''}`));
  if (misses.length) console.error(`NO SHIP：${misses.join('、')}（${MAX_TRIES} 次抽取内不出货）`);
  process.exit(misses.length ? 1 : 0);
}

// ── --check：切出仓里那段冻结数据，与刚铸的逐行比字节 ────────────────────────────────
// 块内除记录行以外只剩 `export const GOLDEN = [` 与 `];`，它们不以 { 起头，所以下面那道
// filter 就是"块里不许有第四条东西"的断言本身（多一条就少一条对上，条数断言当场红）。
const src = readFileSync(GOLDEN_FILE, 'utf8');
const block = src.match(/\/\/ === GOLDEN-BEGIN[\s\S]*?export const GOLDEN = \[([\s\S]*?)\];/);
const tracked = block
  ? block[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .map((l) => l.replace(/,\s*$/, ''))
  : [];

let checks = 0;
let fails = 0;
checks++;
if (misses.length) {
  console.error(`  FAIL ${misses.join('、')} 在 ${MAX_TRIES} 次抽取内不出货 ⇒ 金标准现在重铸不出来`);
  fails++;
}
checks++;
if (!block || tracked.length !== cast.length) {
  console.error(`  FAIL 条数不对：仓里 ${tracked.length} 条，重铸 ${cast.length} 条${block ? '' : '（或根本没找到 GOLDEN-BEGIN 块）'}`);
  fails++;
}
const n = block ? Math.min(tracked.length, cast.length) : 0;
for (let i = 0; i < n; i++) {
  checks++;
  if (tracked[i] === cast[i]) continue;
  console.error(`  FAIL ${SIZES[i]}：重铸的字节与冻结的那一份不同`);
  console.error(`    仓里 ${tracked[i].slice(0, 170)}`);
  console.error(`    重铸 ${cast[i].slice(0, 170)}`);
  fails++;
}
console.log(`RESULT write-golden ok=${fails === 0} checks=${checks} fails=${fails}（重铸 ${cast.length} 条 / 冻结 ${tracked.length} 条）`);
process.exit(fails ? 1 : 0);
