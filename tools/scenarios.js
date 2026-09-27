// 浏览器侧场景套件。由 tools/playtest.cjs 注入到真实页面里跑。
//
// 断言纪律（js/main.js:701 那句「harness 表面：tools/scenarios.js 只读这些」就是契约）：
// 读 DOM 几何与画布像素，不读内部标志位。点一格要真的 dispatch PointerEvent、落子要真的走
// 键盘/按钮、存档要真的从 localStorage 反解回来比对。每个失败都打「当前值 vs 期望值」，
// 每个通过也带着实测数字（坐标、像素计数、游程编码长度）。
//
// 判据出处只有两类：出货的那套引擎（window.kenken 挂的就是 main.js 用的那份模块图），以及
// `js/engine/count.js` 那台**独立的穷举计数器**——它自己不共享规则表，只共享题面文本。
// 凡「这条红到底是测试写错还是代码写错」需要裁决时，都由它来裁决。
//
// 页内 import 一律走 document.baseURI：`import('/js/engine/count.js')` 这种斜杠开头的说明符
// 在本机根形态下解得着，Pages 把仓库挂在 /<repo>/ 下面就是 404，一次失败的动态 import 会把
// 整段场景拦腰抛断——绿的是「根本没跑」。
//
// 跨刷新配对：playtest.cjs 每次 scenario 调用都会重新注入并 navigate 一次 —— 这正是
// resume-a/resume-b、dirty-a/dirty-b 这类「跨刷新」场景的机制：上一段把局面留在 localStorage，
// 下一段在**同一个 Chrome profile 的一次真刷新之后**启动，读到的是磁盘上的存档，不是内存残骸。
// 场景之间的快照走 sessionStorage（测试自己的通道，App 依旧只写一个 localStorage 键）。

((w) => {
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String((e && e.message) || e)));
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String((e && e.reason) || e)));

  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const KEY = 'kenken.save.v1';
  const SNAP = '__kenkenScnSnap';
  const A = () => w.kenken;
  const G = () => w.kenken.game;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => (($(sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e || e.hidden) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  // ---- 页内 import：只按 baseURI 解，绝不写死斜杠根 ----------------------------------------------
  const at = (p) => new URL(p, document.baseURI).href;
  const cache = new Map();
  const mod = (p) => {
    if (!cache.has(p)) cache.set(p, import(at(p)));
    return cache.get(p);
  };

  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    const h = String(s).replace('#', '');
    return h.length >= 6 ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : [-1, -1, -1];
  };
  /** 'rgba(r,g,b,a)' → { c:[r,g,b], a }；纯 hex 的 alpha 是 1。 */
  const rgba = (s) => {
    const m = String(s).match(/rgba\(([^)]+)\)/);
    if (!m) return { c: rgb(s), a: 1 };
    const p = m[1].split(/[,\s]+/).filter(Boolean).map(Number);
    return { c: [p[0], p[1], p[2]], a: p[3] === undefined ? 1 : p[3] };
  };
  const near = (p, c, tol = 24) => p.every((v, i) => Math.abs(v - c[i]) <= tol);
  const dist = (p, c) => Math.max(...p.map((v, i) => Math.abs(v - c[i])));
  /** 前景 rgba(fg,a) 叠在 bg 上应当得到的颜色：测试自己算一遍，不抄画布的输出。 */
  const over = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
  /** 一个笼子底色的期望值：奇偶交替，只有透明度差别（js/theme.js:38）。 */
  const cageBase = (pal, i) => {
    const t = rgba(i % 2 ? pal.cageTintAlt : pal.cageTint);
    return over(t.c, rgb(pal.surface), t.a);
  };

  const pixel = (x, y) => A().pixel(x, y).slice(0, 3);
  const canvasEl = () => A().renderer.canvas();
  /** 一段 CSS 矩形里有多少像素落在目标色附近（tol 内）。 */
  function countIn(cssX, cssY, cssW, cssH, target, tol) {
    const g = A().geometry();
    const d = g.dpr;
    const x = Math.round(cssX * d);
    const y = Math.round(cssY * d);
    const ww = Math.max(1, Math.round(cssW * d));
    const hh = Math.max(1, Math.round(cssH * d));
    const data = canvasEl().getContext('2d').getImageData(x, y, ww, hh).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - target[0]) <= tol && Math.abs(data[i + 1] - target[1]) <= tol && Math.abs(data[i + 2] - target[2]) <= tol) n++;
    }
    return n;
  }

  /** 一段 CSS 矩形里与 base 相差超过 thr 的像素数（格线/粗边/字都算「差得远」）。 */
  function diffIn(cssX, cssY, cssW, cssH, base, thr = 3) {
    const g = A().geometry();
    const d = g.dpr;
    const x = Math.round(cssX * d);
    const y = Math.round(cssY * d);
    const ww = Math.max(1, Math.round(cssW * d));
    const hh = Math.max(1, Math.round(cssH * d));
    const data = canvasEl().getContext('2d').getImageData(x, y, ww, hh).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - base[0]) > thr || Math.abs(data[i + 1] - base[1]) > thr || Math.abs(data[i + 2] - base[2]) > thr) n++;
    }
    return n;
  }
  /** 同一段矩形的设备像素面积：断言按比例给阈值，dpr 变了不至于假红。 */
  function areaOf(cssW, cssH) {
    const d = A().geometry().dpr;
    return Math.max(1, Math.round(cssW * d)) * Math.max(1, Math.round(cssH * d));
  }
  /** 整张画布里被真正画过（alpha > 0）的像素数。 */
  function paintedPixels() {
    const cv = canvasEl();
    const data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  }

  // ---- 真实输入 ------------------------------------------------------------------------------------

  /** 格的 CSS 矩形（画布内坐标）与页面坐标。 */
  function cellRect(t) {
    return A().geometry().cells[t];
  }
  function atCell(t) {
    const rc = cellRect(t);
    const box = canvasEl().getBoundingClientRect();
    return { rect: rc, x: box.left + rc.cx, y: box.top + rc.cy };
  }
  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    canvasEl().dispatchEvent(ev);
    return ev;
  }
  async function tapCell(t) {
    const p = atCell(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    await wait(24);
    return p;
  }
  async function key(k) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await wait(24);
  }
  async function click(sel) {
    $(sel).click();
    await wait(30);
  }
  /** 只靠点击与键盘把一局开起来：点战役卡片 = 玩家的路。 */
  async function openLevel(id) {
    A().resetStore();
    A().showMenu();
    await wait(40);
    const card = $(`.chapter[data-level="${id}"]`);
    if (card) card.click();
    await wait(60);
    return G();
  }
  const inkOf = () => Array.from(G().ink);
  const saved = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  };
  /** 盘面读数（harness 表面）：笼的下标、格子归属，全从这里取，不碰 game.board 本体。 */
  const bd = () => A().board();
  const cageIndexOf = (t) => {
    const c = A().board().cages.find((x) => x.cells.includes(t));
    return c ? c.i : -1;
  };

  // ---- 场景 1：首屏 + 两种 URL 形态都解得开的页内 import -------------------------------------------

  const first = async () => {
    eq('页面标题', document.title, '聪明格 · KenKen 算术笼推理');
    eq('品牌行是聪明格', text('#app h1'), '聪明格');
    ck('window.kenken 挂出且带版本', typeof A().version === 'string' && /^\d+\.\d+/.test(A().version), typeof A().version);
    ck('boot() 走完了（kenkenReady）', A().ready() === true, JSON.stringify({ ready: A().ready() }));

    // 形态探针：baseURI 决定页内 import/资源往哪儿解。根形态与 Pages 前缀形态的差
    // 就在这一个路径段上，所以这一条必须在两种形态下各自成立。
    const base = new URL(document.baseURI);
    const shape = base.pathname.replace(/index\.html$/, '');
    const HERE = location.pathname.split('/').filter(Boolean)[0] || '';
    const PREFIX = '/z-biz-game-kenken-cos/';
    const isPrefix = shape === PREFIX;
    const isRoot = shape === '/';
    ck('URL 形态是根或 Pages 前缀之一', isRoot || isPrefix, `baseURI=${document.baseURI}`);
    ck('样式表按 baseURI 解到位（不是 /css/…）', [...document.querySelectorAll('link[rel=stylesheet]')].every((l) => !l.getAttribute('href').startsWith('/')), [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')).join(','));
    ck('入口脚本按 baseURI 解到位（不是 /js/…）', !document.querySelector('script[src^="/"]'), document.querySelector('script[type=module]')?.src || '');
    ck('样式表真的取到了（CSSOM 有规则）', (() => {
      for (const sh of document.styleSheets) {
        try {
          if ((sh.cssRules || []).length > 0) return true;
        } catch { /* 跨域表读不到，本仓没有 */ }
      }
      return false;
    })(), true);
    eq('模块入口解析出的绝对 URL 落在当前形态之下', new URL('js/main.js', document.baseURI).pathname, PREFIX === shape ? '/z-biz-game-kenken-cos/js/main.js' : '/js/main.js');
    void HERE;

    // 页内 import：这是「前缀形态下会不会 404」最直接的那一刀
    let cnt = null;
    try {
      cnt = await mod('js/engine/count.js');
    } catch (e) {
      ck('动态 import js/engine/count.js 成功', false, String(e && e.message));
    }
    if (!cnt) return report({ shape, base: document.baseURI });
    ck('计数器模块跟着 baseURI 解出来了', typeof cnt.countSolutions === 'function', typeof cnt.countSolutions);
    const gen = await mod('js/engine/generate.js');
    ck('生成器模块解出来了（TIERS/makePuzzle）', !!gen.TIERS && typeof gen.makePuzzle === 'function', typeof gen.makePuzzle);
    const store = await mod('js/store.js');
    ck('存档模块解出来了（sanitize/encodeRuns）', typeof store.sanitize === 'function' && typeof store.encodeRuns === 'function', Object.keys(store).join(','));
    const lib = await mod('js/data/campaign.js');
    ck('战役目录模块解出来了', Array.isArray(lib.CAMPAIGN.levels), typeof lib.CAMPAIGN.levels);

    ck('开局前是选档页', shown('#view-menu') && !shown('#view-game'));
    eq('档位数量与 TIERS 一致', $$('#tier-list .tier').length, A().tiers.length);
    eq('TIERS 五档', A().tiers.length, 5);
    eq('战役卡片数 = 目录关数', $$('.chapter').length, A().campaign.length);
    eq('目录 20 关', A().campaign.length, 20);
    eq('章节分组数', $$('.chapter-group').length, 4);
    eq('规则表四条', $$('.rules li').length, 4);
    eq('纪录行数 = 档位数', $$('#record-list li').length, A().tiers.length);
    ck('首屏（选档页）无未捕获异常', errors.length === 0, errors.join(' | '));

    // 对局视图开局前是**整块隐藏**的（index.html:75 hidden + css/game.css:5 [hidden]{display:none!important}）。
    // 于是画布此刻既没被量过也没被画过：这不是 bug，是 showGame() 之前不该布局的事实——
    // 隐藏块里 getBoundingClientRect().width 是 0，那时候布局只会得到 measure() 兜底的
    // 120px 假盘（js/render/board.js:22）。场景要断的是「进对局之前不许有布局」。
    ck('对局页开局前整块隐藏', $('#view-game').hidden && !shown('#view-game'), JSON.stringify({ hidden: $('#view-game').hidden, shown: shown('#view-game') }));
    eq('未进对局时 layout 还没建（geometry() 为 null）', A().geometry(), null);
    eq('隐藏块里的画布 CSS 宽为 0', Math.round($('#board').getBoundingClientRect().width), 0);

    // 玩家的路：点第 1 关的卡片。这一步之后画布才既有尺寸也有像素。
    $('.chapter[data-level="1"]').click();
    await wait(80);
    ck('点卡片进了对局页', shown('#view-game') && !shown('#view-menu'), JSON.stringify({ game: shown('#view-game'), menu: shown('#view-menu') }));
    const cv = $('#board');
    const box = cv.getBoundingClientRect();
    ck('画布真的有尺寸了', box.width > 100 && box.height > 100, `${box.width}x${box.height}`);
    const geo = A().geometry();
    const theme = await mod('js/theme.js');
    ck('进对局后 layout 建起来了', !!geo, String(geo));
    eq('画布 CSS 宽 = geometry.cssW', Math.round(box.width), geo.cssW);
    eq('画布 CSS 高 = boardPx + 2×inner', Math.round(box.height), geo.boardPx + 2 * theme.Space.inner);
    eq('盘面像素 = cell × size', geo.boardPx, geo.cell * geo.size);
    eq('backing = css × dpr', cv.width, Math.round(geo.cssW * geo.dpr));
    eq('backing 高 = css 高 × dpr', cv.height, Math.round(geo.cssH * geo.dpr));
    ck('dpr 落在 1..3', geo.dpr >= 1 && geo.dpr <= 3, String(geo.dpr));
    eq('geometry 的格子数 = size²', geo.cells.length, geo.size * geo.size);
    eq('开的是战役第 1 关', A().state().levelId, 1);
    eq('第 1 关是 4 阶', geo.size, A().campaign[0].size);
    eq('底部印记写着战役关数与存档键', text('#build-stamp'), `v${A().version} · 战役 ${A().campaign.length} 关 · 存档键 ${KEY}`);

    // token 只有一份：样式表的自定义属性必须与画布用的 Palette 同值
    const pal = theme.Palette;
    eq('--ink 与 Palette.ink 同值', cssVar('--ink').toUpperCase(), pal.ink.toUpperCase());
    eq('--line-heavy 与 Palette.lineHeavy 同值', cssVar('--line-heavy').toUpperCase(), pal.lineHeavy.toUpperCase());
    eq('--space-inner 与 Space.inner 同值', cssVar('--space-inner'), theme.Space.inner + 'px');
    ck('进对局后仍无未捕获异常', errors.length === 0, errors.join(' | '));
    return report({ shape, cell: geo.cell, dpr: geo.dpr, css: `${Math.round(box.width)}x${Math.round(box.height)}`, cages: A().board().cages.length });
  };

  // ---- 场景 2：规则可靠性 + 唯一解由独立计数器逐格复核 + 零猜测 -------------------------------------

  const engine = async () => {
    const cnt = await mod('js/engine/count.js');
    const kk = await mod('js/engine/kenken.js');
    const { CAMPAIGN } = await mod('js/data/campaign.js');

    // 笼运算的四条口径（测试自己按规则文本算，不调用被测函数）
    ck('= 定值笼只认那一格本身', kk.cageHolds('=', 3, [3], 5) === true && kk.cageHolds('=', 3, [1, 2], 5) === false);
    ck('+ 与 * 与次序无关', kk.cageHolds('+', 7, [3, 4], 5) && kk.cageHolds('+', 7, [4, 3], 5) && kk.cageHolds('*', 12, [3, 4], 5) && kk.cageHolds('*', 12, [4, 3], 5));
    ck('− 取绝对值、只用于两格笼', kk.cageHolds('-', 1, [2, 3], 5) && kk.cageHolds('-', 1, [3, 2], 5) && kk.cageHolds('-', 1, [1, 2, 3], 5) === false);
    ck('÷ 要整除且与次序无关', kk.cageHolds('/', 2, [2, 4], 5) && kk.cageHolds('/', 2, [4, 2], 5) && kk.cageHolds('/', 2, [2, 5], 5) === false);
    ck('界外数字一律不算成立', kk.cageHolds('+', 8, [0, 8], 7) === false && kk.cageHolds('+', 8, [8, 0], 7) === false && kk.cageHolds('*', 6, [1, 6], 5) === false);
    ck('0 与 N+1 这类越界值进不了单格笼', kk.cageHolds('=', 0, [0], 5) === false && kk.cageHolds('=', 6, [6], 5) === false);

    // 结构校验：createBoard 该拒的都拒
    const bad = (label, fn) => {
      let threw = '';
      try {
        fn();
        threw = 'NOTHROW';
      } catch (e) {
        threw = String(e.message || e);
      }
      ck(label, threw !== 'NOTHROW' && threw.length > 0, threw);
    };
    bad('两格笼写 −0 被拒（相邻必然不同值）', () => kk.createBoard({ size: 4, cages: [{ cells: [0, 1], op: '-', target: 0 }, { cells: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], op: '+', target: 50 }, { cells: [14], op: '=', target: 1 }, { cells: [15], op: '=', target: 2 }] }));
    bad('单格笼写 + 被拒', () => kk.boardFromText(4, '+4:00'));
    bad('定值笼给两格被拒', () => kk.boardFromText(4, '=4:0001'));
    bad('格子被两个笼同时盖住被拒', () => kk.boardFromText(4, '+3:0001;+4:0102;=1:02;=1:03;=1:04;=1:05;=1:06;=1:07;=1:08;=1:09;=1:0a;=1:0b;=1:0c;=1:0d;=1:0e;=1:0f'));
    bad('笼不连成一片被拒', () => kk.boardFromText(4, '+4:0003;=1:01;=1:02;=1:04;=1:05;=1:06;=1:07;=1:08;=1:09;=1:0a;=1:0b;=1:0c;=1:0d;=1:0e;=1:0f'));
    bad('有格子不属于任何笼被拒', () => kk.boardFromText(4, '+4:0001;=1:02;=1:03;=1:04;=1:05;=1:06;=1:07;=1:08;=1:09;=1:0a;=1:0b;=1:0c;=1:0d;=1:0e'));
    bad('单格笼写了盘外的数字被拒', () => kk.boardFromText(4, '=9:00'));
    bad('越界格子下标被拒', () => kk.boardFromText(4, '+4:000p'));
    // 计数器的口径是「只吃题面文本」：它靠这一点跟规则表分家，但它**不是**只收字符串——
    // 任何带着 size + text 的东西都照数（count.js:80 就是按 text 是否存在判的）。
    // 「递 board 对象它就该抛」是测试自己猜错了口径，真正的拒收面是「没有题面文本」。
    bad('没有题面文本就被拒（只给结构不给题面，它不猜）', () => cnt.countSolutions({ size: 4 }));
    eq('带 text 的对象与纯文本给出同一个答案（分家分在题面，不在类型）', cnt.countSolutions({ size: 4, text: CAMPAIGN.levels[0].text }, { cap: 2 }).status, cnt.countSolutions(CAMPAIGN.levels[0].text, { size: 4, cap: 2 }).status);

    // 出货目录逐格复核：铅笔推得完（零猜测）+ 计数器说 UNIQUE + 两套逐格同解
    let pencilOk = 0;
    let unique = 0;
    let sameAnswer = 0;
    let permOk = 0;
    let cageOk = 0;
    let overBudget = 0;
    const worst = { nodes: 0, id: 0 };
    const firstFail = [];
    let totalNodes = 0;
    for (const lv of CAMPAIGN.levels) {
      const board = kk.boardFromText(lv.size, lv.text);
      const p = kk.solve(board);
      if (p.ok) pencilOk++;
      else if (firstFail.length < 3) firstFail.push({ id: lv.id, why: p.conflict });
      const c = cnt.countSolutions(board, { cap: 2, budget: 600000 });
      totalNodes += c.nodes;
      if (c.nodes > worst.nodes) { worst.nodes = c.nodes; worst.id = lv.id; }
      if (c.status === cnt.UNIQUE) unique++;
      if (c.first && Array.from(c.first).join(',') === lv.answer) sameAnswer++;
      if (c.status === cnt.OVERBUDGET) overBudget++;
      // 行列不重复 + 每笼算术：测试自己扫一遍，不调 verify
      const ans = lv.answer.split(',').map(Number);
      let perm = ans.length === board.n;
      for (let r = 0; r < board.size && perm; r++) {
        const inRow = new Set();
        const inCol = new Set();
        for (let q = 0; q < board.size; q++) {
          inRow.add(ans[r * board.size + q]); // 第 r 行
          inCol.add(ans[q * board.size + r]); // 第 r 列
        }
        if (inRow.size !== board.size || inCol.size !== board.size) perm = false;
        if ([...inRow, ...inCol].some((v) => !(v >= 1 && v <= board.size))) perm = false;
      }
      if (perm) permOk++;
      let holds = true;
      for (const cage of board.cages) {
        const vals = cage.cells.map((t) => ans[t]);
        let ok;
        if (cage.op === '+') ok = vals.reduce((a, v) => a + v, 0) === cage.target;
        else if (cage.op === '*') ok = vals.reduce((a, v) => a * v, 1) === cage.target;
        else if (cage.op === '-') ok = Math.abs(vals[0] - vals[1]) === cage.target;
        else if (cage.op === '/') ok = Math.max(...vals) / Math.min(...vals) === cage.target && Math.max(...vals) % Math.min(...vals) === 0;
        else ok = vals.length === 1 && vals[0] === cage.target;
        if (!ok) holds = false;
      }
      if (holds) cageOk++;
    }
    eq('20/20 关铅笔规则从空盘推到底（零猜测）', pencilOk, CAMPAIGN.levels.length);
    ck('推不完的没有（若有，列前三个）', firstFail.length === 0, JSON.stringify(firstFail));
    eq('20/20 关独立计数器说 UNIQUE', unique, CAMPAIGN.levels.length);
    eq('20/20 关计数器的解与目录里那一份逐格相同', sameAnswer, CAMPAIGN.levels.length);
    eq('一张都不许超预算（OVERBUDGET 不算 UNIQUE）', overBudget, 0);
    eq('20/20 关的答案每行每列都是 1..N 的排列', permOk, CAMPAIGN.levels.length);
    eq('20/20 关的每个笼算术都对（测试自己算）', cageOk, CAMPAIGN.levels.length);
    ck('计数器节点数最难那关仍在预算内', worst.nodes < 600000, `第 ${worst.id} 关 ${worst.nodes} 节点`);

    // 计数器说「有几个解」，也说「数不完」：预算是硬上限，一次也不许多走
    const hard = cnt.countSolutions(kk.boardFromText(CAMPAIGN.levels[4].size, CAMPAIGN.levels[4].text), { cap: 2, budget: 50 });
    eq('小预算下如实报 OVERBUDGET 而不是 UNIQUE', hard.status, cnt.OVERBUDGET);
    ck('节点数绝不越过预算（cf3794f 那次纠正的口径）', hard.nodes <= 50, `nodes=${hard.nodes} budget=50`);
    bad('读不懂的题面它抛错而不是猜（count.js:37 越界格子）', () => cnt.countSolutions('=:not-a-cage', { size: 4 }));

    // 反例（钉的是「这台机器真的会说不」）：把第 1 关里那个单格笼的目标数改成 4 阶盘上
    // 填不出来的数字，穷举计数器必须老老实实数出 0 个解。
    // 上一版这里写的是 `countSolutions(board, { givens: alt })`——计数器**没有 givens 这个
    // 旋钮**（opts 只读 cap/budget/size），传进去等于什么都没传，于是它照样报 UNIQUE：
    // 一条永远绿、而且绿得跟断言无关的期望。判据错了要改判据，不许把 want 改成当前输出。
    const lv = CAMPAIGN.levels[0];
    const board1 = kk.boardFromText(lv.size, lv.text);
    const ans1 = lv.answer.split(',').map(Number);
    eq('正例：第 1 关被独立穷举数到唯一解', cnt.countSolutions(board1, { cap: 2, budget: 600000 }).status, cnt.UNIQUE);
    const broke = lv.text.replace('=3:0e', '=9:0e');
    ck('反例题面确实动了（不是同一段文本自比）', broke !== lv.text, broke.slice(0, 20));
    const cBad = cnt.countSolutions(broke, { size: lv.size, cap: 2, budget: 600000 });
    eq('反例一个解都数不出来（NONE）', cBad.status, cnt.NONE);
    ck('反例是穷举完的，不是「没数完」（OVERBUDGET 不算说不）', cBad.nodes > 0 && cBad.solutions === 0, JSON.stringify({ nodes: cBad.nodes, solutions: cBad.solutions }));
    // 玩家的墨水改坏一格：验收器与可达性都必须点名
    const alt = ans1.slice();
    alt[0] = alt[0] === 1 ? 2 : 1;
    eq('反例墨水与真解至少差一格', alt.join(',') === lv.answer, false);
    const badList = kk.verify(board1, Uint8Array.from(alt));
    ck('独立验收对改坏的满盘说不', badList.length > 0, JSON.stringify(badList.slice(0, 2)));
    // 断言的是「判死」这件事，不是 reachable 的返回值本身：写成 ck(..., reachable(...))
    // 等于把「它说不」的期望反成了「它说行」才绿——那种绿会一直亮，直到引擎真的开始冤枉人。
    const dead = kk.reachable(board1, Uint8Array.from(alt));
    ck('改坏一格的墨水当场就把矛盾说出来（reachable 判死，不是「也许还能救」）', dead === false, `reachable=${dead}`);
    const why = kk.solve(board1, { givens: Uint8Array.from(alt) });
    ck('矛盾那句带着盘面坐标', /第\d+行\d+列|第\d+号笼/.test(why.conflict || ''), why.conflict);
    // 反向对照：真解当前提必须一路绿灯（判死不是「什么都判死」）
    eq('真解墨水判活', kk.reachable(board1, Uint8Array.from(ans1)), true);
    eq('真解墨水推到底', kk.solve(board1, { givens: Uint8Array.from(ans1) }).ok, true);
    return report({ levels: CAMPAIGN.levels.length, worstNodes: worst, totalNodes, badVerify: badList.length });
  };

  // ---- 场景 3：跨引擎指纹（同一颗种子，Chrome 里烤出的盘必须与 node 烤的那份逐格相同） ----------------

  const fingerprint = async () => {
    const gen = await mod('js/engine/generate.js');
    const { CAMPAIGN } = await mod('js/data/campaign.js');
    const cnt = await mod('js/engine/count.js');
    const kk = await mod('js/engine/kenken.js');
    ck('浏览器里能按 bake 的同一套旋钮出题', typeof gen.generate === 'function', typeof gen.generate);
    ck('烤炉用的就是这份目录（20 关 / 4 章）', CAMPAIGN.levels.length === 20 && CAMPAIGN.chapters.length === 4, JSON.stringify({ n: CAMPAIGN.levels.length, ch: CAMPAIGN.chapters.length }));

    let textSame = 0;
    let answerSame = 0;
    let scoreSame = 0;
    let cagesSame = 0;
    const diffs = [];
    const ms = [];
    for (const lv of CAMPAIGN.levels) {
      const tier = gen.TIERS.find((t) => t.key === lv.tier);
      const t0 = performance.now();
      // 与 tools/bake.mjs:73 同一串参数：改一个都不算复烤
      const r = gen.generate({ size: tier.size, cageDist: tier.cageDist, opMix: tier.opMix, band: tier.band, tries: 240, budget: 600000, seed: lv.seed });
      ms.push(Math.round(performance.now() - t0));
      if (!r || !r.ok) {
        if (diffs.length < 3) diffs.push({ id: lv.id, why: (r && r.reason) || 'null' });
        continue;
      }
      if (r.text === lv.text) textSame++;
      else if (diffs.length < 3) diffs.push({ id: lv.id, got: r.text.slice(0, 40), want: lv.text.slice(0, 40) });
      if (Array.from(r.solution).join(',') === lv.answer) answerSame++;
      if (r.score === lv.score) scoreSame++;
      if (r.cages === lv.cages) cagesSame++;
    }
    eq('20/20 关：Chrome 按种子重出的题面文本与 node 烤的逐字符相同', textSame, 20);
    eq('20/20 关：解逐格相同', answerSame, 20);
    eq('20/20 关：难度分相同（分数量程不漂移）', scoreSame, 20);
    eq('20/20 关：笼数相同', cagesSame, 20);
    ck('没有一张盘在两种引擎下画出两张题面', diffs.length === 0, JSON.stringify(diffs));

    // 存档只记 seed：练习盘也必须能按 ref 里那颗种子重画，且仍然唯一
    const made = gen.makePuzzle('scen|fingerprint', 'learner');
    ck('练习盘出得来（makePuzzle）', !!made && !!made.board, JSON.stringify(made && made.reason));
    const again = gen.makePuzzle('scen|fingerprint', 'learner');
    ck('同一颗种子两次出题是同一张盘（题面逐字符）', again.text === made.text, `${made.text.slice(0, 24)} vs ${again.text.slice(0, 24)}`);
    const cMade = cnt.countSolutions(made.board, { cap: 2, budget: 600000 });
    eq('练习盘也被独立计数器数到唯一解', cMade.status, cnt.UNIQUE);
    eq('计数器的解 = 铅笔的解', Array.from(cMade.first).join(','), Array.from(kk.solve(made.board).solution).join(','));
    eq('盘面的序列化文本能原样读回来', kk.boardFromText(made.size, made.text).text, made.text);

    // 界面这条路：loadPractice 走的就是同一颗种子，玩家看到的必须是上面那张盘
    A().resetStore();
    const st = A().loadPractice('scen|fingerprint', 'learner');
    eq('界面按种子开的是同一张盘', st.text, made.text);
    eq('界面读数里的档位/尺寸与烤的一致', `${st.tierName} ${st.size}×${st.size}`, `${made.tierName} ${made.size}×${made.size}`);
    eq('state().seed 就是玩家手里那颗原始种子', A().state().seed, 'scen|fingerprint');
    const t0 = performance.now();
    void t0;
    return report({ levels: 20, genMsMax: Math.max(...ms), genMsTotal: ms.reduce((a, b) => a + b, 0), textSame, answerSame });
  };

  // ---- 场景 4：真实输入这条路（点格 / 键盘 / 按钮 / 拒绝 / 铅笔 / 撤销 / 重开 / 判胜）----------------

  const play = async () => {
    const { encodeRuns, decodeRuns } = await mod('js/store.js');
    await openLevel(1);
    const board = bd();
    const size = board.size;
    const n = size * size;
    const zeros = new Array(n).fill(0).join(',');
    const cn = (t) => `第${Math.floor(t / size) + 1}行${(t % size) + 1}列`;
    const st = () => A().state();
    const ink = () => st().ink;
    const notes = () => st().notes;
    const sol = Array.from(A().solution());
    const offKeys = () => $$('#digit-pad button.digit').filter((b) => b.classList.contains('candidate-off')).map((b) => Number(b.dataset.digit)).join(',');
    const pressed = () => $$('#digit-pad button.digit').map((b) => `${b.dataset.digit}:${b.getAttribute('aria-pressed')}`).join(' ');
    const padLabel = () => $$('#digit-pad button.digit').map((b) => (b.getAttribute('aria-label') || '')).join('|');
    ck('引擎交得出这一关的解（独立计数器在 engine 场景里已逐格核对过它）', sol.length === n, JSON.stringify(sol && sol.length));
    eq('走的是玩家那条路：点战役卡片开第 1 关', st().levelId, 1);
    eq('面板名字与 ref 同源', text('#stat-name'), '战役第 1 关');
    eq('开局墨水全空', ink().join(','), zeros);
    eq('开局读数：步数/提示/冲突', `${text('#stat-moves')}/${text('#stat-hints')}/${text('#stat-conflicts')}`, '0/0/0');
    eq('开局读数：已落子', text('#stat-filled'), `0/${n}`);
    eq('数字键盘只长 size 个键', $$('#digit-pad button.digit').length, size);
    eq('键盘上的数字是 1..N', $$('#digit-pad button.digit').map((b) => b.dataset.digit).join(','), Array.from({ length: size }, (_, i) => i + 1).join(','));
    eq('开局选中第一格（firstEmpty）', st().selected, 0);

    // 1) 真点击选中 + 真键盘落子（点击落在第 6 格：换一格才点得出来，选中第 1 格是默认值）
    await tapCell(5);
    eq('点一格真的选中它（画布坐标→格下标走 hitTest）', st().selected, 5);
    A().select(0);
    await key(String(sol[0]));
    eq('键盘落子写进棋盘', ink()[0], sol[0]);
    eq('落子算一步', text('#stat-moves'), '1');
    eq('已落子读数跟着走', text('#stat-filled'), `1/${n}`);
    eq('状态行说出落在哪一格、填了什么', text('#state-line'), `${cn(0)} 填 ${sol[0]}。`);
    eq('落子把那格的铅笔作废', notes()[0], 0);

    // 2) 重按同一个数字 = 静默无事发生（不写、不计步、不污染状态行）
    await key(String(sol[0]));
    eq('重按同一数字墨水不变', ink()[0], sol[0]);
    eq('重按不许多计步', text('#stat-moves'), '1');
    eq('静默拒绝连状态行都不该动', text('#state-line'), `${cn(0)} 填 ${sol[0]}。`);

    // 3) 非法落子：必须被当场拒绝，并把矛盾说出口。测试自己按规则读一遍，判这条拒绝该不该来：
    //    ① 单格定值笼里填别的数 = 那个笼的算术不成立；② 同一行填两次同一个数 = 那行不是排列；
    //    ③ 盘外数字。三条都该「不写入、不计步、不进撤销栈」。
    const pinned = board.cages.find((c) => c.op === '=' && c.cells.length === 1 && c.head !== 0);
    const wrongForPinned = sol[pinned.cells[0]] === 1 ? 2 : 1;
    const dupRowValue = ink()[0];
    const rowMate = 1; // 与第 1 格同行的另一格（第 1 行是 0..size-1）
    const refusals = [
      { t: pinned.cells[0], v: wrongForPinned, want: `第1号笼那格只认 ${sol[pinned.cells[0]]}`, why: '测试自己算：单格定值笼只认目标数' },
      { t: rowMate, v: dupRowValue, why: '测试自己算：第 1 行已经有这个数，排列不许重来' },
      { t: 2, v: size + 1, why: '盘外数字：这盘只用 1..N' },
    ];
    for (const rf of refusals) {
      A().select(rf.t);
      const r = A().type(rf.v);
      eq(`非法落子被拒（${cn(rf.t)}=${rf.v}）`, r.state.ink[rf.t], 0);
      ck(`拒绝把矛盾说出口：${rf.why}`, typeof r.state.rejection?.why === 'string' && r.state.rejection.why.length > 8, JSON.stringify(r.state.rejection));
      ck(`那句拒绝带着盘面坐标（${cn(rf.t)}）`, /第\d+行\d+列|第\d+号笼|笼|排列|意义/.test(r.state.rejection.why), r.state.rejection?.why);
    }
    eq('三次非法落子一步都不算', text('#stat-moves'), '1');
    eq('非法落子没污染墨水', ink().join(','), [sol[0], ...new Array(n - 1).fill(0)].join(','));
    eq('非法落子不收费', text('#stat-hints'), '0');
    eq('非法落子从不产生冲突格（因为压根没落上）', st().conflicts, 0);
    eq('非法落子之后诊断口径仍是「没有对不上的笼」', st().badCages.length, 0);
    // 键盘那条路对盘外数字是「什么都不做」，不是「按了再被拒」（js/main.js:582 的 v<=size 闸）
    A().select(2);
    const lineBefore = text('#state-line');
    await key(String(size + 1));
    eq('按 5（4 阶盘外数字）墨水不动', ink()[st().selected], 0);
    eq('盘外数字连状态行都不动', text('#state-line'), lineBefore);

    // 4) 键盘导航边界：顶行往上不动、最左列往左不动、右下角往右下不动、往下一步 = +size、wasd 同路
    A().select(0);
    await key('ArrowUp');
    eq('顶行再往上仍是第 1 格', st().selected, 0);
    await key('ArrowLeft');
    eq('最左列再往左仍是第 1 格', st().selected, 0);
    await key('w');
    await key('a');
    eq('W/A 与 ↑/← 同一条路（顶行、最左列都撞不出去）', st().selected, 0);
    await key('ArrowRight');
    eq('往右一格 = 下标 +1', st().selected, 1);
    await key('d');
    eq('D 与 → 同一条路（再往右又 +1）', st().selected, 2);
    await key('ArrowDown');
    eq('行优先：往下就是 +size', st().selected, 2 + size);
    A().select(size - 1);
    await key('ArrowRight');
    eq('最右列再往右不动', st().selected, size - 1);
    await key('ArrowDown');
    eq('右上角往下 = +size', st().selected, 2 * size - 1);
    await key('ArrowDown');
    eq('再往下仍是 +size', st().selected, 3 * size - 1);
    // 手算这一格在哪：3*size-1 = 11 = 行号 2、列号 3（行号从 0 数起），离底还有一行。
    // game.move('down') 走的是 r = Math.min(size-1, r+1)（js/ui/game.js:260），size=4 时
    // 最后一行是 r=3 → t = 4*size-1 = 15 = n-1。原来这条把「3*size-1」当成了底，
    // 于是「S 撞不出去」在还差一行的时候就宣判了——实测 15 是对的，错的是 want。
    await key('s');
    eq('S 与 ↓ 同一条路（还差一行到底，照样 +size）', st().selected, n - 1);
    await key('s');
    eq('S 到底了也撞不出去（行号钳在 size-1）', st().selected, n - 1);
    A().select(n - 1);
    await key('ArrowDown');
    await key('ArrowRight');
    await key('s');
    await key('d');
    eq('右下角往下/往右都不越界', st().selected, n - 1);
    const gsel = A().geometry();
    const rcLast = gsel.cells[n - 1];
    // 读数字段查过了：harness 表面上的 geometry().cells[t] 只有 {t,x,y,s,cx,cy}
    //（js/render/board.js:398 那一行构造的就是这六个字段），**没有** r/c——渲染器内部的
    // cellRect 才有 r/c，它没往外给。所以 rcLast.r 读出来是 undefined（实测那格打印成
    // "undefined,undefined,236"）。行列按同一份几何反算：r = (y-top)/cell、c = (x-left)/cell。
    const lastRow = Math.round((rcLast.y - gsel.top) / gsel.cell);
    const lastCol = Math.round((rcLast.x - gsel.left) / gsel.cell);
    eq('选中的那一格几何上确实在最后一行最后一列', `${lastRow},${lastCol},${rcLast.y + rcLast.s}`, `${size - 1},${size - 1},${gsel.top + size * gsel.cell}`);

    // 5) 铅笔：是玩家自己的记号，引擎不替玩家写也不替玩家擦
    await click('#btn-note');
    eq('铅笔模式按钮文案', text('#btn-note'), '铅笔 开');
    eq('铅笔模式 aria-pressed', $('#btn-note').getAttribute('aria-pressed'), 'true');
    ck('数字键盘的 aria-label 跟着改成「记铅笔」', /（记铅笔）/.test(padLabel()) && !/（落子）/.test(padLabel()), padLabel());
    const noteCell = board.cages.find((c) => c.cells.length > 1).cells[1]; // +4 笼的第二格
    A().select(noteCell);
    const movesWithInk = Number(text('#stat-moves'));
    // 这一格（格 8，笼「4+」的第二格）此刻填不上哪些数字，由独立计数器 js/engine/count.js
    // 逐值穷举裁决过（tools/_tmp 探针跑的结果，写在提交正文里）：往题面里追加「格 8 = v」再数解，
    // v=1 → 0 解、v=2 → 0 解、v=3 → 1 解、v=4 → 0 解，所以键盘该划掉 1、2、4 三档。
    // 手算同一件事（只用题面自己的四条线索）：
    //   · 第 2 行（格 4..7）里格 5 被单格定值笼「3」钉死、格 6 被「2」钉死 → 格 4 只剩 1 或 4；
    //   · 第 1 列（格 0,4,8,12）里格 0 被「2」钉死、格 12 被「4」钉死 → 格 4 只剩 1 或 3；
    //     两条一交 → 格 4 = 1；
    //   · 笼「4+」= 格 4 + 格 8 = 4 → 格 8 = 3 是被迫的，1（同笼挤掉）、2（同列的格 0）、4（凑不出 4）
    //     全都填不上。
    // 原先的 want 只写了 2 与 4，漏了「格 4=1 顺着笼子把 1 也挤掉」这一层，是断言算错了。
    eq('键盘跟着盘面走：这一格只剩 3 填得上，1、2、4 全被划掉', offKeys(), '1,2,4');
    await key('1');
    await key('4');
    eq('记两笔铅笔算两步', text('#stat-moves'), String(movesWithInk + 2));
    eq('铅笔不写墨水', ink()[noteCell], 0);
    eq('两个候选位都记上了', notes()[noteCell], (1 << 1) | (1 << 4));
    eq('已落子读数不因铅笔而变', text('#stat-filled'), '1/' + n);
    eq('铅笔状态回写到数字键盘的 aria-pressed 上', pressed(), '1:true 2:false 3:false 4:true');
    await key('1');
    eq('再按同一个数字把那一笔划掉', notes()[noteCell], 1 << 4);
    eq('划掉铅笔也算一步', text('#stat-moves'), String(movesWithInk + 3));
    A().select(0);
    await key('3');
    eq('落了子的格不许再记铅笔', notes()[0], 0);
    ck('那句拒绝说清了为什么', /落了子|先擦掉/.test(st().rejection?.why || ''), st().rejection?.why);
    eq('这一下没多计步', text('#stat-moves'), String(movesWithInk + 3));
    await key('p');
    eq('P 键关回写字模式', st().noteMode, false);
    eq('按钮文案跟着回写', text('#btn-note'), '铅笔 关');
    ck('数字键盘的 aria-label 跟着改回「落子」', /（落子）/.test(padLabel()) && !/（记铅笔）/.test(padLabel()), padLabel());
    const mate = board.cages.find((c) => c.cells.includes(noteCell) && c.cells.length > 1).cells.find((t) => t !== noteCell);
    A().select(mate);
    await click(`#digit-pad button[data-digit="${sol[mate]}"]`);
    eq('点数字键（DOM 路径）也能落子', ink()[mate], sol[mate]);
    eq('那格的铅笔被数字盖掉', notes()[mate], 0);
    const playerNote = notes()[noteCell];
    await click('#btn-hint');
    eq('提示不碰玩家的铅笔', notes()[noteCell], playerNote);
    eq('提示也不替玩家填格子', ink().filter((v) => v).length, 2);
    eq('提示按了一次就收一次费', `${st().hints}/${text('#stat-hints')}/${text('#hint-count')}`, '1/1/1');
    ck('提示那条规则名是真的（四条之一）', st().hints === 1 && text('#hint-rule').length > 0, text('#hint-rule'));
    // 这一条原来要 `0/11/0/11`，是断言自己数漏了：此刻盘上只有两笔墨（格 0=sol[0]=2、
    // 格 4=sol[4]=1，见上面「点数字键（DOM 路径）也能落子」和「已落子读数」那两条），
    // 但笼 10 是一个**单格定值笼**「=2:00」——它只盖格 0，填进去的又正是 2，
    // 于是「填满且算式成立」这两件事它同时做到了，goodCages 里必须有它。
    // 其余 10 个笼都不成立：笼 1「4+」=格 4+格 8，格 8 还是空的（这就是接下来「清理铅笔」
    // 那段要用的前提）；剩下的笼各格全空。用引擎同一函数 `cageHolds` 在 node 侧复算：
    // goodCages = [10]，count = 1（探针 _tmp-kenken-p4.mjs，只读 js/engine/kenken.js）。
    // 所以「对上的笼/总笼」是 1/11，state 那边也同一口径 → 实测 `1/11/1/11` 才是对的。
    eq('第 1 关一共 11 个笼（读数与题面同口径）', `${st().goodCages.length}/${board.cages.length}/${text('#stat-cages')}`, `1/11/1/11`);

    // 6) 清理铅笔真抹掉「已不可能」的那笔：第 mate 格落了子之后，noteCell 的候选被推到只剩解，
    //    玩家记的那笔 4 已经被证明出局——「清理铅笔」这一格该擦掉它，而且不动步数、不动墨水。
    A().select(noteCell);
    const movesBeforePrune = st().moves;
    await click('#btn-prune');
    eq('清理铅笔抹掉了那笔已死的候选', notes()[noteCell], 0);
    ck('那句说明报出擦掉几个', /擦掉了 \d+ 个/.test(text('#state-line')), text('#state-line'));
    eq('清理铅笔不占步数（它不改题面）', st().moves, movesBeforePrune);
    eq('清理铅笔不碰墨水', ink().filter((v) => v).length, 2);
    const lineAfterPrune = text('#state-line');
    await click('#btn-prune');
    eq('没有可抹的候选时如实静默（状态行一字不改）', text('#state-line'), lineAfterPrune);
    eq('静默那一下仍不占步数', st().moves, movesBeforePrune);

    // 7) 存档：一个键、只记题面出处与游程编码的墨水、反解回来逐格相同
    const raw = saved();
    eq('localStorage 只有本仓那一个键', Object.keys(localStorage).join(','), KEY);
    eq('存档键名与 Store.key 一致', KEY, A().Store.key);
    ck('resume 落了盘', !!raw && !!raw.resume, JSON.stringify(raw && Object.keys(raw)));
    eq('墨水编码反解回来与棋盘逐格相同', Array.from(decodeRuns(raw.resume.ink, n)).join(','), ink().join(','));
    eq('铅笔编码反解回来与棋盘逐格相同', Array.from(decodeRuns(raw.resume.notes, n)).join(','), notes().join(','));
    eq('存的是原始种子/题面出处，不是题面文本', [raw.resume.text === undefined, raw.resume.answer === undefined, raw.resume.cages === undefined].join(','), 'true,true,true');
    eq('ref 指的是战役第 1 关', raw.resume.ref, 'level-1');
    eq('campaign 关也把烤时的种子留在档里', raw.resume.seed, 'kenken-campaign-v1-c1-newcomer');
    eq('档位与边长一起存', `${raw.resume.tier}/${raw.resume.size}`, `newcomer/${size}`);
    eq('步数与提示都落盘', `${raw.resume.moves}/${raw.resume.hints}`, `${st().moves}/1`);
    ck('一张 4 阶盘的存档小得离谱（游程编码的功劳）', JSON.stringify(raw).length < 400, `${JSON.stringify(raw).length} 字节`);
    ck('墨水串比一格一字符还短', raw.resume.ink.length <= n, `${raw.resume.ink} vs ${n} 格`);

    // 8) 撤销链条：退掉那次「清理铅笔」（它进了栈但不计步）、再退墨水、退到空盘之后如实拒绝。
    //    记账口径是「谁收过费，谁才退得起」：pruneNotes 进栈（所以撤得回）却不 moves++
    //    （js/ui/game.js:342），而 undo 读撤销帧上的 costs 才决定退不退那一步
    //    （js/ui/game.js:357）。若它无条件退一步，「清理铅笔 + 撤销」就能成对白送步数——
    //    而步数是写进 best 纪录的同分比较项（js/store.js:251），白送不得。
    const wantNoteBack = notes().slice();
    wantNoteBack[noteCell] = 1 << 4;
    const u1 = A().undo();
    eq('撤销返回明确结论', u1.ok, true);
    eq('撤销把擦掉的那笔铅笔还原', notes().join(','), wantNoteBack.join(','));
    eq('撤销把选中格也带回去', st().selected, noteCell);
    eq('退掉那笔不收费的清理，步数一分不动', st().moves, movesBeforePrune);
    // 再退一步退的才是 mate 那笔墨水（它当初收过一步）。先要这一格真的空了，
    // 「撤回来之后还能重新做一遍、并且重新计步」才有得验——上一版直接重按同一个数字，
    // 盘上墨水没被退掉，inkValue 头一行就静默返回（js/ui/game.js:289），一步都不加。
    const uBackToInk = A().undo();
    eq('再退一步退的是那笔墨水', `${uBackToInk.ok}/${ink()[mate]}`, `true/0`);
    eq('退掉收费的那一笔，步数才减一', st().moves, movesBeforePrune - 1);
    await key(String(sol[mate]));
    eq('撤销之后重做同一格仍能落子', ink()[mate], sol[mate]);
    eq('重做那一格重新计步', st().moves, movesBeforePrune);
    let guard = 0;
    while ((ink().some((v) => v) || notes().some((v) => v)) && guard++ < 200) A().undo();
    eq('一路撤销能退回到空盘（墨水与铅笔全清）', `${ink().join(',')}|${notes().join(',')}`, `${zeros}|${zeros}`);
    eq('退干净之后步数钳在 0', st().moves, 0);
    const u2 = A().undo();
    eq('空栈再撤如实拒绝而不是崩', u2.ok, false);
    ck('拒绝的话是给人看的', typeof u2.why === 'string' && u2.why.length > 0, u2.why);
    eq('空栈撤销不许多减步数（钳在 0）', st().moves, 0);
    eq('空栈撤销之后还能落子', A().type(sol[0]).state.ink[0], sol[0]);

    // 9) 重开：题面与种子不动，墨水、铅笔、步数、提示、计时全部归零
    const textBefore = board.text;
    const seedBefore = st().seed;
    await click('#btn-restart');
    eq('重开之后题面一字未改', bd().text, textBefore);
    eq('重开之后种子还是那一颗', st().seed, seedBefore);
    eq('重开清空墨水', ink().join(','), zeros);
    eq('重开清空铅笔', notes().join(','), zeros);
    eq('重开清空步数', text('#stat-moves'), '0');
    eq('重开把提示计数也一并清零（setPuzzle 不带 keep，记账从头来）', text('#stat-hints'), '0');
    eq('重开把计时归零', text('#stat-time'), '00:00');
    ck('重开那句说明是界面写死的口径', /题面没变/.test(text('#state-line')), text('#state-line'));
    const rawEmpty = saved();
    eq('重开落盘的墨水就是全 0 的游程编码', rawEmpty.resume.ink, encodeRuns(new Uint8Array(n)));
    // 编码格式查过了（js/store.js:35）：`${v.toString(36)}x${c.toString(36)}`，
    // **值与个数都是 36 进制**，个数不是十进制串。所以 16 个 0 写作 `0xg`：
    //   (16).toString(36) === 'g'，反过来 parseInt('g',36) === 16（解码端 js/store.js:60
    //   用的正是 parseInt(...,36)）。原来那条把个数当十进制读成 `0x10`——而 `0x10` 解出来是
    //   parseInt('10',36) = 36 格，比一张 6 阶盘还长，那才是坏档。
    // 写侧的上限也印证这一点：游程合并的条件是 `n < 1296`，1296 = 36²（两位数 36 进制的容量）；
    // 若个数是十进制两位串，上限该写成 99 而不是 1296。
    eq('4 阶空盘的紧凑写法是 0xg（个数也走 36 进制，16 → "g"）', encodeRuns(new Uint8Array(16)), '0xg');
    // 一写一解得回到同一张盘：只断串长会把「编码算错」一路带进存档。
    eq('写出去还能原样读回来（0xg ↔ 16 个 0）', Array.from(decodeRuns('0xg', 16)).join(','), new Array(16).fill(0).join(','));

    // 10) 按真实键盘把整盘填对 → 判胜、写纪录、清续档
    for (let t = 0; t < n; t++) {
      A().select(t);
      const r = A().type(sol[t]);
      if (!r.state.ink[t]) ck(`按解落子第 ${t} 格被接受`, false, JSON.stringify(r.state.rejection));
    }
    const won = st();
    eq('照解填完即判胜', won.won, true);
    eq('16 格 16 步，一步不多', won.moves, n);
    eq('面板读数：已落子', text('#stat-filled'), `${n}/${n}`);
    eq('面板读数：算对的笼', text('#stat-cages'), `${board.cages.length}/${board.cages.length}`);
    eq('面板读数：冲突格 0', text('#stat-conflicts'), '0');
    eq('面板读数：难度实测那格改成已解', text('#stat-score'), '已解 · 提示 0');
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案写着档位、边长、步数与笼数', new RegExp(`初学 ${size}×${size} · \\d\\d:\\d\\d · 步数 ${n} · 提示 0 · ${board.cages.length} 个笼全部算对`).test(text('#win-meta')), text('#win-meta'));
    eq('战役下一关的按钮写着第 2 关', text('#btn-again'), '第 2 关');
    const kk = await mod('js/engine/kenken.js');
    const board1 = kk.boardFromText(size, textBefore);
    eq('独立验收：verify 零违反', kk.verify(board1, Uint8Array.from(won.ink)).length, 0);
    eq('独立验收：complete 判满盘', kk.complete(board1, Uint8Array.from(won.ink)), true);
    const raw2 = saved();
    eq('赢了就不该再有可继续的盘', JSON.stringify(raw2.resume), 'null');
    eq('通关记录进了关卡号', raw2.progress.solved.join(','), '1');
    ck('同档纪录写了时间/步数/提示', raw2.best.newcomer && raw2.best.newcomer.hints === 0 && raw2.best.newcomer.moves === n, JSON.stringify(raw2.best));
    eq('累计账本记了一局', raw2.totals.solved, 1);
    eq('累计格子数', raw2.totals.cells, n);
    eq('一章五关没打完，第二章仍不解锁', raw2.chapters.unlocked, 1);
    await click('#btn-menu');
    eq('回选档后这一关标成已解', $('.chapter[data-level="1"]').getAttribute('aria-pressed'), 'true');
    eq('已解的角标改成文字', $('.chapter[data-level="1"] .badge').textContent, '已解');
    eq('未解锁章节的卡片都挂着锁角标', $$('.chapter.locked').length, A().campaign.length - 5);
    eq('锁着的卡片是 disabled（点它不开局）', $('.chapter[data-level="6"]').disabled, true);
    return report({ level: 1, size, moves: won.moves, refused: refusals.length, cages: board.cages.length, bytes: JSON.stringify(raw).length, inkCode: raw.resume.ink });
  };


  // ---- 场景 5：触控下限 / 命中盒 / 布局公式 / 画布像素 ----------------------------------------------

  const ui = async () => {
    const theme = await mod('js/theme.js');
    const pal = theme.Palette;
    await openLevel(1);
    const geo = () => A().geometry();
    const board = bd();
    const sol = Array.from(A().solution());
    const g0 = geo();
    const size = g0.size;
    const cell = g0.cell;
    const n = size * size;
    const cv = $('#board');
    const baseOf = (t) => cageBase(pal, cageIndexOf(t));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const labH = Math.round(cell * theme.Cell.labelScale) + 5;      // 底衬高度：round(cell×0.34)+5
    const box = () => cv.getBoundingClientRect();
    /** 一格里避开笼标签、避开 1px 笼缝的那片「干净底色」：底部居中一小块。 */
    const patch = (t) => {
      const rc = geo().cells[t];
      const p = Math.max(4, Math.round(rc.s * 0.16));
      const side = Math.max(3, Math.round(rc.s * 0.08));
      return { x: rc.x + rc.s / 2 - p / 2, y: rc.y + rc.s - p - side, w: p, h: p };
    };
    const pa = (t) => { const q = patch(t); return areaOf(q.w, q.h); };
    /** 数字的取样框：字心偏下（`fillText(v, 0, cell*0.04)`），且要让开笼标签那条底衬。 */
    const digitBox = (t) => {
      const rc = geo().cells[t];
      const w = Math.round(rc.s * 0.5);
      const h = Math.round(rc.s * 0.4);
      return { x: rc.x + (rc.s - w) / 2, y: rc.y + Math.round(rc.s * 0.45), w, h };
    };
    /** 一片矩形里离 base 最远的那个像素（字/边的「芯」）与它离 base 多远。 */
    function core(cssX, cssY, cssW, cssH, base) {
      const d = geo().dpr;
      const x = Math.round(cssX * d);
      const y = Math.round(cssY * d);
      const ww = Math.max(1, Math.round(cssW * d));
      const hh = Math.max(1, Math.round(cssH * d));
      const data = canvasEl().getContext('2d').getImageData(x, y, ww, hh).data;
      let best = [0, 0, 0];
      let bestD = -1;
      for (let i = 0; i < data.length; i += 4) {
        const p = [data[i], data[i + 1], data[i + 2]];
        const dd = dist(p, base);
        if (dd > bestD) { bestD = dd; best = p; }
      }
      return { px: best, d: Math.max(0, bestD) };
    }
    const digitCore = (t) => { const q = digitBox(t); return core(q.x, q.y, q.w, q.h, baseOf(t)); };
    const INKS = { ink: rgb(pal.ink), success: rgb(pal.success), accentEdge: rgb(pal.accentEdge) };
    const closest = (px, names) => names.map((k) => [k, dist(px, INKS[k])]).sort((a, b) => a[1] - b[1])[0];

    // ---- (a) 布局公式：每一个数都得是 measure() 那条式子算出来的，测试自己再算一遍 -------------------
    eq('cell = clamp(floor((cssW-2·inner)/size), Cell.min, Cell.max)', cell, clamp(Math.floor((g0.cssW - 2 * theme.Space.inner) / size), theme.Cell.min, theme.Cell.max));
    eq('boardPx = cell × size', g0.boardPx, cell * size);
    eq('left 把盘面在画布里居中', g0.left, Math.round((g0.cssW - g0.boardPx) / 2));
    eq('top = Space.inner', g0.top, theme.Space.inner);
    eq('cssH = boardPx + 2×inner', g0.cssH, g0.boardPx + 2 * theme.Space.inner);
    eq('笼粗边 = max(3, round(cell×0.1))', g0.heavy, Math.max(3, Math.round(cell * 0.1)));
    eq('dpr = clamp(round(devicePixelRatio), 1, 3)', g0.dpr, clamp(Math.round(w.devicePixelRatio || 1), 1, 3));
    eq('backing 宽 = cssW × dpr', cv.width, Math.round(g0.cssW * g0.dpr));
    eq('backing 高 = cssH × dpr', cv.height, Math.round(g0.cssH * g0.dpr));
    eq('画布 CSS 高被 resize 写成 cssH', Math.round(box().height), g0.cssH);
    ck(`4 阶盘的格径实测 ${cell}px，在 44 触控下限之上`, cell >= 44, `cell=${cell}（Cell.max=${theme.Cell.max}，公式值是 ${Math.floor((g0.cssW - 2 * theme.Space.inner) / size)}）`);
    eq('几何里的格子数 = size²', g0.cells.length, n);
    eq('每格的矩形边长都等于 cell', [...new Set(g0.cells.map((rc) => rc.s))].join(','), String(cell));
    ck('格心就在矩形正中（画与命中读同一份 layout）', g0.cells.every((rc) => rc.cx === rc.x + cell / 2 && rc.cy === rc.y + cell / 2), JSON.stringify(g0.cells[5]));

    // ---- (b) 命中测试：最近格心，不是「落在哪个格里」 ----------------------------------------------
    let miss = 0;
    const badHit = [];
    for (let t = 0; t < n; t++) {
      const rc = geo().cells[t];
      const b = box();
      const probes = [[rc.cx, rc.cy], [rc.x + 4, rc.y + 4], [rc.x + cell - 5, rc.y + 4], [rc.x + 4, rc.y + cell - 5], [rc.x + cell - 5, rc.y + cell - 5]];
      for (const [x, y] of probes) {
        const hit = A().renderer.hitTest(b.left + x, b.top + y);
        if (hit !== t) {
          miss++;
          if (badHit.length < 3) badHit.push({ t, x: Math.round(x), y: Math.round(y), got: hit });
        }
      }
    }
    eq(`每格 5 个探测点（中心+四角内缩）全部命中本格，共 ${n * 5} 点`, miss, 0);
    const rc0 = geo().cells[0];
    const b0 = box();
    const outY = rc0.y - cell;
    const dy = rc0.y + cell / 2 - outY;
    ck('盘外一整格远的那个点确实落在 reach = cell×1.15 之外', dy > cell * 1.15, `${dy} vs ${(cell * 1.15).toFixed(1)}`);
    eq('reach 之外一律不命中（返回 -1）', A().renderer.hitTest(b0.left + rc0.cx, b0.top + outY), -1);
    eq('按「最近格心」设计：左上角外 2px 仍归第 1 格', A().renderer.hitTest(b0.left + rc0.x - 2, b0.top + rc0.y - 2), 0);
    eq('右下角外 2px 仍归最后一格（相邻格心更近）', A().renderer.hitTest(b0.left + rc0.x + size * cell + 2, b0.top + rc0.y + size * cell + 2), n - 1);
    const rcDown = geo().cells[size];
    eq('上边界内缩 1px 归上一行（最近格心的既定后果）', A().renderer.hitTest(b0.left + rcDown.cx, b0.top + rcDown.y - 1), 0);
    eq('同一列往下 1px 就归下一格', A().renderer.hitTest(b0.left + rcDown.cx, b0.top + rcDown.y + 1), size);

    // ---- (c) 触控下限 + 命中盒：画得到 44px 却点不着的控件等于没有 -------------------------------
    const small = [];
    const blocked = [];
    const offscreen = [];
    let total = 0;
    const census = (label, sels) => {
      const list = [];
      for (const sel of sels) for (const e of $$(sel)) list.push({ what: `${sel}#${e.id || e.className || ''}`, e });
      const mine = [];
      let min = 1e9;
      for (const { what, e } of list) {
        const r = e.getBoundingClientRect();
        min = Math.min(min, r.width, r.height);
        if (r.width < 44 || r.height < 44) { const o = { what, w: Math.round(r.width), h: Math.round(r.height) }; small.push(o); mine.push(o); }
        if (r.top < 0 || r.bottom > w.innerHeight || r.left < 0 || r.right > w.innerWidth) {
          offscreen.push(what);
          continue; // elementFromPoint 用的是视口坐标：滚出去的东西本来就不该拿它点账
        }
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!(hit === e || e.contains(hit) || (hit && hit.contains(e)))) {
          const o = { what, got: hit && (hit.id || `${hit.tagName}.${hit.className}`) };
          blocked.push(o);
          mine.push(o);
        }
      }
      total += list.length;
      ck(`${label}：${list.length} 个控件全部 ≥44×44（实测最小 ${Math.round(min)}px）`, list.length > 0 && min >= 44, JSON.stringify(mine.slice(0, 3)));
      ck(`${label}：在视口里的 ${list.length - offscreen.length} 个控件中心点都命得着自己（命中盒没被遮住）`, mine.filter((o) => o.got !== undefined).length === 0, JSON.stringify(mine.slice(0, 3)));
      return list.length;
    };
    const censusHidden = (label, sels) => {
      const list = [];
      for (const sel of sels) for (const e of $$(sel)) list.push({ what: sel, n: e.getClientRects().length });
      ck(`${label}：${list.length} 个隐藏控件一个都不占布局（不伪装成触控目标）`, list.length > 0 && list.every((e) => e.n === 0), JSON.stringify(list));
    };
    const gameCtl = census('对局页控件', ['#digit-pad button', '.pad-tools button', '.acts button', '.top-actions button']);
    censusHidden('隐藏的胜利遮罩', ['#win-veil', '#btn-again', '#btn-menu-2']);
    ck('画布本身远大于触控下限', (() => { const r = box(); return r.width >= 44 && r.height >= 44; })(), JSON.stringify(box().width));
    ck('画布完整在视口里', box().right <= w.innerWidth + 1, `${Math.round(box().right)} vs ${w.innerWidth}`);
    ck('页面无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    ck('擦/清理铅笔/铅笔三个工具都在', ['#btn-note', '#btn-erase', '#btn-prune'].every((s) => $(s)), 'missing');
    await tapCell(3);
    eq('真实一次 pointerdown/up 换掉选中格（命中盒到得了画布）', A().state().selected, 3);
    A().select(0);

    // 回选档：菜单侧的控件同样要够大，隐藏起来的续档卡不参与统计
    A().showMenu();
    await wait(60);
    // 原来这里直接断「没有存档时续档卡是隐藏的」，可**前提压根没建立**：openLevel(1) 开完盘，
    // showMenu() 头一件事就是 persist()（js/main.js:285），localStorage 里必然躺着一份 resume，
    // buildResume() 于是合法地把卡亮出来（js/main.js:246）——实测 hidden=false。
    // 产品没错，是这条断言把「菜单刚打开」当成了「没有存档」。先把两种情形分开断：
    ck('有可继续的那局时，续档卡就该露出来（showMenu 会先落一份档）', !!saved()?.resume && !$('#resume-card').hidden, JSON.stringify({ hasResume: !!saved()?.resume, hidden: $('#resume-card').hidden }));
    // 清档只走产品自己那条路：把这局赢掉——赢的时候 Store.clearResume()（js/main.js:450），
    // 之后 persist() 见 game.won 直接早退（js/main.js:336），不会再把它写回去。
    A().fillSolution();
    await wait(120);
    ck('赢了就把「可继续的那局」清掉', (saved() || {}).resume == null, JSON.stringify((saved() || {}).resume));
    await click('#btn-menu-2');
    await wait(60);
    eq('对局视图整块隐藏', $('#view-game').hidden, true);
    eq('没有存档时续档卡是隐藏的', $('#resume-card').hidden, true);
    censusHidden('隐藏的续档卡', ['#resume-card', '#btn-resume']);
    const menuCtl = census('选档页控件', ['.tier', '.chapter', '#btn-daily', '#btn-sound', '#btn-motion']);
    eq('选档页读数 = 5 档 + 20 关 + 3 顶部按钮', menuCtl, A().tiers.length + A().campaign.length + 3);
    eq('对局页控件数 = 4 个数字键 + 3 工具 + 5 动作 + 3 顶栏', gameCtl, size + 3 + 5 + 3);
    void total;
    $('.chapter[data-level="1"]').click();
    // 赢那一瞬间 renderer.celebrate() 起了一圈 900ms 的绿环（js/render/board.js:337 的 drawWin，
    // 时长是 Motion.win），它按时间自灭。下一段 (d) 要取整盘像素，所以等它散干净再采样。
    await wait(theme.Motion.win + 150);
    ck('点战役卡片回到对局页', shown('#view-game'), JSON.stringify({ game: shown('#view-game'), menu: shown('#view-menu') }));

    // ---- (d) 像素：画布真的被画了，而且画的就是那套几何 ------------------------------------------
    const painted = paintedPixels();
    // 分母原来拿的是**整张画布** areaOf(cssW, cssH) = 710×248 = 176080，要求 painted 过半。
    // 这在这个几何下压根做不到，而且和紧跟着的两条自相矛盾——那两条断的就是「角落 alpha=0、
    // 角落颜色 0,0,0」，也就是左右两条留白必须是透明的；盘只有 boardPx² 那么大，
    // 224² = 50176 就算一个像素不缺也只占画布的 28.5%，实测 painted=53188。
    // 换成按渲染器的画法**算出来**的那一方盘面：drawBoardBase 填的是
    // roundRect(left-3, top-3, boardPx+6, boardPx+6, Cell.max/4)（js/render/board.js:117），
    // 圆角半径 r = Cell.max/4 = 14，四个角各缺 r²(1−π/4)。这是**下界**：抗锯齿只会让
    // alpha>0 的像素比理想面积多一圈半个像素宽的毛边（实测 53188 对理想 52732，多 456 ≈ 周长的一半），
    // 所以这里给 >= 而不打折。
    const dpr = g0.dpr;
    const panelSide = (g0.boardPx + 6) * dpr;
    const panelR = Math.min(theme.Cell.max / 4, (g0.boardPx + 6) / 2) * dpr;
    const panelArea = panelSide * panelSide - 4 * panelR * panelR * (1 - Math.PI / 4);
    ck(`盘面那一方像素真的落笔了（${painted}/${Math.round(panelArea)}）`, painted >= panelArea, JSON.stringify({ painted, panelArea: Math.round(panelArea), canvasArea: areaOf(g0.cssW, g0.cssH) }));
    const corner = A().pixel(2, 2);
    eq('画布角落仍是没画过的透明（不是整幅刷了底色）', corner[3], 0);
    eq('角落没画就没有颜色可言', corner.slice(0, 3).join(','), '0,0,0');

    // 笼底色：奇偶交替，测试自己按 rgba 合成算一遍期望值
    const sel0 = A().state().selected;
    let tintOk = 0;
    let tintSeen = 0;
    const tintBad = [];
    for (let t = 0; t < n; t++) {
      if (t === sel0) continue;
      const q = patch(t);
      const want = baseOf(t);
      const got = countIn(q.x, q.y, q.w, q.h, want, 2);
      tintSeen++;
      if (got >= pa(t) * 0.9) tintOk++;
      else if (tintBad.length < 3) tintBad.push({ t, want: want.join(','), got: `${got}/${pa(t)}`, sample: pixel(q.x + 1, q.y + 1).join(',') });
    }
    eq(`${tintSeen} 格底色全部等于按 cageTint 透明度合成的期望值`, tintOk, tintSeen);
    ck('底色可疑的格子为 0（若有，列三个）', tintBad.length === 0, JSON.stringify(tintBad));
    const evenT = [...Array(n).keys()].find((t) => t !== sel0 && cageIndexOf(t) % 2 === 0);
    const oddT = [...Array(n).keys()].find((t) => t !== sel0 && cageIndexOf(t) % 2 === 1);
    const pe = patch(evenT);
    const po = patch(oddT);
    const evenPx = pixel(pe.x + 1, pe.y + 1);
    const oddPx = pixel(po.x + 1, po.y + 1);
    ck('奇偶两种笼底色确实不同（否则「对得上期望值」是空话）', dist(evenPx, oddPx) > 3, JSON.stringify({ even: evenPx, odd: oddPx, wantEven: baseOf(evenT).join(','), wantOdd: baseOf(oddT).join(',') }));
    ck('底色确实比盘面本色亮（透明度真的生效）', dist(evenPx, rgb(pal.surface)) >= 3 && dist(oddPx, rgb(pal.surface)) >= 3, JSON.stringify({ evenPx, oddPx, surface: rgb(pal.surface) }));
    eq('一格内部的中心小片是干净的（没有杂色）', diffIn(pe.x, pe.y, pe.w, pe.h, baseOf(evenT), 2), 0);

    // 笼标签：底衬 + 墨字两层。底衬只许出现在笼头那一格的上沿，往下必须是干净底色。
    const head = board.cages.find((c) => c.head !== sel0);
    const rh = geo().cells[head.head];
    const labBase = baseOf(head.head);
    const backR = rgba('rgba(8,11,22,0.55)');
    const labBack = over(backR.c, labBase, backR.a);
    const dimR = rgba(pal.inkDim);
    const labInk = over(dimR.c, labBack, dimR.a);
    // 底衬的宽不是拍脑袋来的：drawCageLabels 填的是
    //   fillRect(rc.x+1, rc.y+1, w+4, round(cell×labelScale)+5)，w = ctx.measureText(label).width，
    // 字体 `600 ${max(10, round(cell×labelScale))}px ${Font.mono}`（js/render/board.js:195/202/204）。
    // 原来这里写成死数 `Math.min(rh.s - 2, 40)`——那个 40 没有任何出处，于是量到的矩形比画出来的
    // 宽出一整条（40×24=960 vs 真值 (w+4)×24），多出来的部分本来就是笼子底色，永远不计命中，
    // 分母掺了水之后那条「≥25%」就变成了碰运气（实测 193/960，报出来的采样色 74,79,92 其实是字边）。
    const mc = document.createElement('canvas').getContext('2d');
    mc.font = `600 ${Math.max(10, Math.round(rh.s * theme.Cell.labelScale))}px ${theme.Font.mono}`;
    const labGlyphW = mc.measureText(head.label).width;
    const labW = labGlyphW + 4;
    const labArea = areaOf(labW, labH);
    const backPx = countIn(rh.x + 1, rh.y + 1, labW, labH, labBack, 6);
    // 「至少一半是底衬」而不是「全是」：那枚字就画在底衬上头（fillText 排在 fillRect 之后，
    // js/render/board.js:206），笼粗边又从格子边界往内吃进半个线宽，两者都落在矩形里，
    // 100% 覆盖率在物理上不存在。实测这一格（笼 0 的头＝格 14，label "3"）193/371。
    ck(`笼标签的底衬铺在 measureText+4 那一片上（${backPx}/${labArea} 命中期望色）`, backPx >= labArea * 0.5 && backPx >= 40, JSON.stringify({ backPx, labArea, labW: Math.round(labW * 10) / 10, want: labBack.join(','), got: pixel(rh.x + 4, rh.y + labH - 3).join(',') }));
    // 宽度到底对不对，不靠覆盖率说话——在一条**字压不到**的横线上直接量底衬的首末像素。
    // 取 dy = labH-2 那一行：数字的笔尖在 rc.y+3、em 高 round(cell×0.34)=19px，十进制数字没有
    // 降部，墨迹到 rc.y+19 就断了；实测 rc.y+22 一整行都是干净的底衬。
    const scanRow = rh.y + labH - 2;
    const hits = [];
    for (let dx = 1; dx < rh.s - 1; dx++) if (dist(pixel(rh.x + dx, scanRow), labBack) <= 6) hits.push(dx);
    const firstHit = hits.length ? Math.min(...hits) : -1;
    const lastHit = hits.length ? Math.max(...hits) : -1;
    ck(`底衬那一行量得到成片的像素（dx ${firstHit}..${lastHit}，共 ${hits.length} 列）`, hits.length >= Math.round(labW) - g0.heavy, JSON.stringify({ hits, labW: Math.round(labW) }));
    // 右端停在 measureText+4 那一列（±1px 给抗锯齿）。换回原来那个来路不明的 40，
    // 这里会量到右端停在 15 而期望是 39——那才是「底衬没画到那么宽」。
    ck(`底衬右端停在 measureText+4（lastHit ${lastHit} vs round(labW) ${Math.round(labW)}）`, Math.abs(lastHit - Math.round(labW)) <= 1, JSON.stringify({ lastHit, labW: Math.round(labW * 10) / 10 }));
    // 左端不许从格子外面开始涂，但也不能比笼粗边伸进格里的那半个线宽更靠里——
    // fillRect 的起点是 rc.x+1，粗边居中压在格界上、内线到 rc.x+heavy/2 为止。
    ck(`底衬左端就在笼头左上角（firstHit ${firstHit}，格子里侧被粗边盖住的前 ${Math.ceil(g0.heavy / 2)} px 量不到）`, firstHit >= 1 && firstHit <= Math.ceil(g0.heavy / 2), JSON.stringify({ firstHit, heavy: g0.heavy }));
    eq('底衬按 round(cell×0.34)+5 的高度收口，往下就是干净底色', countIn(rh.x + 1, rh.y + 1 + labH + 6, rh.s - 2, 8, labBack, 6), 0);
    // 也不许往宽处涂出去：越过 measureText+4 那一列再往右 6px，必须一格底衬都没有。
    eq('底衬止于 measureText+4，右边的留白里一点都不许有', countIn(rh.x + 1 + Math.ceil(labW) + 1, rh.y + 1, 6, labH, labBack, 6), 0);
    const glyph = core(rh.x + 2, rh.y + 2, labW - 1, labH - 2, labBack);
    ck(`标签的字是 inkDim 叠在底衬上的那个色（芯 ${glyph.px.join(',')}，离期望 ${dist(glyph.px, labInk)}）`, glyph.d > 40 && dist(glyph.px, labInk) <= dist(glyph.px, labBack) && dist(glyph.px, labInk) <= dist(glyph.px, labBase), JSON.stringify({ glyph: glyph.px, d: glyph.d, want: labInk.join(','), back: labBack.join(','), base: labBase.join(',') }));

    // 格线 vs 笼粗边：同一条 5px 宽的带，笼界上必须有粗边、笼内一条都不许有
    const heavy = rgb(pal.lineHeavy);
    const samePair = (() => {
      for (const c of board.cages) for (const t of c.cells) if (t % size !== size - 1 && c.cells.includes(t + 1) && t !== sel0 && t + 1 !== sel0) return [t, t + 1];
      return null;
    })();
    ck('找得到一个横着连成一片的笼（用来验笼内接缝）', !!samePair, JSON.stringify(samePair));
    const diffPair = (() => {
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        const t = r * size + c;
        if (t % size !== size - 1 && cageIndexOf(t) !== cageIndexOf(t + 1) && t !== sel0 && t + 1 !== sel0) return [t, t + 1];
      }
      return null;
    })();
    ck('找得到两个相邻不同笼的格（用来验笼粗边）', !!diffPair, JSON.stringify(diffPair));
    const stripTop = Math.round(cell * theme.Cell.labelScale) + 8;   // 让开笼标签那条底衬
    const stripH = cell - stripTop - 6;
    const bandArea = areaOf(5, stripH);
    ck('取样带落在格子里头（既避开笼标签也避开下边界）', stripH >= 12 && stripTop + stripH <= cell, JSON.stringify({ cell, stripTop, stripH }));
    const sx = (t) => geo().cells[t].x + cell - 2;
    const sy = (t) => geo().cells[t].y + stripTop;
    const inner = samePair && countIn(sx(samePair[0]), sy(samePair[0]), 5, stripH, heavy, 5);
    const outer = diffPair && countIn(sx(diffPair[0]), sy(diffPair[0]), 5, stripH, heavy, 5);
    eq('同一个笼内部一条粗边都没有', inner, 0);
    ck(`笼界上有成片的粗边（${outer}/${bandArea}）`, outer >= bandArea * 0.5, JSON.stringify({ outer, bandArea, want: heavy.join(','), got: pixel(sx(diffPair[0]) + 2, sy(diffPair[0]) + 2).join(',') }));
    const seamMark = samePair && diffIn(sx(samePair[0]), sy(samePair[0]), 5, stripH, baseOf(samePair[0]), 2);
    const edgeMark = diffPair && diffIn(sx(diffPair[0]), sy(diffPair[0]), 5, stripH, baseOf(diffPair[0]), 2);
    ck(`笼内接缝是条细线（${seamMark} 像素，比粗边窄）`, seamMark > 0 && seamMark <= bandArea * 0.5, JSON.stringify({ seamMark, bandArea }));
    ck('笼界占的像素比笼内接缝多得多（粗细分明）', edgeMark > seamMark * 2, JSON.stringify({ edgeMark, seamMark }));

    // ---- (e) 铅笔的两种色：引擎证明还活得下来的候选亮一档，已经出局的淡一档 -------------------------
    // 活/死两档的**颜色差**才是这一段的主题，所以取样格必须挑一格里同时住着「引擎证得活」
    // 和「引擎已判死」两个候选。原来钉在 noteT（笼 4+ 的第二格，格 8）上写死 1 与 2，
    // 判成「1 活 2 死」——可这格在空盘上就被题面推死了：列 0 有定值笼格 0=2、格 12=4，
    // 行 1 有格 5=3、格 6=2 ⇒ 格 4 只能 1 ⇒ 笼 4+ 逼出格 8=3。于是 1 和 2 **都是死候选**，
    // 渲染器按同一支笔（Palette.pencil）画了两遍（js/render/board.js:277 的 dead 分流），
    // 「差一档亮度」在物理上不可能成立：实测两笔芯 [82,85,96] 与 [83,85,96]，差 1。
    // 换笼 6+ 的第二格（格 10）：同笼同行不许同值 ⇒ {2,4}；列 2 已有格 6=2 ⇒ 只剩 4。
    // 这格活的恰好一个（4），死的还有 1 和 2，两个候选都落在九宫位第一列/第二列上。
    const penT = board.cages.find((c) => c.op === '+' && c.target === 6).cells[1];
    await click('#btn-note');
    A().select(penT);
    // 活/死不写死、从数字键盘现读（`candidate-off` 就是界面自己划掉的那批，与渲染器同源）。
    // 但位次要挑：drawNotes 的字心是 `rc.x + (idx%3)·per + per`（js/render/board.js:275 那个
    // `+ per/2 + per/2`），idx=2 那一列的字心正落在**格子右边界**上，半个字溢到邻格，
    // 拿它当「这一笔的芯」取样不成立——所以只从前两列里挑。这条渲染缺陷另报，不在本轮改。
    const offHere = $$('#digit-pad button.digit').filter((b) => b.classList.contains('candidate-off')).map((b) => Number(b.dataset.digit));
    const inBoard = Array.from({ length: size }, (_, i) => i + 1);
    const safeSlot = (v) => (v - 1) % 3 !== 2;
    const aliveV = inBoard.find((v) => safeSlot(v) && !offHere.includes(v));
    const deadV = inBoard.find((v) => safeSlot(v) && offHere.includes(v));
    ck(`取样前提：格 ${penT} 上既有活候选也有死候选，且两个的九宫位都在取得到芯的地方`, !!aliveV && !!deadV, JSON.stringify({ penT, off: offHere, aliveV, deadV }));
    await key(String(aliveV));
    await key(String(deadV));
    A().select(0);
    await click('#btn-note');
    await wait(120);
    const per = cell / 3;
    const slot = (t, v) => {
      const rc = geo().cells[t];
      const idx = v - 1;
      const s = Math.max(10, Math.round(per * 0.9));
      return { x: rc.x + (idx % 3) * per + per - s / 2, y: rc.y + Math.floor(idx / 3) * per + per - s / 2, s };
    };
    const sl1 = slot(penT, aliveV);
    const sl2 = slot(penT, deadV);
    const nb = baseOf(penT);
    const alive = core(sl1.x, sl1.y, sl1.s, sl1.s, nb);
    const dead = core(sl2.x, sl2.y, sl2.s, sl2.s, nb);
    const strong = rgb(pal.pencilStrong);
    const pen = rgba(pal.pencil);
    const dimExpect = over(pen.c, nb, pen.a);
    ck(`两笔铅笔都真画出来了（芯离底色 ${alive.d} / ${dead.d}）`, alive.d > 25 && dead.d > 25, JSON.stringify({ alive: alive.px, dead: dead.px, nb }));
    ck('活候选那一笔整体比死候选亮（三个通道都亮 ≥15）', alive.px.every((v, i) => v >= dead.px[i] + 15), JSON.stringify({ alive: alive.px, dead: dead.px }));
    ck('两笔各自朝自己的期望色靠（pencilStrong 与 pencil 叠底色的合成值）', dist(alive.px, strong) < dist(dead.px, strong) && dist(dead.px, dimExpect) < dist(alive.px, dimExpect), JSON.stringify({ alive: alive.px, dead: dead.px, strong, dimExpect }));

    // ---- (f) 墨色三条路：算对的笼 = success、选中没算完 = accentEdge、普通落子 = ink -------------
    const single = board.cages.find((c) => c.op === '=' && c.cells.length === 1 && c.head !== 0);
    const goodT = single.cells[0];
    const mateT = board.cages.find((c) => c.cells.includes(penT) && c.cells.length > 1).cells.find((t) => t !== penT);
    const plainCage = board.cages.find((c) => c.cells.length === 3);
    const plainT = plainCage.cells[0];
    A().select(goodT);
    await key(String(sol[goodT]));
    A().select(0);
    await wait(460);
    const qg = patch(goodT);
    const solvedWant = over(rgba(pal.cageSolved).c, baseOf(goodT), rgba(pal.cageSolved).a);
    const solvedGot = countIn(qg.x, qg.y, qg.w, qg.h, solvedWant, 2);
    ck(`算对的笼铺上一层 success 底（${solvedGot}/${pa(goodT)} 命中合成色）`, solvedGot >= pa(goodT) * 0.9, JSON.stringify({ solvedGot, area: pa(goodT), want: solvedWant.join(','), got: pixel(qg.x + 1, qg.y + 1).join(',') }));
    const gCore = digitCore(goodT);
    eq('算对的笼里那枚数字用最绿的一档', closest(gCore.px, ['success', 'ink', 'accentEdge'])[0], 'success');
    ck('那枚数字确实画出来了（芯离底色够远）', gCore.d > 40, JSON.stringify(gCore));
    A().select(mateT);
    await key(String(sol[mateT]));
    await wait(460);
    const mCore = digitCore(mateT);
    eq('选中、笼还没算完的那枚数字是 accentEdge', closest(mCore.px, ['accentEdge', 'ink', 'success'])[0], 'accentEdge');
    const qm = patch(mateT);
    eq('笼没算完就不许铺 success 底', countIn(qm.x, qm.y, qm.w, qm.h, solvedWant, 3), 0);
    A().select(plainT);
    await key(String(sol[plainT]));
    A().select(0);
    await wait(460);
    const pCore = digitCore(plainT);
    eq('没选中、笼没算完的那枚数字是墨色', closest(pCore.px, ['ink', 'accentEdge', 'success'])[0], 'ink');
    const qp = patch(plainT);
    eq('普通落子那一格也不许铺 success 底', countIn(qp.x, qp.y, qp.w, qp.h, solvedWant, 3), 0);
    eq('算对的笼只有一个（读数与画布同一口径）', `${A().state().goodCages.length}/${board.cages.length}/${text('#stat-cages')}`, `1/${board.cages.length}/1/${board.cages.length}`);
    A().select(plainT);
    await click('#btn-erase');
    await wait(120);
    eq('擦掉之后墨水没了', A().state().ink[plainT], 0);
    const erased = digitCore(plainT);
    ck(`擦掉之后那一片又回到笼子底色（芯离底色只剩 ${erased.d}）`, erased.d <= 3 && countIn(qp.x, qp.y, qp.w, qp.h, baseOf(plainT), 2) >= pa(plainT) * 0.9, JSON.stringify({ d: erased.d, px: erased.px, base: baseOf(plainT) }));

    // ---- (g) 窄容器：布局公式必须跟着收紧，恢复之后回到原位 --------------------------------------
    const wideCell = geo().cell;
    cv.style.width = '220px';
    w.dispatchEvent(new Event('resize'));
    await wait(140);
    const gn = geo();
    const cssWn = Math.round(box().width);
    ck('窄容器真的收窄了', cssWn < g0.cssW, `${cssWn} vs ${g0.cssW}`);
    eq('窄容器里 cssW 就是量到的宽', gn.cssW, Math.max(120, cssWn));
    eq('窄容器里格径按公式收紧', gn.cell, clamp(Math.floor((gn.cssW - 2 * theme.Space.inner) / size), theme.Cell.min, theme.Cell.max));
    ck('窄容器确实比宽的时候小', gn.cell < wideCell, `${gn.cell} < ${wideCell}`);
    eq('窄容器里 cssH 仍等于 boardPx+2inner', gn.cssH, gn.cell * size + 2 * theme.Space.inner);
    eq('窄容器的 backing 跟着 dpr', cv.width, Math.round(gn.cssW * gn.dpr));
    const bn = box();
    eq('重排之后命中测试跟着新几何走', A().renderer.hitTest(bn.left + gn.cells[5].cx, bn.top + gn.cells[5].cy), 5);
    const q5 = patch(5);
    ck('重排之后像素也对得上新几何（那一格底色还在原位）', countIn(q5.x, q5.y, q5.w, q5.h, baseOf(5), 3) >= areaOf(q5.w, q5.h) * 0.8, JSON.stringify({ q5, want: baseOf(5), got: pixel(q5.x + 1, q5.y + 1).join(',') }));
    cv.style.width = '110px';
    w.dispatchEvent(new Event('resize'));
    await wait(140);
    eq('窄到 cssW 兜底 120', geo().cssW, 120);
    eq('兜底宽度下格径仍是公式值', geo().cell, clamp(Math.floor((120 - 2 * theme.Space.inner) / size), theme.Cell.min, theme.Cell.max));
    cv.style.width = '';
    w.dispatchEvent(new Event('resize'));
    await wait(140);
    eq('恢复样式后格径回到原位', geo().cell, wideCell);
    eq('恢复样式后几何一字不差', `${geo().left},${geo().boardPx},${geo().cssH}`, `${g0.left},${g0.boardPx},${g0.cssH}`);

    // ---- (h) 7 阶大盘：同一条公式的两端都夹得住 ---------------------------------------------------
    A().loadLevel(5);
    await wait(140);
    const g7 = geo();
    eq('第 5 关是 7 阶', g7.size, 7);
    eq('7 阶盘的格子数 = 49', g7.cells.length, 49);
    ck('宽容器下 7 阶顶到 Cell.max 上限', g7.cell === theme.Cell.max && g7.boardPx === theme.Cell.max * 7, JSON.stringify({ cell: g7.cell, boardPx: g7.boardPx, cssW: g7.cssW }));
    cv.style.width = '120px';
    w.dispatchEvent(new Event('resize'));
    await wait(140);
    eq('窄容器下 7 阶夹在 Cell.min 下限', geo().cell, theme.Cell.min);
    eq('夹完 boardPx 仍是 cell×size', geo().boardPx, theme.Cell.min * 7);
    // 兜底宽 120 装不下 7×22=154 的盘：left 是负的，盘面超出画布。这是 measure() 那条
    // Math.max(120,…) 与 Cell.min 下限夹在一起的既定结果；写进断言是为了让「谁改了它」变红。
    eq('兜底宽度装不下 7 阶盘：left 为负（超出画布是既定行为，已记进报告）', geo().left, Math.round((120 - theme.Cell.min * 7) / 2));
    cv.style.width = '';
    w.dispatchEvent(new Event('resize'));
    await wait(140);
    eq('恢复后回到上限', geo().cell, theme.Cell.max);
    ck('7 阶盘的每格矩形都在硬下限之上', geo().cells.every((rc) => rc.s >= theme.Cell.min), String(geo().cells[0].s));
    return report({
      cell, dpr: g0.dpr, css: `${g0.cssW}x${g0.cssH}`, hitProbes: n * 5, painted, tints: tintSeen,
      narrowCell: gn.cell, controls: total, small: small.slice(0, 3), blocked: blocked.slice(0, 3), offscreen: offscreen.length, badHit: badHit.slice(0, 2), tintBad: tintBad.slice(0, 2),
    });
  };

  w.__scn = { first, engine, fingerprint, play, ui };
})(window);
