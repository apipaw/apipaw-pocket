import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, spacing } from '../theme';

const THUMB_SIZE = 22;

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** 轨道上方标题 */
  label?: string;
  /** 右上角数值展示 */
  formatValue?: (value: number) => string;
  /** 轨道下方辅助说明 */
  hint?: string;
  /** 底部左右刻度文案 */
  scaleLabels?: [string, string];
  /** 轨道主色 */
  accentColor?: string;
  /** 轨道底色 */
  trackColor?: string;
  testID?: string;
  trackTestID?: string;
  thumbTestID?: string;
}

/**
 * 通用可视化滑块。
 * RN 0.88 已移除核心 Slider 组件，这里基于 PanResponder 自绘，
 * 并通过 onStartShouldSetPanResponderCapture 抢占父级 ScrollView 的手势，
 * 保证在 Expo Web 与原生端都能稳定拖动。
 */
const Slider: React.FC<SliderProps> = ({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  formatValue,
  hint,
  scaleLabels,
  accentColor = colors.accent,
  trackColor = colors.divider,
  testID,
  trackTestID,
  thumbTestID,
}) => {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  // 按下瞬间的锚点值 —— 拖动过程中不可被外部 value 更新覆盖，否则手势会漂移
  const anchorRef = useRef(value);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  const clamp = (raw: number): number => {
    const bounded = Math.min(max, Math.max(min, raw));
    const stepped = Math.round(bounded / step) * step;
    // 修正浮点误差（例如 step=0.5 时 3.0000000000000004）
    const decimals = (String(step).split('.')[1] || '').length;
    return Number(stepped.toFixed(decimals));
  };

  // PanResponder 必须保持引用稳定 —— 若随 value 变化重建，Web 端手势状态会被重置导致拖不动
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // 抢占父级 ScrollView 的手势, 保证滑块在 Web / 原生端都能拖动
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderGrant: () => {
          anchorRef.current = valueRef.current;
          setDragging(true);
        },
        onPanResponderMove: (_evt, gesture) => {
          const usable = Math.max(1, trackWidth - THUMB_SIZE);
          const next = anchorRef.current + (gesture.dx / usable) * (max - min);
          onChangeRef.current(clamp(next));
        },
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackWidth, min, max, step],
  );

  const usableWidth = Math.max(1, trackWidth - THUMB_SIZE);
  const progress = max > min ? (value - min) / (max - min) : 0;
  const thumbLeft = Math.max(0, Math.min(usableWidth, progress * usableWidth));

  return (
    <View testID={testID}>
      {(label || formatValue) && (
        <View style={styles.header}>
          {label ? <Text style={styles.label}>{label}</Text> : <View />}
          {formatValue ? <Text style={[styles.value, { color: accentColor }]}>{formatValue(value)}</Text> : null}
        </View>
      )}

      <View
        style={styles.touchArea}
        testID={trackTestID}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        {...panResponder.panHandlers}
      >
        <View style={[styles.track, { backgroundColor: trackColor }]}>
          <View
            style={[
              styles.fill,
              { width: thumbLeft + THUMB_SIZE / 2, backgroundColor: accentColor },
            ]}
          />
        </View>
        <View
          testID={thumbTestID}
          style={[
            styles.thumb,
            dragging && styles.thumbActive,
            { left: thumbLeft, borderColor: accentColor },
          ]}
        />
      </View>

      {scaleLabels && (
        <View style={styles.scale}>
          <Text style={styles.scaleText}>{scaleLabels[0]}</Text>
          <Text style={styles.scaleText}>{scaleLabels[1]}</Text>
        </View>
      )}

      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  label: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  value: { fontSize: fontSize.lg, fontWeight: '800' },
  touchArea: { height: 40, justifyContent: 'center' },
  track: {
    height: 8,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginHorizontal: THUMB_SIZE / 2,
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    opacity: 0.35,
  },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: colors.textPrimary,
    borderWidth: 3,
  },
  thumbActive: { transform: [{ scale: 1.15 }] },
  scale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  scaleText: { color: colors.textMuted, fontSize: 10 },
  hint: { color: colors.textMuted, fontSize: 10, marginTop: spacing.sm },
});

export default Slider;
