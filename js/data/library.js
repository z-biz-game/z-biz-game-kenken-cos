// 战役与日课的**选题路线**。题面本身不在这里生成，也不在这里手写——它们是
// `npm run bake` 烤进 js/data/campaign.js 的（那份文件签进 git，`--check` 会重烤一遍
// 比字节）。这个模块只做一件事：给定关卡号或日期，说「用哪一局」。
//
// 为什么战役要烤而不能在运行时生成：
//   * 启动不能有可感知的等待——最难那档抽一张要试上百次生成；
//   * 玩家之间、同一个人反复打开，看到的必须是同一张盘；
//   * 出货前那张盘已经被 balance 量过、被计数器验过，运行时不再抽卡就没有
//     「这次抽出来的比烤的时候难」这种事。

import { CAMPAIGN } from './campaign.js';
import { TIERS } from '../engine/generate.js';

export const LIB = CAMPAIGN;
export const LEVELS = CAMPAIGN.levels;

export const CHAPTER_SIZE = CAMPAIGN.perChapter;
export const CHAPTER_COUNT = Math.ceil(LEVELS.length / CHAPTER_SIZE);

export const tierList = TIERS.map((t) => ({ key: t.key, name: t.name, size: t.size, note: t.note }));
export const tierByKey = (key) => TIERS.find((t) => t.key === key) || TIERS[0];

/** 第 n 关（1 起）。越界返回 null，让调用方去说「战役打完了」。 */
export function levelAt(n) {
  return LEVELS[n - 1] || null;
}

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

export function chapterOf(n) {
  return Math.floor((n - 1) / CHAPTER_SIZE) + 1;
}

export function levelsOfChapter(ch) {
  const from = (ch - 1) * CHAPTER_SIZE + 1;
  return LEVELS.slice(from - 1, from - 1 + CHAPTER_SIZE);
}

export function chapterTitle(ch) {
  return CAMPAIGN.chapters[ch - 1] || `第 ${ch} 章`;
}

// 「一章里五档各一局」：烤的时候就是按这个顺序排的，所以第 k 章的第 j 关落在
// 第 (j % 档位数) 档。章与章之间靠**种子**变盘，不靠改档位——档位一动，
// balance 量出来的阶梯就跟 README 里的表不是一回事了。
export function isChapterDone(ch, solvedIds) {
  const list = levelsOfChapter(ch);
  return list.length > 0 && list.every((l) => solvedIds.has(l.id));
}

// ---- 日课 -------------------------------------------------------------------------
// 日期 → 一个稳定的档位轮换。周一到周日各自偏一档，让「今天的日课」有性格，
// 又不至于哪天抽到一张 7 阶大笼把人堵死一整天。

const DAILY_ROTATION = ['newcomer', 'learner', 'regular', 'expert', 'learner', 'regular', 'master'];

export function isValidDay(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

export function tierForDay(dayKey) {
  const d = new Date(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'regular';
  return DAILY_ROTATION[d.getUTCDay()];
}

/** 今天这一局：日课的题面同样从烤好的目录里取，只是取哪一张由日期决定。 */
export function dailyLevel(dayKey) {
  if (!isValidDay(dayKey)) return null;
  const tier = tierForDay(dayKey);
  const pool = LEVELS.filter((l) => l.tier === tier);
  if (!pool.length) return null;
  let h = 2166136261;
  for (let i = 0; i < dayKey.length; i++) {
    h ^= dayKey.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return { ...pool[h % pool.length], mode: 'daily', day: dayKey, tierName: tierByKey(tier).name };
}

/** 自由练习：这一局是运行时抽的（玩家自己挑档），允许，因为它不进战役也不进日课。 */
export function practiceSeed(dayKey, n) {
  return `free-${dayKey}-${n}`;
}

export function isBakedLevel(l) {
  return !!(l && typeof l.id === 'number' && typeof l.text === 'string' && l.text.length > 4);
}
