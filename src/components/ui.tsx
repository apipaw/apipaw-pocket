import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleProp,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';
import { colors, fontSize, radius, spacing } from '../theme';

// ---------------------------------------------------------------------------
// 设计系统基础件
//
// 这一组组件是「暗黑科幻 / Web3 DePIN」视觉语言的可复用原子：
//   Surface   —— 磨砂玻璃容器
//   StatTile  —— 仪表盘数据小卡
//   Toggle    —— 精致的拨动开关（替代臃肿的整行大按钮）
//   StatusDot —— 会呼吸的在线指示灯
//   Toast     —— 右上角悬浮提示（替代复古的通栏警告条）
//   Pill      —— 霓虹标签
// ---------------------------------------------------------------------------

export interface SurfaceProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Web 专属 CSS 挂载前缀，见 src/ui/webTheme.ts */
  webId?: string;
  testID?: string;
}

export const Surface: React.FC<SurfaceProps> = ({ children, style, webId, testID }) => (
  <View id={webId} testID={testID} style={[styles.surface, style]}>
    {children}
  </View>
);

// ---------------------------------------------------------------------------

export interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  /** 点缀色：emerald 在线 / cyan 数据 / violet 创作者 / amber 提醒 */
  tone?: 'emerald' | 'cyan' | 'violet' | 'amber' | 'rose';
  hint?: string;
  style?: StyleProp<ViewStyle>;
}

const TONE_COLOR: Record<NonNullable<StatTileProps['tone']>, string> = {
  emerald: colors.accent,
  cyan: colors.cyan,
  violet: colors.purple,
  amber: colors.warn,
  rose: colors.danger,
};

export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  unit,
  tone = 'cyan',
  hint,
  style,
}) => {
  const toneColor = TONE_COLOR[tone];
  return (
    <View style={[styles.statTile, style]}>
      <View style={styles.statTileHead}>
        <View style={[styles.statTileDot, { backgroundColor: toneColor }]} />
        <Text style={styles.statTileLabel} id="apx-stat-label" numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={styles.statTileValueRow}>
        <Text style={[styles.statTileValue, { color: toneColor }]} id="apx-stat-value" numberOfLines={1}>
          {value}
        </Text>
        {unit ? <Text style={styles.statTileUnit}>{unit}</Text> : null}
      </View>
      {hint ? (
        <Text style={styles.statTileHint} id="apx-stat-hint" numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
};

// ---------------------------------------------------------------------------

export interface ToggleProps {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  testID?: string;
  webId?: string;
}

/**
 * 拨动开关 —— 取代原先「远程指令: 一键暂停接单」那种占满整行的大红按钮。
 * 轨道颜色与滑块位移都由 Animated 插值驱动，Web / 原生表现一致。
 */
export const Toggle: React.FC<ToggleProps> = ({ value, onChange, disabled, testID, webId }) => {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [anim, value]);

  const trackColor = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(255, 255, 255, 0.10)', colors.accent],
  });
  const thumbLeft = anim.interpolate({ inputRange: [0, 1], outputRange: [3, 25] });
  const glowOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] });

  return (
    <TouchableOpacity
      id={webId}
      testID={testID}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      activeOpacity={0.85}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={styles.toggleHit}
    >
      <Animated.View style={[styles.toggleTrack, { backgroundColor: trackColor }]}>
        <Animated.View style={[styles.toggleGlow, { opacity: glowOpacity }]} />
        <Animated.View style={[styles.toggleThumb, { left: thumbLeft }]} />
      </Animated.View>
    </TouchableOpacity>
  );
};

// ---------------------------------------------------------------------------

export interface StatusDotProps {
  color?: string;
  /** live = 呼吸灯（在线）；alert = 呼吸红灯（告警） */
  variant?: 'static' | 'live' | 'alert';
  size?: number;
  style?: ViewStyle;
}

export const StatusDot: React.FC<StatusDotProps> = ({
  color = colors.accent,
  variant = 'static',
  size = 8,
  style,
}) => {
  const webId =
    variant === 'live'
      ? 'apx-dot-live'
      : variant === 'alert'
        ? 'apx-dot-alert'
        : undefined;
  return (
    <View
      id={webId}
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        style,
      ]}
    />
  );
};

// ---------------------------------------------------------------------------

export interface PillProps {
  label: string;
  color?: string;
  /** dot = 带前置状态点 */
  dot?: boolean;
  style?: ViewStyle;
}

export const Pill: React.FC<PillProps> = ({ label, color = colors.cyan, dot, style }) => (
  <View style={[styles.pill, { borderColor: `${color}55` }, style]}>
    {dot ? <View style={[styles.pillDot, { backgroundColor: color }]} /> : null}
    <Text style={[styles.pillText, { color }]}>{label}</Text>
  </View>
);

// ---------------------------------------------------------------------------

export interface ToastProps {
  visible: boolean;
  title: string;
  message?: string;
  tone?: 'warn' | 'danger' | 'info';
  actionLabel?: string;
  onAction?: () => void;
}

const TOAST_ACCENT: Record<NonNullable<ToastProps['tone']>, string> = {
  warn: colors.warn,
  danger: colors.danger,
  info: colors.cyan,
};

/**
 * 右上角悬浮提示 —— 取代原先占据整行高度的橘红色警告横幅。
 * Web 端由 CSS 固定到视口右上角并带入场动画，原生端退化为普通浮层。
 */
export const Toast: React.FC<ToastProps> = ({
  visible,
  title,
  message,
  tone = 'warn',
  actionLabel,
  onAction,
}) => {
  if (!visible) return null;
  const accent = TOAST_ACCENT[tone];
  return (
    <View id="apx-toast" style={styles.toast} pointerEvents="box-none">
      <View style={[styles.toastAccent, { backgroundColor: accent }]} />
      <View style={styles.toastBody}>
        <Text style={styles.toastTitle}>{title}</Text>
        {message ? <Text style={styles.toastMessage}>{message}</Text> : null}
        {actionLabel && onAction ? (
          <TouchableOpacity style={styles.toastAction} onPress={onAction} activeOpacity={0.8}>
            <Text style={[styles.toastActionText, { color: accent }]}>{actionLabel}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  surface: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },

  statTile: {
    flex: 1,
    minHeight: 96,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    justifyContent: 'center',
  },
  statTileHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statTileDot: { width: 7, height: 7, borderRadius: 3.5 },
  statTileLabel: {
    color: colors.textBody,
    fontSize: fontSize.sm,
    fontWeight: '700',
    letterSpacing: 0.6,
    flexShrink: 1,
  },
  statTileValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 6 },
  // KPI 主数值 —— 卡片的绝对视觉中心
  statTileValue: { fontSize: fontSize.metric, fontWeight: '800', letterSpacing: -1 },
  statTileUnit: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  statTileHint: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 4 },

  toggleHit: { padding: 6 },
  toggleTrack: {
    width: 48,
    height: 28,
    borderRadius: radius.pill,
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  toggleGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.accent,
  },
  toggleThumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
  },
  pillDot: { width: 5, height: 5, borderRadius: 3 },
  pillText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.6 },

  toast: {
    position: 'absolute',
    // 固定在右下角 —— 绝不能遮挡顶栏右侧的全局操作按钮
    bottom: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.cardSolid,
    borderWidth: 1,
    borderColor: colors.warn,
    maxWidth: 360,
  },
  toastAccent: { width: 3 },
  toastBody: { padding: spacing.md, gap: 4, flexShrink: 1, pointerEvents: 'auto' },
  toastTitle: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '800' },
  toastMessage: { color: colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  toastAction: { marginTop: 4, alignSelf: 'flex-start' },
  toastActionText: { fontSize: fontSize.xs, fontWeight: '800' },
});
