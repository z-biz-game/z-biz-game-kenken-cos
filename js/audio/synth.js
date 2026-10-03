// 提示音是合成出来的，不带一个音频文件。益智游戏的音效是**状态的读出**：
// 「落了一个数」「擦掉了」「和线索矛盾了」「这个笼算对了」「整盘解完」——
// 每一种都是一条短包络，用合成器就够，artifact 也小。
//
// 约定：一个声音 = 一次 tone() 调用（或两次，冲突那种故意失谐）。想加第二种音色形状
// 之前先想清楚：那意味着同一件乐器开始有方言。

let ctx = null;
let master = null;
let enabled = true;
// 静音偏好：读回存档。放在模块顶层，这样每次 init（首屏、开局、重开）都拿到同一个答案，
// 重开一局不会把玩家的静音选择洗掉。
try {
  if (localStorage.getItem('cos.mute') === '1') enabled = false;
} catch { /* 读不到就沿用默认开声 */ }


function audio() {
  // 静音态第一行就返回：既不把已挂起的 ctx 拉起来，也不新建节点。
  // 这条比 "gain 设 0" 强一档——静音时这个 AudioContext 根本没有在跑。
  if (!enabled) return null;
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// 单振荡器 + 两点音高滑 + 指数衰减。delay 用秒，调用方自己排节。
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac || !enabled) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const Sound = {
  setEnabled(v) {
    const on = !!v;
    if (on === enabled) return;
    enabled = on;
    // 真静音：停掉 AudioContext 本身（时钟停、图不跑），不是把音量拧到 0。
    if (ctx) {
      if (on) {
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      } else if (ctx.state === 'running' && ctx.suspend) {
        ctx.suspend().catch(() => {});
      }
    }
    // 偏好落盘：刷新页面后 init 要能读回静音态，不能自己弹回来。
    try {
      localStorage.setItem('cos.mute', on ? '1' : '0');
    } catch { /* 隐私模式下写不进去也不该炸游戏 */ }
  },
  enabled: () => enabled,

  // 落子：向上的一挑，音高跟着数字大小走——玩家闭着眼能听出刚敲的是几。
  place(value = 1, size = 6) {
    const step = Math.max(0, Math.min(size - 1, value - 1)) / Math.max(1, size - 1);
    tone({ f0: 440 + step * 260, f1: 660 + step * 320, dur: 0.13, type: 'triangle', gain: 0.2 });
  },
  // 写铅笔候选：比落子轻得多，它是自言自语。
  pencil() {
    tone({ f0: 300, f1: 240, dur: 0.07, type: 'square', gain: 0.07 });
  },
  erase() {
    tone({ f0: 240, f1: 180, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // 两个失谐声部：故意难听，为的是「不用看屏幕也知道这一步和线索打架了」。
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  // 单个笼算对：一声干净的八度，跟整盘解开的四音琶音区分开。
  cageDone() {
    tone({ f0: 660, dur: 0.1, type: 'sine', gain: 0.13 });
    tone({ f0: 990, dur: 0.12, type: 'sine', gain: 0.1, delay: 0.05 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
