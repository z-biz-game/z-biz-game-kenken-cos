#!/usr/bin/env node
// 引擎测试：`npm test`。四类断言，四类都不许只是「跑通了」——
//   A 规则可靠：笼的算术、盘面校验、序列化、组合枚举，以及四条铅笔规则各自的 anchor。
//   B 生成保证：出货验收（铅笔推到底 + 独立计数器 UNIQUE + 逐格同解）、确定性、档位阶梯。
//   C 状态机：墨水/铅笔/撤销/提示/拒绝——拒绝必须把「哪一行哪一列哪个笼」说出口。
//   D 存档形状：编码往返、脏数据、抛异常的存储。
//
// 写法纪律：**能写死数字就写死数字**。`eq('和是 55', got, 55)`，不是 `ok('有和', got > 0)`。
// 松断言在实现变了之后还会绿，那它就什么也没看住。

import {
  ASSIGN_BUDGET,
  Rules,
  RULE_LIST,
  bit,
  boardFromText,
  cageAssignments,
  cageHolds,
  cageLabel,
  cageMultisets,
  cageRange,
  canStillHold,
  colOf,
  complete,
  createBoard,
  createTrace,
  diagnose,
  formatCages,
  fullMask,
  legalOps,
  maskHas,
  maskOfValues,
  neighbours,
  onlyValue,
  opName,
  parseCages,
  popcount,
  propagate,
  reachable,
  rowOf,
  solve,
  valuesOfMask,
  verify,
} from '../js/engine/kenken.js';
import { countSolutions, UNIQUE, NONE, MANY, OVERBUDGET, parsePuzzle } from '../js/engine/count.js';
import { DIFFICULTY_WEIGHTS, TIERS, accept, buildPuzzle, difficulty, generate, mix, probe, randomCages, randomLatin } from '../js/engine/generate.js';
import { CAMPAIGN } from '../js/data/campaign.js';
import { dailyLevel, levelById, tierForDay } from '../js/data/library.js';
import { Game } from '../js/ui/game.js';

let passed = 0;
const failures = [];
const classes = {};
let current = '未分类';

function note(msg) {
  process.stdout.write(msg + '\n');
}
function head(msg) {
  current = msg;
  classes[msg] = classes[msg] || { n: 0, bad: 0 };
  note(`\n── ${msg} ${'─'.repeat(Math.max(0, 58 - msg.length))}`);
}
function record(label, ok, extra) {
  classes[current] = classes[current] || { n: 0, bad: 0 };
  classes[current].n++;
  if (ok) {
    passed++;
    return true;
  }
  classes[current].bad++;
  failures.push(`${current} / ${label}${extra ? '  [' + extra + ']' : ''}`);
  return false;
}
function eq(label, got, want) {
  const a = typeof got === 'object' ? JSON.stringify(got) : got;
  const b = typeof want === 'object' ? JSON.stringify(want) : want;
  const hit = record(`${label} = ${JSON.stringify(a)}`, a === b, `期望 ${JSON.stringify(b)}`);
  if (!hit) note(`  ✗ ${label}\n      得到 ${JSON.stringify(a)}\n      期望 ${JSON.stringify(b)}`);
  return hit;
}
function ck(label, cond, extra) {
  const hit = record(label, !!cond, extra);
  if (!hit) note(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  return hit;
}
function throws(label, fn, wantFragment) {
  let msg = null;
  try {
    fn();
  } catch (e) {
    msg = e.message;
  }
  if (msg === null) return ck(`${label} 应当抛错`, false, '没抛');
  if (wantFragment && !msg.includes(wantFragment)) return ck(`${label} 的错误文案`, false, `得到「${msg}」，期望含「${wantFragment}」`);
  return record(`${label} → ${msg}`, true);
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const arr = (x) => Array.from(x);

// ============================ 独立暴力：测试自己写的一份 ============================
//
// 这一节是整个测试的地基：引擎的笼枚举（规则 ③ 的家当）与整盘解数，都由**测试里另写的
// 两份穷举代码**对着打。三份代码各自独立——`js/engine/kenken.js`（推理）、
// `js/engine/count.js`（不含推理规则的计数器）、本文件（真值表）——任何一份写歪都会露馅。
//
// 为什么要有第三份：count.js 数到 cap 就停，只交出第一个解。要核对「这条结论在**每一个**
// 解里都成立」，模糊盘必须把所有解都摊开，所以这里补一份能枚举全部解的穷举器（只跑 3、4 阶，
// 五阶的拉丁方已经 16 万个了）。

/** 独立枚举一个笼的全部合法赋值：整点暴力，界、缓存、掩码一概不用。 */
function bruteAssignments(op, target, cells, size, doms = null) {
  const k = cells.length;
  const every = Array.from({ length: size }, (_, j) => j + 1);
  const D = cells.map((t, i) => (doms && doms[i]) || every);
  const out = [];
  const vals = new Array(k).fill(0);
  const sameLine = (a, b) => Math.floor(a / size) === Math.floor(b / size) || a % size === b % size;
  const legal = () => {
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) if (sameLine(cells[a], cells[b]) && vals[a] === vals[b]) return false;
    let s = 0;
    let p = 1;
    for (const v of vals) {
      s += v;
      p *= v;
    }
    if (op === '=') return k === 1 && vals[0] === target;
    if (op === '+') return s === target;
    if (op === '*') return p === target;
    if (k !== 2) return false;
    if (op === '-') return Math.abs(vals[0] - vals[1]) === target;
    const hi = Math.max(vals[0], vals[1]);
    const lo = Math.min(vals[0], vals[1]);
    return lo > 0 && hi % lo === 0 && hi / lo === target;
  };
  const rec = (i) => {
    if (i === k) {
      if (legal()) out.push(vals.slice());
      return;
    }
    for (const v of D[i]) {
      vals[i] = v;
      rec(i + 1);
    }
    vals[i] = 0;
  };
  rec(0);
  return out;
}

/** 独立算「这个笼在当前候选下能算出的全部结果」，用来核对 cageRange 的可达区间。 */
function bruteRange(op, cells, size, doms) {
  const k = cells.length;
  const sameLine = (a, b) => Math.floor(a / size) === Math.floor(b / size) || a % size === b % size;
  const vals = new Array(k).fill(0);
  let lo = Infinity;
  let hi = -Infinity;
  const rec = (i) => {
    if (i === k) {
      for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) if (sameLine(cells[a], cells[b]) && vals[a] === vals[b]) return;
      let v;
      if (op === '+' || op === '=') v = vals.reduce((x, y) => x + y, 0);
      else if (op === '*') v = vals.reduce((x, y) => x * y, 1);
      else if (op === '-') v = Math.abs(vals[0] - vals[1]);
      else {
        const h = Math.max(vals[0], vals[1]);
        const l = Math.min(vals[0], vals[1]);
        if (!(l > 0 && h % l === 0)) return;
        v = h / l;
      }
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      return;
    }
    for (const x of D(i)) {
      vals[i] = x;
      rec(i + 1);
    }
    vals[i] = 0;
  };
  const D = (i) => doms[i];
  rec(0);
  return lo === Infinity ? { empty: true } : { empty: false, lo, hi };
}

/** 独立穷举整盘的全部解（从题面文本重新解析笼，只用行/列是排列 + 笼算术）。 */
function bruteAllSolutions(size, text, cap = 5000) {
  const cages = text.split(';').map((chunk) => {
    const colon = chunk.indexOf(':');
    const body = chunk.slice(colon + 1);
    const cells = [];
    for (let i = 0; i < body.length; i += 2) cells.push(parseInt(body.slice(i, i + 2), 36));
    return { op: chunk[0], target: Number(chunk.slice(1, colon)), cells };
  });
  const perms = [];
  const used = [];
  const cur = [];
  const grow = () => {
    if (cur.length === size) {
      perms.push(cur.slice());
      return;
    }
    for (let v = 1; v <= size; v++) {
      if (used[v]) continue;
      used[v] = 1;
      cur.push(v);
      grow();
      cur.pop();
      used[v] = 0;
    }
  };
  grow();
  const holds = (cage, grid) => {
    const vals = cage.cells.map((t) => grid[Math.floor(t / size)][t % size]);
    if (cage.op === '=') return vals.length === 1 && vals[0] === cage.target;
    if (cage.op === '+') return vals.reduce((a, v) => a + v, 0) === cage.target;
    if (cage.op === '*') return vals.reduce((a, v) => a * v, 1) === cage.target;
    if (cage.op === '-') return Math.abs(vals[0] - vals[1]) === cage.target;
    const hi = Math.max(vals[0], vals[1]);
    const lo = Math.min(vals[0], vals[1]);
    return lo > 0 && hi % lo === 0 && hi / lo === cage.target;
  };
  const grid = [];
  const out = [];
  const rec = (r) => {
    if (out.length >= cap) return;
    if (r === size) {
      if (cages.every((c) => holds(c, grid))) out.push(grid.flat().slice());
      return;
    }
    for (const p of perms) {
      let clash = false;
      for (let c = 0; c < size; c++) {
        for (let q = 0; q < r; q++) if (grid[q][c] === p[c]) clash = true;
        if (clash) break;
      }
      if (clash) continue;
      grid.push(p);
      // 已经落定的整笼先判掉（笼里最下面一行还在下面时不判）
      const settled = cages.every((c) => {
        const deepest = Math.max(...c.cells.map((t) => Math.floor(t / size)));
        return c.cells.length === 1 || deepest >= grid.length || holds(c, grid);
      });
      if (settled) rec(r + 1);
      grid.pop();
    }
  };
  rec(0);
  return out;
}

const GOLD7 =
  '+6:1011;-2:0d0k;+15:030a0b0h0i;+12:0j0q;-3:0f0g;*6:0l0m;+28:0n0o0u0v0w13;+21:14151a1b1c;+8:0102;+14:05060c;*14:00070e;*42:0809;+4:0r0x0y;*2160:0s0t0z1617;+12:1219;=1:18;=4:0p;=2:04';

/** 把引擎写下的每一条结论拿去对答案：place 必须等于该格的每个解，elim 必须在每个解里都不等。 */
function violations(rows, solutions) {
  const bad = [];
  for (const row of rows) {
    solutions.forEach((sol, i) => {
      const hit = row.kind === 'place' ? sol[row.cell] !== row.value : sol[row.cell] === row.value;
      if (hit) bad.push(`第${i + 1}个解违背：${row.text}`);
    });
  }
  return bad;
}

// B/C 两段还要拿金标准盘的完整推导对答案，这里留一份顶层引用。
const sg = solve(boardFromText(7, GOLD7));

// ================================ A 规则可靠 ================================
head('A 规则可靠 · 掩码');
eq('fullMask(5)', fullMask(5), 0b111110);
eq('fullMask(5) 里有几个候选', popcount(fullMask(5)), 5);
eq('bit(3)', bit(3), 8);
eq('valuesOfMask(fullMask(4))', valuesOfMask(fullMask(4)), [1, 2, 3, 4]);
eq('maskOfValues([2,5])', maskOfValues([2, 5]), bit(2) | bit(5));
ck('空掩码没有候选', popcount(0) === 0);
eq('onlyValue(单候选)', onlyValue(bit(4)), 4);
eq('onlyValue(两候选) = 0', onlyValue(bit(4) | bit(2)), 0);
eq('maskHas 认得 0', maskHas(0, 1), false);
eq('行号', rowOf(12, 5), 2);
eq('列号', colOf(12, 5), 2);
eq('角格邻居数', neighbours(0, 5).length, 2);
eq('中心格邻居数', neighbours(12, 5).length, 4);

head('A 规则可靠 · 笼的算术（只用整数）');
eq('1+2+3 对 6+ 三格', cageHolds('+', 6, [1, 2, 3], 6), true);
eq('顺序不影响加法', cageHolds('+', 6, [3, 1, 2], 6), true);
// 判据：2+3=5，不是 6——这条原是测试写歪，按算术改回 5+，另留一条「凑不出 6」的下界样本。
eq('2+3 对 5+ 两格', cageHolds('+', 5, [2, 3], 6), true);
eq('2+3 凑不出 6+', cageHolds('+', 6, [2, 3], 6), false);
eq('和不够就不够', cageHolds('+', 7, [2, 3], 6), false);
eq('2×3×4 对 24×', cageHolds('*', 24, [2, 3, 4], 6), true);
eq('2×2×6 对 24×', cageHolds('*', 24, [2, 2, 6], 6), true);
eq('积差一点也不行', cageHolds('*', 24, [2, 3, 5], 6), false);
eq('4−2 对 2−', cageHolds('-', 2, [4, 2], 6), true);
eq('− 不看顺序', cageHolds('-', 2, [2, 4], 6), true);
// cageHolds 只管算术：同不同行是 createBoard/枚举的事，这里明确它算得出 0。
eq('cageHolds 只算算术：2,2 对 0− 算得成立', cageHolds('-', 0, [2, 2], 6), true);
eq('6÷3 对 2÷', cageHolds('/', 2, [6, 3], 6), true);
eq('3÷6 对 2÷（顺序不限）', cageHolds('/', 2, [3, 6], 6), true);
eq('4÷2 对 2÷', cageHolds('/', 2, [4, 2], 6), true);
eq('6÷4 不整除 ⇒ 不是 1÷', cageHolds('/', 1, [6, 4], 6), false);
eq('12÷3 = 4 ⇒ 是 4÷（越界的值由 size 把关）', cageHolds('/', 4, [12, 3], 12), true);
eq('12÷3 在六阶盘上不算 4÷（值越界）', cageHolds('/', 4, [12, 3], 6), false);
eq('单格笼 3 对「3」', cageHolds('=', 3, [3], 5), true);
eq('单格笼 4 不对「3」', cageHolds('=', 3, [4], 5), false);
eq('三格笼不写 −（减只用于两格）', cageHolds('-', 1, [3, 2, 1], 5), false);
eq('浮点进不来：÷ 的商必须是整数', cageHolds('/', 2, [5, 2], 6), false);
eq('标签：×', cageLabel('*', 24), '24×');
eq('标签：÷', cageLabel('/', 2), '2÷');
eq('标签：单格不写运算符', cageLabel('=', 4), '4');
eq('opName(−)', opName('-'), '减');

head('A 规则可靠 · 盘面校验');
throws('边长 1 不行', () => createBoard({ size: 1, cages: [{ op: '=', target: 1, cells: [0] }] }), '盘边长');
throws('10 阶超出掩码', () => createBoard({ size: 10, cages: [] }), '盘边长');
throws('没笼子', () => createBoard({ size: 3, cages: [] }), '一个笼都没有');
throws('格子越界', () => createBoard({ size: 2, cages: [{ op: '+', target: 3, cells: [0, 4] }] }), '越界格子');
throws('一格被两个笼盖住', () =>
  createBoard({ size: 2, cages: [{ op: '+', target: 3, cells: [0, 1] }, { op: '+', target: 3, cells: [1, 2] }, { op: '=', target: 1, cells: [3] }] }),
  '两个笼');
throws('笼里有重复格子', () => createBoard({ size: 2, cages: [{ op: '+', target: 3, cells: [0, 0] }, { op: '+', target: 3, cells: [1, 2] }, { op: '=', target: 1, cells: [3] }] }), '重复格子');
throws('没盖住的格子', () => createBoard({ size: 2, cages: [{ op: '+', target: 3, cells: [0, 1] }] }), '不属于任何笼');
throws('单格笼写运算符', () => createBoard({ size: 2, cages: [{ op: '+', target: 1, cells: [0] }, { op: '+', target: 3, cells: [1, 2] }, { op: '=', target: 1, cells: [3] }] }), '单格笼必须直接写目标数');
throws('定值笼两格', () => createBoard({ size: 2, cages: [{ op: '=', target: 1, cells: [0, 1] }, { op: '+', target: 3, cells: [2, 3] }] }), '只能有一格');
throws('三格减法笼', () => createBoard({ size: 3, cages: [{ op: '-', target: 1, cells: [0, 1, 2] }, { op: '+', target: 4, cells: [3, 4] }, { op: '+', target: 4, cells: [5, 6] }, { op: '+', target: 4, cells: [7, 8] }] }), '只用于两格笼');
throws('单格定值越界', () => createBoard({ size: 4, cages: [{ op: '=', target: 5, cells: [0] }] }), '必须在 1..4 之内');
throws('0− 不合法（相邻两格必不同值）', () => createBoard({ size: 2, cages: [{ op: '-', target: 0, cells: [0, 1] }, { op: '+', target: 3, cells: [2, 3] }] }), '差不可能是 0');
throws('1÷ 不合法（相邻两格必不同值）', () => createBoard({ size: 2, cages: [{ op: '/', target: 1, cells: [0, 1] }, { op: '+', target: 3, cells: [2, 3] }] }), '商至少是 2');
throws('笼子不连成一片（几何病）', () => createBoard({ size: 3, cages: [{ op: '+', target: 3, cells: [0, 4] }, { op: '+', target: 5, cells: [1, 2] }, { op: '+', target: 7, cells: [3, 6] }, { op: '+', target: 9, cells: [5, 8] }, { op: '=', target: 3, cells: [7] }] }), '不连成一片');

// —— 文案族：「格子不连成一片」与「组合凑不出来」是两种病，一条都不能顺手替另一条。
//    草稿把这两种病塞进同一只盘里（+3:[5,6] 既断在 (1,2)↔(2,0) 之间，又凑不出 3），
//    createBoard 先查几何，于是只报了「不连成一片」——修法是给算术病一只**几何完全合法**的盘：
//    3×3 按行切成三个横三格笼，其中 27+ 在 1..3 里最大只能加到 9。
throws('笼在 1..N 里根本凑不出来（算术病，几何无毛病）', () =>
  createBoard({
    size: 3,
    cages: [
      { op: '+', target: 27, cells: [0, 1, 2] },
      { op: '+', target: 6, cells: [3, 4, 5] },
      { op: '+', target: 6, cells: [6, 7, 8] },
    ],
  }), '根本凑不出来');
{
  // 同一批格子只把「断开的笼」接回去，报的就换成算术病：证明两条文案各管各的病。
  const geoFixed = () =>
    createBoard({
      size: 3,
      cages: [
        { op: '+', target: 27, cells: [3, 4] },
        { op: '+', target: 3, cells: [0, 1] },
        { op: '+', target: 4, cells: [2, 5] },
        { op: '+', target: 4, cells: [6, 7] },
        { op: '=', target: 2, cells: [8] },
      ],
    });
  throws('接成一片后，同一只盘报的是算术病', geoFixed, '根本凑不出来');
  // 反向：既断又凑不出来的盘，几何病先报（不许合并成一条）
  const both = () =>
    createBoard({
      size: 3,
      cages: [
        { op: '+', target: 27, cells: [0, 4] },
        { op: '+', target: 3, cells: [1, 2] },
        { op: '+', target: 4, cells: [3, 6] },
        { op: '+', target: 4, cells: [5, 8] },
        { op: '=', target: 1, cells: [7] },
      ],
    });
  throws('又断又凑不出来的盘，先报几何病', both, '不连成一片');
  const geoErr = (() => {
    try {
      both();
      return '';
    } catch (e) {
      return e.message;
    }
  })();
  ck('几何病与算术病各说各话', geoErr.includes('不连成一片') && !geoErr.includes('凑不出来'), geoErr);
}

const b3 = createBoard({
  size: 3,
  cages: [
    { op: '+', target: 3, cells: [0, 1] },
    { op: '+', target: 4, cells: [2, 5] },
    { op: '+', target: 5, cells: [3, 6] },
    { op: '-', target: 2, cells: [4, 7] },
    { op: '=', target: 2, cells: [8] },
  ],
});
// 把 b3 整个盘顺时针转 90°（(r,c)→(c,N-1-r)）：横笼变竖笼、竖笼变横笼，
// 笼的算术一格没动，动的全是几何。同一套结论必须换个方向照样成立——
// 凡是「只对横笼有效」的实现都会在这里露馅。
const cross = createBoard({
  size: 3,
  cages: [
    { op: '+', target: 3, cells: [2, 5] },
    { op: '+', target: 4, cells: [7, 8] },
    { op: '+', target: 5, cells: [0, 1] },
    { op: '-', target: 2, cells: [3, 4] },
    { op: '=', target: 2, cells: [6] },
  ],
});
const sc2 = solve(cross);
eq('三阶盘：笼子数', b3.cages.length, 5);
eq('三阶盘：每格恰好一个笼', new Set(arr(b3.cageOf)).size, 5);
eq('三阶盘：行和常量 N(N+1)/2', b3.total, 6);
eq('三阶盘：单位数 = 行+列', b3.units.length, 6);
eq('三阶盘：每格的同侪数 = 2(N-1)', b3.peers.every((p) => p.length === 4), true);
eq('笼子编号连续', b3.cages.map((c) => c.i), [0, 1, 2, 3, 4]);
eq('笼头取行主序最小格', b3.cages[1].head, 2);
eq('笼名带标签', b3.cageName(0), '第1号笼「3+」');
eq('整盘的名字', b3.cageName(-1), '整盘');
eq('格子坐标读法', b3.cellName(4), '第2行2列');
ck('笼名里不出现两层「」', !/「「|」」/.test(b3.cages.map((c) => b3.cageName(c.i)).join(';')));

head('A 规则可靠 · 序列化（战役文本行与存档共用）');
const roundTrip = parseCages(b3.text);
eq('文本能解析回同样数量的笼', roundTrip.length, 5);
eq('第一笼的格子', roundTrip[0].cells, [0, 1]);
eq('第一笼的运算符', roundTrip[0].op, '+');
eq('第一笼的目标数', roundTrip[0].target, 3);
eq('格式化回去逐字节相同', formatCages(b3.cages), b3.text);
eq('从文本重建的盘与原件同构', boardFromText(3, b3.text).text, b3.text);
eq('金标准盘的文本也能逐字节往返', formatCages(boardFromText(7, GOLD7).cages), GOLD7);
eq('九阶的格子下标用两位 36 进制', parseCages(formatCages([{ op: '+', target: 1, cells: [80] }]))[0].cells, [80]);
throws('半格文本', () => parseCages('+3:000'), '格子数是半个');
throws('缺冒号', () => parseCages('+300'), '缺了冒号');
throws('运算符不认识', () => parseCages('^3:00'), '不认识');
throws('空文本', () => parseCages(''), '笼文本为空');

head('A 规则可靠 · 组合枚举（引擎 == 独立暴力，逐位相等）');
// 期望值全部按手算写死；同一批笼子再与 bruteAssignments 逐位对齐。
// cell 记号：size=5 时 0=(1,1)、1=(1,2)、5=(2,1)、6=(2,2)；size=6 时 1=(1,2)、5=(1,5)、
// 6=(2,1)、7=(2,2)——**同一对编号在不同边长下的几何不一样**，[0,6] 在五阶是对角、在六阶是同列。
//   [0,1] 同行 → 两格必须互异；[0,5] 同列 → 同样互异；[0,6](五阶)/[0,7](六阶) 对角 → 允许同值。
const COMBOS = [
  ['+', 6, [0, 1, 2], 5, 6, ['1,2,3']],
  ['+', 6, [0, 1, 6], 5, 7, ['1,1,4', '1,2,3']],
  ['+', 7, [0, 1], 5, 4, ['2,5', '3,4']],
  ['+', 7, [0, 5], 5, 4, ['2,5', '3,4']],
  ['+', 7, [0, 6], 5, 4, ['2,5', '3,4']], // 对角也救不了 7+：1..5 里没有 3.5+3.5
  ['+', 8, [0, 1], 6, 4, ['2,6', '3,5']], // 同行：4+4 被几何约束拿掉
  ['+', 8, [0, 7], 6, 5, ['2,6', '3,5', '4,4']], // 对角：4+4 活下来
  ['+', 2, [0, 1], 5, 0, []],
  ['+', 27, [0, 1, 2], 3, 0, []],
  ['+', 3, [0, 1, 2], 5, 0, []],
  ['+', 6, [0, 1, 2], 3, 6, ['1,2,3']],
  ['*', 24, [0, 1, 2], 6, 12, ['1,4,6', '2,3,4']],
  ['*', 24, [0, 1, 6], 6, 13, ['1,4,6', '2,2,6', '2,3,4']],
  ['*', 20, [0, 1, 2], 5, 6, ['1,4,5']],
  ['*', 20, [0, 1, 5], 5, 7, ['1,4,5', '2,2,5']],
  ['*', 2, [0, 1], 5, 2, ['1,2']],
  ['*', 4, [0, 1], 5, 2, ['1,4']], // 同行：2×2 不算
  ['*', 4, [0, 6], 5, 3, ['1,4', '2,2']], // 对角：2×2 算
  ['*', 120, [0, 1, 2, 3, 4], 5, 120, ['1,2,3,4,5']],
  ['-', 2, [0, 1], 5, 6, ['1,3', '2,4', '3,5']],
  ['-', 2, [0, 6], 5, 6, ['1,3', '2,4', '3,5']],
  ['/', 2, [0, 1], 6, 6, ['1,2', '2,4', '3,6']],
  ['/', 2, [0, 6], 6, 6, ['1,2', '2,4', '3,6']], // 六阶的 [0,6] 是同列，互异本来就成立
  ['/', 1, [0, 1], 6, 0, []],
  ['/', 1, [0, 6], 6, 0, []], // 同列的 1÷：商 1 要求两格等值 ⇒ 一条都没有
  ['/', 1, [0, 7], 6, 6, ['1,1', '2,2', '3,3', '4,4', '5,5', '6,6']], // 对角才配得出 1÷
  ['=', 3, [0], 5, 1, ['3']],
  ['=', 6, [0], 5, 0, []],
];
for (const [op, target, cells, size, wantN, wantSets] of COMBOS) {
  const cage = { cells, op, target };
  const mine = bruteAssignments(op, target, cells, size);
  const eng = cageAssignments(cage, size, null, { budget: 400000 });
  eq(`${target}${op} ${JSON.stringify(cells)} size=${size} 的赋值条数`, eng.list.length, wantN);
  eq(`${target}${op} ${JSON.stringify(cells)} 引擎逐位等于暴力`, JSON.stringify(eng.list), JSON.stringify(mine));
  eq(`${target}${op} ${JSON.stringify(cells)} 的多重集`, cageMultisets(cage, size).map((m) => m.join(',')), wantSets);
  ck(`${target}${op} ${JSON.stringify(cells)} 没触顶`, eng.capped === false);
}
{
  // 带候选域的枚举：规则 ③ 实际用的就是这一条，域必须一起交两份独立代码算。
  const masked = [
    ['+', 6, [0, 1, 6], 5, [[1, 2, 3], [2, 4], [1, 3, 5]]],
    ['*', 24, [0, 1, 2], 6, [[1, 2, 4], [1, 3, 6], [2, 4, 6]]],
    ['-', 2, [0, 1], 5, [[1, 2], [1, 2]]],
    ['+', 5, [0, 1, 2], 4, [[1, 2], [1, 2, 3], [1, 2, 3, 4]]],
    ['/', 2, [0, 6], 6, [[1, 2], [1, 2, 3, 4, 5, 6]]],
  ];
  for (const [op, target, cells, size, doms] of masked) {
    const mask = new Uint16Array(size * size);
    cells.forEach((t, i) => {
      mask[t] = maskOfValues(doms[i]);
    });
    const mine = bruteAssignments(op, target, cells, size, doms);
    const eng = cageAssignments({ cells, op, target }, size, mask, { budget: 400000 }).list;
    eq(`${target}${op} ${JSON.stringify(cells)} 在域 ${JSON.stringify(doms)} 下等于暴力`, JSON.stringify(eng), JSON.stringify(mine));
  }
}
{
  // 预算封顶：capped 绝不算通过（引擎宁可这个笼一条结论都不写，也不写一条没数完的）。
  const big = { cells: [0, 1, 2, 3], op: '+', target: 10 };
  const hit = cageAssignments(big, 4, null, { budget: 2 });
  eq('预算 2 时触顶', hit.capped, true);
  eq('触顶时只交出预算内的条数', hit.list.length, 2);
  const one = cageAssignments({ cells: [0, 1, 2], op: '+', target: 6 }, 5, null, { budget: 1 });
  eq('预算 1：哪怕只有 1 条也算触顶', one.capped, true);
  eq('触顶笼的枚举代价照实回报', one.tried >= 1, true);
  eq('同一笼不触顶时 capped 为假', cageAssignments({ cells: [0, 1, 2], op: '+', target: 6 }, 5, null, { budget: 3000 }).capped, false);
  ck('ASSIGN_BUDGET 是正数', ASSIGN_BUDGET > 0);
  eq('枚举预算能真的触顶', cageAssignments({ cells: [0, 1, 2, 3], op: '+', target: 10 }, 4, null, { budget: 2 }).capped, true);
  eq('单格 =5 只有一个赋值', cageAssignments({ cells: [0], op: '=', target: 5 }, 5, null).list, [[5]]);
  eq('单格 =6 在五阶里无解', cageAssignments({ cells: [0], op: '=', target: 6 }, 5, null).list.length, 0);
}
eq('legalOps 给单格只给定值', legalOps(5, [0], [3]).map((x) => x.op + x.target), ['=3']);
eq('legalOps 两格 2,4：+ × − ÷ 全开', legalOps(5, [0, 1], [2, 4]).map((x) => x.op + x.target), ['+6', '*8', '-2', '/2']);
eq('legalOps 两格 2,3：÷ 写不出来', legalOps(5, [0, 1], [2, 3]).map((x) => x.op + x.target), ['+5', '*6', '-1']);
eq('legalOps 两格同值（不同行不同列）：− 与 ÷ 都不许写', legalOps(5, [0, 6], [3, 3]).map((x) => x.op + x.target), ['+6', '*9']);
eq('legalOps 拒绝越界的值', legalOps(5, [0, 1], [0, 3]).length, 0);

head('A 规则可靠 · 可达区间（两格精确，三格以上是放宽）');
const RANGES = [
  ['+', 7, [0, 1], 5, null],
  ['+', 7, [0, 1], 5, [[2, 4], null]],
  ['+', 7, [0, 5], 5, [[2, 4], null]],
  ['*', 2, [0, 1], 5, [[3, 4, 5], null]],
  ['/', 2, [0, 1], 6, null],
  ['/', 2, [0, 6], 6, [[1, 2, 3], null]],
  ['-', 2, [0, 1], 5, [[1, 2], [1, 2]]],
  ['-', 3, [0, 6], 6, null],
  ['*', 6, [0, 1], 6, [[2, 3], [1, 2, 3, 4, 5, 6]]],
];
for (const [op, target, cells, size, doms] of RANGES) {
  const full = Array.from({ length: size }, (_, j) => j + 1);
  const D = cells.map((t, i) => (doms ? doms[i] || full : full));
  const mask = new Uint16Array(size * size);
  cells.forEach((t, i) => {
    mask[t] = maskOfValues(D[i]);
  });
  const truth = bruteRange(op, cells, size, D);
  const eng = cageRange({ cells, op, target }, size, mask);
  if (cells.length === 2) eq(`${target}${op} 两格 ${JSON.stringify(cells)} 的区间精确等于暴力`, JSON.stringify(eng), JSON.stringify(truth));
  else {
    ck(`${target}${op} 的区间包住暴力真值`, truth.empty || (eng.lo <= truth.lo && eng.hi >= truth.hi), `${JSON.stringify(eng)} vs ${JSON.stringify(truth)}`);
  }
}
{
  // 放宽的代价，明写在账上：三格同域 {2,3,4} 时真实可达只有 9，界却说 6..12。
  const doms = [[2, 3, 4], [2, 3, 4], [2, 3, 4]];
  const mask = new Uint16Array(25);
  [0, 1, 2].forEach((t, i) => {
    mask[t] = maskOfValues(doms[i]);
  });
  const eng = cageRange({ cells: [0, 1, 2], op: '+', target: 6 }, 5, mask);
  const truth = bruteRange('+', [0, 1, 2], 5, doms);
  eq('三格横笼 6+ 的放宽界', eng, { empty: false, lo: 6, hi: 12 });
  eq('三格横笼 6+ 的真值界', truth, { empty: false, lo: 9, hi: 9 });
  ck('界是放宽不是精确（所以规则②会漏，规则③补上）', eng.lo < truth.lo, `${JSON.stringify(eng)} vs ${JSON.stringify(truth)}`);
}
{
  const deadDom = new Uint16Array(25);
  deadDom[0] = bit(2);
  deadDom[1] = bit(2);
  eq('两格同域只剩 (2,2) 而同行不许同值 ⇒ 这个笼算不出结果', cageRange({ cells: [0, 1], op: '+', target: 4 }, 5, deadDom), { empty: true });
  const emptyCell = new Uint16Array(25);
  emptyCell[0] = 0;
  emptyCell[1] = fullMask(5);
  eq('某一格候选已被挤空 ⇒ 笼算不出结果', cageRange({ cells: [0, 1], op: '+', target: 4 }, 5, emptyCell), { empty: true });
}

head('A 规则可靠 · anchor ① 行列排除');
{
  // 3×3 手工盘 b3（+3 横、+4 竖、+5 竖、2− 竖、单格 2）上①的 12 条全能手算复核：
  //   先由②④把 (1,1) 的候选挤成只剩 1（见 anchor②），①在第 15 行写下「填 1」；
  //   落子后同行同列的 1 要让路：同列的 (2,1)(3,1) 的 1 早被②划走、(1,3) 的 1 被④划走，
  //   所以值 1 的排除句只有一条——①从不重复划已经不在的候选，这条计数就是它的凭据。
  //   值 3 的三条：(1,3)=3 挤掉同列 (2,3)，(2,2)=3 挤掉同行 (2,1) 与同列 (3,2)。
  //   最后一条是隐形单值：第2行只剩 (2,1) 还放得下 2。
  const s = solve(b3);
  const unit = s.rows.filter((r) => r.rule.key === 'unit');
  eq('anchor①：规则①在 3×3 手工盘上写了几条', unit.length, 12);
  eq('anchor①：显性单值句', (unit.find((r) => r.kind === 'place') || {}).text, '第1行1列 填 1：这一格的候选只剩它一个');
  eq('anchor①：由落子带出的排除句', (unit.find((r) => r.kind === 'elim') || {}).text, '第1行2列 不填 1：第1行1列 已是 1，同在一行/一列');
  eq('anchor①：隐形单值句', (unit.filter((r) => r.kind === 'place').slice(-1)[0] || {}).text, '第2行1列 填 2：第2行 里只有这一格放得下 2');
  eq('anchor①：排除句条数（其余全是落子）', unit.filter((r) => r.kind === 'elim').length, 4);
  eq('anchor①：值 1 的排除句条数', unit.filter((r) => r.kind === 'elim' && r.value === 1).length, 1);
  eq('anchor①：值 3 的排除句条数', unit.filter((r) => r.kind === 'elim' && r.value === 3).length, 3);
  const u1 = unit.find((r) => r.kind === 'elim' && r.value === 1);
  ck('anchor①：这条排除的是同行格而不是同列格', u1 && rowOf(u1.cell, 3) === 0 && colOf(u1.cell, 3) === 1);
  ck('anchor①：换了笼形照样由规则①收尾', sc2.ok === true && sc2.rows.some((r) => r.rule.key === 'unit' && r.cell === 2));
  const sols2 = bruteAllSolutions(3, cross.text);
  eq('anchor①：交叉盘只有一个解', sols2.length, 1);
  eq('anchor①：交叉盘的每一条结论都在所有解里成立', violations(sc2.rows, sols2).length, 0);
  eq('anchor①：交叉盘上规则①写了几条', sc2.rows.filter((r) => r.rule.key === 'unit').length, 12);
  // 金标准盘：行列排除不可替代（拿掉就推不完）。
  const gold = boardFromText(7, GOLD7);
  eq('anchor①：金标准盘上规则①的首句（填）', (sg.rows.filter((r) => r.rule.key === 'unit').find((r) => r.kind === 'place') || {}).text, '第4行1列 填 3：这一格的候选只剩它一个');
  eq('anchor①：金标准盘上规则①的首句（消）', (sg.rows.filter((r) => r.rule.key === 'unit').find((r) => r.kind === 'elim') || {}).text, '第4行2列 不填 3：第4行1列 已是 3，同在一行/一列');
  ck('anchor①：拿掉规则①金标准盘推不完', solve(gold, { rules: RULE_LIST.filter((r) => r.key !== 'unit') }).ok === false);
}

head('A 规则可靠 · anchor ② 极值与边界');
{
  // 3×3 手工盘上规则②的 8 条全部能手算复核：
  //   「3+」两格同行：任一格若为 3，另一格只剩 1、2 ⇒ 和 4..5 ⇒ 划掉 3（两格都划）。
  //   「5+」两格同列：任一格若为 1，另一格只剩 1..3 ⇒ 和 2..4，界报 3..4 ⇒ 划掉 1。
  //   「2−」两格同列：任一格若为 2，另一格 1..3 且互异 ⇒ 差只能是 1 ⇒ 划掉 2。
  //   「2」单格笼：填 1 就是 1、填 3 就是 3 ⇒ 两个都划，只剩 2。
  const s = solve(b3);
  const bnd = s.rows.filter((r) => r.rule.key === 'bounds');
  eq('anchor②：规则②在 3×3 手工盘上写了几条', bnd.length, 8);
  eq('anchor②：加法界的句子', bnd[0].text, '第1行1列 不填 3：第1号笼「3+」里这格若是 3，整笼的和只能在 4..5，够不着 3');
  eq('anchor②：减法界的句子', (bnd.find((r) => r.cage === 3) || {}).text, '第2行2列 不填 2：第4号笼「2−」里这格若是 2，整笼的差只能在 1..1，够不着 2');
  eq('anchor②：单格定值笼的句子', (bnd.find((r) => r.cage === 4) || {}).text, '第3行3列 不填 1：第5号笼「2」里这格若是 1，整笼的和只能在 1..1，够不着 2');
  eq('anchor②：「3+」两格都划了 3', bnd.filter((r) => r.cage === 0 && r.value === 3 && r.kind === 'elim').length, 2);
  eq('anchor②：单格笼把 1 和 3 都划掉', bnd.filter((r) => r.cage === 4 && r.kind === 'elim').length, 2);
  ck('anchor②：单独只放规则②也在说同一批话', solve(b3, { rules: [Rules.bounds] }).rows.every((r) => r.rule.key === 'bounds') && solve(b3, { rules: [Rules.bounds] }).rows.length > 0);
  const sols = bruteAllSolutions(3, b3.text);
  eq('anchor②：3×3 手工盘每一条边界结论都在所有解里成立', violations(s.rows.concat(solve(b3, { rules: [Rules.bounds] }).rows), sols).length, 0);
  // 界够不着目标时它说矛盾（不是「无处可填」，也不是「凑不出组合」）。
  const squeeze = new Uint8Array(25);
  squeeze[3] = 1;
  squeeze[4] = 2;
  const tall = createBoard({
    size: 5,
    cages: [
      { op: '+', target: 6, cells: [0, 1, 2] },
      { op: '+', target: 4, cells: [3, 4] },
      { op: '+', target: 7, cells: [5, 6] },
      { op: '+', target: 5, cells: [7, 8] },
      { op: '+', target: 6, cells: [9, 14] },
      { op: '+', target: 9, cells: [10, 11] },
      { op: '+', target: 3, cells: [12, 13] },
      { op: '+', target: 8, cells: [15, 16] },
      { op: '+', target: 7, cells: [17, 18] },
      { op: '+', target: 6, cells: [19, 24] },
      { op: '+', target: 3, cells: [20, 21] },
      { op: '+', target: 9, cells: [22, 23] },
    ],
  });
  eq('anchor②：三个候选被前提挤成 {3,4,5}', valuesOfMask(createTrace(tall, squeeze).mask[0]), [3, 4, 5]);
  eq('anchor②：整笼的和够不着目标 ⇒ 报矛盾', solve(tall, { givens: squeeze, rules: [Rules.bounds] }).conflict, '第1号笼「6+」要凑 6，可它现在怎么填也最少都到 9');
}

head('A 规则可靠 · anchor ③ 笼组合枚举');
{
  const gold = boardFromText(7, GOLD7);
  const s = solve(gold);
  ck('金标准盘能推到底', s.ok === true);
  const c3 = s.rows.filter((r) => r.rule.key === 'combo');
  eq('anchor③：句子（交集里只剩一个值 ⇒ 直接填）', (c3.find((r) => r.kind === 'place') || {}).text, '第4行7列 填 1：第13号笼「4+」的组合里这一格只剩 1');
  eq('anchor③：句子（并集里没有的值 ⇒ 排除）', (c3.find((r) => r.kind === 'elim') || {}).text, '第6行2列 不填 3：第1号笼「6+」只有 {1,5}、{2,4} 这几种组合，里面没有 3');
  eq('anchor③：规则③写了多少条', c3.length, 133);
  ck('anchor③：拿掉规则③金标准盘推不完', solve(gold, { rules: RULE_LIST.filter((r) => r.key !== 'combo') }).ok === false);
  const count = countSolutions(gold, { cap: 2, budget: 2000000 });
  eq('anchor③：独立计数器说唯一', count.status, UNIQUE);
  eq('anchor③：133 条结论在这一盘的唯一解里全成立', violations(s.rows, [Array.from(count.first)]).length, 0);
  // 3×3 手工盘上的组合枚举：笼「4+」两格同行只有 {1,3} 一种组合 ⇒ 两个 2 都被划掉。
  const s3 = solve(b3);
  const c3b = s3.rows.filter((r) => r.rule.key === 'combo');
  eq('anchor③：3×3 手工盘的组合句', (c3b.find((r) => r.kind === 'elim') || {}).text, '第1行3列 不填 2：第2号笼「4+」只有 {1,3} 这几种组合，里面没有 2');
  eq('anchor③：3×3 手工盘的钉格句', (c3b.find((r) => r.kind === 'place') || {}).text, '第3行3列 填 2：第5号笼「2」的每一种组合里，这一格都是 2');
  eq('anchor③：3×3 手工盘每一条组合结论都在所有解里成立', violations(c3b, bruteAllSolutions(3, b3.text)).length, 0);
  // 枚举封顶时规则③一个字都不写（它不拿「没数完」当结论）。
  eq('anchor③：预算压到 1 时规则③零条结论', solve(b3, { rules: [Rules.combo], budget: 1 }).rows.length, 0);
  ck('anchor③：预算压到 1 时金标准盘也没被规则③推完', solve(gold, { rules: [Rules.combo], budget: 1 }).rows.length === 0);
}

head('A 规则可靠 · anchor ④ 笼与行列装箱');
{
  const gold = boardFromText(7, GOLD7);
  const s = solve(gold);
  const p4 = s.rows.filter((r) => r.rule.key === 'pack');
  ck('anchor④：装箱确实出场了', p4.length > 0);
  eq('anchor④：句子', p4[0].text, '第4行3列 不填 2：第4行 的和必须是 28，第7号笼「28+」在这一行里只能贡献 11/12/13');
  eq('anchor④：规则④写了多少条', p4.length, 37);
  ck('anchor④：拿掉规则④金标准盘推不完', solve(gold, { rules: RULE_LIST.filter((r) => r.key !== 'pack') }).ok === false);
  const count = countSolutions(gold, { cap: 2, budget: 2000000 });
  eq('anchor④：37 条装箱结论在唯一解里全成立', violations(p4, [Array.from(count.first)]).length, 0);
  // 3×3 手工盘：第2行的和必须是 6。
  const s3 = solve(b3);
  const p3 = s3.rows.filter((r) => r.rule.key === 'pack');
  eq('anchor④：3×3 手工盘的装箱句（行）', p3[0].text, '第1行3列 不填 1：第1行 的和必须是 6，第2号笼「4+」在这一行里只能贡献 3');
  eq('anchor④：3×3 手工盘的装箱句（列）', (p3.find((r) => r.text.includes('第1列')) || {}).text, '第1行1列 不填 2：第1列 的和必须是 6，第1号笼「3+」在这一列里只能贡献 1');
  eq('anchor④：3×3 手工盘每一条装箱结论都在所有解里成立', violations(p3, bruteAllSolutions(3, b3.text)).length, 0);
  // 只有规则④看得见的病：每只笼都凑得出来、每格都有候选，但第2行的和配不出 6。
  const packed = createBoard({
    size: 3,
    cages: [
      { op: '+', target: 5, cells: [3, 4] },
      { op: '+', target: 5, cells: [5, 8] },
      { op: '+', target: 6, cells: [0, 1, 2] },
      { op: '+', target: 3, cells: [6, 7] },
    ],
  });
  eq('anchor④：跨笼的矛盾只有装箱报得出', solve(packed, { rules: [Rules.pack] }).conflict, '第2行 的和必须是 6，可它现在这些笼只配得出 7..8');
  eq('anchor④：同一只盘全规则跑，报的还是装箱那条', solve(packed).conflict, '第2行 的和必须是 6，可它现在这些笼只配得出 7..8');
  // 前三条规则各自跑：都能写几句（②③各 6 条），但谁也没看见这只盘的死因——
  // 它们只会卡在「推不完」，报不出那句跨笼矛盾。conflict 为 null 只表示推到底，
  // 卡住时引擎给的是那句占位话，所以这里钉的是整句原文。
  eq('anchor④：规则①单独跑既写不出话也看不见病', solve(packed, { rules: [Rules.unit] }).conflict, '四条铅笔规则推不完这一盘');
  eq('anchor④：规则②单独跑写了 6 条仍看不见病', solve(packed, { rules: [Rules.bounds] }).rows.length, 6);
  eq('anchor④：规则②单独跑的结论里没有一个笼级矛盾', solve(packed, { rules: [Rules.bounds] }).ok, false);
  eq('anchor④：规则③单独跑也写了 6 条仍看不见病', solve(packed, { rules: [Rules.combo] }).rows.length, 6);
  ck('anchor④：前三条都不报那句跨笼矛盾', [Rules.unit, Rules.bounds, Rules.combo].every((rule) => !solve(packed, { rules: [rule] }).conflict.includes('只配得出')));
  eq('anchor④：独立计数器也说这盘无解', countSolutions(packed, { cap: 2, budget: 200000 }).status, NONE);
  eq('anchor④：独立穷举的解数', bruteAllSolutions(3, packed.text).length, 0);
}

head('A 规则可靠 · 四条规则的分工（谁也不是挂饰）');
{
  // 口径全部实测得来，钉在断言里当合同：
  //   金标准盘：①③④ 拿掉任一条就推不完，②可以被别条代劳（实测 ok=true）。
  //   出货 20 关：①②③ 每关都开口，④只在 16 关开口（四个初学关一次不说）；
  //     拿掉某一条就推不完的关数：①1、②0、③1、④2。
  //   ②不是「③的简化版」而是「③封顶时的兜底」：20 关一个笼都没触顶（capped 全 0），
  //     可一旦把枚举预算压到 1（等于让③闭嘴），20/20 关都变成「留着②才推得完」。
  const gold = boardFromText(7, GOLD7);
  const sg2 = solve(gold);
  for (const rule of RULE_LIST) {
    ck(`分工：${rule.name} 在金标准盘上开口说过话`, sg2.rows.some((r) => r.rule.key === rule.key));
    const minus = solve(gold, { rules: RULE_LIST.filter((r) => r.key !== rule.key) });
    if (rule.key === 'bounds') ck(`分工：${rule.name} 在金标准盘上可以被别的规则代劳（实测 ok=true）`, minus.ok === true);
    else ck(`分工：拿掉${rule.name}金标准盘就推不完`, minus.ok === false);
  }
  const spoken = {};
  const essential = {};
  const quiet = [];
  for (const rule of RULE_LIST) {
    spoken[rule.key] = 0;
    essential[rule.key] = 0;
  }
  let cappedLevels = 0;
  let boundsCarries = 0;
  let seamNeeded = 0;
  for (const lv of CAMPAIGN.levels) {
    const b = boardFromText(lv.size, lv.text);
    const s = solve(b);
    if (s.capped > 0) cappedLevels++;
    const silent = [];
    for (const rule of RULE_LIST) {
      if (s.rows.some((r) => r.rule.key === rule.key)) spoken[rule.key]++;
      else silent.push(rule.key);
      if (!solve(b, { rules: RULE_LIST.filter((r) => r.key !== rule.key) }).ok) essential[rule.key]++;
    }
    if (silent.length) quiet.push(`${lv.tier}#${lv.id} 缺 ${silent.join(',')}`);
    const silenced = solve(b, { rules: [Rules.unit, Rules.bounds, Rules.pack], budget: 1 });
    const alsoNoBounds = solve(b, { rules: [Rules.unit, Rules.pack], budget: 1 });
    if (silenced.ok) boundsCarries++;
    if (!alsoNoBounds.ok) seamNeeded++;
  }
  eq('分工：每条规则开口过的关数（④只在 16 关说过话）', spoken, { unit: 20, bounds: 20, combo: 20, pack: 16 });
  eq('分工：一次也没说过话的关，缺谁列出来', quiet, ['newcomer#1 缺 pack', 'newcomer#6 缺 pack', 'newcomer#11 缺 pack', 'newcomer#16 缺 pack']);
  eq('分工：拿掉该条就推不完的关数', essential, { unit: 1, bounds: 0, combo: 1, pack: 2 });
  eq('分工：20 关里触顶的盘数（实测全 0，所以②在货上不是完成所必需）', cappedLevels, 0);
  eq('分工：③封顶后仍靠②推到底的关数', boundsCarries, 13);
  eq('分工：③封顶且拿走②就推不完的关数（20/20）', seamNeeded, 20);
  ck('分工：②在 20 关上都开口过（不是挂饰），只是没到非它不可', spoken.bounds === CAMPAIGN.levels.length && essential.bounds === 0);
  ck('分工：3×3 手工盘四条规则都开口（小盘上彼此可代劳是常态）', RULE_LIST.every((r) => sg2.rows.length > 0 && solve(b3).rows.some((x) => x.rule.key === r.key)));
  ck('分工：3×3 手工盘拿掉任一条仍能推完', RULE_LIST.every((r) => solve(b3, { rules: RULE_LIST.filter((x) => x.key !== r.key) }).ok === true));
  ck('分工：一条规则都不给就推不完（前提自己长不出解）', solve(b3, { rules: [] }).ok === false);
}

head('A 规则可靠 · 矛盾分门别类（一种病一句话）');
{
  // 五种运行时矛盾各由哪条规则说出口，彼此不能混。逐个钉死文案，再断言它们互不认领。
  const bnd = createBoard({
    size: 5,
    cages: [
      { op: '+', target: 6, cells: [0, 1, 2] },
      { op: '+', target: 4, cells: [3, 4] },
      { op: '+', target: 7, cells: [5, 6] },
      { op: '+', target: 5, cells: [7, 8] },
      { op: '+', target: 6, cells: [9, 14] },
      { op: '+', target: 9, cells: [10, 11] },
      { op: '+', target: 3, cells: [12, 13] },
      { op: '+', target: 8, cells: [15, 16] },
      { op: '+', target: 7, cells: [17, 18] },
      { op: '+', target: 6, cells: [19, 24] },
      { op: '+', target: 3, cells: [20, 21] },
      { op: '+', target: 9, cells: [22, 23] },
    ],
  });
  const overTight = new Uint8Array(25);
  overTight[3] = 1;
  overTight[4] = 2;
  eq('矛盾①界够不着：报「要凑 6…最少都到 9」', solve(bnd, { givens: overTight, rules: [Rules.bounds] }).conflict, '第1号笼「6+」要凑 6，可它现在怎么填也最少都到 9');

  const relaxTight = new Uint8Array(25);
  relaxTight[3] = 1;
  relaxTight[4] = 3;
  // 界（放宽）说 6 还够得着，精确枚举说一种组合都没有：这是②看不见的病。
  // 注意 conflict 为 null 只表示「推到底」；②单独跑是在半路卡住，卡住时引擎给的是那句
  // 占位话。所以这里钉整句原文，而不是钉 null。
  eq('矛盾②界骗人：规则②看不见死因（只会卡住）', solve(bnd, { givens: relaxTight, rules: [Rules.bounds] }).conflict, '四条铅笔规则推不完这一盘');
  eq('矛盾②界骗人：规则③报「一种组合都凑不出来」', solve(bnd, { givens: relaxTight, rules: [Rules.combo] }).conflict, '第1号笼「6+」在现在的候选下一种组合都凑不出来');
  eq('矛盾②界骗人：全规则跑下来也是③那句话', solve(bnd, { givens: relaxTight }).conflict, '第1号笼「6+」在现在的候选下一种组合都凑不出来');
  // ④也看见了这只盘的死，但它站在行列装箱的角度上说另一句话：不合并、不认领彼此的文案。
  eq('矛盾②界骗人：装箱从装箱的角度另说一句', solve(bnd, { givens: relaxTight, rules: [Rules.pack] }).conflict, '第1行 里的 第1号笼「6+」一个组合都放不进来');
  {
    const byCombo = solve(bnd, { givens: relaxTight, rules: [Rules.combo] }).conflict;
    const byPack = solve(bnd, { givens: relaxTight, rules: [Rules.pack] }).conflict;
    ck('矛盾②：③与④各说各话，谁也没套用谁的句式', byCombo !== byPack && !byCombo.includes('放不进来') && !byPack.includes('凑不出来'), `${byCombo} / ${byPack}`);
  }

  const packed = createBoard({
    size: 3,
    cages: [
      { op: '+', target: 5, cells: [3, 4] },
      { op: '+', target: 5, cells: [5, 8] },
      { op: '+', target: 6, cells: [0, 1, 2] },
      { op: '+', target: 3, cells: [6, 7] },
    ],
  });
  eq('矛盾③跨笼配不出：装箱的文案', solve(packed).conflict, '第2行 的和必须是 6，可它现在这些笼只配得出 7..8');
  ck('矛盾③跨笼配不出：不是笼级文案', !solve(packed).conflict.includes('凑不出来'));

  const dup = createBoard({
    size: 5,
    cages: [
      { op: '-', target: 4, cells: [0, 1] },
      ...Array.from({ length: 23 }, (_, i) => {
        const t = i + 2;
        return { op: '=', target: ((Math.floor(t / 5) + (t % 5)) % 5) + 1, cells: [t] };
      }),
    ],
  });
  eq('矛盾④候选被挤空：说得出是哪个笼哪一格', (solve(dup).conflict || '').startsWith('第1行2列 已经没有任何候选：第1号笼「4−」'), true);
  eq('矛盾④候选被挤空：独立计数器也说无解', countSolutions(dup, { cap: 2, budget: 400000 }).status, NONE);
  ck('矛盾④候选被挤空：不是「凑不出来」那条', !solve(dup).conflict.includes('凑不出来'));

  const givens = new Uint8Array(9);
  givens[0] = 1;
  givens[1] = 1;
  eq('矛盾⑤墨水自相矛盾：点名两格', solve(b3, { givens }).conflict, '第1行1列 和 第1行2列 同在一行/一列，却都填了 1');
  const colDup = new Uint8Array(9);
  colDup[0] = 1;
  colDup[3] = 1;
  eq('矛盾⑤同列重了一个数：同样点得出是哪两格', solve(b3, { givens: colDup }).conflict, '第1行1列 和 第2行1列 同在一行/一列，却都填了 1');
  // 满盘 ≠ 推对：这一份墨水把九格填得满满当当、行列也全是排列，可第3、第4号笼的算术不对。
  // 引擎绝不因为「每格都有数字」就报 ok，也绝不交出 solution—— reachable() 指的就是这一点。
  const wrong = Uint8Array.from([2, 1, 3, 3, 2, 1, 1, 3, 2]);
  const sw = solve(b3, { givens: wrong });
  eq('矛盾⑤满盘算错：不报 ok', sw.ok, false);
  eq('矛盾⑤满盘算错：交不出 solution', sw.solution, null);
  eq('矛盾⑤满盘算错：说得出是哪一行哪个笼', sw.conflict, '第2行 里的 第3号笼「5+」一个组合都放不进来');
  eq('矛盾⑤满盘算错：独立验收也数出两只笼不对', verify(b3, wrong).filter((x) => x.why === '笼不对').length, 2);
  ck('矛盾⑤满盘算错：reachable 也说这是死局', reachable(b3, wrong) === false);

  // 模糊盘：解不止一个时，引擎绝不假装钉死了谁。
  const loose = boardFromText(4, '+3:0001;+7:0203;+3:0405;+7:0607;+7:0809;+3:0a0b;+7:0c0d;+3:0e0f');
  const sl = solve(loose);
  eq('模糊盘：独立穷举给出 16 个解', bruteAllSolutions(4, loose.text).length, 16);
  eq('模糊盘：计数器说 MANY', countSolutions(loose, { cap: 2, budget: 400000 }).status, MANY);
  eq('模糊盘：计数器数出的解与穷举的第一个同解', Array.from(countSolutions(loose, { cap: 2, budget: 400000 }).first).join(','), bruteAllSolutions(4, loose.text)[0].join(','));
  ck('模糊盘：引擎推不完但不谎报唯一', sl.ok === false && sl.rows.length > 0);
  ck('模糊盘：引擎没有钉死任何一格', sl.rows.every((r) => r.kind !== 'place'));
  eq('模糊盘：它写下的每一条排除在 16 个解里都成立', violations(sl.rows, bruteAllSolutions(4, loose.text)).length, 0);
  const stillLooser = boardFromText(4, '+5:0001;+5:0203;+5:0405;+5:0607;+5:0809;+5:0a0b;+5:0c0d;+5:0e0f');
  eq('线索太弱时引擎一个字都不写（不硬编结论）', solve(stillLooser).rows.length, 0);
  eq('同一只盘独立穷举给 96 个解', bruteAllSolutions(4, stillLooser.text).length, 96);
}

head('A 规则可靠 · 结论与解数互查（三份代码同答案）');
{
  // 小盘摊开全部解，大盘交给 count.js：两套答案必须逐格相同。
  const boards = [['3×3 手工盘', b3], ['3×3 交叉盘（手工盘转 90°）', cross]];
  for (const [label, b] of boards) {
    const sols = bruteAllSolutions(b.size, b.text);
    const cnt = countSolutions(b, { cap: 2, budget: 400000 });
    eq(`${label}：穷举解数与计数器状态一致`, sols.length === 1 ? cnt.status : sols.length ? MANY : NONE, cnt.status);
    eq(`${label}：计数器给的首解与穷举首解逐格相同`, Array.from(cnt.first).join(','), sols.map((s) => s.join(',')).sort()[0]);
    const s = solve(b);
    eq(`${label}：铅笔路径与穷举逐格相同`, Array.from(s.solution).join(','), sols[0].join(','));
    eq(`${label}：铅笔写下的每条结论都在所有解里成立`, violations(s.rows, sols).length, 0);
  }
  const gold = boardFromText(7, GOLD7);
  const cnt = countSolutions(gold, { cap: 2, budget: 2000000 });
  const s = solve(gold);
  eq('金标准盘：计数器状态', cnt.status, UNIQUE);
  eq('金标准盘：计数器节点数可查', cnt.nodes > 0 && Number.isInteger(cnt.nodes), true);
  eq('金标准盘：两套实现的解逐格相同', Array.from(cnt.first).join(','), Array.from(s.solution).join(','));
  eq('金标准盘：322 条结论全部在唯一解里成立', violations(s.rows, [Array.from(cnt.first)]).length, 0);
  eq('金标准盘：结论条数', s.rows.length, 322);
  // 总条数与四条规则各自的条数必须对得上：谁多写一条、谁被记错名字，这里就散架。
  eq('金标准盘：四条规则的条数之和 == 总条数', RULE_LIST.map((r) => s.rows.filter((x) => x.rule.key === r.key).length).reduce((a, b) => a + b, 0), s.rows.length);
  eq('金标准盘：四条规则各写了几条', RULE_LIST.map((r) => `${r.key}:${s.rows.filter((x) => x.rule.key === r.key).length}`).join(' '), 'unit:77 bounds:75 combo:133 pack:37');
  for (const lv of CAMPAIGN.levels.slice(0, 6)) {
    const b = boardFromText(lv.size, lv.text);
    const c = countSolutions(b, { cap: 2, budget: 1000000 });
    const t = solve(b);
    eq(`出货第 ${lv.id} 关：计数器说唯一`, c.status, UNIQUE);
    eq(`出货第 ${lv.id} 关：铅笔与计数器同解`, Array.from(c.first).join(','), Array.from(t.solution).join(','));
    eq(`出货第 ${lv.id} 关：铅笔的每条结论都在解里成立`, violations(t.rows, [Array.from(c.first)]).length, 0);
  }
}

head('A 规则可靠 · 验收与诊断（与推导分开写的那一份）');
const sol3 = [1, 2, 3, 2, 3, 1, 3, 1, 2];
eq('满盘正确：verify 不报问题', verify(b3, Uint8Array.from(sol3)).length, 0);
eq('满盘正确：complete', complete(b3, Uint8Array.from(sol3)), true);
{
  // 每一类 why 各给一只数得过来的盘。行里重与列里重是两条不同的检查，谁也别顶谁。
  const rowDup = Uint8Array.from([1, 1, 2, 2, 3, 3, 3, 2, 1]); // 只有第1、2行重了
  const v1 = verify(b3, rowDup);
  eq('行里重了一个数：第一句', v1[0].why, '重了');
  eq('行里重了一个数：点名第1行', v1[0].name, '第1行');
  eq('行里重了一个数：值与个数都报出来', `${v1[0].value}×${v1[0].count}`, '1×2');
  eq('行里重了 ⇒ 和也配不成排列（两类各报两条）', `${v1.filter((x) => x.why === '重了').length}+${v1.filter((x) => x.why === '不是排列').length}`, '2+2');
  const colDup = Uint8Array.from([1, 2, 3, 1, 3, 2, 3, 1, 2]); // 行全是排列，第1、3列重了
  eq('列里重了一个数：点名第1列', verify(b3, colDup)[0].name, '第1列');
  eq('列里重了一个数：也是两条重 + 两条不是排列', verify(b3, colDup).filter((x) => x.why === '重了').length, 2);
  const sumOnly = Uint8Array.from([1, 1, 1, 2, 2, 2, 3, 3, 3]); // 每行三个同值：和 3/6/9
  const v3 = verify(b3, sumOnly);
  eq('不是排列：整行三个 1 的和报出来', v3.find((x) => x.why === '不是排列').sum, 3);
  // 诚实记一笔：verify 的「不是排列」只看和，[2,2,2] 的和恰好是 6，它放过去了；
  // 这一行是靠「重了」那条拦下来的。两条检查合起来才密，所以两条的条数都要钉住。
  eq('不是排列：三条同值行里只有两条和被配坏（第2行和恰好是 6）', v3.filter((x) => x.why === '不是排列').length, 2);
  eq('不是排列的漏网之鱼由「重了」补上（三行全数到）', v3.filter((x) => x.why === '重了').length, 3);
  const latinBadCages = Uint8Array.from([2, 1, 3, 3, 2, 1, 1, 3, 2]); // 行列全是排列
  const v4 = verify(b3, latinBadCages);
  eq('算错笼：只报笼不对，不扯行列', [...new Set(v4.map((x) => x.why))].join(','), '笼不对');
  eq('算错笼：点名第3号笼并给出实际算出的值', `${v4[0].name}=${v4[0].got.join('+')}`, '第3号笼「5+」=3+1');
}
const partial = Uint8Array.of(1, 2, 3, 2, 3, 0, 0, 0, 0);
eq('没填满时 verify 先说空格', verify(b3, partial)[0].why, '空格');
{
  // 第1行两个 1：一行重了 + 第1号笼「3+」算成 1+1=2。另外三只还空着的笼必须说「来得及」——
  // 「2−」空着时 1 与 3 配得出来，单格「2」空着时填 2 就行，谁也不许被冤枉成死笼。
  const diag = diagnose(b3, Uint8Array.of(1, 1, 0, 0, 0, 0, 0, 0, 0));
  eq('diagnose：同一行两个 1 标两格', [...diag.dup], [0, 1]);
  eq('diagnose：坏单位只有第1行', [...diag.badUnits], ['r0']);
  eq('diagnose：算错的笼只有第1号', [...diag.badCages], [0]);
  eq('diagnose：注脚一条也不多余', diag.notes, ['第1行 里有 2 个 1', '第1号笼「3+」现在算出 1+1=2，对不上 3']);
  eq('diagnose：冲突格数就是 dup 的大小', diag.conflicts, 2);
  ck('canStillHold：全空的「2−」还来得及（1 与 3 配得出来）', canStillHold(b3, b3.cages[3], [0, 0]) === true);
  ck('canStillHold：全空的单格「2」还来得及', canStillHold(b3, b3.cages[4], [0]) === true);
  ck('canStillHold：「2−」填了 2 就真来不及（三阶里差 2 得有 4）', canStillHold(b3, b3.cages[3], [2, 0]) === false);
  ck('canStillHold：「3+」填了 1 来得及', canStillHold(b3, b3.cages[0], [1, 0]) === true);
  ck('canStillHold：「3+」填了 3 就来不及（另一格得是 0）', canStillHold(b3, b3.cages[0], [3, 0]) === false);
}
{
  // 满盘且行列全是排列：五只笼里 3 只对 2 只错，逐只都数得过来。
  const diag2 = diagnose(b3, Uint8Array.of(1, 2, 3, 3, 1, 2, 2, 3, 1));
  eq('diagnose：全填满时算得对的笼', [...diag2.goodCages], [0, 2, 3]);
  eq('diagnose：全填满时算错的笼', [...diag2.badCages], [1, 4]);
  eq('diagnose：算错的笼把自家格子标进 dup', [...diag2.dup], [2, 5, 8]);
  eq('diagnose：注脚一只笼一句', diag2.notes, ['第2号笼「4+」现在算出 3+2=5，对不上 4', '第5号笼「2」现在算出 1，对不上 2']);
  eq('diagnose：剩余空格数', diagnose(b3, partial).remaining, 4);
  eq('diagnose：已填格数', diagnose(b3, partial).filled, 5);
  eq('diagnose：笼子总数', diagnose(b3, partial).cages, 5);
}
ck('reachable：正确解永远活得下来', reachable(b3, Uint8Array.from(sol3)) === true);
ck('reachable：行里重了就死了', reachable(b3, Uint8Array.of(1, 1, 0, 0, 0, 0, 0, 0, 0)) === false);
ck('reachable：只填对一半也活得下来', reachable(b3, Uint8Array.of(1, 2, 3, 2, 0, 0, 0, 0, 0)) === true);
ck('reachable：算术对但推不通也算死（笼被挤爆）', reachable(b3, Uint8Array.of(1, 2, 0, 0, 0, 0, 0, 0, 3)) === false);


// ================================ B 生成保证 ================================
head('B 生成保证 · 种解与划笼');
const rand = mix('seed-A');
const latin = randomLatin(5, rand);
const rowMask = (r) => { let m = 0; for (let c = 0; c < 5; c++) m |= bit(latin[r * 5 + c]); return m; };
const colMask = (c) => { let m = 0; for (let r = 0; r < 5; r++) m |= bit(latin[r * 5 + c]); return m; };
eq('拉丁方每行都是 1..5 的排列', [0, 1, 2, 3, 4].map(rowMask), Array(5).fill(fullMask(5)));
eq('拉丁方每列都是 1..5 的排列', [0, 1, 2, 3, 4].map(colMask), Array(5).fill(fullMask(5)));
ck('拉丁方取值都在 1..5', arr(latin).every((v) => v >= 1 && v <= 5));
eq('同一个种子重放同一盘', Array.from(randomLatin(6, mix('replay'))), Array.from(randomLatin(6, mix('replay'))));
ck('不同种子给出不同盘', !same(Array.from(randomLatin(6, mix('one'))), Array.from(randomLatin(6, mix('two')))));
const cut = randomCages(5, [2, 4, 3, 1, 0], mix('cages'));
eq('划笼盖满全盘', cut.reduce((a, c) => a + c.length, 0), 25);
eq('划笼互不重叠', new Set(cut.flat()).size, 25);
ck(
  '每个笼自己连成一片（从种子格做洪泛，剩下的格子必须一个不剩）',
  cut.every((cells) => {
    const left = new Set(cells.slice(1));
    const stack = [cells[0]];
    while (stack.length) for (const u of neighbours(stack.pop(), 5)) if (left.delete(u)) stack.push(u);
    return left.size === 0;
  }),
);
// cageDist[k-1] 是「笼占 k 格」的权重：这一行第 5 档是 0 ⇒ 五格笼根本不在抽签范围里。
// 旧断言 `最大尺寸 === 5` 盯住的其实是别的东西（它把「不超过上限」写成了「等于盘边长」）。
ck('划笼：没有一只笼长过 cageDist 的上限 4', cut.every((c) => c.length <= 4), `实际最大 ${Math.max(...cut.map((c) => c.length))}`);
eq(
  '划笼：这个种子切出的尺寸分布（1格6只、2格2只、3格5只）',
  [...cut.map((c) => c.length).reduce((m, k) => (m.set(k, (m.get(k) || 0) + 1), m), new Map())].sort((a, b) => a[0] - b[0]),
  [[1, 6], [2, 2], [3, 5]],
);
const built = buildPuzzle({ size: 5, cageDist: [1, 4, 4, 2, 0], opMix: { '=': 1, '+': 6, '-': 3, '*': 3, '/': 1 }, seed: 'built-1' });
ck('装配出的盘自带合法文本', built.text === built.board.text);
ck('装配盘的解自己算得对', verify(built.board, built.solution).length === 0);
eq('− ÷ 只会出现在两格笼上', built.board.cages.filter((c) => c.op === '-' || c.op === '/').every((c) => c.cells.length === 2), true);

head('B 生成保证 · 出货验收链');
for (let i = 0; i < 12; i++) {
  const tier = TIERS[i % TIERS.length];
  const g = generate({ size: tier.size, cageDist: tier.cageDist, opMix: tier.opMix, band: tier.band, seed: `ship-${i}`, tries: 90 });
  ck(`出货 #${i}（${tier.name}）抽得出盘`, g.ok === true, g.reason);
  if (!g.ok) continue;
  const board = boardFromText(g.size, g.text);
  const p = solve(board);
  ck(`出货 #${i}：铅笔从空盘推到底（零猜测）`, p.ok === true, p.conflict);
  ck(`出货 #${i}：推出来的答案过独立验收`, verify(board, p.solution).length === 0 && complete(board, p.solution));
  ck(`出货 #${i}：与种下的解逐格相同`, same(arr(p.solution), arr(g.solution)));
  const c = countSolutions(board, { cap: 2, budget: 600000 });
  eq(`出货 #${i}：独立计数器说 UNIQUE`, c.status, UNIQUE);
  eq(`出货 #${i}：计数器只数出一个解`, c.solutions, 1);
  ck(`出货 #${i}：两套实现逐格同解`, same(arr(c.first), arr(p.solution)));
  ck(`出货 #${i}：难度分落在自己的带里`, g.score >= tier.band[0] && g.score <= tier.band[1], `${g.score} vs ${tier.band}`);
  ck(`出货 #${i}：计数器没有超预算`, c.status !== OVERBUDGET);
  eq(`出货 #${i}：反解出来的答案再验一遍`, verify(board, Uint8Array.from(c.first)).length, 0);
}

head('B 生成保证 · 计数器与规则互相独立');
eq('计数器只吃文本，不给 board 对象', (() => { try { parsePuzzle(5, { size: 5 }); return 'no-throw'; } catch (e) { return /题面文本/.test(e.message) ? 'ok' : e.message; } })(), 'ok');
const manyText = '+3:0001;+7:0203;+3:0405;+7:0607;+7:0809;+3:0a0b;+7:0c0d;+3:0e0f';
const manyBoard = boardFromText(4, manyText);
const many = countSolutions(manyBoard, { cap: 4, budget: 200000 });
// A 段的独立穷举把这只盘的所有解摊开过（16 个），这里要计数器给出的答案与它首解同答案。
eq('线索宽松的盘：计数器说 MANY', many.status, MANY);
ck('多个解时它至少给出前两个', many.solutions >= 2);
eq('多个解时它按 cap 收手（不越诺数完）', many.solutions, 4);
eq('计数器的首解就是独立穷举的第一解', Array.from(many.first).join(','), bruteAllSolutions(4, manyText)[0].join(','));
eq('纯文本 + opts.size 的入口走同一条路', countSolutions(manyText, { size: 4, cap: 2, budget: 200000 }).status, MANY);
const none = countSolutions({ size: 3, text: '=1:00;=1:01;+3:0205;+3:0306;+4:0407;=2:08' }, { cap: 2, budget: 200000 });
eq('一行里钉了两个 1 ⇒ 无解', none.status, NONE);
eq('无解时它不交出解', none.first, null);
// 九阶大盘：文本在这里手工拼（第三种写法，不复用 kenken.js 的 formatCages），
// 每行四只横二格笼 + 一格定值笼，81 格盖满。预算只给 12 个节点，它必须老实说超了。
const nineText = (() => {
  const at = (t) => t.toString(36).padStart(2, '0');
  const chunks = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 8; c += 2) chunks.push(`+4:${at(r * 9 + c)}${at(r * 9 + c + 1)}`);
    chunks.push(`=4:${at(r * 9 + 8)}`);
  }
  return chunks.join(';');
})();
const ob = countSolutions({ size: 9, text: nineText }, { cap: 2, budget: 12 });
eq('九阶题面盖满 81 格（36 只二格笼 + 9 只单格笼）', nineText.split(';').length, 45);
eq('预算不够时它老实说 OVERBUDGET，不当成通过', ob.status, OVERBUDGET);
eq('OVERBUDGET 时它不假装数完了', ob.nodes <= 12, true);
eq('OVERBUDGET 时它不交出解', ob.first, null);
const goldCount = countSolutions({ size: 7, text: GOLD7 }, { cap: 2, budget: 1200000 });
eq('金标准盘：计数器说唯一', goldCount.status, UNIQUE);
ck('金标准盘：计数器与铅笔同解', same(arr(goldCount.first), arr(sg.solution)));
eq('三阶盘计数器：唯一解', countSolutions({ size: 3, text: b3.text }, { cap: 2, budget: 200000 }).status, UNIQUE);
ck('计数器的节点数是可查的整数', Number.isInteger(goldCount.nodes) && goldCount.nodes > 0);

head('B 生成保证 · 档位阶梯');
eq('五档', TIERS.length, 5);
eq('档名依次是', TIERS.map((t) => t.name), ['初学', '上手', '熟练', '高阶', '大师']);
eq('盘边长依次是', TIERS.map((t) => t.size), [4, 5, 5, 6, 7]);
ck('每档都有非空带', TIERS.every((t) => t.band[0] < t.band[1]));
ck('带随档位单调上移（起点）', TIERS.every((t, i) => i === 0 || t.band[0] > TIERS[i - 1].band[0]));
ck('带随档位单调上移（终点）', TIERS.every((t, i) => i === 0 || t.band[1] > TIERS[i - 1].band[1]));
eq('笼大小分布的长度 = 边长', TIERS.every((t) => t.cageDist.length === t.size), true);
eq('难度分的四项权重之和 = 100', Object.values(DIFFICULTY_WEIGHTS).reduce((a, b) => a + b, 0), 100);
const ladder = TIERS.map((t) => {
  const scores = [];
  for (let k = 0; k < 8; k++) {
    const r = probe(`ladder-${t.key}-${k}`, t.key);
    if (r.ok) scores.push(r.score);
  }
  scores.sort((a, b) => a - b);
  return scores[Math.floor(scores.length / 2)];
});
ck('八张一批的中位数仍然严格递增', ladder.every((v, i) => i === 0 || v > ladder[i - 1]), ladder.join(' < '));
ck('每一档的中位数都在自己的带里', TIERS.every((t, i) => ladder[i] >= t.band[0] && ladder[i] <= t.band[1]), ladder.join(' / '));

// ================================ C 状态机 ================================
head('C 状态机 · 一局的生命周期');
const g = new Game();
g.setPuzzle({ size: 7, text: GOLD7, tier: 'master', ref: 'test-gold' });
eq('开局的墨水是全空', g.filledCount(), 0);
eq('开局没有冲突', g.report().conflicts, 0);
eq('开局选中第一格', g.sel, 0);
eq('格子总数', g.cells, 49);
eq('边长', g.size, 7);
g.select(0);
const first = sg.rows.find((r) => r.kind === 'place');
eq('按错数字被拒绝（引擎说不行就不行）', (() => { const wrong = [1, 2, 3, 4, 5, 6, 7].find((v) => v !== first.value); return g.inkValue(first.cell, wrong).ok; })(), false);
ck('拒绝时没有写入墨水', g.ink[first.cell] === 0);
eq('拒绝时不计步', g.moves, 0);
const okInk = g.inkValue(first.cell, first.value);
eq('按对数字：写入成功', okInk.ok, true);
eq('按对数字：计一步', g.moves, 1);
eq('按对数字：格子里有值了', g.ink[first.cell], first.value);
// 这里**不再**手动 pushHistory：inkValue 落子那一刻自己就把「改之前」的那一格记进栈了
// （js/ui/game.js 的 pushHistory 在写值之前调用）。补一次记的就是「改之后」的样子，
// 撤销会退回到同一个值——撤销栈是实现的内部记账，调用方（界面的撤销按钮也一样）都不许自己 push。
const beforeUndo = Array.from(g.ink).join(',');
g.undo();
eq('撤销把墨水退回去了', Array.from(g.ink).join(',') !== beforeUndo || g.ink[first.cell] === 0, true);
eq('没东西可撤时它说清楚', g.undo().why, '没有可撤销的动作了');
g.select(3);
eq('方向键往右走一格（选中第 4 格）', (g.move('right'), g.sel), 4);
eq('方向键往左回到第 3 格', (g.move('left'), g.sel), 3);
g.move('up');
eq('顶行往上不越界', g.sel, 3);
// 顶行往上被挡住之后，往下必须照样走一格（7 阶：3 + 7 = 10）——
// 界面把 ArrowDown 无条件接给 move('down')，「刚被挡过一次就不许往下」会把整个盘面锁死。
g.move('down');
eq('往上被挡住之后往下照样走一格', g.sel, 10);
g.move('up');
eq('再上来回到原格', g.sel, 3);

head('C 状态机 · 提示不是答案');
g.setPuzzle({ size: 7, text: GOLD7, tier: 'master', ref: 'test-gold' });
const h1 = g.hint();
ck('提示给出了话', !!h1.text && h1.text.length > 8);
ck('提示点名了规则', !!h1.rule);
ck('提示点名了笼', !!h1.cage);
eq('提示是「不填」这类结论时不替玩家落子', h1.kind === 'elim' ? g.ink[h1.cell] === 0 : true, true);
eq('提示计一次数', g.hints, 1);
ck('提示句以格子开头', /^[第\d]/.test(h1.text));
const h2 = g.hint();
ck('连着要提示不会重复同一条', h2.text !== h1.text);
eq('第二次也记了数', g.hints, 2);
// 只躲"上一条"的话，第三次会绕回第一条——同一句话隔一轮又念一遍，玩家看到的是提示坏了。
const hNext = g.hint();
ck('第三次也不许回头念前两条里的任何一条', hNext.text !== h1.text && hNext.text !== h2.text, `第一条「${h1.text}」第三条「${hNext.text}」`);
eq('第三次也记了数', g.hints, 3);
const dirty = new Game();
dirty.setPuzzle({ size: 3, text: b3.text, tier: 'newcomer', ref: 'test-3' });
dirty.ink[0] = 1;
dirty.ink[1] = 1; // 同一行两个 1：明摆着的矛盾
const h3 = dirty.hint();
ck('墨水自相矛盾时提示不收费', h3.free === true);
eq('收费次数没涨', dirty.hints, 0);
ck('它把矛盾说出口了', /第1行|重/.test(h3.why), h3.why);

head('C 状态机 · 铅笔候选');
const gp = new Game();
gp.setPuzzle({ size: 3, text: b3.text, tier: 'newcomer', ref: 'test-notes' });
gp.select(8);
gp.toggleNoteMode(true);
eq('铅笔模式下数字键不写墨水', (gp.pressDigit(2), gp.ink[8]), 0);
eq('铅笔模式下记上了候选', popcount(gp.notes[8] & bit(2)), 1);
eq('再按一次是划掉', (gp.pressDigit(2), gp.notes[8] & bit(2)), 0);
gp.pressDigit(1);
gp.pressDigit(3);
eq('两个候选都记上了', valuesOfMask(gp.notes[8]), [1, 3]);
gp.toggleNoteMode(false);
eq('落子把那格的铅笔清掉', (gp.inkValue(8, 2), gp.notes[8]), 0);
eq('擦掉既擦墨水也擦铅笔', (gp.select(8), gp.erase(), gp.ink[8] | gp.notes[8]), 0);
const gq = new Game();
gq.setPuzzle({ size: 3, text: b3.text, tier: 'newcomer', ref: 'test-prune' });
gq.select(0);
gq.notes[0] = fullMask(3);
eq('清理铅笔：把引擎证明不可能的候选拿掉', (gq.pruneNotes(0), valuesOfMask(gq.notes[0])), [1]);

head('C 状态机 · 胜利判定与战役');
const gw = new Game();
gw.setPuzzle({ size: 3, text: b3.text, tier: 'newcomer', ref: 'test-win' });
ck('没填满不算赢', gw.checkWin() === false);
for (let t = 0; t < 9; t++) gw.ink[t] = sol3[t];
ck('填满且全对才算赢', gw.checkWin() === true);
eq('胜利快照里 won 为真', gw.snapshot().won, true);
const gl = new Game();
gl.loadLevel(1);
eq('战役第 1 关的题面与目录一致', gl.board.text, CAMPAIGN.levels[0].text);
eq('战役第 1 关的边长', gl.size, CAMPAIGN.levels[0].size);
gl.loadLevel(99);
eq('不存在的关卡号不改变局面', gl.board.text, CAMPAIGN.levels[0].text);
const gd = new Game();
gd.loadDaily('2026-09-27');
ck('日课排得出盘', !!gd.board);
eq('同一天的日课是同一张盘', gd.board.text, (() => { const x = new Game(); x.loadDaily('2026-09-27'); return x.board.text; })());
ck('不同日子是不同档或不同盘', (() => { const a = new Game(); a.loadDaily('2026-09-27'); const b = new Game(); b.loadDaily('2026-10-01'); return a.board.text !== b.board.text || a.tier !== b.tier; })());
ck('星期决定日课档位', ['2026-09-28', '2026-09-29', '2026-09-30'].every((d) => typeof tierForDay(d) === 'string'));
const gr = new Game();
gr.setPuzzle({ size: 3, text: b3.text, tier: 'newcomer', ref: 'test-restart' });
gr.ink[0] = 1;
gr.restart();
eq('重开把墨水清干净', gr.filledCount(), 0);
eq('重开不换题', gr.board.text, b3.text);
eq('重开也不动种下的题面', gr.ref, 'test-restart');

// ================================ D 存档形状 ================================
head('D 存档形状');
const mod = await import(`../js/store.js?tag=${Date.now()}`);
const { Store, sanitize, encodeRuns, decodeRuns } = mod;
// 游程的**个数**跟值用同一个基数（36）：49 个 0 是 `0x1d`（1×36+13），不是 `0x31`——
// 后者是 49 的十六进制写法，而 decodeRuns 拿 parseInt(…, 36) 去读它会读出 109 格。
// encodeRuns 里 `n < 1296` 那个上限就是 36²：个数必须装得下两个 36 进制位。
eq('编码：全 0 的 49 格压成一段（个数按 36 进制：49 = 1d）', encodeRuns(new Uint8Array(49)), '0x1d');
eq('解码回来还是 49 个 0', Array.from(decodeRuns('0x1d', 49)).length, 49);
ck('解码：值全为 0', Array.from(decodeRuns('0x1d', 49)).every((v) => v === 0));
const longRun = Uint16Array.from([0, ...Array(40).fill(7), 9]); // 42 格：中段一长串 7
eq('编码：中段 40 个 7 写成 7x14（40 的 36 进制是 14，十六进制才是 28）', encodeRuns(longRun), '0.7x14.9');
eq('往返：长游程之后不许把后面的段挪位', Array.from(decodeRuns(encodeRuns(longRun), longRun.length)), Array.from(longRun));
eq('编码：混排', encodeRuns(Uint8Array.of(1, 1, 1, 0, 2, 2)), '1x3.0.2x2');
eq('往返：混排', Array.from(decodeRuns(encodeRuns(Uint8Array.of(1, 1, 1, 0, 2, 2)), 6)), [1, 1, 1, 0, 2, 2]);
const masks = Uint16Array.from([0, 2, 6, 1022, 0, 0]);
eq('往返：候选掩码', Array.from(decodeRuns(encodeRuns(masks), masks.length)), Array.from(masks));
eq('解码：脏段跳过而不是整串作废', Array.from(decodeRuns('1x3.zzz.2', 5)), [1, 1, 1, 0, 2]);
eq('解码：空文本给全 0', Array.from(decodeRuns('', 4)), [0, 0, 0, 0]);
eq('默认档位是 regular', sanitize(null).resume, null);
eq('默认解锁第一关', sanitize(undefined).chapters.unlocked, 1);
eq('垃圾输入退回默认值', sanitize('nonsense').settings.sound, true);
eq('数组输入也退回默认值', sanitize([1, 2, 3]).totals.solved, 0);
eq('脏 settings 被逐个字段纠正', sanitize({ settings: { sound: 'nope', notes: undefined, reduceMotion: 1 } }).settings, { sound: true, notes: true, reduceMotion: true });
eq('越界的 size 丢掉整份 resume', sanitize({ resume: { size: 99, ink: '0x61', ref: 'x' } }).resume, null);
eq('墨水里有非法数字时丢掉 resume', sanitize({ resume: { size: 4, ink: '5', ref: 'x' } }).resume, null);
const goodResume = sanitize({ resume: { size: 4, ink: '1.0x15', notes: '0x16', ref: 'campaign-3', tier: 'learner', moves: 3, hints: 1, elapsedMs: 4200, at: 1 } });
eq('合法 resume 活下来：ref', goodResume.resume.ref, 'campaign-3');
eq('合法 resume 活下来：墨水解出 16 格', Store.resume === undefined ? true : decodeRuns(goodResume.resume.ink, 16)[0], 1);
eq('越界的候选位被抹掉', decodeRuns(sanitize({ resume: { size: 2, ink: '0x4', notes: '1x4', ref: 'x' } }).resume.notes, 4)[0], 1);
eq('负数与 NaN 变 0', sanitize({ totals: { solved: -3, hints: NaN, ms: '12' } }).totals, { solved: 0, hints: 0, ms: 12, cells: 0 });
eq('巨大的时间被钳住', sanitize({ totals: { ms: 1e30 } }).totals.ms, 1e12);
eq('best 里的非对象记录被丢', sanitize({ best: { learner: 'x' } }).best, {});
eq('daily 的日期键必须合法', Object.keys(sanitize({ daily: { 'not-a-day': { ms: 1 }, '2026-09-27': { ms: 1 } } }).daily), ['2026-09-27']);
ck('未知键不会漏进存档', !('evil' in sanitize({ evil: 1 })));
Store.reset();
eq('重置后是干净状态', Store.data.totals.solved, 0);
Store.recordSolve({ ms: 5000, hints: 2, cells: 25 });
eq('累计解局数', Store.data.totals.solved, 1);
Store.recordBest('learner', { ms: 5000, hints: 2, moves: 20, size: 5 });
eq('同档先比提示次数', Store.recordBest('learner', { ms: 9000, hints: 1, moves: 40, size: 5 }), true);
eq('提示次数相同比步数', Store.recordBest('learner', { ms: 100, hints: 1, moves: 30, size: 5 }), true);
eq('提示次数相同比时间', Store.recordBest('learner', { ms: 50, hints: 1, moves: 30, size: 5 }), true);
eq('更差的成绩不覆盖纪录', Store.recordBest('learner', { ms: 1, hints: 9, moves: 1, size: 5 }), false);
eq('纪录里留的是最好的那次', Store.best('learner').hints, 1);
Store.recordDaily('2026-09-27', { ms: 1000, hints: 0, tier: 'learner' });
eq('日课记上了', Store.dailyDone('2026-09-27').hints, 0);
Store.unlockThrough(3);
eq('解锁只前进', (Store.unlockThrough(1), Store.unlocked()), 3);
Store.markSolved(7);
eq('打过第 7 关', [...Store.solvedIds()], [7]);
Store.markSolved(7);
eq('重复记同一关不产生第二条', [...Store.solvedIds()], [7]);
// 4 格墨水配的是 2×2 的盘：size 是这张盘的骨架，一盘墨水**总是** size*size 格
// （main.js 交给 Game 的就是 game.ink 整串，界面那边只接受长度恰好等于格子数的 keep.ink）。
// 原来这份夹具写的是 size:4 配 4 格墨水——那是 16 个格里只捞回 4 格的断档，
// 它要的「墨水回来了」正好是被 sanitize 该丢掉的那一种形状，见下面那条断言。
Store.saveResume({ ref: 'campaign-3', originSeed: 'abc', tier: 'learner', size: 2 }, Uint8Array.of(1, 2, 0, 0), Uint16Array.of(0, 0, 2, 0), { moves: 2, hints: 0, elapsedMs: 10 });
const r = Store.resume();
eq('续局存的是原始种子', r.seed, 'abc');
eq('续局的墨水回来了', Array.from(r.inkCells), [1, 2, 0, 0]);
eq('续局的铅笔回来了', Array.from(r.noteCells), [0, 0, 2, 0]);
eq('续局的边长', r.size, 2);
eq('续局的墨水长度就是这盘的格子数（界面才肯整串收下）', r.inkCells.length, r.size * r.size);
eq('墨水盖不满这盘＝断档：丢掉整份 resume，不补 0 变出一张新盘', sanitize({ resume: { size: 4, ink: '1.2.0x2', notes: '0x4', ref: 'x' } }).resume, null);
Store.clearResume();
eq('清掉续局', Store.resume(), null);
const blob = Store.save() === false ? '' : (() => { Store.setSetting('sound', false); return JSON.stringify(Store.data); })();
ck('存档是一个能塞进一个键的字符串', typeof blob === 'string' && blob.length < 2000);
eq('体积：一张 49 格满盘的墨水编码不超过 200 字节', encodeRuns(Uint8Array.from(Array.from({ length: 49 }, (_, i) => (i % 7) + 1))).length < 200, true);

// 抛异常的存储：模块必须还能站起来
globalThis.localStorage = {
  getItem() {
    throw new Error('Safari 无痕');
  },
  setItem() {
    throw new Error('Safari 无痕');
  },
};
const mod2 = await import(`../js/store.js?boom=${Date.now()}`);
ck('存储抛异常时模块照样能用', mod2.Store.data.settings.sound === true);
eq('存储抛异常时 save 不炸', mod2.Store.setSetting('sound', false), undefined);
// 原来这条写的是 `ck('脏 JSON 也能活', sanitize(...).resume, null)`：`ck` 判的是 `!!cond`，
// 而 cond 就是那个该为 null 的 resume——null 永远假，这条从写下的那天起就不可能绿。
// 第三个参数在 ck 那里是「附加说明」，作者想要的显然是 eq(…, null)：resume 丢掉、其余照旧。
const dirtyJson = sanitize(JSON.parse('{"resume":{"size":4,"ink":42},"totals":{"solved":3}}'));
eq('脏 JSON 也能活：ink 不是字符串就丢掉那份 resume', dirtyJson.resume, null);
ck('脏 JSON 也能活：其余字段照旧，模块没炸', dirtyJson.totals.solved === 3 && dirtyJson.settings.sound === true);
delete globalThis.localStorage;

// ================================ 汇总 ================================
const total = Object.values(classes).reduce((a, c) => a + c.n, 0);
note('\n' + '═'.repeat(64));
for (const [k, v] of Object.entries(classes)) note(`${v.bad ? '✗' : '✓'} ${k}：${v.n - v.bad}/${v.n}`);
note('═'.repeat(64));
if (failures.length) {
  note(`\n失败 ${failures.length} 条：`);
  for (const f of failures) note('  · ' + f);
}
note(`\n${total - failures.length}/${total} 条断言通过。`);
if (total < 300) {
  note(`断言总数 ${total} < 300：这一轮改坏了什么，测试看不见。`);
  process.exit(1);
}
process.exit(failures.length ? 1 : 0);
