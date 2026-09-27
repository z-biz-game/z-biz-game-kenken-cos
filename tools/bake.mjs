#!/usr/bin/env node
// 战役目录的烤炉。
//
//     node tools/bake.mjs            # 写 js/data/campaign.js 并打印实测表
//     node tools/bake.mjs --check    # 重烤一遍比字节，什么都不写，漂移就退出码非零
//
// 为什么要有这一步：游戏运行时**不许**抽卡。战役与日课的每一张盘都在这里烤好、
// 签进 git，于是「这一局能不能纯逻辑推到底」是烤的时候证明过的事实，而不是玩家
// 手机上某次随机抽卡的结果。
//
// 烤的过程里每张盘都要过三道：
//   1. 铅笔路径从空盘推到底（零猜测）；
//   2. 独立穷举计数器说 UNIQUE（唯一解），且给出的答案与铅笔答案**逐格相同**；
//   3. 落盘之后再从**文本**把盘读回来重跑一遍 1、2 —— 序列化漏一格都过不了这一关。
// 打印出来的表是本仓的证据：每档抽了多少次、接受率多少、计数器跑了多少毫秒、
// 被拒的原因分布。接受率低就照实印，不为了好看去放宽验收。

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TIERS, generate } from '../js/engine/generate.js';
import { solve, verify, complete, boardFromText } from '../js/engine/kenken.js';
import { countSolutions, UNIQUE } from '../js/engine/count.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'js/data/campaign.js');
const CHECK = process.argv.includes('--check');

const PER_CHAPTER = TIERS.length; // 一章五关，一档一关
const BAKE_SEED = 'kenken-campaign-v1';

const CHAPTER_TITLES = [
  '第一章 · 认笼',
  '第二章 · 借位',
  '第三章 · 堆乘除',
  '第四章 · 大笼',
];
const CHAPTERS = CHAPTER_TITLES.length; // 共 4 章 × 5 档 = 20 关

const median = (list) => {
  const a = list.slice().sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : 0;
};

const pct = (n, d) => `${d ? Math.round((n / d) * 100) : 0}%`;

/** 一道题从文本回来重验一遍：这是「数字必须重新推得出来」的那一条。 */
function reverify(level) {
  const board = boardFromText(level.size, level.text);
  const p = solve(board);
  if (!p.ok) return `铅笔推不完：${p.conflict}`;
  if (verify(board, p.solution).length || !complete(board, p.solution)) return '铅笔答案过不了独立验收';
  if (Array.from(p.solution).join(',') !== level.answer) return '重烤给出的解与烤时不同（生成不确定？）';
  const c = countSolutions(board, { cap: 2, budget: 600000 });
  if (c.status !== UNIQUE) return `计数器说 ${c.status}，不是 UNIQUE`;
  if (Array.from(c.first).join(',') !== Array.from(p.solution).join(',')) return '两套实现不同解';
  return null;
}

function bake() {
  const levels = [];
  const perTier = new Map(TIERS.map((t) => [t.key, { draws: 0, accepted: 0, ms: [], nodes: [], rejects: new Map(), ids: [] }]));
  let id = 0;

  for (let ch = 1; ch <= CHAPTERS; ch++) {
    for (const tier of TIERS) {
      id += 1;
      const seed = `${BAKE_SEED}-c${ch}-${tier.key}`;
      const stat = perTier.get(tier.key);
      const t0 = Date.now();
      const r = generate({
        size: tier.size,
        cageDist: tier.cageDist,
        opMix: tier.opMix,
        band: tier.band,
        tries: 240,
        budget: 600000,
        seed,
      });
      const ms = Date.now() - t0;
      stat.draws += r.gen || 1;
      if (!r.ok) {
        const key = (r.reason || '未知').slice(0, 20);
        stat.rejects.set(key, (stat.rejects.get(key) || 0) + 1);
        throw new Error(`${tier.name} 第 ${ch} 章（种子 ${seed}）烤不出盘：${r.reason}\n` + `已试 ${r.rejected} 次。不放宽验收，改种子或改旋钮。`);
      }
      stat.accepted += 1;
      stat.ms.push(ms);
      stat.nodes.push(r.countNodes);
      stat.ids.push(r.score);
      levels.push({
        id,
        chapter: ch,
        tier: tier.key,
        tierName: tier.name,
        size: r.size,
        seed,
        text: r.text,
        answer: Array.from(r.solution).join(','),
        score: r.score,
        steps: r.steps,
        elims: r.elims,
        rounds: r.rounds,
        ruleLevel: r.level,
        enumCost: r.enumCost,
        cages: r.cages,
        countNodes: r.countNodes,
      });
    }
  }

  // 第二遍：从文本重验。烤炉里再跑一次，比 CI 的 --check 更早发现序列化漏了什么。
  for (const level of levels) {
    const bad = reverify(level);
    if (bad) throw new Error(`第 ${level.id} 关重验失败：${bad}`);
  }

  return { levels, perTier };
}

function renderBody(levels) {
  const rows = levels.map((l) => JSON.stringify(l)).join(',\n    ');
  return `// 战役目录：由 \`node tools/bake.mjs\` 烤出来，**不要手改**。
// 手改会被 \`npm run bake -- --check\` 和 CI 里的同名步骤立刻抓出来。
// 每一关都带着它被烤时的实测数字：分数、推理步数、扫了几轮、计数器跑了多少节点。

export const CAMPAIGN = {
  format: 1,
  perChapter: ${PER_CHAPTER},
  chapters: ${JSON.stringify(CHAPTER_TITLES)},
  levels: [
    ${rows},
  ],
};
`;
}

const { levels, perTier } = bake();
const body = renderBody(levels);

console.log(`\n聪明格 · 战役烤炉   ${levels.length} 关 / ${CHAPTERS} 章${CHECK ? '  (--check：只比字节)' : ''}`);
console.log(`\n| 档 | 关 | 抽卡次数 | 出货 | 计数器节点 中位/最大 | 每张耗时 中位/最大 | 分数中位 | 被拒原因 |`);
console.log(`|---|:--|:--|:--|:--|:--|:--|:--|`);
let red = false;
for (const tier of TIERS) {
  const s = perTier.get(tier.key);
  const ids = levels.filter((l) => l.tier === tier.key).length;
  const rej = [...s.rejects.entries()].map(([k, v]) => `${k} x${v}`).join('、') || '无';
  if (!s.accepted) red = true;
  console.log(
    `| ${tier.name} | ${ids} | ${s.draws} | ${pct(s.accepted, s.draws)} | ${median(s.nodes)} / ${Math.max(0, ...s.nodes)} | ${median(s.ms)}ms / ${Math.max(0, ...s.ms)}ms | ${median(s.ids)} | ${rej} |`
  );
}
const byChapter = new Map();
for (const l of levels) byChapter.set(l.chapter, (byChapter.get(l.chapter) || 0) + 1);
console.log(`\n每关都重新从文本验过一遍：铅笔推到底 + 计数器 UNIQUE + 逐格同解。共 ${levels.length} 关，章节 ${[...byChapter.keys()].length} 章。`);

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error('缺少 js/data/campaign.js：先跑 npm run bake');
    process.exit(1);
  }
  const cur = readFileSync(OUT, 'utf8');
  if (cur !== body) {
    const a = cur.split('\n');
    const b = body.split('\n');
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    console.error(`战役目录与重烤结果不一致（第 ${i + 1} 行起）：\n  现有: ${String(a[i]).slice(0, 120)}\n  重烤: ${String(b[i]).slice(0, 120)}`);
    console.error('要么有人手改了 js/data/campaign.js，要么引擎变了一句话不改目录就出货。跑 npm run bake 再看差异。');
    process.exit(1);
  }
  console.log(`\n--check 通过：${OUT} 与重烤结果逐字节一致。`);
  process.exit(red ? 1 : 0);
}

writeFileSync(OUT, body);
console.log(`\nwrote ${OUT}  (${Buffer.byteLength(body)} bytes)`);
if (red) process.exit(1);
