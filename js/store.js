// 存档。所有东西挂在**一个键**下，所以「清空进度」是一行，脏数据也只可能脏在一处。
//
// 存的是什么：一盘没下完的局存 (题面出处, 已落的墨水, 铅笔候选, 这一局花了多少)，
// **不存题面文本、不存答案**——题面由 ref（战役/日课的编号，或练习的原始种子 + 档位）
// 决定，而生成器对同一个种子是确定的。一张 7 阶满盘也只有一两百字节。
//
// 三件事必须在模块内成立，因为界面只在启动时读一次：
//   1. 任何字段坏了就丢那一个字段，其余照旧（不许整档作废，玩家会以为进度丢了）；
//   2. 读存储本身可能抛（Safari 无痕、Electron 磁盘异常）——抛了就当没有存档；
//   3. 数值一律钳制：存档里的 size 越界、墨水里有 0..N 之外的数字、数组长度对不上，
//      都直接丢掉那份 resume，不能让界面去猜。

const KEY = 'kenken.save.v1';

const defaults = () => ({
  v: 1,
  settings: { sound: true, notes: true, reduceMotion: false },
  best: {}, // 档位 → { ms, hints, moves, size, at }
  daily: {}, // 'YYYY-MM-DD' → { ms, hints, tier, at }
  chapters: { unlocked: 1 }, // 已解锁到第几章（1 起）
  progress: { solved: [] }, // 打过的关卡号：解锁判定与战役打勾都读它
  totals: { solved: 0, hints: 0, ms: 0, cells: 0 },
  resume: null,
});

// ---- 紧凑编码 -------------------------------------------------------------------
// 状态是一串小整数（墨水 0..9，候选掩码 0..1023）。开局时它们几乎全是 0，
// 「值 + 连续个数」的游程编码就是 49 格存档不至于变成 1KB JSON 数组的原因。
// 段之间用 `.`，段内 `值x个数`，个数为 1 时省略。纯字符串，JSON 里躺着也安心。

export function encodeRuns(list) {
  const out = [];
  let run = list[0] ?? 0;
  let n = 1;
  const push = (v, c) => out.push(c > 1 ? `${v.toString(36)}x${c.toString(36)}` : v.toString(36));
  for (let i = 1; i < list.length; i++) {
    if (list[i] === run && n < 1296) n++;
    else {
      push(run, n);
      run = list[i];
      n = 1;
    }
  }
  if (list.length) push(run, n);
  return out.join('.');
}

export function decodeRuns(text, len) {
  const out = new Uint16Array(len);
  if (typeof text !== 'string' || !text) return out;
  let i = 0;
  for (const seg of text.split('.')) {
    if (i >= len) break;
    const x = seg.indexOf('x');
    const v = parseInt(x < 0 ? seg : seg.slice(0, x), 36);
    const c = x < 0 ? 1 : parseInt(seg.slice(x + 1), 36);
    if (!Number.isFinite(v) || !Number.isFinite(c) || c < 1) continue; // 脏段：跳过，不整串作废
    for (let k = 0; k < c && i < len; k++) out[i++] = v;
  }
  return out;
}

// ---- 存储访问：拿不到就当没有 -------------------------------------------------------

function backend() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    return null; // Safari 无痕模式下连属性访问都会抛
  }
  return null;
}

function readRaw() {
  const ls = backend();
  if (!ls) return null;
  try {
    return ls.getItem(KEY);
  } catch {
    return null;
  }
}

function writeRaw(text) {
  const ls = backend();
  if (!ls) return false;
  try {
    ls.setItem(KEY, text);
    return true;
  } catch {
    return false; // 配额 / 无痕：游戏照玩，只是不记事
  }
}

// ---- 消毒：把任何形状的对象压回合法形状 ----------------------------------------------
// 单列出来是给 tools/engine-test.mjs 直接喂垃圾用的，不经过 localStorage。

const num = (v, lo, hi, fallback = 0) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
const flag = (v, dflt) => (v === undefined ? dflt : !!v);

export function sanitize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const s = raw.settings || {};
  const out = {
    v: 1,
    settings: {
      sound: flag(s.sound, true),
      notes: flag(s.notes, true),
      reduceMotion: flag(s.reduceMotion, false),
    },
    best: {},
    daily: {},
    chapters: { unlocked: num(raw.chapters && raw.chapters.unlocked, 1, 999, 1) },
    progress: { solved: [] },
    totals: {
      solved: num(raw.totals && raw.totals.solved, 0, 1e7),
      hints: num(raw.totals && raw.totals.hints, 0, 1e7),
      ms: num(raw.totals && raw.totals.ms, 0, 1e12),
      cells: num(raw.totals && raw.totals.cells, 0, 1e9),
    },
    resume: null,
  };
  for (const [tier, rec] of Object.entries(raw.best || {})) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof tier !== 'string' || !tier || tier.length > 24) continue;
    out.best[tier] = {
      ms: num(rec.ms, 0, 1e10),
      hints: num(rec.hints, 0, 1e6),
      moves: num(rec.moves, 0, 1e6),
      size: num(rec.size, 2, 9, 4),
      at: num(rec.at, 0, 1e14),
    };
  }
  for (const [day, rec] of Object.entries(raw.daily || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !rec || typeof rec !== 'object') continue;
    out.daily[day] = {
      ms: num(rec.ms, 0, 1e10),
      hints: num(rec.hints, 0, 1e6),
      tier: typeof rec.tier === 'string' && rec.tier.length <= 24 ? rec.tier : '',
      at: num(rec.at, 0, 1e14),
    };
  }
  // 关卡号：只收 1..999 的整数、去重、排序，最多 200 个——存档被人手改成
  // 「1..1e9」也不能让战役页列出十万行。
  const solved = Array.isArray(raw.progress && raw.progress.solved) ? raw.progress.solved : [];
  out.progress.solved = [...new Set(solved.map((v) => num(v, 1, 999, 0)).filter((v) => v >= 1))].slice(0, 200).sort((a, b) => a - b);

  const r = raw.resume;
  if (r && typeof r === 'object') {
    const size = num(r.size, 2, 9, 0);
    const len = size * size;
    // 长度对不上就是题面和墨水不是同一张盘——丢掉，别去猜哪一边错。
    if (size >= 2 && len <= 81 && typeof r.ink === 'string' && r.ink.length <= 600) {
      const ink = decodeRuns(r.ink, len);
      const notes = decodeRuns(typeof r.notes === 'string' ? r.notes : '', len);
      let bad = false;
      for (let t = 0; t < len; t++) {
        if (ink[t] > size) bad = true;
        if (notes[t] & ~((1 << (size + 1)) - 2)) notes[t] = 0; // 越界候选位：这格的铅笔作废
      }
      if (!bad) {
        out.resume = {
          ref: typeof r.ref === 'string' && r.ref.length <= 48 ? r.ref : '',
          seed: typeof r.seed === 'string' && r.seed.length <= 48 ? r.seed : '',
          tier: typeof r.tier === 'string' && r.tier.length <= 24 ? r.tier : '',
          size,
          ink: r.ink,
          notes: typeof r.notes === 'string' && r.notes.length <= 900 ? r.notes : '',
          moves: num(r.moves, 0, 1e6),
          hints: num(r.hints, 0, 1e6),
          elapsedMs: num(r.elapsedMs, 0, 1e11),
          at: num(r.at, 0, 1e14),
        };
      }
    }
  }
  return out;
}

function load() {
  const raw = readRaw();
  if (!raw) return defaults();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

export const Store = {
  data: load(),

  save() {
    return writeRaw(JSON.stringify(this.data));
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    if (!(name in this.data.settings)) return;
    this.data.settings[name] = !!value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // 纪录先比「欠了多少提示」再比步数、最后比时间：纪录要说的是「这盘我自己推出来的」，
  // 靠六次提示换来的快成绩不算这件事。
  recordBest(tier, rec) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      rec.hints < cur.hints ||
      (rec.hints === cur.hints && (rec.moves < cur.moves || (rec.moves === cur.moves && rec.ms < cur.ms)));
    if (better) this.data.best[tier] = { ...rec, at: Date.now() };
    this.save();
    return better;
  },

  dailyDone(day) {
    return this.data.daily[day] || null;
  },
  recordDaily(day, rec) {
    const cur = this.data.daily[day];
    const better = !cur || rec.hints < cur.hints || (rec.hints === cur.hints && rec.ms < cur.ms);
    if (better) this.data.daily[day] = { ...rec, at: Date.now() };
    this.save();
    return better;
  },
  dailyStreak(today) {
    // 连续天数从今天（或昨天）往回数。today 是 'YYYY-MM-DD'。
    const parse = (s) => new Date(`${s}T12:00:00Z`).getTime();
    const day = 86400000;
    let cursor = parse(today);
    if (!this.data.daily[today]) cursor -= day; // 今天还没做，从昨天起算
    let n = 0;
    while (this.data.daily[new Date(cursor).toISOString().slice(0, 10)]) {
      n++;
      cursor -= day;
      if (n > 4000) break;
    }
    return n;
  },

  unlocked() {
    return this.data.chapters.unlocked;
  },
  solvedIds() {
    return new Set(this.data.progress.solved);
  },
  markSolved(levelId) {
    const id = num(levelId, 1, 999, 0);
    if (!id) return false;
    const list = new Set(this.data.progress.solved);
    if (list.has(id)) return false;
    list.add(id);
    this.data.progress.solved = [...list].sort((a, b) => a - b);
    this.save();
    return true;
  },
  // 战役进度只前进不后退：过第 k 关才解锁第 k+1 关。
  unlockThrough(index) {
    const next = num(index, 1, 999, 1);
    if (next > this.data.chapters.unlocked) {
      this.data.chapters.unlocked = next;
      this.save();
      return true;
    }
    return false;
  },

  recordSolve({ ms = 0, hints = 0, cells = 0 } = {}) {
    const t = this.data.totals;
    t.solved += 1;
    t.hints += num(hints, 0, 1e6);
    t.ms += num(ms, 0, 1e10);
    t.cells += num(cells, 0, 1e6);
    this.save();
  },

  saveResume(puzzle, ink, notes, run) {
    this.data.resume = {
      // 生成器会把手里的种子再加工一次，所以存**原始种子**，
      // 续局才能重绘出同一块盘——存题面文本是更大的那份，也没必要。
      ref: puzzle.ref || '',
      seed: puzzle.originSeed || puzzle.seed || '',
      tier: puzzle.tier || '',
      size: puzzle.size,
      ink: encodeRuns(ink),
      notes: encodeRuns(notes),
      moves: run.moves,
      hints: run.hints,
      elapsedMs: run.elapsedMs,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    const len = r.size * r.size;
    return { ...r, inkCells: decodeRuns(r.ink, len), noteCells: decodeRuns(r.notes, len) };
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },

  key: KEY,
  defaults,
};
