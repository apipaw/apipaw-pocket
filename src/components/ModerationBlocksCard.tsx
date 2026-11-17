import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  ModerationBlocksResponse,
  describeCloudError,
  fetchOwnerModerationBlocks,
} from '../api/cloudClient';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';

/**
 * 网关**内容安全拦截器**看板（阶段十七 P2 · 业主视角）。
 *
 * 网关在**预扣费之前**扫描 Prompt，命中高危特征（越狱 / 系统命令注入 /
 * 凭据外泄 / 测试标记）立即 400 `content_policy_violation` ——
 * **绝不产生任何预扣或扣费流水**。
 *
 * 这里给业主看三件事：
 *   1. 累计拦截数（网关自上线以来）；
 *   2. 当前规则表与开关状态；
 *   3. 最近拦截明细（账户 / 规则 / 片段 / 时间）。
 */

const fmtTime = (ts: number): string => {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const ModerationBlocksCard: React.FC = () => {
  const [data, setData] = useState<ModerationBlocksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchOwnerModerationBlocks(20);
      setData(res);
    } catch (e: unknown) {
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.card} testID="moderation-blocks-card" id="apx-glass-moderation">
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>🛡️ 网关内容安全拦截器</Text>
        </View>
        <TouchableOpacity onPress={() => void load()} activeOpacity={0.8} testID="moderation-refresh">
          {loading ? (
            <ActivityIndicator size="small" color={colors.cyan} />
          ) : (
            <Text style={styles.chevron}>刷新 ⟳</Text>
          )}
        </TouchableOpacity>
      </View>

      <Text style={styles.subtitle}>
        命中即 400 拦截，排在**预扣费之前** ⇒ 一律零扣费、零流水
      </Text>

      {error !== null ? (
        <Text style={styles.errorText} testID="moderation-error">
          ⚠️ {error}
        </Text>
      ) : (
        <>
          <View style={styles.kpiRow}>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>累计拦截</Text>
              <Text style={styles.kpiValue} testID="moderation-total">
                {Number(data?.total ?? 0)}
              </Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>拦截器状态</Text>
              <Text
                style={[
                  styles.kpiValue,
                  { color: data?.enabled ? colors.accent : colors.textMuted },
                ]}
                testID="moderation-enabled"
              >
                {data?.enabled ? '已启用' : '已停用'}
              </Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiLabel}>规则数</Text>
              <Text style={styles.kpiValue}>{Number(data?.rules?.length ?? 0)}</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>最近拦截明细</Text>
          {(data?.recent?.length ?? 0) === 0 ? (
            <Text style={styles.hint} testID="moderation-empty">
              暂无拦截记录 —— 网关运行正常
            </Text>
          ) : (
            (data?.recent ?? []).map((row) => (
              <View key={row.id} style={styles.row} testID={`moderation-row-${row.id}`}>
                <View style={styles.rowHead}>
                  <Text style={styles.rowRule}>{row.rule}</Text>
                  <Text style={styles.rowTime}>{fmtTime(row.created_at)}</Text>
                </View>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  账户 {row.account_handle || '—'} · 模型 {row.model_id || '—'} · IP {row.client_ip || '—'}
                </Text>
                {row.snippet ? (
                  <Text style={styles.rowSnippet} numberOfLines={2}>
                    {row.snippet}
                  </Text>
                ) : null}
              </View>
            ))
          )}
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  chevron: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.xs },

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  kpi: {
    flexGrow: 1,
    flexBasis: 100,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  kpiLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  kpiValue: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: '800',
    fontFamily: monoFont,
    marginTop: 2,
  },

  sectionTitle: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '800', marginTop: spacing.md },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.xs },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },

  row: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginTop: 4,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowRule: { color: colors.warn, fontSize: fontSize.xs, fontWeight: '800', fontFamily: monoFont },
  rowTime: { color: colors.textMuted, fontSize: fontSize.xs },
  rowMeta: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  rowSnippet: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: monoFont, marginTop: 2 },
});

export default ModerationBlocksCard;
