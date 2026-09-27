// 生成器：**先种解，再划笼**。
//
// 随机拉丁方给出一个必然成立的解（每行每列都是 1..N 的排列），然后把盘划成连通的笼、
// 按解算出每个笼的「目标数 + 运算符」。这样造出来的题**必然有解**，因为解就是我们放的。
// 难度不在「删多少线索」——KenKen 没有可删的线索，删掉一个笼就等于改题——而在三个旋钮上：
//
//   盘多大 × 笼多大 × 运算符配比
//
// 出货验收是两条独立的：铅笔路径必须从空盘推到底（零猜测），穷举计数器必须说 UNIQUE
// 并且给出**逐格相同**的答案（唯一解）。任何一条不成立就重抽。

import {
  Op,
  Rules,
  RULE_LIST,
  createBoard,
  cageAssignments,
  cluesFromSolution,
  legalOps,
  solve,
  verify,
  complete,
  formatCages,
} from './kenken.js';
import { countSolutions, UNIQUE } from './count.js';

// FNV-1a 哈希 + xorshift32：字符串种子进、[0,1) 序列出。同一字符串永远同一盘。
export function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const shuffled = (list, rand) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function pickWeighted(items, weights, rand) {
  let total = 0;
  for (let i = 0; i < items.length; i++) total += weights[i];
  if (total <= 0) return items[0];
  let x = rand() * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** 随机拉丁方：循环方 + 行置换 + 列置换 + 数字置换。每一步都保持「每行每列是排列」。 */
export function randomLatin(size, rand) {
  const perm = (n) => shuffled(Array.from({ length: n }, (_, i) => i), rand);
  const rows = perm(size);
  const cols = perm(size);
  const syms = perm(size);
  const out = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      out[r * size + c] = syms[(rows[r] + cols[c]) % size] + 1;
    }
  }
  return out;
}

/**
 * 把盘划成连通的笼。cageDist[k-1] 是「笼占 k 格」的权重（k = 1..maxCage）。
 * 从随机顺序里挑未分配的格子当种子，用边界集合一路长到目标大小；长不满就短，
 * 剩下的散格自然成为单格笼。划分本身不看解，所以「大笼」与「难算」是两件事。
 */
export function randomCages(size, cageDist, rand) {
  const n = size * size;
  const taken = new Uint8Array(n);
  const cages = [];
  const weights = cageDist.map((w, i) => (i === 0 ? w : w));
  for (const start of shuffled(Array.from({ length: n }, (_, i) => i), rand)) {
    if (taken[start]) continue;
    const want = pickWeighted(weights.map((_, i) => i + 1), weights, rand);
    const member = [start];
    taken[start] = 1;
    let frontier = new Set(neighboursOf(start, size).filter((t) => !taken[t]));
    while (member.length < want && frontier.size) {
      const list = [...frontier];
      const next = list[Math.floor(rand() * list.length)];
      frontier.delete(next);
      taken[next] = 1;
      member.push(next);
      for (const t of neighboursOf(next, size)) if (!taken[t]) frontier.add(t);
      for (const t of member) if (frontier.has(t)) frontier.delete(t);
    }
    cages.push(member.sort((a, b) => a - b));
  }
  return cages;
}

function neighboursOf(t, size) {
  const r = Math.floor(t / size);
  const c = t % size;
  const out = [];
  if (r > 0) out.push(t - size);
  if (r < size - 1) out.push(t + size);
  if (c > 0) out.push(t - 1);
  if (c < size - 1) out.push(t + 1);
  return out;
}

/**
 * 按解给每个笼挑「目标数 + 运算符」。opMix 是权重（`{ '=': 3, '+': 6, '-': 2, '*': 2, '/': 1 }`），
 * 只在该笼写得出的运算符之间分配权重：两格笼才有 − ÷，单格笼只有定值。
 */
export function assignOps(size, solution, cellsList, opMix, rand) {
  const cages = [];
  for (const cells of cellsList) {
    const vals = cells.map((t) => solution[t]);
    const legal = legalOps(size, cells, vals);
    if (!legal.length) return null;
    const weights = legal.map((x) => (opMix && opMix[x.op] != null ? opMix[x.op] : 1));
    const chosen = pickWeighted(legal, weights, rand);
    cages.push({ cells, op: chosen.op, target: chosen.target });
  }
  return cages;
}

/** 一局的完整装配：种解 → 划笼 → 写目标数 → 校验盘面。抛错=这盘不要。 */
export function buildPuzzle({ size = 5, cageDist = null, opMix = null, seed = 'plain' }) {
  const rand = mix(seed);
  const solution = randomLatin(size, rand);
  const cellsList = randomCages(size, cageDist || [1, 4, 3, 1], rand);
  const cages = assignOps(size, solution, cellsList, opMix || { '=': 2, '+': 6, '-': 2, '*': 2, '/': 1 }, rand);
  if (!cages) return null;
  const board = createBoard({ size, cages });
  return { board, solution, text: formatCages(cages) };
}

/**
 * 出货验收：铅笔推得完 + 穷举说唯一 + 两套逐格同解。
 * 任何一条不成立就返回原因，调用方重抽。
 */
export function accept(board, solution, opts = {}) {
  const budget = opts.budget || 300000;
  const p = solve(board);
  if (!p.ok) return { ok: false, reason: p.conflict || '推不完', probe: p };
  if (verify(board, p.solution).length || !complete(board, p.solution)) return { ok: false, reason: '铅笔答案过不了独立验收', probe: p };
  if (solution && Array.from(p.solution).join(',') !== Array.from(solution).join(',')) {
    return { ok: false, reason: '铅笔答案与种下的解不同（题面不止一个解）', probe: p };
  }
  const c = countSolutions(board, { cap: 2, budget });
  if (c.status === 'OVERBUDGET') return { ok: false, reason: '穷举计数器超预算，未验证', probe: p, count: c };
  if (c.status !== UNIQUE) return { ok: false, reason: `穷举计数器数出 ${c.solutions} 个解`, probe: p, count: c };
  if (Array.from(c.first).join(',') !== Array.from(p.solution).join(',')) {
    return { ok: false, reason: '两套实现给出的不是同一个解', probe: p, count: c };
  }
  return { ok: true, probe: p, count: c };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- 难度度量 ------------------------------------------------------------------
//
// 一开始我们直接用「铅笔结论条数 × 规则权重」当难度分，实测把它否了：80 张一批跑下来，
// 这个原始分几乎只跟盘的边长走（4 阶 ~130、5 阶 ~255、6 阶 ~440），同一 4 阶盘里
// 「满是单格笼的送分题」和「全是三格大笼的硬题」分数只差 3 分，反而送分题略高——
// 因为笼子越小、可排除的候选越多，写下的结论条数越多。**拿它当难度就是在量格子数**。
//
// 所以难度分改成三个**跟边长无关**的量加上一个温和的规模项，量纲归到 0..100：
//
//   load   每次推理平均动用几级规则 (Σ 条数×权重 / 总条数)，1..3.5 归一到 0..1
//   heavy  需要规则③④（枚举组合、装箱计数）的结论占比
//   depth  铅笔路径要扫多少轮才收敛（依赖链长度），1..4 轮归一到 0..1
//   span   边长项，(n-4)/3；同样一条推理链，盘大了人的工作记忆确实更吃紧
//
// 四项权重写死在这里并印在 README 里；tools/balance.mjs 负责证明它们**量得出阶梯**。

export const DIFFICULTY_WEIGHTS = { load: 40, heavy: 25, depth: 15, span: 20 };

/** 铅笔结果 → 0..100 的难度分（边长归一，跨档可比）。 */
export function difficulty(p, size) {
  const total = (p.steps || 0) + (p.elims || 0) || 1;
  const weighted = Object.entries(p.breakdown || {}).reduce((a, [name, n]) => {
    const rule = RULE_LIST.find((r) => r.name === name);
    return a + n * (rule ? rule.weight : 1);
  }, 0);
  const load = clamp((weighted / total - 1) / 2.5, 0, 1);
  const heavy = clamp(((p.breakdown?.[Rules.combo.name] || 0) + (p.breakdown?.[Rules.pack.name] || 0)) / total, 0, 1);
  const depth = clamp((p.rounds - 1) / 3, 0, 1);
  const span = clamp((size - 4) / 3, 0, 1);
  const W = DIFFICULTY_WEIGHTS;
  return Math.round((W.load * load + W.heavy * heavy + W.depth * depth + W.span * span) * 10) / 10;
}

/** 难度分的各分量（0..1），balance 要把它们单独印出来，不能只给一个总分。 */
export function difficultyParts(p, size) {
  const total = (p.steps || 0) + (p.elims || 0) || 1;
  const weighted = Object.entries(p.breakdown || {}).reduce((a, [name, n]) => {
    const rule = RULE_LIST.find((r) => r.name === name);
    return a + n * (rule ? rule.weight : 1);
  }, 0);
  return {
    load: Math.round(clamp((weighted / total - 1) / 2.5, 0, 1) * 1000) / 1000,
    heavy: Math.round(clamp(((p.breakdown?.[Rules.combo.name] || 0) + (p.breakdown?.[Rules.pack.name] || 0)) / total, 0, 1) * 1000) / 1000,
    depth: Math.round(clamp((p.rounds - 1) / 3, 0, 1) * 1000) / 1000,
    span: Math.round(clamp((size - 4) / 3, 0, 1) * 1000) / 1000,
    writes: total,
    level: p.level,
    rounds: p.rounds,
    enumCost: p.enumCost,
    rawScore: p.rawScore != null ? p.rawScore : p.score,
  };
}

/**
 * 抽 `tries` 次，取分数最靠近档位区间的那个。
 * 选取键里**不许**掺墙钟时间：存档只存种子，续局要靠同一个种子重绘出同一块盘。
 */
export function generate(opts = {}) {
  const {
    size = 5,
    cageDist = [1, 4, 3, 1],
    opMix = { '=': 2, '+': 6, '-': 2, '*': 2, '/': 1 },
    seed = 'plain',
    band = null,
    tries = 60,
    report = () => {},
    budget = 300000,
  } = opts;
  let best = null;
  let lastReason = '';
  let rejected = 0;
  for (let k = 0; k < tries; k++) {
    const trial = `${seed}#${k}`;
    let built = null;
    try {
      built = buildPuzzle({ size, cageDist, opMix, seed: trial });
    } catch (e) {
      lastReason = e.message;
      rejected++;
      continue;
    }
    if (!built) {
      lastReason = '笼挑不出合法的运算符';
      rejected++;
      continue;
    }
    const a = accept(built.board, built.solution, { budget });
    if (!a.ok) {
      lastReason = a.reason;
      rejected++;
      continue;
    }
    const p = a.probe;
    const d = difficulty(p, size);
    const offBand = band ? Math.abs(d - clamp(d, band[0], band[1])) : 0;
    const cand = {
      board: built.board,
      text: built.text,
      solution: built.solution,
      seed: trial,
      size,
      score: d,
      rawScore: p.score,
      parts: difficultyParts(p, size),
      steps: p.steps,
      elims: p.elims,
      rounds: p.rounds,
      level: p.level,
      enumCost: p.enumCost,
      capped: p.capped,
      breakdown: p.breakdown,
      cages: built.board.cages.length,
      countNodes: a.count.nodes,
      offBand,
      gen: k + 1,
      rejected,
    };
    report({ k, score: d, offBand, reason: lastReason });
    if (!best || cand.offBand < best.offBand) best = cand;
    // 落进档位区间就收手：区间内第一张就是它。再挑「区间里分数最高的」等于把分布往上抬，
    // band 会从「选取目标」变成「自我实现的预言」，阶梯门禁也就量不出真东西了。
    if (band && cand.offBand === 0) break;
  }
  if (!best) return { ok: false, board: null, reason: lastReason || '没找到既唯一又能纯逻辑推到底的盘面', rejected };
  return { ok: true, rejected, ...best };
}

// ---- 五档：盘尺寸 × 笼大小分布 × 运算符配比 ---------------------------------------
//
// cageDist 的下标 k-1 对应「笼占 k 格」的权重；opMix 是运算符权重（只在该笼写得出的
// 运算符之间分）。band 是**选取目标**，不是标签：tools/balance.mjs 会盯着每一档有没有
// 真的落进自己的区间，落不进就退出码非零。
//
// 旋钮与档位带都来自实测（`SAMPLES=80 node tools/balance.mjs --report`）：每一档跑满
// 80 张裸抽取（tries=1、不设 band），看接受率与难度分的 p05/p50/p95，再取带。
// 另有三组旋钮量过没采用，理由写在 DESIGN「被实测否掉的做法」：4 阶收紧（接受率 48%、
// 难度分中位数反而比放松版还低——4 阶盘抬不动量表）、6 阶大笼（中位数更高但接受率 11%）、
// 6 阶全大笼（接受率 1%，铅笔路径根本推不出）。

export const TIERS = [
  {
    key: 'newcomer',
    name: '初学',
    size: 4,
    cageDist: [6, 3, 1, 0],
    opMix: { '=': 6, '+': 4, '-': 0, '*': 0, '/': 0 },
    band: [26, 40],
    note: '四阶盘，笼小、只加法，多半格子靠行列排除就能数出来',
  },
  {
    key: 'learner',
    name: '上手',
    size: 5,
    cageDist: [3, 5, 2, 1, 0],
    opMix: { '=': 3, '+': 7, '-': 2, '*': 1, '/': 0 },
    band: [33, 47],
    note: '五阶盘，笼开始跨行跨列，减法进来，极值规则开始真的被用到',
  },
  {
    key: 'regular',
    name: '熟练',
    size: 5,
    cageDist: [1, 3, 4, 2, 1],
    opMix: { '=': 1, '+': 6, '-': 3, '*': 3, '/': 1 },
    band: [36, 53],
    note: '还是五阶，但笼大得多：要枚举组合，并留意一行的和是定数',
  },
  {
    key: 'expert',
    name: '高阶',
    size: 6,
    cageDist: [2, 4, 3, 2, 0, 0],
    opMix: { '=': 2, '+': 6, '-': 3, '*': 3, '/': 1 },
    band: [40, 60],
    note: '六阶盘，乘除笼逼你去算极值，装箱计数开始真的被用到',
  },
  {
    key: 'master',
    name: '大师',
    size: 7,
    cageDist: [1, 3, 4, 4, 2, 1, 0],
    opMix: { '=': 0.5, '+': 5, '-': 3, '*': 5, '/': 2 },
    band: [55, 75],
    note: '七阶大笼：组合多、排除少，一条铅笔链要顶到四层规则',
  },
];

export function tierFor(key) {
  return TIERS.find((t) => t.key === key) || TIERS[2];
}

/** 档位 + 原始种子 → 一局可出货的题（出货不过验收就返回 null）。 */
export function makePuzzle(seed, tierKey, opts = {}) {
  const tier = tierFor(tierKey);
  const r = generate({
    size: tier.size,
    cageDist: tier.cageDist,
    opMix: tier.opMix,
    band: opts.ignoreBand ? null : tier.band,
    tries: opts.tries || tier.tries || 60,
    seed,
  });
  if (!r.ok) return null;
  return {
    ...r,
    originSeed: seed,
    tier: tier.key,
    tierName: tier.name,
    size: tier.size,
    label: `${tier.name} ${tier.size}×${tier.size}`,
  };
}

/** 只报告，不判定：给 balance 用的裸抽取（tries=1，不设 band）。 */
export function probe(seed, tierKey) {
  const tier = tierFor(tierKey);
  return generate({ size: tier.size, cageDist: tier.cageDist, opMix: tier.opMix, seed, tries: 1 });
}

export { Op, cageAssignments, cluesFromSolution, countSolutions, UNIQUE };
