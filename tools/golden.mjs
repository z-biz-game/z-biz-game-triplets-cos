// golden 快照：**纯数据 + 纯函数**，一个 node API 都不许出现（fs/path/url/process/Date 全无）。
//
// 理由是它同时是「浏览器轮的对照物」：tools/playtest.cjs 把这个文件的字节读出来，注入成一个
// Blob 模块，页面里的 Chrome 用它**自己的**引擎把同样的 seed 重画一遍，再和这里冻结的数据对账。
// 这一条证明的是「同一个 seed 在 node 和 Chrome 里画出同一张盘」——也正是界面上那句
// 「seed 可以直接敲回来」唯一可信的版本。对侧的账由 tools/golden-test.mjs 在 node 里逐条复核
// （它才是允许 import 引擎、允许用 fs 的那半边）。
//
// 冻结的字段（一条记录 = 一个固定 seed 走完整条流水线的所有结果）：
//   key      : 菜单档（generate.js 的 SIZES 之一）
//   seed     : **原始 seed**（不是引擎内部派生过的那一个，界面和存档用的都是它）
//   reg      : 区域编号表，每格一个字符、36 进制（nr ≤ 32 < 36，菜单内所有档都成立）
//   givens   : 题面给的符号，'.' = 空；与 reg 同长
//   fill     : 唯一解（=门禁在浏览器里逐格核对的那一份，也是「点鼠标能不能解完」的靶）
//   clues    : 题面给的格数
//   fp       : fingerprintOf(记录) 的冻结值，口径与 js/engine/generate.js 的 fingerprint() 完全一致
//   draws    : 为了出这一盘抽了几次卡（>1 就说明这一档的出货没那么便宜，读数是给 ceiling 看的）
//
// ⚠ fill 是**答案**。这整个文件住在 tools/ 下，而 .github/workflows/pages.yml 的 artifact
//   只打包 index.html、css/、js/ —— 答案不进线上产物，界面上也没有一条路读得到它。
//   数据段由 tools/write-golden.mjs 重生成（只替换 BEGIN/END 之间那几行；`--check` 会把现在铸出来的
//   与下面这段逐字节比一次，CI 跑的就是它）。下面的 fingerprintOf / regOf / givensOf / fillOf 是人写的，不会被覆盖。

export const GOLDEN_SCHEMA = 1;

// 指纹口径（写死在这里，浏览器和 node 共用同一个函数，所以两侧不可能各算一套）：
//   `${w}x${h}|${reg 的 36 进制串}|${givens 串（空格是 '.'）}`
// 与 js/engine/generate.js 的 fingerprint(w,h,reg,givens) 逐字符同形 —— 那边改口径，
// golden-test 就会红，逼着两边一起改。
export function fingerprintOf(rec) {
  if (!rec || typeof rec.reg !== 'string' || typeof rec.givens !== 'string') {
    throw new Error('fingerprintOf 要吃 {w,h,reg,givens}（都是串）');
  }
  return `${rec.w}x${rec.h}|${rec.reg}|${rec.givens}`;
}

// 三个把冻结的串还原成引擎要的 Int8Array 的小函数。同样是纯的，浏览器和 node 共用。
// 这里不 import 引擎：本文件必须是零依赖字节，注入成 Blob 模块也能跑。
export function regOf(rec) {
  const out = new Int8Array(rec.reg.length);
  for (let i = 0; i < rec.reg.length; i++) out[i] = parseInt(rec.reg[i], 36);
  return out;
}

export function givensOf(rec) {
  const out = new Int8Array(rec.givens.length);
  for (let i = 0; i < rec.givens.length; i++) {
    const c = rec.givens[i];
    out[i] = c === '.' ? -1 : Number(c);
  }
  return out;
}

export function fillOf(rec) {
  const out = new Int8Array(rec.fill.length);
  for (let i = 0; i < rec.fill.length; i++) out[i] = Number(rec.fill[i]);
  return out;
}

export function puzzleOf(rec) {
  return { w: rec.w, h: rec.h, reg: regOf(rec), givens: givensOf(rec) };
}

// === GOLDEN-BEGIN（重生成时只替换这一段；来源 tools/write-golden.mjs，2026-09-28 跑过）===
export const GOLDEN = [
  {"v":1,"key":"4x6","seed":"gold-4x6-3-0","w":4,"h":6,"reg":"117713376630260025442554","givens":".1.1...0..0....1.....0.2","fill":"112112100101121110221002","clues":7,"fp":"4x6|117713376630260025442554|.1.1...0..0....1.....0.2","draws":1},
  {"v":1,"key":"6x6","seed":"gold-6x6-3-0","w":6,"h":6,"reg":"3100073115573aa257ba2288b99968b44466","givens":"...1.2.2.......2............0.1.2.1.","fill":"121112122002100202202211011101122212","clues":8,"fp":"6x6|3100073115573aa257ba2288b99968b44466|...1.2.2.......2............0.1.2.1.","draws":1},
  {"v":1,"key":"6x8","seed":"gold-6x8-3-0","w":6,"h":8,"reg":"77aa2274aee2f44eddf3999df3360055660815bcc811bbc8","givens":"2...0..2.......1.........0..0212......20.22.....","fill":"210202021021122100010210202102120210202002220101","clues":13,"fp":"6x8|77aa2274aee2f44eddf3999df3360055660815bcc811bbc8|2...0..2.......1.........0..0212......20.22.....","draws":1},
  {"v":1,"key":"6x9","seed":"gold-6x9-3-0","w":6,"h":9,"reg":"03321h03221h0ccc1h5ff88855fa7e944a7e946a7e9g66bbggdddb","givens":"......2..21..........1.......2.2....1......0.0.2.212..","fill":"212012201212212012120120201012022120121201202022121202","clues":13,"fp":"6x9|03321h03221h0ccc1h5ff88855fa7e944a7e946a7e9g66bbggdddb|......2..21..........1.......2.2....1......0.0.2.212..","draws":1},
  {"v":1,"key":"8x9","seed":"gold-8x9-3-0","w":8,"h":9,"reg":"ee5599cced5g9bbclddggnb2lmmknn22lmhkka77fhh44aa7f6648811fi608j13ii00jj33","givens":"2.1.1...........1.2.........0.....2..1.........2..0.1....0......2...0.0.","fill":"221212102101010210202021020100112120212202210202210210101021212121020202","clues":15,"fp":"8x9|ee5599cced5g9bbclddggnb2lmmknn22lmhkka77fhh44aa7f6648811fi608j13ii00jj33|2.1.1...........1.2.........0.....2..1.........2..0.1....0......2...0.0.","draws":1},
  {"v":1,"key":"9x9","seed":"gold-9x9-3-0","w":9,"h":9,"reg":"doooqqqnndgkkp111ndgkppfff5agh447ll5ahh477lj5amm6663jjbme003388bbee0cc82999iiic22","givens":"1....2.1...0...0..0...0.2............2....1.2..0......0...0.........1.1...2.....0","fill":"102122210210010002020202221102120110022012102210120200021002211210201010102120200","clues":18,"fp":"9x9|doooqqqnndgkkp111ndgkppfff5agh447ll5ahh477lj5amm6663jjbme003388bbee0cc82999iiic22|1....2.1...0...0..0...0.2............2....1.2..0......0...0.........1.1...2.....0","draws":1},
  {"v":1,"key":"8x12","seed":"gold-8x12-3-0","w":8,"h":12,"reg":"66g4ee5562g44eh522grrrhh7mm11sss77m1oottbbbpojitnnppjjiiqnlllkkkqquccffv00uucf8v309dd88v3399daaa","givens":".....1......2..10........12....2...2..0....0...0...........0....1.2...10....0...1...2..2.....1.0","fill":"220211202102210102010200212010122202010010202010021212112100010210212010012202011201200220120120","clues":22,"fp":"8x12|66g4ee5562g44eh522grrrhh7mm11sss77m1oottbbbpojitnnppjjiiqnlllkkkqquccffv00uucf8v309dd88v3399daaa|.....1......2..10........12....2...2..0....0...0...........0....1.2...10....0...1...2..2.....1.0","draws":1},
];
// === GOLDEN-END ===
