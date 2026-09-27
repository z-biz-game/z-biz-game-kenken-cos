// 颜色、间距、动效的唯一出处。样式表通过 applyThemeVars 把它们读成 CSS 自定义属性，
// 画布直接读同一批对象——所以改一个 token 不可能只改到一边（那是「一条线一种颜色」
// 会长出四十种颜色的原因）。
//
// 聪明格是「格子游戏」：一格里同时住着数字、铅笔候选、笼标签、选中框、冲突色。
// 下面的色板就是按这五层各自该说什么来分配的，不给画布留任何就地取色的余地。

export const Palette = {
  bgTop: '#080B16',
  bgBottom: '#131A2E',
  surface: '#101627',
  surfaceLift: '#182036',
  line: '#243050',
  lineHeavy: '#3A4A72',
  ink: '#F2F5FB',
  inkDim: 'rgba(242,245,251,0.62)',
  inkFaint: 'rgba(242,245,251,0.34)',

  // 琥珀 = 玩家自己的手：刚敲下的数字、选中格、提示刚点名的那一格都用它。
  // 「这是你正在做的事」在屏幕上只有一种颜色。
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  // 铅笔候选是「还没落子的话」，比墨水暗、比笼标签亮，用偏蓝的冷色跟琥珀的暖色分开。
  info: '#7BB8FF',
  pencilStrong: '#8FA6CC',
  pencil: 'rgba(242,245,251,0.30)',

  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  focus: 'rgba(123,184,255,0.16)',
  hint: '#7BB8FF',

  // 笼底色：同一笼的格子共享一点点提亮，用来把「这几格是一伙的」说清楚。
  // 只用透明度差别，不引入新色相——笼多了色相不够用是这类盘的通病。
  cageTint: 'rgba(123,184,255,0.05)',
  cageTintAlt: 'rgba(255,200,92,0.05)',
  cageSolved: 'rgba(61,220,145,0.10)',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 3 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// 时长守在 150–350ms：比这长的动画会挡住下一步操作。
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// 一格的像素尺寸区间：7 阶盘在 iPhone 宽度上刚好落在 min 附近，22px 还能点得着。
export const Cell = { min: 22, max: 56, gap: 2, labelScale: 0.34, digitScale: 0.52, noteScale: 0.24 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// 系统偏好是地板，游戏内的开关只能往上加不能往下减——
// 一个把系统设成「减弱动效」的玩家不该被游戏覆盖掉。
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
