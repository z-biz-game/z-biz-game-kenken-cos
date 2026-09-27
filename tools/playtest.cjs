// Minimal CDP driver for headless playtesting (Node 22+ global WebSocket/fetch).
//
// env: CDP_PORT (devtools port, default 9365), BASE_URL (page URL, default
//      http://127.0.0.1:5315/)
//
//   node tools/playtest.cjs open <url>          fresh tab at <url>, prints boot logs
//   node tools/playtest.cjs eval '<expr>'       evaluate, await promises, print result
//   node tools/playtest.cjs eval '<expr>' nonav don't navigate first
//   node tools/playtest.cjs scenario <name>     inject tools/scenarios.js, run __scn.<name>()
//   node tools/playtest.cjs shot <file.png>
//   node tools/playtest.cjs logs
//
// 抄自 z-biz-game-kakuro-cos/tools/playtest.cjs（只读模板），本仓专属端口 5315 / CDP 9365
// （server.cjs:20 那行注释钉的就是这两个号）。零依赖：只用 Node 内建的 fetch + WebSocket，
// 不 npm install 任何东西 —— 装了 puppeteer 就等于让这台门禁开始怕网络抖动。
//
// Which page to attach to is decided by BASE_URL, never by a hard-coded port: an `eval` that
// silently lands on an about:blank target reads like a broken deploy. 匹配整段 URL 而不只是
// origin，因为 tools/verify.sh 要在**同一个端口上跑两种形态**（根形态与 Pages 的 /<repo>/
// 前缀形态），只看 origin 会让第二形态的驱动悄悄接回第一形态那张页面上去。
//
// scenario 命令每次都会重新注入 tools/scenarios.js 并 navigate 一次 —— 这正是
// resume-a/resume-b、dirty-a/dirty-b 这类「跨刷新」配对场景的机制：上一段场景把局面
// 留在 localStorage，下一段场景在**同一个 Chrome profile 的一次真刷新之后**跑起来，
// 读到的是磁盘上的存档，不是内存里的残骸。
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9365);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5315/';
const ORIGIN = new URL(BASE).origin;
const cmd = process.argv[2];
const arg = process.argv[3];
const rest = process.argv[4];
// 本 BASE 之下的页面（带路径前缀的形态匹配前缀）
const isHere = (u) => typeof u === 'string' && u.startsWith(BASE);
// 同源但不是本形态的残留页：只有关掉它们的权利，没有替它们答题的权利
const isSibling = (u) => typeof u === 'string' && u.startsWith(ORIGIN) && !isHere(u);

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
      if (t.type === 'page' && (isHere(t.url) || isSibling(t.url))) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId });
        } catch { /* already gone */ }
      }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isHere(t.url));
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

  if (cmd === 'open') {
    await navigate(arg || BASE);
    await sleep(400);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (rest !== 'nonav') await navigate(BASE);
    const out = await evaluate(arg);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  } else if (cmd === 'scenario') {
    const src = fs.readFileSync(path.join(__dirname, 'scenarios.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sessionId);
    await navigate(BASE);
    // Headless reports the page as hidden, and the render loop is allowed to skip
    // frames when hidden — so a scenario that waits on animation would time out
    // against a browser that is only pretending to be in the background.
    await evaluate(`Object.defineProperty(document,'hidden',{get:()=>false,configurable:true});
      Object.defineProperty(document,'visibilityState',{get:()=>'visible',configurable:true});'ok'`);
    const out = await evaluate(`(async()=>{
      if (!window.__scn) throw new Error('scenarios.js never installed');
      const r = await window.__scn[${JSON.stringify(arg)}]();
      return JSON.stringify(r);
    })()`);
    // Console noise first, machine-readable line last: the parser in verify.sh takes the
    // final RESULT line, so a stray '{' in a log cannot hijack the report.
    if (logs.length) console.error(logs.slice(-40).join('\n'));
    console.log('RESULT ' + out);
  } else if (cmd === 'shot') {
    // A background tab only pushes compositor frames when something repaints it, so a
    // capture taken right after a pure CSS state change (hiding one screen, showing
    // another) can return the previous frame. Bringing the target forward forces one.
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
  console.error('ERROR ' + (err.message || err));
  if (logs.length) console.error(logs.slice(-12).join('\n'));
  process.exit(1);
});
