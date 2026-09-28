#!/usr/bin/env node
// npm run check：纯语法门。把 js/ 与 tools/ 下所有 .js/.mjs 过一遍 `node --check`。
//
// 为什么用 node 走目录而不是 shell 通配：npm 脚本走 sh，sh 不认 `**`（不会递归），括号还得转义；
// 跨 macOS/Linux 的可靠做法就是在 node 里自己走目录。
// 为什么这一门要单独存在：另外四套测试跑的是逻辑，逻辑跑不起来常常只是因为某个文件写坏了语法；
// 语法门先红，报告就直指文件名，而不是"导入时炸在第三个 await"。
//
// 本仓第一阶段没有 server.cjs / electron / shell 门禁脚本，所以那两个 EXTRA 列表是空的；
// 第二阶段加浏览器壳时把文件名补进下面两个数组，别让它们逃过 check。
import { readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// tests/ 是"从临时探针里救出来的证人"（tests/*.test.mjs，npm test 会跑它们）；
// 语法门必须也走一遍这个目录，否则第一个红会变成"测试文件写坏了没人发现"。
const DIRS = ['js', 'tools', 'tests'];
const EXTS = ['.js', '.mjs', '.cjs'];
const EXTRA_JS = []; // 第二阶段：'server.cjs'、'electron/main.cjs'、'electron/preload.cjs'、'tools/playtest.cjs'
const SHELLS = []; // 第二阶段：'tools/verify.sh'
const SKIP = (name) => name.startsWith('_tmp-'); // 仓根的临时文件不许混进门禁

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

const files = DIRS.map((d) => join(ROOT, d)).filter((d) => existsSync(d)).reduce((acc, d) => walk(d, acc), []);
for (const rel of EXTRA_JS) if (existsSync(join(ROOT, rel))) files.push(join(ROOT, rel));
if (!files.length) {
  console.error('check: 一个文件都没找到，检查目录名');
  process.exit(1);
}

let jsBad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    jsBad++;
    console.error(`✗ node --check ${relative(ROOT, f)}\n${(r.stderr || '').trim()}`);
  }
}

let shellBad = 0;
const presentShells = SHELLS.filter((rel) => existsSync(join(ROOT, rel)));
for (const rel of presentShells) {
  const r = spawnSync('bash', ['-n', join(ROOT, rel)], { encoding: 'utf8' });
  if (r.status !== 0) {
    shellBad++;
    console.error(`✗ bash -n ${rel}\n${(r.stderr || '').trim()}`);
  }
}

const bad = jsBad + shellBad;
const shellNote = presentShells.length
  ? `；bash -n：${presentShells.length - shellBad}/${presentShells.length} 个 shell 脚本${shellBad ? `，失败 ${shellBad} 个` : '，零失败'}`
  : '；bash -n：本阶段还没有 shell 脚本';
console.log(
  `node --check：${files.length - jsBad}/${files.length} 个文件语法通过（${DIRS.join('、')} 下所有 ${EXTS.join('/')}，另 ${EXTRA_JS.filter((rel) => existsSync(join(ROOT, rel))).length} 个根目录入口` +
    shellNote +
    (bad ? ` ⇒ 合计失败 ${bad} 个` : ' ⇒ 零失败') +
    '）'
);
process.exit(bad ? 1 : 0);
