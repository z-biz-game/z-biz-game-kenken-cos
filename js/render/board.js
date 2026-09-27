// 画布：笼的粗边、目标数与运算符、墨水数字、铅笔候选、选中框、冲突色，全部画在这里。
// 一个美术文件都不带，是因为这类盘的所有视觉信息都是**结构**：笼的划分就是边界线段，
// 线索就是左上角那几个字符。把它们画出来比贴图更准，也更省。
//
// 三条纪律：
//   1. 布局只算一次（resize），画与命中测试读同一份 `layout`。数字与像素对不上，
//      十有八九是两处各算了一套坐标。
//   2. 颜色/字号/圆角/时长全部来自 theme.js，这里不出现字面量色值。
//   3. 背衬按 devicePixelRatio 放大，再用 setTransform 把单位换算回 CSS 像素；
//      不这么做的话 Retina 上线条发虚，笼边界会有半格偏移。

import { Palette, Space, Font, Motion, Cell, prefersReducedMotion } from '../theme.js';
import { OpGlyph, maskHas } from '../engine/kenken.js';

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let layout = null;
  let anim = { pops: new Map(), hintPulse: null, winAt: 0 };

  function measure(size) {
    const box = canvas.getBoundingClientRect();
    const cssW = Math.max(120, Math.round(box.width || 320));
    const pad = Space.inner;
    const avail = cssW - pad * 2;
    let cell = Math.floor(avail / size);
    if (cell > Cell.max) cell = Cell.max;
    if (cell < Cell.min) cell = Cell.min;
    const boardPx = cell * size;
    const left = Math.round((cssW - boardPx) / 2);
    return {
      size,
      dpr: Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1))),
      cell,
      pad,
      left,
      top: pad,
      boardPx,
      cssW,
      cssH: boardPx + pad * 2,
      heavy: Math.max(3, Math.round(cell * 0.1)),
      hair: 1,
    };
  }

  function resize(size) {
    layout = measure(size);
    const { dpr, cssW, cssH } = layout;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return layout;
  }

  const cellRect = (t) => {
    const r = Math.floor(t / layout.size);
    const c = t % layout.size;
    return {
      x: layout.left + c * layout.cell,
      y: layout.top + r * layout.cell,
      s: layout.cell,
      r,
      c,
    };
  };

  /** 命中测试：找**最近的格心**，而不是「落在哪个格里」。
   *  七阶盘上一格只有 40px 出头，按格子边界点会在两格之间反复跳。 */
  function hitTest(clientX, clientY) {
    if (!layout) return -1;
    const box = canvas.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    let best = -1;
    let bestD = Infinity;
    for (let t = 0; t < layout.size * layout.size; t++) {
      const rc = cellRect(t);
      const dx = x - (rc.x + rc.s / 2);
      const dy = y - (rc.y + rc.s / 2);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    const reach = layout.cell * 1.15;
    return bestD <= reach * reach ? best : -1;
  }

  /** 场景断言要用：把 CSS 像素坐标读成真实像素。 */
  function pixelAt(x, y) {
    const dpr = layout ? layout.dpr : 1;
    const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }

  // ---- 画的各层 ------------------------------------------------------------------

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawBoardBase(board) {
    const { cssW, cssH, left, top, boardPx, cell } = layout;
    ctx.clearRect(0, 0, cssW, cssH);
    roundRect(left - 3, top - 3, boardPx + 6, boardPx + 6, Cell.max / 4);
    ctx.fillStyle = Palette.surface;
    ctx.fill();
    // 笼子底色：同笼同色，奇偶交替。色相不增加——笼多的时候色相不够用是这类盘的通病。
    for (const cage of board.cages) {
      ctx.fillStyle = cage.i % 2 ? Palette.cageTintAlt : Palette.cageTint;
      for (const t of cage.cells) {
        const rc = cellRect(t);
        ctx.fillRect(rc.x + 1, rc.y + 1, cell - 2, cell - 2);
      }
    }
    // 细网格：只画同笼内部的接缝，让「这几格是一伙的」有个边界感。
    ctx.strokeStyle = Palette.line;
    ctx.lineWidth = layout.hair;
    ctx.beginPath();
    for (let t = 0; t < board.n; t++) {
      const rc = cellRect(t);
      const right = t % board.size !== board.size - 1 ? t + 1 : -1;
      const down = t < board.n - board.size ? t + board.size : -1;
      if (right >= 0 && board.cageOf[right] === board.cageOf[t]) {
        ctx.moveTo(rc.x + cell, rc.y + 1);
        ctx.lineTo(rc.x + cell, rc.y + cell - 1);
      }
      if (down >= 0 && board.cageOf[down] === board.cageOf[t]) {
        ctx.moveTo(rc.x + 1, rc.y + cell);
        ctx.lineTo(rc.x + cell - 1, rc.y + cell);
      }
    }
    ctx.stroke();
    void top;
  }

  /** 笼的粗边界：一格的四条边，只要对面不属于同一个笼（或在盘外），就是边界。 */
  function drawCageBorders(board) {
    const { cell, heavy } = layout;
    ctx.save();
    ctx.strokeStyle = Palette.lineHeavy;
    ctx.lineWidth = heavy;
    ctx.lineCap = 'square';
    ctx.beginPath();
    const half = heavy / 2;
    for (let t = 0; t < board.n; t++) {
      const rc = cellRect(t);
      const ci = board.cageOf[t];
      const size = board.size;
      const r = Math.floor(t / size);
      const c = t % size;
      const across = (nr, nc) => (nr < 0 || nr >= size || nc < 0 || nc >= size ? -1 : board.cageOf[nr * size + nc]);
      // 上
      if (across(r - 1, c) !== ci) {
        ctx.moveTo(rc.x - half, rc.y);
        ctx.lineTo(rc.x + cell + half, rc.y);
      }
      // 下
      if (across(r + 1, c) !== ci) {
        ctx.moveTo(rc.x - half, rc.y + cell);
        ctx.lineTo(rc.x + cell + half, rc.y + cell);
      }
      // 左
      if (across(r, c - 1) !== ci) {
        ctx.moveTo(rc.x, rc.y - half);
        ctx.lineTo(rc.x, rc.y + cell + half);
      }
      // 右
      if (across(r, c + 1) !== ci) {
        ctx.moveTo(rc.x + cell, rc.y - half);
        ctx.lineTo(rc.x + cell, rc.y + cell + half);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawCageLabels(board) {
    const { cell } = layout;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `600 ${Math.max(10, Math.round(cell * Cell.labelScale))}px ${Font.mono}`;
    for (const cage of board.cages) {
      const rc = cellRect(cage.head);
      const glyph = OpGlyph[cage.op];
      const label = glyph ? `${cage.target}${glyph}` : `${cage.target}`;
      ctx.fillStyle = Palette.inkDim;
      // 左上角一点点底衬，防止数字压在候选上看不清
      const w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(8,11,22,0.55)';
      ctx.fillRect(rc.x + 1, rc.y + 1, w + 4, Math.round(cell * Cell.labelScale) + 5);
      ctx.fillStyle = Palette.inkDim;
      ctx.fillText(label, rc.x + 3, rc.y + 3);
    }
    ctx.restore();
  }

  function drawSelection(board, g) {
    const { cell } = layout;
    if (g.selected < 0) return;
    const rc = cellRect(g.selected);
    ctx.save();
    roundRect(rc.x + 1.5, rc.y + 1.5, cell - 3, cell - 3, Cell.cell);
    ctx.fillStyle = Palette.focus;
    ctx.fill();
    ctx.strokeStyle = Palette.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 同数字呼应：选中格里有墨水时，把同数字的其它格子描一圈。
    const v = g.ink[g.selected];
    if (v) {
      ctx.strokeStyle = Palette.accentSoft;
      ctx.lineWidth = 2;
      for (let t = 0; t < board.n; t++) {
        if (t !== g.selected && g.ink[t] === v) {
          const o = cellRect(t);
          roundRect(o.x + 2, o.y + 2, cell - 4, cell - 4, Cell.cell);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawHintPulse(board, g, nowMs) {
    const h = anim.hintPulse;
    if (!h) return;
    const age = nowMs - h.at;
    const dur = Motion.pop * 3;
    if (age > dur) {
      anim.hintPulse = null;
      return;
    }
    const k = 1 - age / dur;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hexWith(Palette.hint, 0.35 + 0.5 * k);
    for (const t of h.cells) {
      const rc = cellRect(t);
      roundRect(rc.x + 2, rc.y + 2, layout.cell - 4, layout.cell - 4, Cell.cell);
      ctx.stroke();
    }
    ctx.restore();
    g.pulseActive = true;
  }

  function drawNotes(board, g) {
    const { cell } = layout;
    const masks = g.masks;
    for (let t = 0; t < board.n; t++) {
      const m = g.notes[t];
      if (!m || g.ink[t]) continue;
      const rc = cellRect(t);
      // 候选按「九宫位」摆放：最多 9 个数字，正好一格九个位置。
      const per = cell / 3;
      ctx.font = `500 ${Math.max(8, Math.round(per * Cell.noteScale * 2.1))}px ${Font.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let v = 1; v <= board.size; v++) {
        if (!maskHas(m, v)) continue;
        const idx = v - 1;
        const px = rc.x + (idx % 3) * per + per / 2 + per / 2;
        const py = rc.y + Math.floor(idx / 3) * per + per / 2 + per / 2;
        const dead = masks && !maskHas(masks[t] || 0, v);
        ctx.fillStyle = dead ? Palette.pencil : Palette.pencilStrong;
        ctx.fillText(String(v), px, py);
      }
    }
  }

  function drawInk(board, g, nowMs) {
    const { cell } = layout;
    const rep = g.report;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(cell * Cell.digitScale)}px ${Font.mono}`;
    for (let t = 0; t < board.n; t++) {
      const v = g.ink[t];
      if (!v) continue;
      const rc = cellRect(t);
      const pop = anim.pops.get(t);
      let scale = 1;
      if (pop) {
        const age = nowMs - pop.at;
        if (age > Motion.pop) anim.pops.delete(t);
        else scale = 1 + 0.28 * Math.sin((Math.PI * age) / Motion.pop) * (1 - age / Motion.pop);
      }
      const bad = rep && rep.dup.has(t);
      ctx.save();
      ctx.translate(rc.x + cell / 2, rc.y + cell / 2);
      ctx.scale(scale, scale);
      if (bad) {
        // 冲突的墨水：红底白字，先把「这步不行」说出来，再谈数字本身。
        roundRect(-cell * 0.32, -cell * 0.32, cell * 0.64, cell * 0.64, Cell.cell);
        ctx.fillStyle = Palette.error;
        ctx.fill();
        ctx.fillStyle = '#080B16';
      } else if (rep && rep.goodCages.has(board.cageOf[t])) {
        ctx.fillStyle = Palette.success;
      } else {
        ctx.fillStyle = t === g.selected ? Palette.accentEdge : Palette.ink;
      }
      ctx.fillText(String(v), 0, cell * 0.04);
      ctx.restore();
    }
  }

  function drawCageSolved(board, g) {
    const rep = g.report;
    if (!rep || !rep.goodCages.size) return;
    const { cell } = layout;
    ctx.save();
    ctx.fillStyle = Palette.cageSolved;
    for (const ci of rep.goodCages) {
      for (const t of board.cages[ci].cells) {
        if (!g.ink[t]) continue;
        const rc = cellRect(t);
        ctx.fillRect(rc.x + 1, rc.y + 1, cell - 2, cell - 2);
      }
    }
    ctx.restore();
  }

  function drawWin(board, g, nowMs) {
    if (!anim.winAt) return;
    const age = nowMs - anim.winAt;
    if (age > Motion.win) {
      anim.winAt = 0;
      return;
    }
    const k = age / Motion.win;
    const { left, top, boardPx, cell } = layout;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = Palette.success;
    ctx.lineWidth = 3;
    const inset = k * cell * 0.5;
    roundRect(left + inset, top + inset, boardPx - inset * 2, boardPx - inset * 2, Cell.card / 2);
    ctx.stroke();
    ctx.restore();
  }

  function draw(game, nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    if (!layout || !game.board) return false;
    const board = game.board;
    if (layout.size !== board.size) resize(board.size);
    const g = {
      ink: game.ink,
      notes: game.notes,
      selected: game.sel,
      masks: game.derive ? game.derive().res.masks : null,
      report: game.report ? game.report() : null,
      pulseActive: false,
    };
    drawBoardBase(board);
    drawCageSolved(board, g);
    drawSelection(board, g);
    drawNotes(board, g);
    drawCageBorders(board);
    drawCageLabels(board);
    drawInk(board, g, nowMs);
    drawHintPulse(board, g, nowMs);
    drawWin(board, g, nowMs);
    return g.pulseActive || anim.pops.size > 0 || !!anim.winAt || !!anim.hintPulse;
  }

  function notePop(cell) {
    if (prefersReducedMotion()) return;
    anim.pops.set(cell, { at: typeof performance !== 'undefined' ? performance.now() : Date.now() });
  }

  function pulse(cells) {
    anim.hintPulse = { cells: cells.slice(), at: typeof performance !== 'undefined' ? performance.now() : Date.now() };
  }

  function celebrate() {
    anim.winAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function geometry() {
    if (!layout) return null;
    const cells = [];
    for (let t = 0; t < layout.size * layout.size; t++) {
      const rc = cellRect(t);
      cells.push({ t, x: rc.x, y: rc.y, s: rc.s, cx: rc.x + rc.s / 2, cy: rc.y + rc.s / 2 });
    }
    return {
      size: layout.size,
      cell: layout.cell,
      left: layout.left,
      top: layout.top,
      boardPx: layout.boardPx,
      heavy: layout.heavy,
      dpr: layout.dpr,
      cssW: layout.cssW,
      cssH: layout.cssH,
      cells,
    };
  }

  return { resize, draw, hitTest, pixelAt, geometry, notePop, pulse, celebrate, canvas: () => canvas };
}

// 十六进制/rgb 颜色加透明度：只在描边脉冲里用，避免为了一次淡入引入第四种颜色。
function hexWith(color, alpha) {
  if (color.startsWith('rgba')) return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'rgba($1,$2,$3,' + alpha + ')');
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  return color;
}
