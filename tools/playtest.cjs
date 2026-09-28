// Minimal CDP driver for headless playtesting (Node 18+ global fetch; Node 22+ global WebSocket).
//
// env: CDP_PORT (devtools port, default 9378), BASE_URL (page origin, default
//      http://127.0.0.1:5278/)
//
//   node tools/playtest.cjs open <url>          fresh tab at <url>, prints boot logs
//   node tools/playtest.cjs eval '<expr>'       evaluate, await promises, print result
//   node tools/playtest.cjs eval '<expr>' nonav don't navigate first
//   node tools/playtest.cjs scenario <name>     inject tools/scenarios.js, run __tripletsGate.<name>()
//   node tools/playtest.cjs scenario <name> '<json>'  同上，把 <json> 作为 #expect= 带进那趟导航
//   node tools/playtest.cjs --only <name>       只跑一个场景，且**一行人类可读的读数都不印**
//                                               （门禁的变异证据用它：改坏夹具之后只想知道红没红）
//   node tools/playtest.cjs shot <file.png>
//   node tools/playtest.cjs logs
//
// 注入顺序是有讲究的：__tripletsGolden 在 scenarios.js **之前**装进新文档，所以场景里的
// golden() 一调用就有；少一个都会变成「场景自己没跑起来」而不是「夹具丢了」。
//
// Which page to attach to is decided by BASE_URL's **origin**, never by a hard-coded port:
// an `eval` that silently lands on an about:blank target reads like a broken deploy.
//
// 这两个默认号是本仓自己的一对（5278 静态服务器 / 9378 DevTools），和 server.cjs 的 fallback、
// package.json 的 dev 脚本、tools/verify.sh 的默认值必须是同一批数。一个漂到别人家号上的
// 驱动器，评的是碰巧监听在那儿的另一个仓的 DOM。
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9378);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5278/';
const ORIGIN = new URL(BASE).origin;
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);

// 夹具由驱动器带进页面。
//
// tools/golden.mjs 里躺着每张出货盘的唯一解（fill），pages.yml 刻意不把 tools/ 部署上线——
// 「玩家唯一的判胜入口读不到答案」这条纪律就只剩自觉了。所以让页面去 fetch 它（旧写法：
// import(new URL('tools/golden.mjs', document.baseURI))）在线上必然 404，而 404 之后门禁
// 只会少跑几条断言，看起来像「生产环境测不出来的东西」。现在三个 URL 形态吃的是**同一批字节**：
// 本地根、Pages 前缀、线上站点，都是磁盘上这个文件的原文，和 node 侧 golden-test 读的同一份。
const GOLDEN_SRC = fs.readFileSync(path.join(__dirname, 'golden.mjs'), 'utf8');
const GOLDEN_LOADER =
  'globalThis.__tripletsGolden = async () => {\n' +
  `  const src = ${JSON.stringify(GOLDEN_SRC)};\n` +
  '  const m = await import(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));\n' +
  '  if (!Array.isArray(m.GOLDEN) || !m.GOLDEN.length || typeof m.fingerprintOf !== "function") {\n' +
  '    throw new Error("golden 夹具形状不对：GOLDEN 或 fingerprintOf 少了一个");\n' +
  '  }\n' +
  '  return m;\n' +
  '};';

const logs = [];

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) this.consume(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  consume(m) {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push(`[log:error] ${e.text} ${e.url || ''}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not bound yet */
    }
    if (Date.now() > deadline) throw new Error(`devtools never bound on :${PORT}`);
    await sleep(250);
  }
}

async function main() {
  const info = await waitForDevTools();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);

  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) {
      if (t.type === 'page' && isOurs(t.url)) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let sessionId;
  if (existing) {
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: existing.id || existing.targetId, flatten: true }));
  } else {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: GOLDEN_LOADER }, sessionId);

  const evaluate = async (expression) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: 900000 },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 120; i++) {
      const ready = await evaluate('document.readyState').catch(() => 'loading');
      if (ready === 'complete') break;
      await sleep(100);
    }
  };

  // 场景 = 注入 tools/scenarios.js、从一次全新文档开始、跑那一个函数、把报告取回来。
  // scenario 和 --only 两条命令共用这一手，区别只在**怎么把结果交出去**：前者打 RESULT 一行
  // 给门禁的解析器读，后者逐条打 FAIL 并用退出码说话（变异证据要的就是这个）。
  //
  // ⚠ 先离开这个文档、再进来。URL 只差一个 #fragment 的时候 Page.navigate 走的是**同文档
  // 片段跳转**：document 不换、window.triplets 还是上一个场景那一个、存档根本没被读过
  // （实测：导航前后 performance.timeOrigin 一模一样，而 hash 已经换掉了）。
  // resume-set → resume-check 那一对靠的就是「中间真的重载过一次」，同文档跳转会让它变成
  // 一场自己对自己答案的假绿。每个场景都从一次全新文档开始，读数才各管各的。
  //
  // 第三个参数（expect）走的是**同一趟导航**里的片段：about:blank → BASE#expect=… 是换文档，
  // 不是改片段。期望值因此不进 localStorage、也不进命令行 argv 的解析逻辑（那里面逗号、引号、
  // 中文都要命），只是 URL 的一部分。
  async function runScenario(name, expect) {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    const target = expect ? BASE + (BASE.includes('#') ? '' : '#expect=' + encodeURIComponent(JSON.stringify(expect))) : BASE;
    await navigate('about:blank');
    await navigate(target);
    // Headless reports the page as hidden, and the render loop is allowed to skip
    // frames when hidden — so a scenario that waits on animation would time out
    // against a browser that is only pretending to be in the background.
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});'ok'`);
    return await evaluate(`(async()=>{
      if (!window.__tripletsGate) throw new Error('scenarios.js never installed');
      const fn = window.__tripletsGate[${JSON.stringify(name)}];
      if (typeof fn !== 'function') throw new Error('no such scenario: ' + ${JSON.stringify(name)});
      const r = await fn();
      return JSON.stringify(r);
    })()`);
  }

  // 第三个参数：resume-check 那一段要吃的期望值（一段 JSON，来自上一个场景的读数）。
  // 只在 scenario / --only 两条命令下解析 —— `eval <expr> nonav` 的第三位是关键字，不是 JSON。
  const expectArg = (() => {
    if (!rest || (cmd !== 'scenario' && cmd !== '--only')) return null;
    try {
      return JSON.parse(rest);
    } catch {
      throw new Error(`${cmd} 的第三参数不是 JSON，读不到期望值：${String(rest).slice(0, 60)}`);
    }
  })();

  if (cmd === 'open') {
    await navigate(arg || BASE);
    await sleep(400);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (cmd === '--only') {
    const out = await runScenario(arg, expectArg);
    // 变异证据只要一件事：红没红。逐条打出来，让人（和 shell）看得见是哪一条。
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    const parsed = JSON.parse(out);
    for (const r of parsed.rows) if (!r.pass) console.log(`FAIL ${r.test} :: ${r.detail}`);
    console.log(`ONLY ${arg}: ${parsed.rows.length} checks, ${parsed.fail} failed`);
    ws.close();
    process.exit(parsed.fail ? 1 : 0);
  } else if (cmd === 'scenario') {
    const out = await runScenario(arg, expectArg);
    // Console noise first, machine-readable line last: the parser in verify.sh takes the
    // final RESULT line, so a stray '{' in a log cannot hijack the report.
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + out);
  } else if (cmd === 'shot') {
    // A background tab only pushes compositor frames when something repaints it, so a
    // capture taken right after a pure CSS state change can return the previous frame.
    await cdp.send('Page.bringToFront', {}, sessionId);
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.mkdirSync(path.dirname(arg), { recursive: true });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs') {
    console.log(logs.join('\n') || '(clean)');
  } else if (cmd === 'reload-logs') {
    await navigate(BASE);
    console.log(logs.join('\n') || '(clean)');
  } else {
    console.error('unknown command: ' + cmd);
    process.exit(64);
  }
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('RESULT ' + JSON.stringify({ scenario: cmd, fatal: String(err.message || err), logs: logs.slice(-12) }));
  process.exit(1);
});
