// 浏览器侧场景套件。由 tools/playtest.cjs 注入到真实页面里跑。
//
// 断言纪律（js/main.js:696 那句「harness 表面：tools/scenarios.js 只读这些」就是契约）：
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
  const near = (p, c, tol = 24) => p.every((v, i) => Math.abs(v - c[i]) <= tol);
  const dist = (p, c) => Math.max(...p.map((v, i) => Math.abs(v - c[i])));
  /** 前景 rgba(fg,a) 叠在 bg 上应当得到的颜色：测试自己算一遍，不抄画布的输出。 */
  const over = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));

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

  w.__scn = { first, engine, fingerprint };
})(window);
