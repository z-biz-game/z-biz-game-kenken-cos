#!/usr/bin/env node
// 难度是量出来的，不是贴标签贴出来的。
//
//   node tools/balance.mjs                 默认 SAMPLES=24：跑阶梯门禁，落不进就退出码非零
//   SAMPLES=80 node tools/balance.mjs      只看量表，不判定（--report）
//   node tools/balance.mjs --report        同上
//
// 两件事分开做，是因为「测分布」和「判定出货」要的样本量不一样：判定时 24 张够稳
// （每档的接受率都在 19% 以上，24 张里中位数的位置不会跳），看分布时想要长尾。
//
// 门禁三条，一条都不许放宽：
//   1. 每一档的中位数落在自己的 band 里；
//   2. 中位数按档位顺序严格递增（阶梯不塌）；
//   3. 每档至少一半样本真的落进 band（带不是摆设）。

import { TIERS, generate, probe, difficultyParts } from '../js/engine/generate.js';

const SAMPLES = Number(process.env.SAMPLES || 24);
const REPORT = process.argv.includes('--report');
const SEED_PREFIX = process.env.SEED_PREFIX || 'balance';

const quantiles = (list) => {
  const a = list.slice().sort((x, y) => x - y);
  if (!a.length) return { min: NaN, p05: NaN, p25: NaN, p50: NaN, p75: NaN, p95: NaN, max: NaN, mean: NaN };
  const at = (p) => {
    const i = Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))));
    return a[i];
  };
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  return {
    min: a[0],
    p05: at(0.05),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    max: a[a.length - 1],
    mean: Math.round(mean * 10) / 10,
  };
};

const pad = (s, n) => String(s).padStart(n);
const row = (cells) => `| ${cells.join(' | ')} |`;
const sep = (cells) => `|---${cells.map(() => ':---').join('|')}---|`;

const results = [];
console.log(`\n聪明格 · 难度量表  SAMPLES=${SAMPLES}${REPORT ? '  (--report：只测不判)' : '  (门禁)'}`);
console.log(`每档抽 ${SAMPLES} 次裸生成（tries=1、不设 band），只统计**能出货**的盘。\n`);

for (const tier of TIERS) {
  const scores = [];
  const parts = [];
  const rejected = new Map();
  let ms = 0;
  for (let k = 0; k < SAMPLES; k++) {
    const t0 = Date.now();
    const r = probe(`${SEED_PREFIX}-${tier.key}-${k}`, tier.key);
    ms += Date.now() - t0;
    if (!r.ok) {
      const key = (r.reason || '未知').slice(0, 24);
      rejected.set(key, (rejected.get(key) || 0) + 1);
      continue;
    }
    scores.push(r.score);
    parts.push(difficultyParts(r, tier.size));
  }
  const q = quantiles(scores);
  const inBand = scores.filter((s) => s >= tier.band[0] && s <= tier.band[1]).length;
  const avg = (sel) => {
    if (!parts.length) return NaN;
    return Math.round((parts.reduce((a, p) => a + sel(p), 0) / parts.length) * 100) / 100;
  };
  results.push({ tier, q, n: scores.length, inBand, ms, avg, rejected });
}

const head = ['档', '阶', '出货', '带', 'p05', 'p25', '中位', 'p75', 'p95', '带内', '规则级', '重规则占比', '轮数', '规模项', 'ms/张'];
console.log(row(head));
console.log(
  sep(head.map(() => ' '))
);
for (const r of results) {
  const { tier, q, n, inBand, ms, avg } = r;
  console.log(
    row([
      tier.name,
      `${tier.size}²`,
      `${n}/${SAMPLES}`,
      `${tier.band[0]}..${tier.band[1]}`,
      pad(q.p05.toFixed(1), 5),
      pad(q.p25.toFixed(1), 5),
      pad(q.p50.toFixed(1), 5),
      pad(q.p75.toFixed(1), 5),
      pad(q.p95.toFixed(1), 5),
      n ? `${Math.round((inBand / n) * 100)}%` : '-',
      avg((p) => p.load).toFixed(2),
      avg((p) => p.heavy).toFixed(2),
      avg((p) => p.depth).toFixed(2),
      avg((p) => p.span).toFixed(2),
      (ms / SAMPLES).toFixed(1),
    ])
  );
}

console.log('\n难度分 = 40×规则等级负担 + 25×重规则占比 + 15×依赖链深度 + 20×盘规模（各量已归一到 0..1，见 js/engine/generate.js）');
console.log('「重规则占比」= 需要规则③（笼组合枚举）或规则④（笼与行列装箱）的结论占比，这两条是零猜测承诺里最贵的两条。');

const fails = [];
if (!REPORT) {
  for (const { tier, q, n, inBand } of results) {
    if (n === 0) fails.push(`${tier.name}：一张都没出货，档位无法测量`);
    else if (q.p50 < tier.band[0] || q.p50 > tier.band[1]) {
      fails.push(`${tier.name}：中位数 ${q.p50} 不在带 ${tier.band.join('..')} 里`);
    }
    if (n >= 4 && inBand / n < 0.5) fails.push(`${tier.name}：只有 ${inBand}/${n} 落进带内，带形同虚设`);
  }
  for (let i = 1; i < results.length; i++) {
    const a = results[i - 1];
    const b = results[i];
    if (!Number.isFinite(a.q.p50) || !Number.isFinite(b.q.p50)) continue;
    if (b.q.p50 <= a.q.p50) fails.push(`阶梯塌了：${b.tier.name} 中位 ${b.q.p50} 没有高于 ${a.tier.name} 的 ${a.q.p50}`);
  }
  // 出货通道单独验一次：带真的被 makePuzzle 用上时，每张出货盘都该在带内。
  for (const tier of TIERS) {
    const t0 = Date.now();
    const r = generate({
      size: tier.size,
      cageDist: tier.cageDist,
      opMix: tier.opMix,
      band: tier.band,
      tries: 120,
      seed: `shipcheck-${tier.key}`,
    });
    const ms = Date.now() - t0;
    if (!r.ok) fails.push(`${tier.name}：出货通道抽不出盘（${r.reason}）`);
    else if (r.score < tier.band[0] || r.score > tier.band[1]) {
      fails.push(`${tier.name}：出货通道给出 ${r.score}，在带外（抽了 ${r.gen} 次）`);
    } else {
      console.log(`出货校验 ${tier.name}：${r.score} 在带内，抽 ${r.gen} 次 / 弃 ${r.rejected} 张 / ${ms}ms，计数器节点 ${r.countNodes}`);
    }
  }
}

if (fails.length) {
  console.error('\n难度阶梯不合格：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(REPORT ? '\n(--report 模式：只出表，不做判定)' : `\n阶梯合格：五档中位数 ${results.map((r) => r.q.p50).join(' < ')}，每档都在自己的带里。`);
