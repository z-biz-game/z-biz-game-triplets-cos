#!/usr/bin/env node
// 资产门（零依赖）：把 assets/manifest.json 里登记的每一张位图在盘上验一遍。
//
// 为什么要有这一道：派工单要求「美术资产自己产、不许留空、不许占位符」，而自述不算证据。
// 这一门只认三种物证：PNG 文件签名、IHDR 里的宽高、整张字节的 sha256。于是——
//   · 0 字节或半截文件：签名/IHDR 读不出来 ⇒ 红
//   · 把 SVG 改名成 .png：签名不是 \x89PNG ⇒ 红（判 fake，不看扩展名）
//   · 手改过某张图：sha 与 manifest 不符 ⇒ 红（要改图就重跑 python3 assets/gen/gen_art.py）
//   · manifest 里没登记的新图：不红，但会作为「未登记的资产」列出来提醒
// 另外它替 index.html / css / manifest.webmanifest 核一遍**引用的路径在盘上真的存在**，
// 因为线上最容易出现的鬼状态就是「HTML 换新了、引用的图 404」。
//
// 用法： node tools/check-assets.mjs [--verbose]
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'assets', 'manifest.json');

let ok = true;
const fail = (msg) => { ok = false; console.error(`✗ ${msg}`); };
const info = [];

function pngIhdr(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

if (!existsSync(MANIFEST)) fail('assets/manifest.json 不在（跑 python3 assets/gen/gen_art.py 重铸）');
const man = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { files: {} };
const listed = Object.keys(man.files || {});
if (!listed.length) fail('assets/manifest.json 里一张图都没登记');

for (const rel of listed) {
  const meta = man.files[rel];
  const full = join(ROOT, rel);
  if (!existsSync(full)) { fail(`${rel} 登记在 manifest 里但盘上没有`); continue; }
  const buf = readFileSync(full);
  if (buf.length === 0) { fail(`${rel} 是 0 字节占位符`); continue; }
  const ihdr = pngIhdr(buf);
  if (!ihdr) { fail(`${rel} 不是真 PNG（文件头对不上；SVG 改名冒充也算这一类）`); continue; }
  if (ihdr.w !== meta.w || ihdr.h !== meta.h) fail(`${rel} IHDR=${ihdr.w}x${ihdr.h}，manifest 写的是 ${meta.w}x${meta.h}`);
  if (buf.length !== meta.bytes) fail(`${rel} 字节数=${buf.length}，manifest 写的是 ${meta.bytes}`);
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== meta.sha256) fail(`${rel} sha256=${sha.slice(0, 12)}… 与 manifest 的 ${String(meta.sha256).slice(0, 12)}… 不符（改图请重跑生成器）`);
  info.push(`${rel} ${ihdr.w}x${ihdr.h} ${buf.length}B ${sha.slice(0, 8)}`);
}

// manifest 之外还有没有位图躺在仓里（未登记 = 这一门看不见它，等于没门）
const seen = new Set(listed);
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'gen') walk(p); continue; }
    if (!p.endsWith('.png')) continue;
    const rel = relative(ROOT, p);
    if (!seen.has(rel)) fail(`${rel} 是盘上的位图但没登记进 assets/manifest.json`);
  }
};
for (const dir of ['icons', 'assets']) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));

// ── 引用完整性：页面/样式表/manifest 里写的每一个本地路径都要在盘上 ─────────────────
const REF_RE = /(?:href|src|content|url)\s*[=(]?\s*["']?([^"')\s,]+\.(?:png|webp|svg|ico|webmanifest|css|js))["')]/gi;
const refs = new Map();
const collect = (rel, text) => {
  for (const m of text.matchAll(REF_RE)) {
    const raw = m[1];
    if (/^(https?:|data:|mailto:)/.test(raw)) continue;
    const base = rel === 'index.html' ? ROOT : join(ROOT, dirname(rel));
    const target = resolve(base, raw.replace(/^\//, ''));
    refs.set(`${rel} → ${raw}`, existsSync(target));
  }
};
collect('index.html', readFileSync(join(ROOT, 'index.html'), 'utf8'));
collect('css/game.css', readFileSync(join(ROOT, 'css', 'game.css'), 'utf8'));
for (const cand of ['manifest.webmanifest', 'manifest.json']) {
  if (existsSync(join(ROOT, cand))) collect(cand, readFileSync(join(ROOT, cand), 'utf8'));
}
for (const [ref, hit] of refs) if (!hit) fail(`引用指向盘上不存在的路径：${ref}`);

const big = listed.filter((r) => man.files[r].w >= 180 && man.files[r].h >= 180);
console.log(`assets: ${listed.length} 张真 PNG（≥180 边长 ${big.length} 张）、引用 ${refs.size} 条全部命中` +
  (ok ? ' ⇒ 零失败' : ' ⇒ 有失败见上'));
if (process.argv.includes('--verbose')) for (const line of info) console.log('  ' + line);
process.exit(ok ? 0 : 1);
