import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  OverviewAnalytics,
  SmartAlert,
  describeCloudError,
  fetchOverviewAnalytics,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';

/**
 * 智能风控告警中心 + 场景 A/B 费用拆解（阶段十七 P1）。
 *
 * 两件事放在一块，因为它们回答的是同一个问题：**我花的钱去了哪、有没有风险**。
 *
 * 1. **场景 A vs 场景 B**（买家最关心的"多付的那部分钱是哪来的"）：
 *    - **场景 A** = 开源基础模型（无创作者版税）⇒ 实付 = 算力基价；
 *    - **场景 B** = 社区创作者模型（含 15% 版税）⇒ 实付 = 基价 × (1 + 版税率)。
 *    面板给出**费用占比条**、Token 占比、调用次数与场景 B 累计产生的版税。
 *
 * 2. **实时智能告警**（服务端统一口径，前端只渲染徽章）：
 *    - `low_balance` —— 可用余额 < $5.00；
 *    - `daily_limit_near` —— 今日消费 ≥ 单日限额 80%；
 *    - `key_frozen` —— 当前 Key 被冻结；
 *    - `node_overheat` —— 节点 GPU 温度 ≥ 75°C；
 *    - `node_offline` —— 节点离线。
 *
 * ⚠️ **不带 Key 也能看**：服务端在无有效凭证时只返回**全网公开基准**
 * （不含任何账户信息），所以首屏不会空着。
 */

const ALERT_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  low_balance: { label: '余额告警', color: colors.danger, bg: colors.dangerSoft },
  daily_limit_near: { label: '限额预警', color: colors.warn, bg: colors.warnSoft },
  key_frozen: { label: '密钥冻结', color: colors.warn, bg: colors.warnSoft },
  node_overheat: { label: '节点高温', color: colors.danger, bg: colors.dangerSoft },
  node_offline: { label: '节点离线', color: colors.textSecondary, bg: colors.cardAlt },
};

const REFRESH_INTERVAL_MS = 30000;

const pct = (v: number): string => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%`;

const SmartAlertCard: React.FC = () => {
  const apiKey = usePawStore((s) => s.apiKey);

  const [data, setData] = useState<OverviewAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ts, setTs] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOverviewAnalytics();
      setData(res);
      setTs(Date.now());
    } catch (e: unknown) {
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const a = data?.scenario_a;
  const b = data?.scenario_b;
  const alerts: SmartAlert[] = data?.alerts ?? [];
  const shareA = Number(a?.cost_share ?? 0);
  const shareB = Number(b?.cost_share ?? 0);
  const scoped = !!data?.scoped;

  return (
    <View style={styles.card} testID="smart-alert-card" id="apx-glass-smart-alert">
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>🔔 智能风控告警与场景 A/B 费用拆解</Text>
        </View>
        <TouchableOpacity
          onPress={() => void load()}
          activeOpacity={0.8}
          testID="smart-alert-refresh"
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.cyan} />
          ) : (
            <Text style={styles.chevron}>刷新 ⟳</Text>
          )}
        </TouchableOpacity>
      </View>

      <Text style={styles.subtitle} testID="smart-alert-scope">
        {scoped
          ? '账户口径 · 场景 A（开源基础模型 / 无版税） vs 场景 B（创作者版税模型）'
          : '全网公开基准 · 场景 A（开源基础模型 / 无版税） vs 场景 B（创作者版税模型）'}
      </Text>

      {/* ---- A/B 费用占比条 ---- */}
      <View style={styles.bar} testID="smart-alert-bar">
        <View style={[styles.barA, { flex: Math.max(shareA, 0.001) }]} />
        <View style={[styles.barB, { flex: Math.max(shareB, 0.001) }]} />
      </View>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.chartBase }]} />
          <Text style={styles.legendText}>
            场景 A {pct(shareA)} · ${Number(a?.cost_usd ?? 0).toFixed(6)}
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.chartCreator }]} />
          <Text style={styles.legendText}>
            场景 B {pct(shareB)} · ${Number(b?.cost_usd ?? 0).toFixed(6)}
          </Text>
        </View>
      </View>

      <View style={styles.kpiRow}>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>总消费</Text>
          <Text style={styles.kpiValue} testID="smart-alert-total-cost">
            ${Number(data?.total_cost_usd ?? 0).toFixed(6)}
          </Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>总 Token</Text>
          <Text style={styles.kpiValue} testID="smart-alert-total-tokens">
            {Number(data?.total_tokens ?? 0).toLocaleString()}
          </Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>调用次数</Text>
          <Text style={styles.kpiValue} testID="smart-alert-total-calls">
            {Number(data?.total_calls ?? 0)}
          </Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>场景 B 版税</Text>
          <Text style={[styles.kpiValue, { color: colors.chartCreator }]} testID="smart-alert-royalty">
            ${Number(b?.royalty_usd ?? 0).toFixed(6)}
          </Text>
        </View>
      </View>

      {scoped ? (
        <View style={styles.kpiRow}>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>可用余额</Text>
            <Text style={styles.kpiValue} testID="smart-alert-balance">
              ${Number(data?.balance_usd ?? 0).toFixed(4)}
            </Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>单日限额</Text>
            <Text style={styles.kpiValue} testID="smart-alert-limit">
              ${Number(data?.daily_limit_usd ?? 0).toFixed(2)}
            </Text>
          </View>
        </View>
      ) : null}

      {/* ---- 告警徽章 ---- */}
      <Text style={styles.sectionTitle}>实时告警（{alerts.length}）</Text>
      {error !== null ? (
        <Text style={styles.errorText} testID="smart-alert-error">
          ⚠️ {error}
        </Text>
      ) : alerts.length === 0 ? (
        <Text style={styles.okText} testID="smart-alert-none">
          ✓ 当前没有风险告警
        </Text>
      ) : (
        <View style={styles.alertList} testID="smart-alert-list">
          {alerts.map((alert, index) => {
            const style = ALERT_STYLE[alert.code] ?? {
              label: alert.code,
              color: colors.textSecondary,
              bg: colors.cardAlt,
            };
            return (
              <View
                key={`${alert.code}-${index}`}
                style={[styles.alertRow, { backgroundColor: style.bg, borderColor: style.color }]}
                testID={`smart-alert-item-${alert.code}`}
              >
                <Text style={[styles.alertBadge, { color: style.color }]}>{style.label}</Text>
                <Text style={styles.alertText}>{alert.message}</Text>
              </View>
            );
          })}
        </View>
      )}

      {ts ? (
        <Text style={styles.footer}>
          更新于 {new Date(ts).toLocaleTimeString()} · 每 {REFRESH_INTERVAL_MS / 1000}s 自动刷新
          {apiKey ? '' : ' · 配置 API Key 后可看到账户口径'}
        </Text>
      ) : null}
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  titleDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.cyan },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800', flexShrink: 1 },
  chevron: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.xs },

  bar: {
    flexDirection: 'row',
    height: 12,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginTop: spacing.md,
    backgroundColor: colors.cardAlt,
  },
  barA: { backgroundColor: colors.chartBase, height: 12 },
  barB: { backgroundColor: colors.chartCreator, height: 12 },

  legendRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.textSecondary, fontSize: fontSize.xs, fontFamily: monoFont },

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  kpi: {
    flexGrow: 1,
    flexBasis: 120,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  kpiLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  kpiValue: {
    color: colors.textPrimary,
    fontSize: fontSize.md,
    fontWeight: '800',
    fontFamily: monoFont,
    marginTop: 2,
  },

  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '800',
    marginTop: spacing.md,
  },
  alertList: { gap: 6, marginTop: spacing.xs },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  alertBadge: { fontSize: fontSize.xs, fontWeight: '800' },
  alertText: { color: colors.textBody, fontSize: fontSize.xs, flex: 1, lineHeight: 17 },
  okText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700', marginTop: spacing.xs },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },
  footer: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.md },
});

export default SmartAlertCard;
