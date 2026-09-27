// 装配层：把状态机、画布、存档、DOM 接在一起，并给验证 harness 留一个 `window.kenken`。
//
// 这一层刻意**不做判断**：能不能填、下一步推什么、这一局算不算赢，全在 js/ui/game.js 与
// js/engine/ 里。这里只负责「把玩家的手势翻译成状态机的方法，把状态机说的话写进 DOM」。
// 于是浏览器里跑的那份逻辑，和 tools/engine-test.mjs 在 Node 里跑的那份，是同一份。

import { Game, Mode } from './ui/game.js';
import { createRenderer } from './render/board.js';
import { Store } from './store.js';
import { Sound } from './audio/synth.js';
import { applyThemeVars, setReduceMotion, systemPrefersReducedMotion, Motion, Space } from './theme.js';
import { TIERS, makePuzzle } from './engine/generate.js';
import { OpGlyph, RULE_LIST, cageHolds, diagnose, parseCages, boardFromText, solve } from './engine/kenken.js';
import { CAMPAIGN } from './data/campaign.js';
import { CHAPTER_SIZE, chapterTitle, dailyLevel, isChapterDone, levelsOfChapter, tierByKey } from './data/library.js';

applyThemeVars();

const VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);

const el = {
  viewMenu: $('view-menu'),
  viewGame: $('view-game'),
  canvas: $('board'),
  tierList: $('tier-list'),
  chapterList: $('chapter-list'),
  recordList: $('record-list'),
  dailyCard: $('daily-card'),
  resumeCard: $('resume-card'),
  resumeName: $('resume-name'),
  resumeMeta: $('resume-meta'),
  btnResume: $('btn-resume'),
  btnDaily: $('btn-daily'),
  btnSound: $('btn-sound'),
  btnMotion: $('btn-motion'),
  btnHint: $('btn-hint'),
  btnUndo: $('btn-undo'),
  btnRestart: $('btn-restart'),
  btnNew: $('btn-new'),
  btnMenu: $('btn-menu'),
  btnMenu2: $('btn-menu-2'),
  btnAgain: $('btn-again'),
  btnNote: $('btn-note'),
  btnErase: $('btn-erase'),
  btnPrune: $('btn-prune'),
  pad: $('digit-pad'),
  hintCount: $('hint-count'),
  hintRule: $('hint-rule'),
  hintLine: $('hint-line'),
  stateLine: $('state-line'),
  statName: $('stat-name'),
  statTier: $('stat-tier'),
  statTime: $('stat-time'),
  statMoves: $('stat-moves'),
  statHints: $('stat-hints'),
  statFilled: $('stat-filled'),
  statCages: $('stat-cages'),
  statConflicts: $('stat-conflicts'),
  statScore: $('stat-score'),
  winVeil: $('win-veil'),
  winMeta: $('win-meta'),
  winRecord: $('win-record'),
  buildStamp: $('build-stamp'),
};

const game = new Game();
const renderer = createRenderer(el.canvas);

let dirty = true;
let loopHandle = 0;
let lastRejection = null;
let currentTier = 'regular';
let practiceCounter = 1;

// ---- 小工具 ---------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const todayKey = () => new Date().toISOString().slice(0, 10);

function markDirty() {
  dirty = true;
  if (!loopHandle) loopHandle = requestAnimationFrame(tick);
}

function tick(ts) {
  loopHandle = 0;
  const animating = renderer.draw(game, ts);
  dirty = false;
  if (animating) loopHandle = requestAnimationFrame(tick);
}

function say(text, tone = '') {
  el.stateLine.textContent = text || '';
  el.stateLine.className = tone ? `conflict-line ${tone}` : 'conflict-line';
}

// ---- 数字键盘：跟着盘的边长走 --------------------------------------------------------

function buildPad() {
  const size = game.size || 6;
  el.pad.textContent = '';
  for (let v = 1; v <= size; v++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'digit';
    b.dataset.digit = String(v);
    b.textContent = String(v);
    b.setAttribute('aria-label', `在第${Math.floor(game.sel / size) + 1}行${(game.sel % size) + 1}列${game.noteMode ? '记' : '填'} ${v}`);
    el.pad.appendChild(b);
  }
  syncPad();
}

/** 每个数字键上的一点状态：这格还填得上吗？铅笔里已经记了吗？ */
function syncPad() {
  const size = game.size || 6;
  const t = game.sel;
  const masks = game.derive().res.masks;
  for (const b of el.pad.querySelectorAll('button.digit')) {
    const v = Number(b.dataset.digit);
    const off = t >= 0 && masks && !game.ink[t] && !(masks[t] & (1 << v));
    b.classList.toggle('candidate-off', !!off);
    b.setAttribute('aria-pressed', t >= 0 && game.noteMode ? String(!!(game.notes[t] & (1 << v))) : String(game.ink[t] === v));
    b.setAttribute('aria-label', `第${v}${game.noteMode ? '（记铅笔）' : '（落子）'}`);
  }
  void size;
}

// ---- 选档页 -------------------------------------------------------------------------

function buildMenu() {
  el.tierList.textContent = '';
  for (const tier of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = tier.key;
    const left = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = tier.name;
    const note = document.createElement('small');
    note.textContent = tier.note;
    left.append(name, note);
    const badge = document.createElement('span');
    badge.className = 'size';
    badge.textContent = `${tier.size}×${tier.size} · 实测 ${tier.band[0]}–${tier.band[1]}`;
    b.append(left, badge);
    b.addEventListener('click', () => startPractice(tier.key));
    el.tierList.appendChild(b);
  }

  el.chapterList.textContent = '';
  const solved = Store.solvedIds();
  const unlocked = Store.unlocked();
  const chapters = Math.ceil(CAMPAIGN.levels.length / CHAPTER_SIZE);
  for (let ch = 1; ch <= chapters; ch++) {
    const wrap = document.createElement('div');
    wrap.className = 'chapter-group';
    const title = document.createElement('b');
    title.textContent = `${chapterTitle(ch)}${ch > unlocked ? ' · 未解锁' : ''}`;
    wrap.appendChild(title);
    for (const level of levelsOfChapter(ch)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chapter';
      b.dataset.level = String(level.id);
      const lock = ch > unlocked;
      if (lock) b.classList.add('locked');
      b.setAttribute('aria-pressed', String(solved.has(level.id)));
      const left = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = `第 ${level.id} 关 · ${level.tierName}`;
      const note = document.createElement('small');
      note.textContent = `${level.size}×${level.size} · ${level.cages} 个笼 · 实测难度 ${level.score}`;
      left.append(name, note);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = solved.has(level.id) ? '已解' : lock ? '锁' : '去解';
      b.append(left, badge);
      b.disabled = lock;
      b.addEventListener('click', () => {
        game.loadById(level.id);
        showGame();
      });
      wrap.appendChild(b);
    }
    el.chapterList.appendChild(wrap);
  }

  buildRecords();
  buildDaily();
  buildResume();
}

function buildRecords() {
  el.recordList.textContent = '';
  for (const tier of TIERS) {
    const best = Store.best(tier.key);
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${tier.name} ${tier.size}×${tier.size}`;
    const time = document.createElement('b');
    time.textContent = best ? fmtTime(best.ms) : '—';
    const hints = document.createElement('b');
    hints.textContent = best ? `提示 ${best.hints}` : '未挑战';
    li.append(name, hints, time);
    el.recordList.appendChild(li);
  }
}

function buildDaily() {
  const day = todayKey();
  const done = Store.dailyDone(day);
  const level = dailyLevel(day);
  el.dailyCard.textContent = '';
  const box = document.createElement('ul');
  const item = (k, v) => {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = k;
    const b = document.createElement('b');
    b.textContent = v;
    li.append(s, b);
    box.appendChild(li);
  };
  item('今天', day);
  item('档位', level ? level.tierName + ' ' + level.size + '×' + level.size : '—');
  item('状态', done ? `已解 · 提示 ${done.hints} · ${fmtTime(done.ms)}` : '未做');
  item('连续', `${Store.dailyStreak(day)} 天`);
  const totals = Store.data.totals;
  item('累计解出', `${totals.solved} 局 / ${totals.cells} 格`);
  el.dailyCard.appendChild(box);
}

function buildResume() {
  const r = Store.resume();
  if (!r || !r.ref) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  const tier = tierByKey(r.tier);
  el.resumeName.textContent = describeRef(r.ref) || '未完成的牌局';
  el.resumeMeta.textContent = `${tier.name} ${r.size}×${r.size} · ${r.elapsedMs ? fmtTime(r.elapsedMs) : '00:00'} · 提示 ${r.hints}`;
}

function describeRef(ref) {
  if (!ref) return '';
  if (ref.startsWith('level-')) return `战役第 ${ref.slice(6)} 关`;
  if (ref.startsWith('daily-')) return `日课 ${ref.slice(6)}`;
  if (ref.startsWith('practice-')) return `练习 · 种子 ${ref.slice(9)}`;
  return ref;
}

// 通关记录就在 Store.solvedIds() 里（关卡号数组，跟着存档走）。
// 这里只补一件事：一章五关全打过，就解锁下一章——**只前进不后退**。
function markSolved(levelId) {
  if (!levelId) return;
  Store.markSolved(levelId);
  const idx = CAMPAIGN.levels.findIndex((l) => l.id === levelId);
  if (idx < 0) return;
  const solved = Store.solvedIds();
  const chapter = Math.floor(idx / CHAPTER_SIZE) + 1;
  if (isChapterDone(chapter, solved)) Store.unlockThrough(chapter + 1);
}

// ---- 视图切换 -----------------------------------------------------------------------

function showGame() {
  el.viewMenu.hidden = true;
  el.viewGame.hidden = false;
  el.winVeil.hidden = true;
  renderer.resize(game.size);
  buildPad();
  refresh();
  markDirty();
}

function showMenu() {
  persist();
  el.viewGame.hidden = true;
  el.viewMenu.hidden = false;
  buildMenu();
}

function startPractice(tierKey) {
  currentTier = tierKey;
  const seed = `web-${todayKey()}-${practiceCounter++}`;
  const made = makePuzzle(seed, tierKey);
  if (!made) {
    say(`这一档暂时抽不出既唯一又能纯逻辑推到底的盘面（种子 ${seed}）。换种子再试，或回战役。`, 'bad');
    return;
  }
  game.setPuzzle({ ...made, mode: Mode.practice, ref: `practice-${seed}`, originSeed: seed });
  showGame();
  say(`${made.tierName} ${made.size}×${made.size} · 实测难度 ${made.score}（区间 ${tierByKey(made.tier).band.join('–')}）`, '');
}

// ---- 读数写回 DOM ---------------------------------------------------------------------

function refresh() {
  if (!game.board) return;
  const s = game.snapshot();
  el.statName.textContent = describeRef(s.ref) || '练习';
  el.statTier.textContent = `${s.tierName} ${s.size}×${s.size}`;
  el.statTime.textContent = fmtTime(s.elapsedMs);
  el.statMoves.textContent = String(s.moves);
  el.statHints.textContent = String(s.hints);
  el.hintCount.textContent = String(s.hints);
  el.statFilled.textContent = `${s.filled}/${s.total}`;
  el.statCages.textContent = `${s.goodCages}/${s.cages}`;
  el.statConflicts.textContent = String(s.conflicts);
  el.statScore.textContent = s.won ? `已解 · 提示 ${s.hints}` : '—';
  el.btnNote.textContent = `铅笔 ${game.noteMode ? '开' : '关'}`;
  el.btnNote.setAttribute('aria-pressed', String(game.noteMode));
  syncPad();
  if (s.conflicts && !s.won) {
    const notes = s.report?.notes;
    void notes;
    say(`有 ${s.conflicts} 处和线索对不上：${reportText()}`, 'bad');
  }
}

function reportText() {
  const rep = game.report();
  if (!rep.notes.length) return '行/列或笼里有对不上的地方';
  return rep.notes.join('；');
}

function persist() {
  if (!game.board || game.won) return;
  Store.saveResume(
    {
      ref: game.ref,
      originSeed: game.originSeed || game.ref,
      tier: game.tier,
      size: game.size,
    },
    game.ink,
    game.notes,
    { moves: game.moves, hints: game.hints, elapsedMs: game.elapsedMs() }
  );
}

// ---- 事件 ---------------------------------------------------------------------------

game.addEventListener('ink', (e) => {
  renderer.notePop(e.detail.cell);
  lastRejection = null;
  const v = e.detail.value;
  const t = e.detail.cell;
  say(`${game.board.cellName(t)} 填 ${v}。`, '');
  refresh();
  markDirty();
  persist();
});

game.addEventListener('note', (e) => {
  const t = e.detail.cell;
  say(`${game.board.cellName(t)} 的铅笔里${e.detail.on ? '记上了' : '划掉了'} ${e.detail.value}。`, '');
  refresh();
  markDirty();
  persist();
});

game.addEventListener('prune', (e) => {
  say(`${game.board.cellName(e.detail.cell)} 擦掉了 ${e.detail.removed} 个已经不可能出现的候选。`, 'good');
  refresh();
  markDirty();
});

game.addEventListener('erase', () => {
  say('擦掉了。', '');
  refresh();
  markDirty();
  persist();
});

game.addEventListener('undo', () => {
  Sound.undo();
  say('撤销了一步。', '');
  refresh();
  markDirty();
  persist();
});

game.addEventListener('select', () => {
  syncPad();
  markDirty();
});

game.addEventListener('reject', (e) => {
  const d = e.detail;
  Sound.conflict();
  lastRejection = { cell: d.cell ?? -1, value: d.value ?? 0, why: d.why };
  say(`这一步不放：${d.why}`, 'bad');
  refresh();
  markDirty();
});

game.addEventListener('hint-conflict', (e) => {
  Sound.conflict();
  say(`先别急，你的数字和线索已经打架了：${e.detail.why}（这次提示不收费）`, 'bad');
});

game.addEventListener('hint', (e) => {
  const h = e.detail;
  Sound.hint();
  el.hintRule.textContent = h.rule ? `${h.rule}${h.cage ? ' · ' + h.cage : ''}` : '提示';
  el.hintLine.innerHTML = '';
  const strong = document.createElement('b');
  strong.textContent = h.text;
  el.hintLine.append(strong);
  if (h.ruleBlurb) {
    const why = document.createElement('span');
    why.textContent = `　${h.ruleBlurb}`;
    el.hintLine.append(why);
  }
  if (h.cageCells.length) renderer.pulse(h.cageCells);
  renderer.notePop(h.cell);
  refresh();
  markDirty();
  persist();
});

game.addEventListener('win', (e) => {
  const s = e.detail;
  Sound.win();
  renderer.celebrate();
  markSolved(s.levelId);
  Store.recordSolve({ ms: s.elapsedMs, hints: s.hints, cells: s.total });
  const isDaily = s.mode === Mode.daily;
  const better = isDaily
    ? Store.recordDaily(s.day || todayKey(), { ms: s.elapsedMs, hints: s.hints, tier: s.tier })
    : Store.recordBest(s.tier, { ms: s.elapsedMs, hints: s.hints, moves: s.moves, size: s.size });
  el.winVeil.hidden = false;
  el.winMeta.textContent = `${s.tierName} ${s.size}×${s.size} · ${fmtTime(s.elapsedMs)} · 步数 ${s.moves} · 提示 ${s.hints} · ${s.cages} 个笼全部算对`;
  el.winRecord.textContent = better ? '新纪录：这一局你没怎么靠提示。' : '已记录。同档比较先看提示次数，再看步数。';
  el.btnAgain.textContent = isDaily ? '回选档' : s.levelId ? `第 ${Math.min(CAMPAIGN.levels.length, s.levelId + 1)} 关` : '再来一局';
  Store.clearResume();
  refresh();
  markDirty();
});

el.canvas.addEventListener('pointerdown', (ev) => {
  const cell = renderer.hitTest(ev.clientX, ev.clientY);
  if (cell < 0) return;
  game.select(cell);
  ev.preventDefault();
  markDirty();
});

el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

el.pad.addEventListener('click', (ev) => {
  const b = ev.target.closest('button.digit');
  if (!b) return;
  press(Number(b.dataset.digit));
});

function press(v) {
  const before = game.ink[game.sel];
  const r = game.noteMode ? game.toggleNote(v) : game.inkValue(game.sel, v);
  if (r.ok) {
    if (game.noteMode) Sound.pencil();
    else Sound.place(v, game.size);
  } else if (!r.silent) {
    lastRejection = { cell: game.sel, value: v, why: r.why };
  }
  void before;
  if (!r.ok && r.why && !r.silent) say(`这一步不放：${r.why}`, 'bad');
  refresh();
  markDirty();
}

el.btnNote.addEventListener('click', () => {
  game.toggleNoteMode();
  buildPad();
  refresh();
  markDirty();
});

el.btnErase.addEventListener('click', () => {
  const r = game.erase();
  if (r.ok) Sound.erase();
  refresh();
  markDirty();
  persist();
});

el.btnPrune.addEventListener('click', () => {
  const r = game.pruneNotes();
  if (!r.ok && r.why) say(r.why, 'warn');
  refresh();
  markDirty();
});

el.btnHint.addEventListener('click', () => {
  game.hint();
});

el.btnUndo.addEventListener('click', () => game.undo());

el.btnRestart.addEventListener('click', () => {
  game.restart();
  buildPad();
  Say_restart();
  refresh();
  markDirty();
  persist();
});

function Say_restart() {
  say('重开了：题面没变，墨水与计时归零。', 'warn');
}

el.btnNew.addEventListener('click', () => {
  startPractice(game.tier || currentTier);
});

el.btnMenu.addEventListener('click', showMenu);
el.btnMenu2.addEventListener('click', () => {
  el.winVeil.hidden = true;
  showMenu();
});
el.btnAgain.addEventListener('click', () => {
  el.winVeil.hidden = true;
  const s = game.snapshot();
  if (s.mode === Mode.daily || !s.levelId) {
    showMenu();
    return;
  }
  game.loadById(s.levelId + 1) || startPractice(s.tier);
  showGame();
});

el.btnDaily.addEventListener('click', () => {
  if (game.loadDaily(todayKey())) showGame();
  else say('今天的日课没排上，回选档看看别的日子。', 'warn');
});

el.btnResume.addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  const ok = restoreResume(r);
  if (!ok) say('那份存档对应的题面已经不在了（存档里的 ref 找不到对应关卡），只能重开。', 'bad');
});

el.btnSound.addEventListener('click', () => {
  const on = !Store.setting('sound');
  Store.setSetting('sound', on);
  Sound.setEnabled(on);
  el.btnSound.textContent = `音效 ${on ? '开' : '关'}`;
  el.btnSound.setAttribute('aria-pressed', String(on));
});

el.btnMotion.addEventListener('click', () => {
  const cur = document.documentElement.classList.contains('reduce-motion');
  const next = !cur;
  document.documentElement.classList.toggle('reduce-motion', next);
  setReduceMotion(next);
  el.btnMotion.textContent = `动效 ${next ? '简' : '全'}`;
  el.btnMotion.setAttribute('aria-pressed', String(next));
  Store.setSetting('reduceMotion', next);
});

window.addEventListener('keydown', (ev) => {
  if (el.viewGame.hidden) return;
  const k = ev.key;
  if (k >= '1' && k <= '9') {
    const v = Number(k);
    if (v <= game.size) {
      press(v);
      ev.preventDefault();
    }
    return;
  }
  if (k === '0' || k === 'Backspace' || k.toLowerCase() === 'e') {
    const r = game.erase();
    if (r.ok) Sound.erase();
    refresh();
    markDirty();
    ev.preventDefault();
    return;
  }
  const nav = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' }[k.length === 1 ? k.toLowerCase() : k];
  if (nav) {
    game.move(nav);
    refresh();
    markDirty();
    ev.preventDefault();
    return;
  }
  if (k.toLowerCase() === 'h') {
    game.hint();
    ev.preventDefault();
  } else if (k.toLowerCase() === 'z') {
    game.undo();
    ev.preventDefault();
  } else if (k.toLowerCase() === 'p') {
    game.toggleNoteMode();
    buildPad();
    refresh();
    markDirty();
    ev.preventDefault();
  } else if (k.toLowerCase() === 'r') {
    game.restart();
    buildPad();
    Say_restart();
    refresh();
    markDirty();
  }
});

setInterval(() => {
  if (!el.viewGame.hidden && !game.won) el.statTime.textContent = fmtTime(game.elapsedMs());
}, 1000);

window.addEventListener('resize', () => {
  if (!el.viewGame.hidden && game.board) {
    renderer.resize(game.size);
    markDirty();
  }
});

// ---- 续局 ---------------------------------------------------------------------------

function restoreResume(r) {
  let puzzle = null;
  if (r.ref.startsWith('level-')) puzzle = { id: Number(r.ref.slice(6)), mode: Mode.campaign, ref: r.ref };
  else if (r.ref.startsWith('daily-')) puzzle = { day: r.ref.slice(6), mode: Mode.daily, ref: r.ref };
  else if (r.ref.startsWith('practice-')) {
    const seed = r.ref.slice(9);
    const made = makePuzzle(seed, r.tier);
    if (made) puzzle = { ...made, mode: Mode.practice, ref: r.ref, originSeed: seed };
  }
  if (!puzzle) return false;
  if (puzzle.id) {
    game.loadById(puzzle.id);
    game.mode = puzzle.mode;
    game.ref = puzzle.ref;
  } else {
    game.setPuzzle(puzzle);
  }
  if (!game.board || game.size !== r.size) return false;
  // 墨水与题面必须配得上：长度不符、数字越界，都在 sanitize 那一关被挡掉了；
  // 这里再要求「恢复出来的盘仍然推得完」，否则宁可丢弃，不让玩家对着一盘死局发呆。
  game.setPuzzle(
    { board: game.board, size: game.size, text: game.board.text, mode: game.mode, tier: game.tier, id: game.levelId, ref: game.ref, originSeed: game.originSeed, day: game.day },
    { keep: { ink: r.inkCells, notes: r.noteCells, moves: r.moves, hints: r.hints } }
  );
  game.restartTimer();
  if (r.elapsedMs > 0) game.pausedMs = 0;
  const d = game.derive(true);
  if (d.res.conflict) {
    game.restart();
    Store.clearResume();
    return false;
  }
  showGame();
  say('接上了存档里的这一局。', 'good');
  return true;
}

// ---- 启动 ---------------------------------------------------------------------------

function boot() {
  const sound = Store.setting('sound');
  Sound.setEnabled(sound !== false);
  el.btnSound.textContent = `音效 ${sound !== false ? '开' : '关'}`;
  el.btnSound.setAttribute('aria-pressed', String(sound !== false));
  const reduce = Store.setting('reduceMotion') || systemPrefersReducedMotion();
  document.documentElement.classList.toggle('reduce-motion', !!reduce);
  setReduceMotion(!!reduce);
  el.btnMotion.textContent = `动效 ${reduce ? '简' : '全'}`;
  el.btnMotion.setAttribute('aria-pressed', String(!!reduce));
  el.buildStamp.textContent = `v${VERSION} · 战役 ${CAMPAIGN.levels.length} 关 · 存档键 ${Store.key}`;
  void Space;

  const r = Store.resume();
  game.loadLevel(1);
  currentTier = game.tier;
  buildMenu();
  if (r && r.ref) {
    el.resumeCard.hidden = false;
  }
  markDirty();
  window.kenkenReady = true;
}

// ---- harness 表面：tools/scenarios.js 只读这些，不读内部标志位 -----------------------------

const api = {
  version: VERSION,
  ready: () => window.kenkenReady === true,
  game,
  renderer,
  Store,
  Sound,
  state: () => {
    const s = game.snapshot();
    const rep = game.report();
    return { ...s, reportNotes: rep.notes.slice(), dup: [...rep.dup], goodCages: [...rep.goodCages], badCages: [...rep.badCages], rejection: lastRejection };
  },
  board: () =>
    game.board
      ? {
          size: game.board.size,
          text: game.board.text,
          cages: game.board.cages.map((c) => ({ i: c.i, label: c.label, op: c.op, target: c.target, cells: c.cells.slice(), head: c.head })),
        }
      : null,
  geometry: () => renderer.geometry(),
  pixel: (x, y) => renderer.pixelAt(x, y),
  select: (cell) => {
    game.select(cell);
    refresh();
    markDirty();
    return game.sel;
  },
  tap: (row, col) => api.select(row * game.size + col),
  type: (v) => {
    press(v);
    return { ink: Array.from(game.ink), state: api.state() };
  },
  note: (v) => {
    const was = game.noteMode;
    if (!was) game.toggleNoteMode(true);
    press(v);
    if (!was) game.toggleNoteMode(false);
    return Array.from(game.notes);
  },
  setNoteMode: (on) => {
    game.toggleNoteMode(!!on);
    buildPad();
    refresh();
    markDirty();
    return game.noteMode;
  },
  erase: () => game.erase(),
  undo: () => game.undo(),
  hint: () => game.hint(),
  restart: () => {
    game.restart();
    buildPad();
    refresh();
    markDirty();
  },
  loadLevel: (id) => {
    if (!game.loadById(Number(id))) return null;
    currentTier = game.tier;
    showGame();
    return api.state();
  },
  loadDaily: (day) => {
    if (!game.loadDaily(day || todayKey())) return null;
    showGame();
    return api.state();
  },
  loadPractice: (seed, tier) => {
    const made = makePuzzle(String(seed || `api-${Date.now()}`), tier || currentTier);
    if (!made) return null;
    game.setPuzzle({ ...made, mode: Mode.practice, ref: `practice-${made.originSeed}` });
    currentTier = made.tier;
    showGame();
    return api.state();
  },
  showMenu,
  solution: () => game.solutionOf(),
  // 只给场景用：把引擎的解填满，走一遍胜利路径。**不**是玩家能按到的按钮。
  fillSolution: () => {
    const sol = game.solutionOf();
    if (!sol) return null;
    for (let t = 0; t < sol.length; t++) if (game.ink[t] !== sol[t]) game.inkValue(t, sol[t]);
    game.checkWin();
    refresh();
    markDirty();
    return api.state();
  },
  // 引擎直读：某一格此刻的候选（用来断言「排除真的发生了」）。
  candidates: (cell) => {
    const m = game.derive(true).res.masks;
    return Array.from(game.board.cells).filter((v, i) => i && m[cell] & (1 << i)).length || 0;
  },
  diagnoseText: () => reportText(),
  cageHolds,
  parseCages,
  boardFromText,
  solveFor: (text, size) => solve(boardFromText(size || game.size, text)),
  rules: RULE_LIST.map((r) => ({ key: r.key, name: r.name, index: r.index, weight: r.weight, blurb: r.blurb })),
  glyphs: OpGlyph,
  tiers: TIERS.map((t) => ({ key: t.key, name: t.name, size: t.size, band: t.band.slice(), note: t.note })),
  campaign: CAMPAIGN.levels.map((l) => ({ id: l.id, tier: l.tier, size: l.size, score: l.score, cages: l.cages })),
  motion: Motion,
  resetStore: () => {
    Store.reset();
    buildMenu();
  },
  storage: () => {
    try {
      return localStorage.getItem(Store.key);
    } catch {
      return null;
    }
  },
};

window.kenken = api;

boot();

export { api };
