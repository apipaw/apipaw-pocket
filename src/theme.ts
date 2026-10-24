/**
 * APIPaw Pocket 设计令牌
 * 深色主题，供 Playground / Analytics 组件与图表共享
 */
export const colors = {
  bg: '#0F172A',
  card: '#1E293B',
  cardAlt: '#172033',
  border: '#334155',
  divider: '#243044',
  accent: '#10B981',
  accentSoft: 'rgba(16, 185, 129, 0.14)',
  purple: '#8B5CF6',
  purpleSoft: 'rgba(139, 92, 246, 0.14)',
  warn: '#F59E0B',
  warnSoft: 'rgba(245, 158, 11, 0.14)',
  danger: '#EF4444',
  dangerDark: '#DC2626',
  resume: '#059669',
  textPrimary: '#F8FAFC',
  textSecondary: '#94A3B8',
  textBody: '#CBD5E1',
  textMuted: '#64748B',
  // 图表专用色板
  chartPrompt: '#8B5CF6',
  chartCompletion: '#10B981',
  chartBase: '#3B82F6',
  chartCreator: '#F59E0B',
  chartGrid: '#243044',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;
