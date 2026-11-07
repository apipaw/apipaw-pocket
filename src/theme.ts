/**
 * APIPaw Pocket 设计令牌 —— Web3 DePIN / 暗黑科幻
 *
 * 视觉基线（与桌面端 Agent 同源）：
 *   · 底色近乎纯黑（#050509，比 zinc-950 更深），靠极光渐变 + 网格纹理制造纵深
 *   · 卡片是「磨砂玻璃」：半透明白底 + 1px 高光描边，而不是实心色块
 *   · 三个点缀色各司其职：翠绿 = 在线/正常，霓虹蓝 = 数据流，亮紫 = 创作者/生态
 *
 * 玻璃拟态里那些 RN 表达不了的属性（backdrop-filter、渐变描边、渐变文字、
 * 呼吸灯、终端内阴影）统一交给 `src/ui/webTheme.ts` 的 Web 专属 CSS 层，
 * 通过元素的 `id` 前缀做选择器挂载 —— RNW 会把 `id` 原样映射到 DOM。
 */

export const colors = {
  // ---- 背景层 ----
  bg: '#050509',
  bgDeep: '#020204',
  bgElevated: '#0A0A11',

  // ---- 玻璃层 ----
  card: 'rgba(255, 255, 255, 0.035)',
  cardAlt: 'rgba(255, 255, 255, 0.06)',
  cardHover: 'rgba(255, 255, 255, 0.085)',
  cardSolid: '#0B0B12',

  border: 'rgba(255, 255, 255, 0.09)',
  borderStrong: 'rgba(255, 255, 255, 0.18)',
  divider: 'rgba(255, 255, 255, 0.07)',

  // ---- 点缀色 ----
  accent: '#34D399', // 翠绿 · 在线 / 正常
  accentSoft: 'rgba(52, 211, 153, 0.14)',
  cyan: '#22D3EE', // 霓虹蓝 · 数据流
  cyanSoft: 'rgba(34, 211, 238, 0.14)',
  blue: '#60A5FA',
  purple: '#A78BFA', // 亮紫 · 创作者 / 生态
  purpleSoft: 'rgba(167, 139, 250, 0.16)',
  pink: '#F472B6',
  warn: '#FBBF24',
  warnSoft: 'rgba(251, 191, 36, 0.14)',
  danger: '#FB7185',
  dangerSoft: 'rgba(251, 113, 133, 0.14)',
  dangerDark: '#F43F5E',
  resume: '#10B981',

  // ---- 文字层 ----
  textPrimary: '#F4F4F5',
  textSecondary: '#A1A1AA',
  textBody: '#D4D4D8',
  textMuted: '#71717A',

  // ---- 图表色板（全部换到霓虹冷调）----
  chartPrompt: '#22D3EE',
  chartCompletion: '#34D399',
  chartBase: '#60A5FA',
  chartCreator: '#FBBF24',
  chartGrid: 'rgba(255, 255, 255, 0.07)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const fontSize = {
  xs: 12,
  sm: 13,
  md: 14,
  lg: 16,
  /** 卡片标题级 */
  title: 18,
  xl: 20,
  /** KPI 主数值级（StatTile 的绝对视觉中心）*/
  metric: 30,
  xxl: 28,
  hero: 44,
} as const;

/**
 * 等宽字体栈 —— 数字、节点 ID、密钥片段等「机器感」文本统一用它。
 * RN 侧用 `fontFamily: 'monospace'`，Web 侧由 CSS 精确指定。
 */
export const monoFont = 'monospace';
