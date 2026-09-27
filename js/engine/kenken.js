// 聪明格 · KenKen（calcudoku / Mathdoku）引擎。
//
// 盘上只有两类事实：行和列都是 1..N 的排列（数独约束），以及每个「笼」左上角写着
// 「目标数 + 运算符」——笼里的格子用这个运算符（任意次序）必须算出目标数。
// 所以本文件的核心不是搜索，而是**候选排除**：四条铅笔规则都只读局部事实（一行、一列、
// 一个笼、一行里所有笼的装箱），每一步写下的排除都在该盘的**每一个解**里成立。
//
// `solve()` 是铅笔路径：它既是玩家的路线、出货的验收，也是每一条提示的来源，
// 所以它**绝不回溯**。搜索只存在于 count.js，而且生成器两个都不信。
//
// 纯模块：不碰 window、不碰 document、不碰 DOM。浏览器与 Node 共用同一份文件。

export const EMPTY = 0; // 一格还没落子；合法数字是 1..N，所以 0 可以当哨兵
export const MAX_SIZE = 9; // 候选集是 16 位掩码（bit v 表示数字 v），9 是上限
export const NO_CAGE = -1;

export const Op = {
  eq: '=', // 单格笼：这一格就等于目标数
  plus: '+',
  minus: '-',
  times: '*',
  divide: '/',
};

// 界面上写的是数学符号；序列化进 campaign 文本的是 ASCII，两者不能混用。
export const OpGlyph = { '+': '+', '-': '−', '*': '×', '/': '÷', '=': '' };

export const OPS = ['=', '+', '-', '*', '/'];

export const opName = (op) =>
  op === '+' ? '加' : op === '-' ? '减' : op === '*' ? '乘' : op === '/' ? '除' : '定值';

// ---- 候选掩码：bit v 表示「数字 v 还可能是这一格」 ------------------------------------
//
// 0 在这里有两种含义，绝不能混：`value === 0` 是「这格还没填」，`mask === 0` 是
// 「这格没有候选」，后者是矛盾。把后者读成前者，无解盘就会被当成未填盘放出去。

export const bit = (v) => 1 << v;
export const fullMask = (size) => (1 << (size + 1)) - 2; // bit 1..size
export const maskHas = (m, v) => (m & (1 << v)) !== 0;

export function popcount(m) {
  let x = m;
  let n = 0;
  while (x) {
    n += x & 1;
    x >>>= 1;
  }
  return n;
}

export function valuesOfMask(m) {
  const out = [];
  for (let v = 1; v <= MAX_SIZE; v++) if (m & (1 << v)) out.push(v);
  return out;
}

export const maskOfValues = (list) => list.reduce((m, v) => m | (1 << v), 0);
export const onlyValue = (m) => (popcount(m) === 1 ? valuesOfMask(m)[0] : 0);

// ---- 笼的算术：只用整数，绝不出现浮点 --------------------------------------------------

/** 一组数字（笼内全部格子的值）是否满足这个笼。只返回布尔值。 */
export function cageHolds(op, target, values, size) {
  for (const v of values) if (!(v >= 1 && v <= size)) return false;
  const k = values.length;
  if (op === '=') return k === 1 && values[0] === target;
  if (op === '+') {
    let s = 0;
    for (const v of values) s += v;
    return s === target;
  }
  if (op === '*') {
    let p = 1;
    for (const v of values) p *= v;
    return p === target;
  }
  if (k !== 2) return false;
  const a = values[0];
  const b = values[1];
  if (op === '-') return Math.abs(a - b) === target;
  if (op === '/') {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return lo > 0 && hi % lo === 0 && hi / lo === target;
  }
  return false;
}

/** 笼的显示标签：单格笼只写数字，其余「目标数 + 符号」。 */
export function cageLabel(op, target) {
  return op === '=' ? String(target) : `${target}${OpGlyph[op]}`;
}

export const rowOf = (t, size) => Math.floor(t / size);
export const colOf = (t, size) => t % size;

export function neighbours(t, size) {
  const r = Math.floor(t / size);
  const c = t % size;
  const out = [];
  if (r > 0) out.push(t - size);
  if (r < size - 1) out.push(t + size);
  if (c > 0) out.push(t - 1);
  if (c < size - 1) out.push(t + 1);
  return out;
}

// ---- 盘面 --------------------------------------------------------------

/**
 * @param {object} spec { size, cages: [{ cells:number[], op, target }] }
 * 任何一处不合法都抛中文错误：生成器把抛错当成「这批不要」，界面把它当成 bug 报出来。
 */
export function createBoard(spec) {
  const size = spec.size;
  if (!Number.isInteger(size) || size < 2 || size > MAX_SIZE) {
    throw new Error(`盘边长必须是 2..${MAX_SIZE} 的整数，收到 ${size}`);
  }
  const n = size * size;
  const cageOf = new Int8Array(n).fill(NO_CAGE);
  if (!Array.isArray(spec.cages) || !spec.cages.length) throw new Error('盘上一个笼都没有');
  const cages = spec.cages.map((c, i) => {
    if (!Array.isArray(c.cells) || !c.cells.length) throw new Error(`笼 #${i + 1} 没有格子`);
    const cells = c.cells.slice();
    if (new Set(cells).size !== cells.length) throw new Error(`笼 #${i + 1} 有重复格子`);
    for (const t of cells) {
      if (!Number.isInteger(t) || t < 0 || t >= n) throw new Error(`笼 #${i + 1} 含有越界格子 ${t}`);
      if (cageOf[t] !== NO_CAGE) throw new Error(`第${rowOf(t, size) + 1}行${colOf(t, size) + 1}列被两个笼同时盖住`);
      cageOf[t] = i;
    }
    const op = c.op;
    if (!OPS.includes(op)) throw new Error(`笼 #${i + 1} 的运算符「${op}」不认识`);
    const target = c.target;
    if (!Number.isInteger(target) || target < 0) throw new Error(`笼 #${i + 1} 的目标数不是非负整数：${target}`);
    if (op === '=' && cells.length !== 1) throw new Error(`定值笼 #${i + 1} 只能有一格，却有 ${cells.length} 格`);
    if (op !== '=' && cells.length === 1) throw new Error(`笼 #${i + 1} 只有一格，运算符却写着「${op}」：单格笼必须直接写目标数`);
    if ((op === '-' || op === '/') && cells.length !== 2) {
      throw new Error(`笼 #${i + 1} 写着「${op}」，减与除只用于两格笼，它有 ${cells.length} 格`);
    }
    if (op === '=' && (target < 1 || target > size)) {
      throw new Error(`第${rowOf(cells[0], size) + 1}行${colOf(cells[0], size) + 1}列的单格笼写着 ${target}，但它必须在 1..${size} 之内`);
    }
    if (op === '-' && target < 1) throw new Error(`笼 #${i + 1} 写着「${target}−」：两格相邻必然不同值，差不可能是 ${target}`);
    if (op === '/' && target < 2) throw new Error(`笼 #${i + 1} 写着「${target}÷」：两格相邻必然不同值，商至少是 2`);
    const set = new Set(cells);
    const seen = new Set([cells[0]]);
    const queue = [cells[0]];
    while (queue.length) {
      const t = queue.pop();
      for (const nb of neighbours(t, size)) if (set.has(nb) && !seen.has(nb)) (seen.add(nb), queue.push(nb));
    }
    if (seen.size !== cells.length) throw new Error(`笼 #${i + 1} 的格子不连成一片`);
    return {
      i,
      cells,
      // head = 行主序最小格：笼标签写在这一格的左上角，界面与断言都读它
      head: cells.reduce((a, t) => (t < a ? t : a), cells[0]),
      op,
      target,
      size,
      label: cageLabel(op, target),
      name: `第${i + 1}号笼`,
    };
  });
  for (let t = 0; t < n; t++) {
    if (cageOf[t] === NO_CAGE) throw new Error(`第${rowOf(t, size) + 1}行${colOf(t, size) + 1}列不属于任何笼`);
  }

  const rows = [];
  const cols = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    const col = [];
    for (let c = 0; c < size; c++) {
      row.push(r * size + c);
      col.push(c * size + r);
    }
    rows.push(row);
    cols.push(col);
  }
  const peers = [];
  for (let t = 0; t < n; t++) {
    const list = [];
    for (const u of rows[rowOf(t, size)]) if (u !== t) list.push(u);
    for (const u of cols[colOf(t, size)]) if (u !== t) list.push(u);
    peers.push(list);
  }

  const board = {
    size,
    n,
    total: (size * (size + 1)) / 2, // 每一行（每一列）之和
    cages,
    cageOf,
    rows,
    cols,
    peers,
    cells: Array.from({ length: n }, (_, i) => i),
    emptyMask: fullMask(size),
    text: formatCages(cages),
    cellName: (t) => `第${rowOf(t, size) + 1}行${colOf(t, size) + 1}列`,
    cageName: (ci) => (ci == null || ci < 0 ? '整盘' : `${cages[ci].name}「${cages[ci].label}」`),
  };
  board.units = unitsOf(board);
  // 结构自检：任何一个笼在 1..N 内本来就凑不出来，就别出货。
  for (const cage of board.cages) {
    const probe = cageAssignments(cage, size, null, { budget: 4000 });
    if (!probe.capped && !probe.list.length) {
      throw new Error(`${board.cageName(cage.i)}在 1..${size} 内根本凑不出来`);
    }
  }
  return board;
}

/** 行与列两种「单位」：规则 ① 与 ④ 都按这张表扫。 */
export function unitsOf(board) {
  if (board._units) return board._units;
  const units = [];
  for (let r = 0; r < board.size; r++) units.push({ key: `r${r}`, kind: 'row', index: r, name: `第${r + 1}行`, cells: board.rows[r] });
  for (let c = 0; c < board.size; c++) units.push({ key: `c${c}`, kind: 'col', index: c, name: `第${c + 1}列`, cells: board.cols[c] });
  board._units = units;
  return units;
}

// ---- 序列化：campaign 文本行与存档都用它 ---------------------------------------------
// 每格下标写成两位 36 进制，笼写成 `op目标数:格子串`，笼之间用分号。

export function formatCages(cages) {
  return cages.map((c) => `${c.op}${c.target}:${c.cells.map((t) => pad36(t)).join('')}`).join(';');
}

const pad36 = (t) => t.toString(36).padStart(2, '0');

export function parseCages(text) {
  if (typeof text !== 'string' || !text) throw new Error('笼文本为空');
  return text.split(';').map((chunk) => {
    const colon = chunk.indexOf(':');
    if (colon < 1) throw new Error(`笼文本缺了冒号：${chunk}`);
    const head = chunk.slice(0, colon);
    const op = head[0];
    if (!OPS.includes(op)) throw new Error(`笼文本运算符不认识：${chunk}`);
    const target = Number(head.slice(1));
    if (!Number.isInteger(target)) throw new Error(`笼文本目标数不认识：${chunk}`);
    const body = chunk.slice(colon + 1);
    if (!body.length || body.length % 2) throw new Error(`笼文本格子数是半个：${chunk}`);
    const cells = [];
    for (let i = 0; i < body.length; i += 2) cells.push(parseInt(body.slice(i, i + 2), 36));
    return { op, target, cells };
  });
}

/** 由序列化文本重建盘面（会跑完整校验）。 */
export function boardFromText(size, text) {
  return createBoard({ size, cages: parseCages(text) });
}

// ---- 笼的合法赋值枚举：铅笔规则 ③ 的引擎 ------------------------------------------------
//
// 枚举的是「这个笼的格子分别取什么值」的全部可能，且：
//   * 只取 1..N；
//   * 同一笼里若有两格同行/同列，它们不能同值（数独约束先行排除）；
//     注意这条只管「同行同列」——不同行也不同列的两格**允许**同值，这是 KenKen 的正规规则，
//     也是 `2+` 三格笼能取 {1,1,4} 的原因。
//   * 预算封顶：超过 budget 个合法赋值就返回 capped=true，调用方**不许**把 capped 当成通过。
// 结果次序由格子顺序决定，纯函数：同一笼、同一掩码永远给出同一份表。

export function cageAssignments(cage, size, mask = null, opts = {}) {
  const budget = opts.budget || 4000;
  const cells = cage.cells;
  const k = cells.length;
  const doms = cells.map((t) => valuesOfMask(mask ? mask[t] & fullMask(size) : fullMask(size)));
  if (doms.some((d) => !d.length)) return { list: [], capped: false, tried: 0, empty: true };
  const sameLine = (a, b) => Math.floor(a / size) === Math.floor(b / size) || a % size === b % size;

  const list = [];
  let tried = 0;
  let capped = false;
  const assign = new Array(k).fill(0);

  // 后缀和界：剪掉「再怎么填也到不了目标」的分支（界是松弛的，只会少剪，不会错杀）
  const minSuffix = new Array(k + 1).fill(0);
  const maxSuffix = new Array(k + 1).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    minSuffix[i] = minSuffix[i + 1] + Math.min(...doms[i]);
    maxSuffix[i] = maxSuffix[i + 1] + Math.max(...doms[i]);
  }

  if (cage.op === '-' || cage.op === '/') {
    for (const a of doms[0]) {
      for (const b of doms[1]) {
        if (sameLine(cells[0], cells[1]) && a === b) continue;
        tried++;
        if (cageHolds(cage.op, cage.target, [a, b], size)) {
          list.push([a, b]);
          if (list.length >= budget) {
            capped = true;
            break;
          }
        }
      }
      if (capped) break;
    }
    return { list, capped, tried, empty: false };
  }

  const go = (i, sum, prod) => {
    if (capped) return;
    if (i === k) {
      tried++;
      if (cageHolds(cage.op, cage.target, assign, size)) {
        list.push(assign.slice());
        if (list.length >= budget) capped = true;
      }
      return;
    }
    for (const v of doms[i]) {
      let clash = false;
      for (let j = 0; j < i; j++) if (assign[j] === v && sameLine(cells[i], cells[j])) clash = true;
      if (clash) continue;
      if (cage.op === '+' && (sum + v + minSuffix[i + 1] > cage.target || sum + v + maxSuffix[i + 1] < cage.target)) continue;
      if (cage.op === '*' && (prod * v > cage.target || cage.target % (prod * v) !== 0)) continue;
      assign[i] = v;
      go(i + 1, sum + v, prod * v);
      assign[i] = 0;
      if (capped) return;
    }
  };
  go(0, 0, 1);
  return { list, capped, tried, empty: false };
}

/** 这个笼在 1..N 内、满足该运算的全部**多重集**（不含位置）。README 里那张表就是它。 */
export function cageMultisets(cage, size) {
  const { list } = cageAssignments(cage, size, null, { budget: 20000 });
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = a.slice().sort((x, y) => x - y).join(',');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key.split(',').map(Number));
    }
  }
  return out.sort((x, y) => (x.join(',') < y.join(',') ? -1 : 1));
}

/**
 * 笼的和/积/差/商**可达区间**：规则 ② 的全部家当。
 *
 * 两格笼给**精确**区间：把两格的候选两两配对算一遍，同行同列的配对先跳过（那是数独约束，
 * 不是这个笼的道理——留着就会报出「1+1=2」这种根本填不出来的下界），除不尽的对也跳过。
 * 三格及以上给**放宽**的区间（每格各取候选的最小/最大再相加/相乘）：界只可能比真值更宽，
 * 规则 ② 于是永远只是少排除、不错排除；精确的组合归规则 ③。
 * `empty: true` 说的是「这个笼在现在的候选下连一种结果都算不出来」，它包含某一格候选被挤空。
 */
export function cageRange(cage, size, mask) {
  const cells = cage.cells;
  const doms = cells.map((t) => valuesOfMask(mask[t] & fullMask(size)));
  if (doms.some((d) => !d.length)) return { empty: true };
  const op = cage.op;
  if (cells.length === 2) {
    const clash = Math.floor(cells[0] / size) === Math.floor(cells[1] / size) || cells[0] % size === cells[1] % size;
    let lo = Infinity;
    let hi = -Infinity;
    let any = false;
    for (const a of doms[0]) {
      for (const b of doms[1]) {
        if (clash && a === b) continue;
        let v;
        if (op === '+') v = a + b;
        else if (op === '*') v = a * b;
        else if (op === '-') v = Math.abs(a - b);
        else {
          const x = a > b ? a : b;
          const y = a > b ? b : a;
          if (y <= 0 || x % y !== 0) continue;
          v = x / y;
        }
        any = true;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return any ? { empty: false, lo, hi } : { empty: true };
  }
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mul = (a) => a.reduce((x, y) => x * y, 1);
  if (op === '+') return { empty: false, lo: sum(doms.map((d) => d[0])), hi: sum(doms.map((d) => d[d.length - 1])) };
  if (op === '*') return { empty: false, lo: mul(doms.map((d) => d[0])), hi: mul(doms.map((d) => d[d.length - 1])) };
  if (op === '=') return { empty: false, lo: doms[0][0], hi: doms[0][doms[0].length - 1] };
  // 减与除只用于两格笼（createBoard 把关），到这里不可能走到
  return { empty: true };
}

// ---- 四条铅笔规则 ---------------------------------------------------------------
//
// 每条规则都只读局部事实，写下的每一格、每一处排除都在该盘的每一个解里成立。
// weight 既是「玩家要多费劲」也是打分权重；index 是规则层级（难度度量里的 level）。

export const Rules = {
  unit: {
    key: 'unit',
    index: 1,
    name: '行列排除',
    weight: 1,
    blurb: '同行同列的已定值互相挤候选；一个数字在一行里只剩一格放得下，就必须填在那里。',
  },
  bounds: {
    key: 'bounds',
    index: 2,
    name: '极值与边界',
    weight: 2,
    blurb: '笼的和/积有一个可达区间：目标数在区间外就矛盾，某个候选一填就出界，那个候选不能在这格。',
  },
  combo: {
    key: 'combo',
    index: 3,
    name: '笼组合枚举',
    weight: 2.5,
    blurb: '枚举这个笼在 1..N 内满足该运算的全部组合，取交集：一个组合都不出现的值全部排除，所有组合里都落在同一格的值直接填上。',
  },
  pack: {
    key: 'pack',
    index: 4,
    name: '笼与行列装箱',
    weight: 3.5,
    blurb: '一行（一列）里所有笼的贡献加起来必须等于 N(N+1)/2：配不满就矛盾，只剩一种配法就把那一格钉死。',
  },
};

export const RULE_LIST = [Rules.unit, Rules.bounds, Rules.combo, Rules.pack];
export const ruleByKey = (k) => RULE_LIST.find((r) => r.key === k);
export const ASSIGN_BUDGET = 3000;

/**
 * 求解状态：候选掩码 + 已落子。传 `givens` 时，玩家的墨水被当成前提（reachable 靠这个）。
 */
export function createTrace(board, givens = null) {
  const mask = new Uint16Array(board.n).fill(board.emptyMask);
  const val = new Uint8Array(board.n);
  const st = {
    board,
    mask,
    val,
    cache: new Array(board.cages.length).fill(null),
    placed: 0,
    dead: -1, // 掩码被清空的那一格：下一次扫描会把它说成矛盾
    locked: false, // 前提（线索/墨水）本身互相矛盾
    lockNote: '',
  };
  if (givens) {
    for (let t = 0; t < board.n; t++) {
      const v = givens[t];
      if (v >= 1) st.mask[t] = bit(v);
    }
    for (let t = 0; t < board.n; t++) {
      const v = givens[t];
      if (v >= 1) placeGiven(st, t, v);
    }
  }
  return st;
}

// 把玩家的落子当前提：先同行同列查重，再把这个数字从同行同列的候选里挤掉
function placeGiven(st, t, v) {
  const { board, mask, val } = st;
  val[t] = v;
  st.placed++;
  touch(st, t);
  for (const u of board.peers[t]) {
    if (val[u] === v) {
      st.locked = true;
      st.lockNote = `${board.cellName(u)} 和 ${board.cellName(t)} 同在一行/一列，却都填了 ${v}`;
      return;
    }
    if (maskHas(mask[u], v)) {
      mask[u] &= ~bit(v);
      touch(st, u);
      if (!mask[u] && !val[u]) st.dead = u;
    }
  }
}

function touch(st, t) {
  const ci = st.board.cageOf[t];
  if (ci >= 0) st.cache[ci] = null;
  st.stamp++;
}

/**
 * 落一个值（唯一入口）：写 val、钉死掩码、挤掉同行同列的同一个数字，并产出中文句子。
 * 返回是否真的写了。
 */
function place(st, t, v, rule, note, out) {
  const { mask, val } = st;
  const board = st.board;
  if (val[t]) return false;
  if (!maskHas(mask[t], v)) {
    st.dead = t;
    return false;
  }
  val[t] = v;
  mask[t] = bit(v);
  st.placed++;
  touch(st, t);
  out.push({ kind: 'place', cell: t, value: v, cage: board.cageOf[t], rule, note });
  for (const u of board.peers[t]) {
    if (val[u] || !maskHas(mask[u], v)) continue;
    eliminate(st, u, v, out, { rule, by: t, note: `${board.cellName(t)} 已是 ${v}，同在一行/一列` });
  }
  return true;
}

/** 排除一个候选；真的排掉了才产出句子。掩码被清空时记下 dead 让下一轮去说矛盾。 */
function eliminate(st, t, v, out, extra) {
  const { mask, val } = st;
  if (val[t] || !maskHas(mask[t], v)) return false;
  mask[t] &= ~bit(v);
  touch(st, t);
  if (!mask[t]) st.dead = t;
  out.push({ kind: 'elim', cell: t, value: v, cage: st.board.cageOf[t], ...extra });
  return true;
}

const say = (board, rec) =>
  rec.kind === 'place'
    ? `${board.cellName(rec.cell)} 填 ${rec.value}：${rec.note}`
    : `${board.cellName(rec.cell)} 不填 ${rec.value}：${rec.note}`;

/**
 * 一轮扫描：四条规则按 ①②③④ 的次序各跑一遍（后面的规则看得见前面刚改过的掩码）。
 * 返回 { changed, found, conflict, stats }。
 *
 * `opts` 上挂着两个只给测试用的闸，出货路径一个都不传：
 *   rules  —— 想证明某条规则真的在养活货盘，就把别的都留下、只拿掉它；
 *   budget —— 把笼的赋值枚举预算压到 1，等价于「这个笼封顶了，规则③一个字都不说」，
 *             用它实测规则②到底是③的简化版还是兜底版。实测口径（测试 A「分工」里钉着）：
 *             出货的 20 关**一个笼都没触顶**（capped 全 0，七阶也不例外），所以②在货上不是
 *             完成所必需的；可一旦把③的枚举压到 1，20/20 关都变成「留着②才推得完」——
 *             ②是③封顶时的兜底，不是③的缩略版。
 */
export function propagate(board, st, opts = {}) {
  const out = [];
  const stats = { enumerated: 0, capped: 0 };
  for (const rule of opts.rules || RULE_LIST) {
    if (st.dead >= 0 || st.locked) break;
    const r = RULE_RUN[rule.key](board, st, out, stats, opts);
    if (r.conflict) return { changed: true, found: [], conflict: r.conflict, rule: rule.name, cage: r.cage, unit: r.unit };
  }
  if (st.locked) return { changed: true, found: [], conflict: st.lockNote, rule: '前提' };
  if (st.dead >= 0) {
    const t = st.dead;
    return { changed: true, found: [], conflict: `${board.cellName(t)} 已经没有任何候选：${board.cageName(board.cageOf[t])} 与同行同列一起把它挤空了`, rule: '排除' };
  }
  void opts;
  const found = out.map((rec) => ({ ...rec, text: say(board, rec) }));
  return { changed: found.length > 0, found, conflict: null, stats };
}

const RULE_RUN = { unit: runUnit, bounds: runBounds, combo: runCombo, pack: runPack };

// ---- 规则 ①：数独式排除 ---------------------------------------------------------

function runUnit(board, st, out) {
  const { mask, val } = st;
  for (let t = 0; t < board.n; t++) {
    if (val[t]) continue;
    if (!mask[t]) {
      st.dead = t;
      return { conflict: `${board.cellName(t)} 已经没有任何候选` };
    }
    const only = onlyValue(mask[t]);
    if (only) place(st, t, only, Rules.unit, '这一格的候选只剩它一个', out);
  }
  for (const unit of board.units) {
    for (let v = 1; v <= board.size; v++) {
      let hits = 0;
      let last = -1;
      let placed = 0;
      for (const t of unit.cells) {
        if (val[t] === v) placed++;
        else if (!val[t] && maskHas(mask[t], v)) {
          hits++;
          last = t;
        }
      }
      if (placed > 1) return { conflict: `${unit.name} 里 ${v} 被填了 ${placed} 次`, unit: unit.key };
      if (placed) continue;
      if (!hits) return { conflict: `${unit.name} 里的 ${v} 已经无处可放`, unit: unit.key };
      if (hits === 1) place(st, last, v, Rules.unit, `${unit.name} 里只有这一格放得下 ${v}`, out);
    }
  }
  return {};
}

// ---- 规则 ②：极值与边界 ---------------------------------------------------------
//
// 只用候选集的最小/最大值算出这个笼的和/积可达区间：目标在区间外就是矛盾；某个候选一填
// 就把区间推出目标之外，这个候选就不能在这格。它比枚举便宜得多，而且**枚举预算封顶的笼
// 只有这条规则能处理**——所以它不是规则 ③ 的简化版，是它的兜底。

function runBounds(board, st, out) {
  for (const cage of board.cages) {
    if (cage.cells.every((t) => st.val[t])) continue;
    const rg = cageRange(cage, board.size, st.mask);
    if (rg.empty) return { conflict: emptyCageNote(board, st, cage), cage: cage.i };
    if (cage.target < rg.lo || cage.target > rg.hi) {
      const word = cage.target < rg.lo ? '最少都到 ' : '最多也只到 ';
      const edge = cage.target < rg.lo ? rg.lo : rg.hi;
      return { conflict: `${board.cageName(cage.i)}要凑 ${cage.target}，可它现在${cage.target < rg.lo ? '怎么填也' : ''}${word}${edge}`, cage: cage.i };
    }
    for (const t of cage.cells) {
      if (st.val[t]) continue;
      for (const v of valuesOfMask(st.mask[t])) {
        const saved = st.mask[t];
        st.mask[t] = bit(v);
        const probe = cageRange(cage, board.size, st.mask);
        st.mask[t] = saved;
        if (probe.empty || cage.target < probe.lo || cage.target > probe.hi) {
          eliminate(st, t, v, out, {
            rule: Rules.bounds,
            note: probe.empty
              ? `${board.cageName(cage.i)}里这格若是 ${v}，另外一格的候选就全被挤空了，${cage.target} 无从算起`
              : `${board.cageName(cage.i)}里这格若是 ${v}，整笼的${word2Op(cage.op)}只能在 ${probe.lo}..${probe.hi}，够不着 ${cage.target}`,
          });
        }
      }
    }
  }
  return {};
}

/** 一格里候选被挤空 vs 整个笼算不出任何结果：两种病分开说。 */
function emptyCageNote(board, st, cage) {
  const dead = cage.cells.find((t) => !st.mask[t]);
  if (dead != null) return `${board.cellName(dead)} 已经没有任何候选：${board.cageName(cage.i)} 与同行同列一起把它挤空了`;
  return `${board.cageName(cage.i)}在现在的候选下连一种结果都算不出来`;
}

const word2Op = (op) => (op === '*' ? '积' : op === '-' ? '差' : op === '/' ? '商' : '和');

// ---- 规则 ③：笼的候选组合枚举 ---------------------------------------------------
//
// 枚举这个笼的全部合法赋值（含同笼同行同列不能同值），然后：
//   * 一种都没有 → 矛盾；
//   * 某值在所有组合里都落在同一格 → 那一格就是它；
//   * 某值一次都不出现在某一格 → 那一格排除它。
// README 里 `×24` 三格笼例子的出处：写成横排三格时 6 阶只有 {1,4,6} 与 {2,3,4} 两种多重集
// （两格同行还要互异，{2,2,6} 被数独约束拿掉），交集里没有 5，所以 5 不能落进这个笼。

function assignmentsFor(board, st, cage, budget) {
  // 缓存只按「这个笼有没有格子被写过」失效（touch 置 null），所以规则 ③ 与 ④ 共用一份表。
  const hit = st.cache[cage.i];
  if (hit) return hit;
  const r = cageAssignments(cage, board.size, st.mask, { budget: budget || ASSIGN_BUDGET });
  st.cache[cage.i] = r;
  return r;
}

function runCombo(board, st, out, stats, opts = {}) {
  for (const cage of board.cages) {
    if (cage.cells.every((t) => st.val[t])) continue;
    const a = assignmentsFor(board, st, cage, opts.budget);
    stats.enumerated += a.tried;
    if (a.capped) {
      stats.capped++;
      continue; // 预算封顶：这一轮对这个笼不下结论，交给 ②④
    }
    if (!a.list.length) {
      return { conflict: `${board.cageName(cage.i)}在现在的候选下一种组合都凑不出来`, cage: cage.i };
    }
    const summary = comboSummary(a.list);
    for (let i = 0; i < cage.cells.length; i++) {
      const t = cage.cells[i];
      if (st.val[t]) continue;
      let union = 0;
      for (const as of a.list) union |= bit(as[i]);
      const gone = valuesOfMask(st.mask[t] & ~union);
      if (gone.length) {
        for (const v of gone) {
          eliminate(st, t, v, out, { rule: Rules.combo, note: `${board.cageName(cage.i)}只有 ${summary} 这几种组合，里面没有 ${v}` });
        }
        if (st.mask[t] && onlyValue(st.mask[t]) && !st.val[t]) {
          place(st, t, onlyValue(st.mask[t]), Rules.combo, `${board.cageName(cage.i)}的组合里这一格只剩 ${onlyValue(st.mask[t])}`, out);
        }
      }
    }
    // 所有组合都把同一个值钉在同一格（哪怕候选集还更大）
    for (let i = 0; i < cage.cells.length; i++) {
      const t = cage.cells[i];
      if (st.val[t]) continue;
      const first = a.list[0][i];
      if (a.list.every((as) => as[i] === first)) place(st, t, first, Rules.combo, `${board.cageName(cage.i)}的每一种组合里，这一格都是 ${first}`, out);
    }
  }
  return {};
}

// 把组合表写成玩家看得懂的一句话（最多列 3 种多重集）
export function comboSummary(list) {
  const seen = new Set();
  const multisets = [];
  for (const a of list) {
    const key = a.slice().sort((x, y) => x - y).join('');
    if (!seen.has(key)) {
      seen.add(key);
      multisets.push(`{${key.split('').join(',')}}`);
    }
  }
  return multisets.length <= 3 ? multisets.join('、') : `${multisets.length} 种组合`;
}

// ---- 规则 ④：笼与行/列的装箱计数 -------------------------------------------------
//
// 一行（或一列）里所有格子的和必然是 N(N+1)/2。把这一行按笼切开，每个笼能贡献多少由它
// 自己的合法赋值决定；把这些贡献配到 T 上：
//   * 最小的配法都超过 T、或最大的配法够不到 T → 矛盾；
//   * 某个笼的可用贡献被窗口收窄 → 用收窄后的贡献反推每一格还能是什么。
// 这一步用的是**跨笼**事实，前三条谁也替代不了它。

function runPack(board, st, out, stats, opts = {}) {
  const T = board.total;
  for (const unit of board.units) {
    const groups = [];
    for (const cage of board.cages) {
      const slot = cage.cells.map((t, i) => (unit.cells.includes(t) ? i : -1)).filter((i) => i >= 0);
      if (!slot.length) continue;
      const a = assignmentsFor(board, st, cage, opts.budget);
      stats.enumerated += a.tried;
      const contrib = new Map();
      let relaxed = false;
      if (a.capped) {
        relaxed = true;
        const rg = cageRange(cage, board.size, st.mask);
        if (rg.empty) return { conflict: emptyCageNote(board, st, cage), cage: cage.i };
        for (let s = rangeSum(cage.cells, st, slot, 'lo'); s <= rangeSum(cage.cells, st, slot, 'hi'); s++) contrib.set(s, null);
      } else {
        if (!a.list.length) return { conflict: `${unit.name} 里的 ${board.cageName(cage.i)}一个组合都放不进来`, cage: cage.i, unit: unit.key };
        for (const as of a.list) {
          let s = 0;
          for (const i of slot) s += as[i];
          if (!contrib.has(s)) contrib.set(s, []);
          contrib.get(s).push(as);
        }
      }
      const sums = [...contrib.keys()].sort((x, y) => x - y);
      groups.push({ cage, slot, contrib, relaxed, sums });
    }
    const min = groups.reduce((a, g) => a + g.sums[0], 0);
    const max = groups.reduce((a, g) => a + g.sums[g.sums.length - 1], 0);
    if (T < min || T > max) {
      return {
        conflict: `${unit.name} 的和必须是 ${T}，可它现在这些笼只配得出 ${min}..${max}`,
        unit: unit.key,
      };
    }
    for (const g of groups) {
      const othersMin = min - g.sums[0];
      const othersMax = max - g.sums[g.sums.length - 1];
      const allowed = g.sums.filter((s) => T - othersMax <= s && s <= T - othersMin);
      if (allowed.length === g.sums.length || !allowed.length) continue;
      if (g.relaxed) continue; // 预算封顶的笼只参与区间判断，不反推格子
      const cellsInUnit = g.slot.map((i) => g.cage.cells[i]);
      for (const i of g.slot) {
        const t = g.cage.cells[i];
        if (st.val[t]) continue;
        let union = 0;
        for (const s of allowed) for (const as of g.contrib.get(s)) union |= bit(as[i]);
        for (const v of valuesOfMask(st.mask[t] & ~union)) {
          eliminate(st, t, v, out, {
            rule: Rules.pack,
            note: `${unit.name} 的和必须是 ${T}，${board.cageName(g.cage.i)}在这一${unit.kind === 'row' ? '行' : '列'}里只能贡献 ${allowed.join('/')}`,
          });
        }
        void cellsInUnit;
      }
    }
  }
  return {};
}

function rangeSum(cells, st, slot, side) {
  let s = 0;
  for (const i of slot) {
    const t = cells[i];
    if (st.val[t]) s += st.val[t];
    else {
      const vs = valuesOfMask(st.mask[t]);
      s += side === 'lo' ? vs[0] || 0 : vs[vs.length - 1] || 0;
    }
  }
  return s;
}

// ---- 铅笔路径：从空盘推到底 -------------------------------------------------------

/**
 * @returns { ok, solution, rows, steps, elims, score, level, enumCost, rounds, capped, breakdown, conflict }
 * rows 就是提示脚本：顺序、规则、格、值、句子都在里面。它**不读玩家的墨水**，
 * 所以填错一格不会让提示跟着错。
 */
export function solve(board, opts = {}) {
  const st = createTrace(board, opts.givens || null);
  const fail = (conflict) => ({
    ok: false,
    conflict,
    rows: [],
    steps: 0,
    elims: 0,
    score: 0,
    level: 0,
    enumCost: 0,
    rounds: 0,
    capped: 0,
    breakdown: {},
    masks: Uint16Array.from(st.mask),
    solution: null,
    trace: st,
  });
  if (st.locked) return fail(st.lockNote);
  const rows = [];
  const weights = new Map();
  let enumCost = 0;
  let capped = 0;
  let rounds = 0;
  let level = 0;
  let conflict = null;
  const activeRules = opts.rules || RULE_LIST;
  for (;;) {
    const sweep = propagate(board, st, { rules: activeRules, budget: opts.budget });
    if (sweep.conflict) {
      conflict = sweep.conflict;
      break;
    }
    enumCost += sweep.stats.enumerated;
    capped += sweep.stats.capped;
    if (!sweep.changed) break;
    for (const rec of sweep.found) {
      rows.push(rec);
      level = Math.max(level, rec.rule.index);
      const cur = weights.get(rec.rule.name) || { n: 0, weight: rec.rule.weight };
      cur.n++;
      weights.set(rec.rule.name, cur);
    }
    if (++rounds > 600) return fail('推导没有收敛（引擎缺陷）');
  }
  const filled = st.val.every((v) => v >= 1);
  const places = rows.filter((r) => r.kind === 'place').length;
  const elims = rows.filter((r) => r.kind === 'elim').length;
  let score = 0;
  for (const x of weights.values()) score += x.n * x.weight;
  score += rounds * 0.5 + Math.floor(enumCost / 500);
  if (!filled && !conflict) conflict = '四条铅笔规则推不完这一盘';
  // 「每格都有数字」不等于「推对了」：把一只算错的满盘当前提塞进来，规则照样会在某一轮
  // 撞上笼级矛盾。这时候哪怕盘是满的，也绝不报 ok、绝不交出 solution——
  // reachable()/提示/验收全都指这一点，冤枉人的话它不说，蒙对的事它也不认。
  const ok = filled && !conflict;
  return {
    ok,
    solution: ok ? Uint8Array.from(st.val) : null,
    // 推到底（或推不下去）时每一格还剩哪些候选。界面用它把「引擎已证明不可能」的
    // 铅笔候选画暗，玩家自己决定要不要擦掉——引擎不替他擦。
    masks: Uint16Array.from(st.mask),
    rows,
    steps: places,
    elims,
    score: ok ? Math.round(score * 10) / 10 : 0,
    level,
    enumCost,
    rounds,
    capped,
    breakdown: Object.fromEntries([...weights].map(([k, v]) => [k, v.n])),
    conflict: ok ? null : conflict,
    trace: st,
  };
}

/**
 * 玩家现在的墨水还活不活得下来：把墨水当前提跑一遍铅笔规则，逼出矛盾就是死局。
 * 规则写下的每一处排除都在所有解里成立，所以「矛盾为真 ⟹ 确实无解」，这句警告不冤枉人。
 * 反过来不成立（规则不完备），所以界面只说「这些数字和笼已经矛盾了」，绝不说「这样放是对的」。
 */
export function reachable(board, val) {
  const r = solve(board, { givens: val });
  return !r.conflict;
}

/** 下一条玩家能用的推理（不在脚本里现算，给「提示」兜底与测试用）。 */
export function nextDeduction(board, val) {
  const st = createTrace(board, val);
  const sweep = propagate(board, st);
  if (sweep.conflict) return { conflict: sweep.conflict };
  return sweep.found.find((f) => f.kind === 'place') || sweep.found[0] || null;
}

// ---- 验收：只读盘面，不读推导 ------------------------------------------------------
//
// 与 solve() 无关的一段代码：行是不是排列、列是不是排列、每个笼的算术成不成立。
// 提示逻辑写错也伪造不出一场胜利，靠的就是这里。

export function verify(board, val) {
  const bad = [];
  for (let t = 0; t < board.n; t++) if (!(val[t] >= 1 && val[t] <= board.size)) bad.push({ why: '空格', cell: t });
  for (const unit of board.units) {
    const seen = new Map();
    for (const t of unit.cells) if (val[t] >= 1) seen.set(val[t], (seen.get(val[t]) || 0) + 1);
    for (const [v, k] of seen) if (k > 1) bad.push({ why: '重了', unit: unit.key, name: unit.name, value: v, count: k });
    if (unit.cells.every((t) => val[t] >= 1)) {
      let s = 0;
      for (const t of unit.cells) s += val[t];
      if (s !== board.total) bad.push({ why: '不是排列', unit: unit.key, name: unit.name, sum: s });
    }
  }
  for (const cage of board.cages) {
    const vals = cage.cells.map((t) => val[t]);
    if (vals.some((v) => !(v >= 1))) continue;
    if (!cageHolds(cage.op, cage.target, vals, board.size)) {
      bad.push({ why: '笼不对', cage: cage.i, name: board.cageName(cage.i), label: cage.label, want: cage.target, got: vals.slice() });
    }
  }
  return bad;
}

export function complete(board, val) {
  return val.every((v) => v >= 1) && verify(board, val).length === 0;
}

/**
 * 给界面用的读数：哪一格重了、哪个笼已经凑不成、哪个笼现在还来得及。
 * 与 verify() 同源（都只读盘面），分成两份的原因见 DESIGN §3。
 */
export function diagnose(board, val) {
  let filled = 0;
  const dup = new Set();
  const badCages = new Set();
  const goodCages = new Set();
  const badUnits = new Set();
  const notes = [];
  for (let t = 0; t < board.n; t++) if (val[t] >= 1) filled++;
  for (const unit of board.units) {
    const byValue = new Map();
    for (const t of unit.cells) if (val[t] >= 1) byValue.set(val[t], (byValue.get(val[t]) || []).concat(t));
    for (const [v, list] of byValue) {
      if (list.length > 1) {
        for (const t of list) dup.add(t);
        badUnits.add(unit.key);
        notes.push(`${unit.name} 里有 ${list.length} 个 ${v}`);
      }
    }
  }
  for (const cage of board.cages) {
    const vals = cage.cells.map((t) => val[t]);
    if (vals.every((v) => v >= 1)) {
      if (cageHolds(cage.op, cage.target, vals, board.size)) goodCages.add(cage.i);
      else {
        badCages.add(cage.i);
        for (const t of cage.cells) dup.add(t);
        notes.push(`${board.cageName(cage.i)}现在算出 ${explainAttempt(cage, vals)}，对不上 ${cage.target}`);
      }
      continue;
    }
    if (!canStillHold(board, cage, vals)) {
      badCages.add(cage.i);
      for (let i = 0; i < vals.length; i++) if (vals[i] >= 1) dup.add(cage.cells[i]);
      notes.push(`${board.cageName(cage.i)}填下去就已经凑不出 ${cage.target}`);
    }
  }
  return {
    filled,
    total: board.n,
    remaining: board.n - filled,
    cages: board.cages.length,
    dup,
    badCages,
    goodCages,
    badUnits,
    notes,
    conflicts: dup.size,
  };
}

/** 已经落子的部分，剩下的格子在 1..N 里随便填（不做枚举，只用界）能不能把这个笼凑出来。 */
export function canStillHold(board, cage, vals) {
  const size = board.size;
  const fixed = vals.filter((v) => v >= 1);
  const rest = vals.length - fixed.length;
  if (!rest) return cageHolds(cage.op, cage.target, vals, size);
  // 单格定值笼还空着：只要目标数在盘上合法就来得及（createBoard 保证 1..N，越界的那一类
  // 在这里一并挡掉）。空着 ≠ 凑不出——说「凑不出」是冤枉玩家。
  if (cage.op === '=') return cage.target >= 1 && cage.target <= size;
  if (cage.op === '+') {
    const s = fixed.reduce((a, v) => a + v, 0);
    return cage.target >= s + rest && cage.target <= s + rest * size;
  }
  if (cage.op === '*') {
    const p = fixed.reduce((a, v) => a * v, 1);
    if (cage.target % p !== 0) return false;
    const need = cage.target / p;
    return need >= 1 && need <= size ** rest;
  }
  // − 与 ÷ 只会是两格笼：一格已填就顺着它试，**两格都空着时不能拿 fixed[0] 说话**
  // （那时候它还不存在，`[undefined, x]` 什么都算不出，就会把一只好端端的空笼判成死笼）。
  if (!fixed.length) {
    for (let x = 1; x <= size; x++) for (let y = 1; y <= size; y++) if (cageHolds(cage.op, cage.target, [x, y], size)) return true;
    return false;
  }
  const a = fixed[0];
  for (let x = 1; x <= size; x++) if (cageHolds(cage.op, cage.target, [a, x], size)) return true;
  return false;
}

function explainAttempt(cage, vals) {
  if (cage.op === '+') return `${vals.join('+')}=${vals.reduce((a, v) => a + v, 0)}`;
  if (cage.op === '*') return `${vals.join('×')}=${vals.reduce((a, v) => a * v, 1)}`;
  if (cage.op === '-') return `${vals[0]}−${vals[1]}=${Math.abs(vals[0] - vals[1])}`;
  if (cage.op === '/') {
    const hi = Math.max(vals[0], vals[1]);
    const lo = Math.min(vals[0], vals[1]);
    return `${hi}÷${lo}=${lo && hi % lo === 0 ? hi / lo : '不整除'}`;
  }
  return String(vals[0]);
}

// ---- 由解反推线索：生成器用，验收器绝不用 ------------------------------------------

/**
 * 给定一个拉丁方解与笼划分，列出每个笼能写的所有「目标数 + 运算符」，
 * 按 `pick(list)` 选一个（list 已按 + × − ÷ = 的固定次序排好）。选不出来返回 null。
 */
export function cluesFromSolution(size, solution, cageCells, pick) {
  const cages = [];
  for (const cells of cageCells) {
    const vals = cells.map((t) => solution[t]);
    const legal = legalOps(size, cells, vals);
    if (!legal.length) return null;
    const chosen = pick ? pick(legal, cells) : legal[0];
    if (!chosen) return null;
    cages.push({ cells, op: chosen.op, target: chosen.target });
  }
  return cages;
}

/** 这个笼能写哪些「目标数 + 运算符」；次序固定 = / + / * / - / ÷，方便按配比挑。 */
export function legalOps(size, cells, vals) {
  const out = [];
  if (!vals.every((v) => v >= 1 && v <= size)) return out;
  if (cells.length === 1) return [{ op: '=', target: vals[0] }];
  out.push({ op: '+', target: vals.reduce((a, v) => a + v, 0) });
  out.push({ op: '*', target: vals.reduce((a, v) => a * v, 1) });
  if (cells.length === 2 && vals[0] !== vals[1]) {
    out.push({ op: '-', target: Math.abs(vals[0] - vals[1]) });
    const hi = Math.max(vals[0], vals[1]);
    const lo = Math.min(vals[0], vals[1]);
    if (hi % lo === 0) out.push({ op: '/', target: hi / lo });
  }
  return out.filter((x) => !(x.op === '-' && x.target < 1) && !(x.op === '/' && x.target < 2));
}
