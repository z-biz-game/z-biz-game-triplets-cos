// 32 位 FNV 哈希 + mulberry32。rng 只吃字符串，所以同一个 seed 在任何一台机器上都画出同一张盘：
// 存档只需要记 seed，恢复时重新生成即可。
//
// 本仓的随机数只有这一个入口。任何"看上去更随机"的写法（Math.random / Date.now / loadavg）
// 一律禁止出现在判定路径上：门禁要在三台机器上得到同一批盘，浏览器和 node 也要给同一张。
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function makeRng(seed) {
  let a = hash32(String(seed)) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 12)) >>> 0) / 4294967296;
  };
  const api = {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    // 洗牌的随机数**全部在这里一次性抽完**，比较器里不抽随机数：
    // node 和 Chrome 的 Array#sort 实现不同（V8 对长数组用 TimSort、短的用插入排序），
    // 比较器里抽随机数会让两边挑出不同的盘，门禁连跑三次条数都在变。
    shuffle: (list) => {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    // 需要"随机序 + 稳定断键"的场合用这个：先给每一项预抽一个随机键，
    // 再按 (分数 desc, 随机键 asc, 编号 asc) 排。这样排序本身是纯函数，
    // 换一台机器、换一个 sort 实现都得到同一个序。
    keyed: (list) => list.map((v, i) => ({ v, i, k: next() })),
  };
  return api;
}
