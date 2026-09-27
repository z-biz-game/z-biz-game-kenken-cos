// 一局的状态机。这里只管四件事：**能接受什么输入、接受了会怎样、怎么把结果说给人、
// 什么情况下必须拒绝并把矛盾说出口**。画多少东西、DOM 长什么样都不归它管。
//
// 三条纪律，都是这个游戏的承诺落到代码上的样子：
//
//  1. 墨水与线索矛盾时**拒绝这一步**，不写入、不计步、不计提示，并说清楚是哪一行、
//     哪一列、哪一个笼对不上。判据不是「我写的校验器不喜欢」，而是把新墨水当前提
//     跑一遍铅笔规则（reachable）：规则写下的每条排除都在所有解里成立，所以逼出
//     矛盾就是真的没有解——这句拒绝不冤枉人。
//  2. 提示**不是答案**。提示句来自 solve() 那份推导脚本，点名「哪个笼、哪条规则、
//     哪一格的哪个候选被排除/被定下」，从不替玩家往格子里填数字（填定值的那条除外，
//     但它同时给出理由，玩家仍然可以自己复核）。玩家已经做到的结论不会再提示。
//  3. 铅笔候选是**玩家自己的**记号，引擎不偷偷帮他改。引擎只在候选被证明不可能时
//     把它画暗（看得见，但不会替你擦掉）。

import {
  Rules,
  boardFromText,
  complete,
  diagnose,
  fullMask,
  maskHas,
  bit,
  nextDeduction,
  opName,
  popcount,
  reachable,
  solve,
  cageLabel,
  verify,
} from '../engine/kenken.js';
import { makePuzzle, tierFor, TIERS } from '../engine/generate.js';
import { CAMPAIGN } from '../data/campaign.js';
import { dailyLevel, levelById, tierByKey } from '../data/library.js';

export const Mode = { campaign: '战役', daily: '日课', practice: '练习' };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Game extends EventTarget {
  constructor() {
    super();
    this.board = null;
    this.ink = new Uint8Array(0); // 玩家落的子；0 = 空
    this.notes = new Uint16Array(0); // 玩家自己的候选集，bit v = 「这格还可能是 v」
    this.noteMode = false; // 数字键当前是「写字」还是「记铅笔」
    this.sel = -1;
    this.history = []; // 撤销栈：{kind, cell, ink, notes}
    this.moves = 0;
    this.hints = 0;
    this.hintLog = [];
    this.lastHintKey = ''; // 上一次念出来的那条结论（内容身份，连着按提示不许重复同一句话）
    this.lastHintStamp = ''; // 它的盘面签名：签名没变才谈得上「刚念过」
    this.startedAt = now();
    this.pausedMs = 0;
    this.won = false;
    this.ref = '';
    this.mode = Mode.practice;
    this.levelId = 0;
    this.tier = 'regular';
    this.originSeed = '';
    this.derived = null; // 最近一次整盘推导（脚本 + 候选），只在需要时重算
  }

  // ---- 生命周期 ---------------------------------------------------------------

  /** EventTarget 只有 dispatchEvent；界面统一听 `addEventListener('ink'|'hint'|…)`。 */
  emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /**
   * 换一局。puzzle 可以是烤好的战役题（给 text）或运行时抽的练习题（给 seed + 档位）。
   * `keep` 用来在「同一局重画」时保住墨水（续局）。
   */
  setPuzzle(puzzle, { keep = null } = {}) {
    const board = puzzle.board || boardFromText(puzzle.size, puzzle.text);
    this.board = board;
    this.ink = new Uint8Array(board.n);
    this.notes = new Uint16Array(board.n);
    if (keep && keep.ink && keep.ink.length === board.n) {
      for (let t = 0; t < board.n; t++) {
        this.ink[t] = keep.ink[t] <= board.size ? keep.ink[t] : 0;
        this.notes[t] = keep.notes ? keep.notes[t] & board.emptyMask : 0;
      }
    }
    this.history = [];
    this.moves = keep ? keep.moves || 0 : 0;
    this.hints = keep ? keep.hints || 0 : 0;
    this.hintLog = [];
    this.won = false;
    this.sel = this.firstEmpty();
    this.ref = puzzle.ref || puzzle.seed || '';
    this.originSeed = puzzle.originSeed || puzzle.seed || '';
    this.mode = puzzle.mode || Mode.practice;
    this.levelId = puzzle.id || 0;
    this.tier = puzzle.tier || 'regular';
    this.day = puzzle.day || '';
    this.derived = null;
    this.derive();
    this.restartTimer();
    this.emit('change', { what: 'puzzle' });
    if (this.checkWin(true)) this.emit('win', this.snapshot());
    return this;
  }

  /** 战役：第 n 关（1 起）。 */
  loadLevel(n) {
    const level = typeof n === 'number' ? CAMPAIGN.levels[n - 1] : n;
    if (!level) return null;
    return this.setPuzzle({ ...level, mode: Mode.campaign, ref: `level-${level.id}` });
  }

  loadById(id) {
    const level = levelById(id);
    if (!level) return null;
    return this.setPuzzle({ ...level, mode: Mode.campaign, ref: `level-${level.id}` });
  }

  /** 日课：今天的盘由日期决定，从烤好的目录里取。 */
  loadDaily(dayKey) {
    const level = dailyLevel(dayKey);
    if (!level) return null;
    return this.setPuzzle({ ...level, mode: Mode.daily, ref: `daily-${dayKey}` });
  }

  /** 练习：玩家挑档位，这一局是运行时抽的（不进战役、不进日课）。 */
  loadPractice(seedText, tierKey) {
    const made = makePuzzle(seedText, tierKey);
    if (!made) return null;
    return this.setPuzzle({
      ...made,
      mode: Mode.practice,
      tier: made.tier,
      originSeed: made.originSeed,
      ref: `practice-${made.originSeed}`,
    });
  }

  /** 同一局重开：种子与题面都不变，只清墨水。计时归零。 */
  restart() {
    const board = this.board;
    this.setPuzzle({
      board,
      size: board.size,
      text: board.text,
      mode: this.mode,
      tier: this.tier,
      id: this.levelId,
      ref: this.ref,
      originSeed: this.originSeed,
      day: this.day,
    });
    return this;
  }

  // ---- 读数 ---------------------------------------------------------------------

  get size() {
    return this.board ? this.board.size : 0;
  }

  get cells() {
    return this.board ? this.board.n : 0;
  }

  filledCount() {
    let n = 0;
    for (let t = 0; t < this.ink.length; t++) if (this.ink[t]) n++;
    return n;
  }

  firstEmpty() {
    for (let t = 0; t < this.ink.length; t++) if (!this.ink[t]) return t;
    return -1;
  }

  elapsedMs() {
    return Math.max(0, Math.round(now() - this.startedAt - this.pausedMs));
  }

  restartTimer() {
    this.startedAt = now();
    this.pausedMs = 0;
  }

  /** 整盘推导：脚本 + 冲突。墨水变了就要重算，所以缓存按「墨水指纹」失效。 */
  derive(force = false) {
    const sig = this.ink.join(',') + '|' + this.notes.join(',');
    if (!force && this.derived && this.derived.sig === sig) return this.derived;
    const res = solve(this.board, { givens: this.ink });
    this.derived = { sig, res, report: diagnose(this.board, this.ink) };
    return this.derived;
  }

  /** 报告：哪一格重了、哪个笼已经凑不成。跟 verify 同源，但它是**给人看**的。 */
  report() {
    return this.derive().report;
  }

  /** 这一格现在还能不能填 v（引擎视角；不是「填了会不会赢」而是「填了还有没有解」）。 */
  canFill(cell, v) {
    if (!this.board || v < 1 || v > this.board.size) return { ok: false, why: '这个数字在这盘里没有意义' };
    if (this.ink[cell] === v) return { ok: false, why: '这一格已经是它了' };
    const trial = Uint8Array.from(this.ink);
    trial[cell] = v;
    const r = solve(this.board, { givens: trial });
    if (r.conflict) return { ok: false, why: r.conflict };
    return { ok: true };
  }

  snapshot() {
    const d = this.derive();
    return {
      mode: this.mode,
      levelId: this.levelId,
      ref: this.ref,
      day: this.day,
      tier: this.tier,
      tierName: tierByKey(this.tier).name,
      seed: this.originSeed,
      size: this.size,
      text: this.board ? this.board.text : '',
      ink: Array.from(this.ink),
      notes: Array.from(this.notes),
      selected: this.sel,
      noteMode: this.noteMode,
      moves: this.moves,
      hints: this.hints,
      filled: this.filledCount(),
      total: this.cells,
      conflicts: d.report.conflicts,
      badCages: [...d.report.badCages],
      goodCages: d.report.goodCages.size,
      cages: this.board ? this.board.cages.length : 0,
      won: this.won,
      elapsedMs: this.elapsedMs(),
      solvable: d.res.ok || !d.res.conflict,
      level: d.res.level,
      rounds: d.res.rounds,
    };
  }

  // ---- 输入 ---------------------------------------------------------------------

  select(cell) {
    if (!this.board || cell < 0 || cell >= this.cells) return this;
    this.sel = cell;
    this.emit('select', { cell });
    return this;
  }

  move(dir) {
    const b = this.board;
    if (!b) return this;
    const size = b.size;
    let r = Math.floor(this.sel / size);
    let c = this.sel % size;
    if (dir === 'up') r = Math.max(0, r - 1);
    if (dir === 'down') r = Math.min(size - 1, r + 1);
    if (dir === 'left') c = Math.max(0, c - 1);
    if (dir === 'right') c = Math.min(size - 1, c + 1);
    return this.select(r * size + c);
  }

  toggleNoteMode(v = null) {
    this.noteMode = v === null ? !this.noteMode : !!v;
    this.emit('change', { what: 'noteMode' });
    return this.noteMode;
  }

  pushHistory(cell) {
    this.history.push({ cell, ink: this.ink[cell], notes: this.notes[cell] });
    if (this.history.length > 400) this.history.shift();
  }

  /** 数字键：noteMode 下改铅笔，否则落墨水（可能被拒）。 */
  pressDigit(v) {
    const b = this.board;
    if (!b || this.sel < 0) return { ok: false, why: '先选一格' };
    if (v < 1 || v > b.size) return { ok: false, why: `这盘只用 1..${b.size}` };
    if (this.won) return { ok: false, why: '这一局已经解完了' };
    if (this.noteMode) return this.toggleNote(v);
    return this.inkValue(this.sel, v);
  }

  inkValue(cell, v) {
    const b = this.board;
    if (this.ink[cell] === v) return { ok: false, why: '这一格已经是它了', silent: true };
    const check = this.canFill(cell, v);
    if (!check.ok) {
      // 拒绝，并把矛盾说出口。不写入、不计步、不进撤销栈。
      this.emit('reject', { cell, value: v, why: check.why });
      return { ok: false, why: check.why };
    }
    this.pushHistory(cell);
    this.ink[cell] = v;
    this.notes[cell] = 0; // 落了子，这格的铅笔就作废了
    this.moves++;
    this.derived = null;
    this.emit('ink', { cell, value: v });
    this.checkWin();
    return { ok: true };
  }

  toggleNote(v) {
    const b = this.board;
    if (this.ink[this.sel]) return { ok: false, why: '这一格已经落了子，先擦掉再记铅笔' };
    this.pushHistory(this.sel);
    this.notes[this.sel] ^= bit(v);
    this.notes[this.sel] &= b.emptyMask;
    this.moves++;
    this.derived = null;
    this.emit('note', { cell: this.sel, value: v, on: maskHas(this.notes[this.sel], v) });
    return { ok: true };
  }

  erase() {
    if (!this.board || this.sel < 0) return { ok: false };
    if (!this.ink[this.sel] && !this.notes[this.sel]) return { ok: false, silent: true };
    this.pushHistory(this.sel);
    this.ink[this.sel] = 0;
    this.notes[this.sel] = 0;
    this.moves++;
    this.won = false;
    this.derived = null;
    this.emit('erase', { cell: this.sel });
    return { ok: true };
  }

  /** 擦掉一格里「引擎已经证明不可能」的候选——这是给懒人的工具，不改题面。 */
  pruneNotes(cell = this.sel) {
    const b = this.board;
    if (!b || cell < 0 || !this.notes[cell]) return { ok: false, silent: true };
    const d = this.derive();
    if (!d.res.ok && d.res.conflict) return { ok: false, why: d.res.conflict };
    const keep = d.res.masks ? d.res.masks[cell] : 0;
    if (!keep) return { ok: false, silent: true };
    const before = this.notes[cell];
    const after = before & keep;
    if (before === after) return { ok: false, silent: true };
    this.pushHistory(cell);
    this.notes[cell] = after;
    this.emit('prune', { cell, removed: popcount(before & ~after) });
    return { ok: true, removed: popcount(before & ~after) };
  }

  undo() {
    const last = this.history.pop();
    if (!last) return { ok: false, why: '没有可撤销的动作了' };
    this.ink[last.cell] = last.ink;
    this.notes[last.cell] = last.notes;
    this.sel = last.cell;
    this.moves = Math.max(0, this.moves - 1);
    this.won = false;
    this.derived = null;
    this.emit('undo', { cell: last.cell });
    return { ok: true };
  }

  // ---- 提示：把脚本里下一条**玩家还没做到**的结论念出来 ------------------------------
  //
  // 「不替玩家填」的边界：规则说「这格只能填 4」时，我们说的是哪个笼、哪条规则、
  // 哪一格；写不写由玩家的手决定。排除类提示只说「哪一格的哪个候选可以划掉」。

  hint() {
    const b = this.board;
    if (!b) return { ok: false };
    if (this.won) return { ok: false, why: '这一局已经解完了' };
    const d = this.derive(true);
    if (d.res.conflict) {
      // 墨水已经和线索矛盾：不收费，先把这件事说清楚。
      this.emit('hint-conflict', { why: d.res.conflict });
      return { ok: false, conflict: true, why: d.res.conflict, free: true };
    }
    const rows = d.res.rows || [];
    if (!rows.length) return { ok: false, why: '这盘没有可提示的结论' };
    let row = pickUnrealized(rows, this.ink, this.notes, this.sel);
    let suffix = row ? null : '（这一步你已经做过了，接着往下想）';
    if (!row) row = rows[0];
    // 连着要提示不许念同一句话：盘面没动（推导的签名一模一样）、看的还是同一格，
    // 那第二条就必须往前走——顺着推导往下找一条不是刚念过的，走到末尾再绕回开头。
    // 玩家一旦落子/记铅笔/换选中格，签名就变了，重新开始念。
    // 比对只能按**内容**比：derive(true) 每次都重算，rows 里的对象是新生成的，比 `===` 永远不等。
    const stamp = `${b.text}|${d.sig}|${this.sel}`;
    const key = hintKey(row);
    if (key === this.lastHintKey && stamp === this.lastHintStamp) {
      const from = rows.indexOf(row);
      for (let k = 1; k < rows.length; k++) {
        const alt = rows[(from + k) % rows.length];
        if (hintKey(alt) === key) continue;
        row = alt;
        suffix = realized(alt, this.ink, this.notes) ? '（这一步你已经做过了，接着往下想）' : null;
        break;
      }
    }
    this.lastHintKey = hintKey(row);
    this.lastHintStamp = stamp;
    return this.charge(row, suffix);
  }

  charge(row, suffix) {
    this.hints++;
    const b = this.board;
    const cage = row.cage >= 0 ? b.cages[row.cage] : null;
    const text = row.text + (suffix ? ` ${suffix}` : '');
    const rec = {
      ok: true,
      free: false,
      cell: row.cell,
      kind: row.kind,
      value: row.value,
      rule: row.rule ? row.rule.name : '',
      ruleBlurb: row.rule ? row.rule.blurb : '',
      cage: cage ? `${cage.name}「${cage.label}」` : '',
      cageOp: cage ? opName(cage.op) : '',
      cageTarget: cage ? cage.target : 0,
      text,
      // 提示点名到「哪个笼」：界面上把这个笼整串格子描出来，玩家自己去看那三格。
      cageCells: cage ? cage.cells.slice() : [],
      hintNo: this.hints,
    };
    this.hintLog.push(rec);
    this.emit('hint', rec);
    return rec;
  }

  /** 引擎此刻能立刻指出的那一步（不走脚本，用来做「这格为什么不能填」的追问）。 */
  whyNot(cell, v) {
    const b = this.board;
    const check = this.canFill(cell, v);
    if (check.ok) return { ok: true, why: '这一格填得上，往下推推看' };
    return { ok: false, why: check.why, deduction: nextDeduction(b, assignAt(this.ink, cell, v)) };
  }

  checkWin(quiet = false) {
    const b = this.board;
    if (!b || this.won) return this.won;
    if (!complete(b, this.ink)) return false;
    const bad = verify(b, this.ink);
    if (bad.length) {
      if (!quiet) this.emit('reject', { why: '填满了，但算错了：' + describeBad(b, bad[0]) });
      return false;
    }
    this.won = true;
    this.emit('win', this.snapshot());
    return true;
  }

  /** 只给测试与「验算」按钮用：把引擎的解直接读出来（界面不许拿它填盘）。 */
  solutionOf() {
    const d = this.derive(true);
    return d.res.ok ? Array.from(d.res.solution) : null;
  }
}

function assignAt(ink, cell, v) {
  const out = Uint8Array.from(ink);
  out[cell] = v;
  return out;
}

// 一条结论的**内容**身份：同一份推导重算一遍会得到新对象，所以「刚没刚念过」只能这么比。
function hintKey(row) {
  return `${row.kind}|${row.cell}|${row.value}|${row.text}`;
}

// 脚本里的哪一条是「玩家还没做到的」：
//   * 落子：那一格现在不是这个数；
//   * 排除：那一格还空着，且玩家的铅笔里这个候选还没被划掉。
function realized(row, ink, notes) {
  if (row.kind === 'place') return ink[row.cell] === row.value;
  if (row.kind === 'elim') return !!ink[row.cell] || !maskHas(notes[row.cell], row.value);
  return true;
}

// 优先给**选中格**相关的结论——人在看哪一格，提示就该从哪一格说起；没有就按推导顺序给。
function pickUnrealized(rows, ink, notes, sel) {
  let fallback = null;
  for (const row of rows) {
    if (row.kind !== 'place' && row.kind !== 'elim') continue;
    if (realized(row, ink, notes)) continue;
    if (row.cell === sel) return row;
    if (!fallback) fallback = row;
  }
  return fallback;
}

function describeBad(board, bad) {
  if (!bad) return '';
  if (bad.why === '重了') return `${bad.name}里 ${bad.value} 出现了 ${bad.count} 次`;
  if (bad.why === '笼不对') return `${bad.name} 算不出 ${bad.want}`;
  if (bad.why === '空格') return `${board.cellName(bad.cell)} 还空着`;
  return `${bad.name} 不是 1..${board.size} 的排列`;
}

export { Rules, cageLabel, fullMask, TIERS, tierFor };
