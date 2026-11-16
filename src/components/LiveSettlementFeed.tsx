import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { RecentSettlement, describeCloudError, fetchRecentSettlements } from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 全网实时推理与三方分账公示（阶段九 P0）。
 *
 * 这块面板回答全网所有人都会问、却从没人正面回答的问题：
 * **「你付的钱，到底分给了谁？」**
 *
 * 每行是一笔**已结算**的真实推理（数据源 `revenue_ledger` LEFT JOIN `usage_logs`），
 * 逐笔给出：模型、节点、首字延迟、吐字速度，以及
 * 买家实付 / 节点分成 / 创作者版税 / 平台管理费 **四方金额**。
 *
 * 口径说明（写在这里是为了让读者知道**哪些数字可以被核对**）：
 * - `request_id` 由服务端脱敏（只回末段前 8 位），公开端点不回吐可回溯的原始标识；
 * - 不含买家账号、钱包地址与任何提示词/回复内容；
 * - 金额单位 USD，分成金额之和恒等于买家实付（后端账本守恒）。
 */
const REFRESH_MS = 20000;

const fmtUsd = (v: number | undefined | null): string => {
  const n = Number(v ?? 0);
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${n.toFixed(4)}`;
};

const LiveSettlementFeed: React.FC = () => {
  const [rows, setRows] = useState<RecentSettlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetchRecentSettlements(20);
      setRows(res.settlements ?? []);
      setNote(res.note ?? '');
      setError(null);
    } catch (e: unknown) {
      // 公示栏是「加分项」：拉不到不该把整页拖垮，只在面板里提示。
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <View style={styles.card} testID="live-settle-card" id="apx-glass-live-settle">
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>全网实时推理与三方分账公示</Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => void load()}
          activeOpacity={0.75}
          testID="live-settle-refresh"
        >
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.subtitle}>LIVE DePIN SETTLEMENTS · 每 20 秒自动刷新</Text>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={styles.loadingText}>正在读取全网结算流水...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </View>
      ) : rows.length === 0 ? (
        <Text style={styles.emptyText} testID="live-settle-empty">
          暂无已结算的推理记录（网关完成第一笔真实推理后这里就会亮起来）
        </Text>
      ) : (
        <>
          {rows.map((row, idx) => (
            <View
              key={`${row.request_id}-${idx}`}
              style={styles.row}
              testID={`live-settle-row-${idx}`}
            >
              <View style={styles.rowHead}>
                <Text style={styles.modelId} numberOfLines={1}>
                  {row.model_id || '未知模型'}
                </Text>
                <Text style={styles.rid}>{row.request_id}</Text>
              </View>

              <View style={styles.metaRow}>
                <Text style={styles.metaText} numberOfLines={1}>
                  节点 {row.node_id || '—'} · {row.model_tier || '—'}
                </Text>
                <Text style={styles.perfText}>
                  {row.ttft_ms != null ? `${row.ttft_ms.toFixed(0)}ms` : '—'} /{' '}
                  {row.throughput_tps != null ? `${row.throughput_tps.toFixed(1)} tok/s` : '—'}
                </Text>
              </View>

              <View style={styles.shareRow}>
                <View style={styles.shareCell}>
                  <Text style={styles.shareLabel}>买家实付</Text>
                  <Text style={[styles.shareValue, styles.shareGross]}>{fmtUsd(row.gross_usd)}</Text>
                </View>
                <View style={styles.shareCell}>
                  <Text style={styles.shareLabel}>节点分成</Text>
                  <Text style={[styles.shareValue, styles.shareNode]}>{fmtUsd(row.node_share_usd)}</Text>
                </View>
                <View style={styles.shareCell}>
                  <Text style={styles.shareLabel}>创作者版税</Text>
                  <Text style={[styles.shareValue, styles.shareCreator]}>
                    {fmtUsd(row.creator_share_usd)}
                  </Text>
                </View>
                <View style={styles.shareCell}>
                  <Text style={styles.shareLabel}>平台管理费</Text>
                  <Text style={[styles.shareValue, styles.sharePlatform]}>
                    {fmtUsd(row.platform_fee_usd)}
                  </Text>
                </View>
              </View>

              <Text style={styles.footText}>
                {row.prompt_tokens}/{row.completion_tokens} tokens
                {row.royalty_rate != null ? ` · 版税率 ${(row.royalty_rate * 100).toFixed(0)}%` : ''}
                {row.usage_source ? ` · ${row.usage_source}` : ''}
              </Text>
            </View>
          ))}
          {note ? <Text style={styles.noteText}>{note}</Text> : null}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
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
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  refreshBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  refreshBtnText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    letterSpacing: 0.8,
    marginTop: 4,
    marginBottom: spacing.md,
  },

  row: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  modelId: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '800', flexShrink: 1 },
  rid: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: 'monospace' },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    gap: spacing.sm,
  },
  metaText: { color: colors.textSecondary, fontSize: fontSize.xs, flexShrink: 1 },
  perfText: { color: colors.cyan, fontSize: fontSize.xs, fontFamily: 'monospace' },

  shareRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  shareCell: { flex: 1, gap: 2 },
  shareLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  shareValue: { fontSize: fontSize.sm, fontWeight: '800', fontFamily: 'monospace' },
  shareGross: { color: colors.textPrimary },
  shareNode: { color: colors.accent },
  shareCreator: { color: colors.purple },
  sharePlatform: { color: colors.cyan },

  footText: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.sm },
  noteText: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.xs },

  loadingWrap: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  loadingText: { color: colors.textSecondary, fontSize: fontSize.xs },
  errorWrap: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs, paddingVertical: spacing.md },
});

export default LiveSettlementFeed;
