import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LeaderboardNode, describeCloudError, fetchNodeLeaderboard } from '../api/cloudClient';
import { useVisibilityInterval } from '../hooks/useVisibilityInterval';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 全网算力节点**贡献排行榜**（阶段十 P2 · 公开端点）。
 *
 * 回答「谁在真正出活」—— 这不是营销榜，是**可核对的生产记录**：
 *   - 请求数 / tokens  ← `node_qos_metrics`（真实推理的事实表）
 *   - 首字延迟 / 吐字速度 ← 同一张表（均值 + 峰值）
 *   - 累计分账收益 ← `revenue_ledger.node_share_usd`（**9 位小数**）
 *   - 信用分 ← `node_reliability`
 *
 * 脱敏口径：只回**产能与贡献**，不含钱包地址、密钥、买家身份。
 */
const REFRESH_MS = 30000;

/** 收益金额：9 位小数（0.0073 这类小份额截断即失真） */
const fmtUsd9 = (v: number | undefined | null): string => {
  const n = Number(v ?? 0);
  const trimmed = n.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  const parts = trimmed.split('.');
  if (parts.length === 1) return `$${parts[0]}.00`;
  return `$${parts[0]}.${parts[1].padEnd(2, '0')}`;
};

const NodeLeaderboardCard: React.FC = () => {
  const [rows, setRows] = useState<LeaderboardNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchNodeLeaderboard(20);
      setRows(res.nodes ?? []);
      setError(null);
    } catch (e: unknown) {
      // 排行榜是"加分项"：拉不到不该把整页拖垮
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 阶段二十四 P1 · 可见性感知轮询（后台停表，回前台补刷一次）
  useEffect(() => {
    void load();
  }, [load]);
  useVisibilityInterval(() => {
    void load();
  }, REFRESH_MS);

  return (
    <View style={styles.card} testID="node-leaderboard-card" id="apx-glass-node-leaderboard">
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>全网算力节点排行榜</Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => void load()}
          activeOpacity={0.75}
          testID="node-leaderboard-refresh"
        >
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.subtitle}>
        LIVE NODE CONTRIBUTION · 每 30 秒自动刷新 · 收益 9 位小数
      </Text>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={styles.loadingText}>正在读取全网节点产能…</Text>
        </View>
      ) : error ? (
        <Text style={styles.errorText}>⚠️ {error}</Text>
      ) : rows.length === 0 ? (
        <Text style={styles.emptyText} testID="node-leaderboard-empty">
          暂无节点贡献记录（节点完成第一笔真实推理后这里就会亮起来）
        </Text>
      ) : (
        rows.map((node, idx) => (
          <View
            key={node.node_id}
            style={styles.row}
            testID={`node-leaderboard-row-${idx}`}
          >
            <View style={styles.rowHead}>
              <View style={styles.rankWrap}>
                <Text style={styles.rank}>#{idx + 1}</Text>
                <View
                  style={[
                    styles.dot,
                    {
                      backgroundColor: node.online
                        ? colors.accent
                        : node.is_paused
                          ? colors.danger
                          : colors.textMuted,
                    },
                  ]}
                />
                <Text style={styles.nodeId} numberOfLines={1}>
                  {node.node_id}
                </Text>
              </View>
              <Text style={styles.share}>{fmtUsd9(node.total_node_share_usd)}</Text>
            </View>

            <View style={styles.kvGrid}>
              <Text style={styles.kv}>
                完成请求 <Text style={styles.kvStrong}>{node.requests ?? 0}</Text>
              </Text>
              <Text style={styles.kv}>
                累计 tokens <Text style={styles.kvStrong}>{node.tokens ?? 0}</Text>
              </Text>
              <Text style={styles.kv}>
                均 TTFT{' '}
                <Text style={styles.kvStrong}>
                  {node.avg_ttft_ms != null ? `${node.avg_ttft_ms.toFixed(0)}ms` : '—'}
                </Text>
              </Text>
              <Text style={styles.kv}>
                均吞吐{' '}
                <Text style={styles.kvStrong}>
                  {node.avg_throughput_tps != null
                    ? `${node.avg_throughput_tps.toFixed(1)} tok/s`
                    : '—'}
                </Text>
              </Text>
              <Text style={styles.kv}>
                峰值吐字{' '}
                <Text style={styles.kvStrong}>
                  {node.peak_throughput_tps != null
                    ? `${node.peak_throughput_tps.toFixed(1)} tok/s`
                    : '—'}
                </Text>
              </Text>
              <Text style={styles.kv}>
                信用分 <Text style={styles.kvStrong}>{(node.credit_score ?? 0).toFixed(2)}</Text>
              </Text>
            </View>

            {node.models && node.models.length > 0 ? (
              <Text style={styles.models} numberOfLines={1}>
                可服务：{node.models.join('、')}
              </Text>
            ) : null}
          </View>
        ))
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
  titleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.purple,
    shadowColor: colors.purple,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  refreshBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  refreshBtnText: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    letterSpacing: 0.8,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  loadingText: { color: colors.textSecondary, fontSize: fontSize.xs },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.md, lineHeight: 17 },

  row: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: 4,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  rankWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  rank: { color: colors.purple, fontSize: fontSize.xs, fontWeight: '800' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  nodeId: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontWeight: '800',
    fontFamily: 'monospace',
    flexShrink: 1,
  },
  share: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '800', fontFamily: 'monospace' },
  kvGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
    gap: spacing.sm,
  },
  kv: { color: colors.textMuted, fontSize: fontSize.xs },
  kvStrong: { color: colors.textBody, fontWeight: '800' },
  models: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 4 },
});

export default NodeLeaderboardCard;
