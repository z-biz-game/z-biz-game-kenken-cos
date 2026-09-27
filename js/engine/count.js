// 独立的解数计数器：一台**不含任何推理规则**的穷举机器。
//
// 它与 kenken.js 之间只共享「题面文本」这一件事：本文件自己解析笼、自己判算术、
// 自己查行列重复。规则表、界、候选掩码一概不用——共享了常量表就只是自己跟自己一致。
// 出货要求两套代码在同一批题上给出**逐格相同**的答案（tools/balance.mjs 与
// tools/engine-test.mjs 都盯着这件事）。
//
// 它只回答一个问题：这个题面有几个解？数到 `cap` 就停，并且把超预算当成
// OVERBUDGET 返回，绝不让「没数完」冒充「只有一个解」。

export const UNIQUE = 'UNIQUE';
export const MANY = 'MANY';
export const NONE = 'NONE';
export const OVERBUDGET = 'OVERBUDGET';

const OPS = ['=', '+', '-', '*', '/'];

/** 自己解析题面文本：`op目标数:格子对` 用分号隔开。 */
export function parsePuzzle(size, text) {
  const n = size * size;
  const cages = [];
  const cageOf = new Int8Array(n).fill(-1);
  for (const chunk of String(text).split(';')) {
    const colon = chunk.indexOf(':');
    const op = chunk.slice(0, colon);
    const target = Number(op.slice(1));
    const kind = op[0];
    if (!OPS.includes(kind)) throw new Error(`计数器不认识运算符：${chunk}`);
    const body = chunk.slice(colon + 1);
    const cells = [];
    for (let i = 0; i < body.length; i += 2) cells.push(parseInt(body.substr(i, 2), 36));
    for (const t of cells) {
      if (!(t >= 0 && t < n)) throw new Error(`计数器遇到越界格子：${chunk}`);
      if (cageOf[t] >= 0) throw new Error(`计数器的格子被两个笼盖住：${t}`);
      cageOf[t] = cages.length;
    }
    cages.push({ cells, op: kind, target });
  }
  let covered = 0;
  for (let t = 0; t < n; t++) if (cageOf[t] >= 0) covered++;
  if (covered !== n) throw new Error('计数器：有格子不属于任何笼');
  return { size, n, cages, cageOf };
}

// 本文件自己写的一份笼判定（与 kenken.js 的 cageHolds 分开维护）。
function holdsLocal(op, target, vals, size) {
  for (const v of vals) if (!(v >= 1 && v <= size)) return false;
  if (op === '=') return vals.length === 1 && vals[0] === target;
  if (op === '+') {
    let s = 0;
    for (const v of vals) s += v;
    return s === target;
  }
  if (op === '*') {
    let p = 1;
    for (const v of vals) p *= v;
    return p === target;
  }
  const a = vals[0];
  const b = vals[1];
  if (op === '-') return Math.abs(a - b) === target;
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  return hi % lo === 0 && hi / lo === target;
}

/**
 * 逐格穷举：一位试一个数字（1..N），当场查同行同列有没有重，笼在填满的那一刻查算术。
 * 候选掩码、界、组合枚举一概没有——它的价值就在于「什么道理都不讲，只数」。
 *
 * @param {object|string} puzzle board 结构、{size,text} 或题面文本（第二参数给 size）
 */
export function countSolutions(puzzle, opts = {}) {
  const cap = opts.cap || 2;
  const budget = opts.budget || 400000;
  const size = typeof puzzle === 'string' ? opts.size : puzzle.size;
  const text = typeof puzzle === 'string' ? puzzle : puzzle.text != null ? puzzle.text : null;
  if (text == null) throw new Error('计数器只吃题面文本，避免共用规则表');
  const { n, cages, cageOf } = parsePuzzle(size, text);
  const cellsSorted = cages.map((c) => c.cells.slice().sort((a, b) => a - b));
  const lastCellOf = cellsSorted.map((list) => list[list.length - 1]);
  const assign = new Uint8Array(n);
  const rowUsed = [];
  const colUsed = [];
  for (let i = 0; i < size; i++) {
    rowUsed.push(new Uint8Array(size + 1));
    colUsed.push(new Uint8Array(size + 1));
  }
  let nodes = 0;
  let solutions = 0;
  let first = null;
  let over = false;

  const cageComplete = (ci, at) => lastCellOf[ci] === at;

  const go = (t) => {
    if (nodes++ > budget) {
      over = true;
      return true;
    }
    if (t === n) {
      solutions++;
      if (!first) first = Uint8Array.from(assign);
      return solutions >= cap;
    }
    const r = Math.floor(t / size);
    const c = t % size;
    const ci = cageOf[t];
    const cage = cages[ci];
    for (let v = 1; v <= size; v++) {
      if (rowUsed[r][v] || colUsed[c][v]) continue;
      assign[t] = v;
      rowUsed[r][v] = 1;
      colUsed[c][v] = 1;
      let ok = true;
      if (cageComplete(ci, t)) {
        // 笼里最后一格刚落子，此刻整笼有值：用本文件的判定函数算一次
        const vals = cage.cells.map((x) => assign[x]);
        if (!holdsLocal(cage.op, cage.target, vals, size)) ok = false;
      }
      if (ok && go(t + 1)) {
        assign[t] = 0;
        rowUsed[r][v] = 0;
        colUsed[c][v] = 0;
        return true;
      }
      assign[t] = 0;
      rowUsed[r][v] = 0;
      colUsed[c][v] = 0;
    }
    return false;
  };
  go(0);
  if (over) return { status: OVERBUDGET, solutions, nodes, first: null };
  return {
    status: solutions >= cap ? MANY : solutions === 1 ? UNIQUE : NONE,
    solutions,
    nodes,
    first,
  };
}
