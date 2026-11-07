import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { usePawStore } from '../store/usePawStore';
import {
  AnalyticsResponse,
  AnalyticsTier,
  describeCloudError,
  fetchAnalytics,
  updateDailyLimit,
} from '../api/cloudClient';
import Slider from './Slider';
import { colors, fontSize, radius, spacing } from '../theme';

// ----------------- 常量 -----------------
const CHART_HEIGHT = 156;
const CHART_PADDING_LEFT = 38;
const CHART_PADDING_RIGHT = 10;
const CHART_PADDING_TOP = 12;
const CHART_PADDING_BOTTOM = 24;

const MIN_LIMIT_USD = 10;
const MAX_LIMIT_USD = 500;
const LIMIT_STEP_USD = 10;

/**
 * 仅把外部回填的限额收敛到滑块可表示区间，不做取整 ——
 * 服务端存量值可能是任意数（后端只校验 [10,500]），取整会让显示值与真实值不一致。
 * 用户拖动产生的步进取整由 Slider 内部的 clamp 负责。
 */
const boundLimit = (value: number): number =>
  Math.min(MAX_LIMIT_USD, Math.max(MIN_LIMIT_USD, value));

// ----------------- 24 小时 Token 折线图 -----------------

interface TokenLineChartProps {
  data: AnalyticsResponse | null;
  width: number;
}

const TokenLineChart: React.FC<TokenLineChartProps> = ({ data, width }) => {
  const hours = data?.hours ?? [];
  const innerW = Math.max(1, width - CHART_PADDING_LEFT - CHART_PADDING_RIGHT);
  const innerH = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

  const maxValue = useMemo(() => {
    const values = hours.flatMap((h) => [h.prompt_tokens, h.completion_tokens]);
    const max = Math.max(1, ...values);
    const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    return Math.ceil(max / magnitude) * magnitude;
  }, [hours]);

  const xAt = (index: number) =>
    CHART_PADDING_LEFT + (hours.length <= 1 ? 0 : (index / (hours.length - 1)) * innerW);
  const yAt = (value: number) => CHART_PADDING_TOP + innerH - (value / maxValue) * innerH;

  const buildPath = (pick: (h: AnalyticsResponse['hours'][number]) => number): string => {
    if (hours.length === 0) return '';
    return hours
      .map((h, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(pick(h)).toFixed(2)}`)
      .join(' ');
  };

  const buildArea = (pick: (h: AnalyticsResponse['hours'][number]) => number): string => {
    if (hours.length === 0) return '';
    const baseY = (CHART_PADDING_TOP + innerH).toFixed(2);
    const firstX = xAt(0).toFixed(2);
    const lastX = xAt(hours.length - 1).toFixed(2);
    return `${buildPath(pick)} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;
  };

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maxValue * ratio));

  return (
    <Svg width={width} height={CHART_HEIGHT}>
      {gridValues.map((value) => {
        const y = yAt(value);
        return (
          <React.Fragment key={`grid-${value}`}>
            <Line
              x1={CHART_PADDING_LEFT}
              y1={y}
              x2={CHART_PADDING_LEFT + innerW}
              y2={y}
              stroke={colors.chartGrid}
              strokeWidth={1}
            />
            <SvgText
              x={CHART_PADDING_LEFT - 6}
              y={y + 3.5}
              fill={colors.textMuted}
              fontSize={9}
              textAnchor="end"
            >
              {value >= 1000 ? `${Math.round(value / 1000)}k` : `${value}`}
            </SvgText>
          </React.Fragment>
        );
      })}

      <Path d={buildArea((h) => h.completion_tokens)} fill="rgba(16,185,129,0.12)" />
      <Path
        d={buildPath((h) => h.prompt_tokens)}
        stroke={colors.chartPrompt}
        strokeWidth={2}
        fill="none"
        strokeLinejoin="round"
      />
      <Path
        d={buildPath((h) => h.completion_tokens)}
        stroke={colors.chartCompletion}
        strokeWidth={2}
        fill="none"
        strokeLinejoin="round"
      />

      {hours.length > 0 && (
        <>
          <Circle
            cx={xAt(hours.length - 1)}
            cy={yAt(hours[hours.length - 1].prompt_tokens)}
            r={3}
            fill={colors.chartPrompt}
          />
          <Circle
            cx={xAt(hours.length - 1)}
            cy={yAt(hours[hours.length - 1].completion_tokens)}
            r={3}
            fill={colors.chartCompletion}
          />
        </>
      )}

      {hours.map((h, i) =>
        i % 6 === 0 ? (
          <SvgText
            key={`x-${h.index}`}
            x={xAt(i)}
            y={CHART_HEIGHT - 6}
            fill={colors.textMuted}
            fontSize={9}
            textAnchor="middle"
          >
            {h.label}
          </SvgText>
        ) : null,
      )}
    </Svg>
  );
};

// ----------------- 场景占比环形图 -----------------

interface TierDonutProps {
  tiers: AnalyticsTier[];
  size?: number;
}

/** 极坐标换算: 0° 指向正上方, 顺时针增长 */
const polar = (cx: number, cy: number, r: number, angleDeg: number) => {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
};

/** 生成环形扇区路径 (避免使用 transform/rotation 属性, 兼容 Web DOM) */
const donutSegment = (
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number,
): string => {
  const p1 = polar(cx, cy, outerR, startAngle);
  const p2 = polar(cx, cy, outerR, endAngle);
  const p3 = polar(cx, cy, innerR, endAngle);
  const p4 = polar(cx, cy, innerR, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    'Z',
  ].join(' ');
};

const TierDonut: React.FC<TierDonutProps> = ({ tiers, size = 132 }) => {
  const thickness = 18;
  const outerR = size / 2;
  const innerR = outerR - thickness;
  const cx = size / 2;
  const cy = size / 2;
  const total = tiers.reduce((sum, t) => sum + t.cost_usd, 0);

  const segments = useMemo(() => {
    if (total <= 0) return [];
    const gap = 2; // 扇区间隙 (角度)
    let cursor = 0;
    return tiers
      .filter((tier) => tier.cost_usd > 0)
      .map((tier) => {
        const sweep = (tier.cost_usd / total) * 360;
        const start = cursor + gap / 2;
        const end = cursor + sweep - gap / 2;
        cursor += sweep;
        if (end <= start) return null;
        return {
          tier,
          path: donutSegment(cx, cy, outerR, innerR, start, end),
        };
      })
      .filter(Boolean) as Array<{ tier: AnalyticsTier; path: string }>;
  }, [tiers, total, cx, cy, outerR, innerR]);

  return (
    <View style={styles.donutWrap}>
      <Svg width={size} height={size}>
        {total <= 0 ? (
          <Circle
            cx={cx}
            cy={cy}
            r={(outerR + innerR) / 2}
            stroke={colors.divider}
            strokeWidth={thickness}
            fill="none"
          />
        ) : (
          segments.map((segment) => (
            <Path
              key={segment.tier.tier}
              d={segment.path}
              fill={segment.tier.tier === 'CREATOR' ? colors.chartCreator : colors.chartBase}
            />
          ))
        )}
      </Svg>
      <View style={styles.donutCenter} pointerEvents="none">
        <Text style={styles.donutValue}>${total.toFixed(3)}</Text>
        <Text style={styles.donutLabel}>24h 总支出</Text>
      </View>
    </View>
  );
};

// ----------------- 可视化限额滑块 -----------------

interface LimitSliderProps {
  value: number;
  spentToday: number;
  syncState: 'idle' | 'syncing' | 'done' | 'error';
  onChange: (value: number) => void;
}

const LimitSlider: React.FC<LimitSliderProps> = ({ value, spentToday, syncState, onChange }) => {
  const usageRatio = value > 0 ? Math.min(1, spentToday / value) : 0;

  return (
    <View>
      <Slider
        testID="limit-slider"
        trackTestID="limit-slider-track"
        thumbTestID="limit-slider-thumb"
        label="单日 API Key 消费上限"
        value={value}
        min={MIN_LIMIT_USD}
        max={MAX_LIMIT_USD}
        step={LIMIT_STEP_USD}
        onChange={onChange}
        formatValue={(v) => `$${v}/日`}
        scaleLabels={[`$${MIN_LIMIT_USD}`, `$${MAX_LIMIT_USD}`]}
      />

      {usageRatio > 0 && (
        <View style={styles.sliderUsageBar}>
          <View style={[styles.sliderUsageFill, { width: `${usageRatio * 100}%` }]} />
        </View>
      )}

      <View style={styles.sliderFooter}>
        <Text style={styles.sliderHint}>
          今日已用 ${spentToday.toFixed(4)} · 剩余 ${Math.max(0, value - spentToday).toFixed(2)}
        </Text>
        {syncState === 'syncing' && <Text style={styles.syncSyncing}>同步中...</Text>}
        {syncState === 'done' && <Text style={styles.syncDone}>✓ 已同步至网关</Text>}
        {syncState === 'error' && <Text style={styles.syncError}>✕ 同步失败</Text>}
      </View>
    </View>
  );
};

// ----------------- 主组件 -----------------

const AnalyticsCard: React.FC = () => {
  const { dailyLimitUsd, setDailyLimitUsd, spentTodayUsd, setSpentTodayUsd } = usePawStore();

  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(320);
  const [limit, setLimit] = useState(boundLimit(dailyLimitUsd));
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');

  /**
   * 限额变更来源标记：只有用户拖动滑块才允许回写网关。
   * 外部回填（App 拉取账户信息 / PUT 响应）若触发 PUT，会把服务端限额静默改写。
   */
  const limitFromUserRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchAnalytics(24);
      setData(res);
      if (typeof res.totals?.cost_usd === 'number') {
        setSpentTodayUsd(res.totals.cost_usd);
      }
    } catch (e: any) {
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 外部（如 App 拉取账户信息）更新限额时只回填滑块显示，绝不回写网关
  useEffect(() => {
    limitFromUserRef.current = false;
    setLimit(boundLimit(dailyLimitUsd));
  }, [dailyLimitUsd]);

  const handleLimitChange = useCallback((value: number) => {
    limitFromUserRef.current = true;
    setLimit(value);
  }, []);

  // 滑动后自动同步至后端数据库（防抖 450ms）—— 仅限用户主动拖动
  useEffect(() => {
    if (!limitFromUserRef.current) {
      limitFromUserRef.current = false;
      return;
    }
    limitFromUserRef.current = false;
    setSyncState('syncing');
    const timer = setTimeout(async () => {
      try {
        const res = await updateDailyLimit(limit);
        setDailyLimitUsd(res.daily_limit_usd);
        setSyncState('done');
        setTimeout(() => setSyncState((s) => (s === 'done' ? 'idle' : s)), 2000);
      } catch {
        setSyncState('error');
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [limit, setDailyLimitUsd]);

  const tiers = data?.tiers ?? [];
  const totals = data?.totals;

  return (
    <View style={styles.card} testID="analytics-card" id="apx-glass-analytics">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>流量分析与额度管理</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load} activeOpacity={0.75}>
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在拉取 24 小时消耗数据...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorHint}>请确认云端网关 cloud.apipaw.com 可达，且 API Key 有效</Text>
        </View>
      ) : (
        <>
          {/* 概览指标 */}
          <View style={styles.metricRow}>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Prompt Tokens</Text>
              <Text style={styles.metricValue}>{totals?.prompt_tokens.toLocaleString() ?? '0'}</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>Completion Tokens</Text>
              <Text style={styles.metricValue}>
                {totals?.completion_tokens.toLocaleString() ?? '0'}
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>24h 花费</Text>
              <Text style={[styles.metricValue, styles.metricValueAccent]}>
                ${totals?.cost_usd.toFixed(4) ?? '0.0000'}
              </Text>
              <Text style={styles.metricSub}>{totals?.cgas.toFixed(0) ?? '0'} CGas</Text>
            </View>
          </View>

          {/* 24 小时折线图 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>24 小时 Token 消耗曲线</Text>
            <View
              style={styles.chartBox}
              onLayout={(e) => setChartWidth(e.nativeEvent.layout.width)}
            >
              <TokenLineChart data={data} width={chartWidth} />
            </View>
            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.chartPrompt }]} />
                <Text style={styles.legendText}>Prompt Tokens</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.chartCompletion }]} />
                <Text style={styles.legendText}>Completion Tokens</Text>
              </View>
              <Text style={styles.legendRequests}>请求 {totals?.requests ?? 0} 次</Text>
            </View>
          </View>

          {/* 支出占比 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>支出占比 · 结算场景分布</Text>
            <View style={styles.donutRow}>
              <TierDonut tiers={tiers} />
              <View style={styles.tierList}>
                {tiers.map((tier) => (
                  <View key={tier.tier} style={styles.tierItem}>
                    <View style={styles.tierItemHeader}>
                      <View
                        style={[
                          styles.legendDot,
                          {
                            backgroundColor:
                              tier.tier === 'CREATOR' ? colors.chartCreator : colors.chartBase,
                          },
                        ]}
                      />
                      <Text style={styles.tierName}>{tier.label}</Text>
                    </View>
                    <View style={styles.tierBarTrack}>
                      <View
                        style={[
                          styles.tierBarFill,
                          {
                            width: `${Math.max(2, tier.ratio * 100)}%`,
                            backgroundColor:
                              tier.tier === 'CREATOR' ? colors.chartCreator : colors.chartBase,
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.tierMeta}>
                      {(tier.ratio * 100).toFixed(1)}% · ${tier.cost_usd.toFixed(4)} ·{' '}
                      {tier.share_note}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {data?.settlement && (
              <View style={styles.settlementBox}>
                <Text style={styles.settlementTitle}>结算拆解 (24h)</Text>
                <View style={styles.settlementRow}>
                  <Text style={styles.settlementLabel}>节点分成 85%</Text>
                  <Text style={styles.settlementValue}>
                    ${data.settlement.node_earn_usd.toFixed(4)}
                  </Text>
                </View>
                <View style={styles.settlementRow}>
                  <Text style={styles.settlementLabel}>创作者版税 15%</Text>
                  <Text style={[styles.settlementValue, styles.settlementValueCreator]}>
                    ${data.settlement.creator_royalty_usd.toFixed(4)}
                  </Text>
                </View>
                <View style={styles.settlementRow}>
                  <Text style={styles.settlementLabel}>平台服务费 15%</Text>
                  <Text style={styles.settlementValue}>
                    ${data.settlement.platform_fee_usd.toFixed(4)}
                  </Text>
                </View>
              </View>
            )}
          </View>

          {/* 限额滑块 */}
          <View style={styles.section}>
            <LimitSlider
              value={limit}
              spentToday={totals?.cost_usd ?? spentTodayUsd}
              syncState={syncState}
              onChange={handleLimitChange}
            />
          </View>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.cyan,
    shadowColor: colors.cyan,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  refreshBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  refreshBtnText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },

  loadingWrap: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  loadingText: { color: colors.textMuted, fontSize: fontSize.sm },
  errorWrap: { paddingVertical: spacing.lg, gap: spacing.sm },
  errorText: { color: colors.danger, fontSize: fontSize.sm },
  errorHint: { color: colors.textMuted, fontSize: fontSize.xs },

  metricRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  metricBox: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
  },
  metricLabel: { color: colors.textSecondary, fontSize: fontSize.xs, marginBottom: 4 },
  metricValue: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800' },
  metricValueAccent: { color: colors.accent },
  metricSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },

  section: { marginBottom: spacing.lg },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.md,
  },

  chartBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingVertical: spacing.sm,
    overflow: 'hidden',
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.textSecondary, fontSize: fontSize.sm },
  legendRequests: { color: colors.textMuted, fontSize: fontSize.xs, marginLeft: 'auto' },

  donutRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  donutWrap: { alignItems: 'center', justifyContent: 'center' },
  donutCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  donutValue: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  donutLabel: { color: colors.textMuted, fontSize: 12, marginTop: 2 },

  tierList: { flex: 1, gap: spacing.md },
  tierItem: { gap: 5 },
  tierItemHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tierName: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '700' },
  tierBarTrack: {
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.divider,
    overflow: 'hidden',
  },
  tierBarFill: { height: 7, borderRadius: radius.pill },
  tierMeta: { color: colors.textMuted, fontSize: 12 },

  settlementBox: {
    marginTop: spacing.md,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
    gap: 6,
  },
  settlementTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    marginBottom: 2,
  },
  settlementRow: { flexDirection: 'row', justifyContent: 'space-between' },
  settlementLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  settlementValue: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '700' },
  settlementValueCreator: { color: colors.chartCreator },

  sliderUsageBar: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.divider,
    overflow: 'hidden',
    marginTop: -spacing.sm,
    marginBottom: spacing.xs,
  },
  sliderUsageFill: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(245, 158, 11, 0.65)',
  },
  sliderFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  sliderHint: { color: colors.textMuted, fontSize: 12 },
  syncSyncing: { color: colors.warn, fontSize: 12, fontWeight: '700' },
  syncDone: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  syncError: { color: colors.danger, fontSize: 12, fontWeight: '700' },
});

export default AnalyticsCard;
