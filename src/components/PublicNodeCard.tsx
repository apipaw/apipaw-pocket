import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { PublicNode, describeCloudError, fetchPublicNodes } from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';
import { Pill, StatusDot } from './ui';

/**
 * 公开节点身份卡（阶段六 P3-5）。
 *
 * 买家可见的**最小可信身份视图**：节点名 / 硬件 / Agent 版本 / 等级 / 在离线 /
 * 可服务模型清单。**不含钱包地址、不含收益、不含任何凭证** —— 那是治理面板的事。
 *
 * 目的是把"在线算力节点"这个统计数字变成**可核验的清单**：
 * 买家能看见到底是哪几台机器在接单，而不是只看一个数字。
 */
const PublicNodeCard: React.FC = () => {
  const [nodes, setNodes] = useState<PublicNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchPublicNodes();
      setNodes(res.nodes ?? []);
    } catch (e: unknown) {
      setError(describeCloudError(e, 'key'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const online = nodes.filter((n) => n.alive).length;
  const visible = expanded ? nodes : nodes.slice(0, 4);

  return (
    <View style={styles.card} testID="public-node-card" id="apx-glass-public-nodes">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>算力节点身份</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load} activeOpacity={0.75}>
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在读取节点注册表...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </View>
      ) : nodes.length === 0 ? (
        <Text style={styles.emptyText}>节点注册表为空 —— 还没有节点登记上线</Text>
      ) : (
        <>
          <View style={styles.summaryRow}>
            <View style={styles.summaryBox}>
              <Text style={styles.summaryValue}>{online}</Text>
              <Text style={styles.summaryLabel}>心跳在线</Text>
            </View>
            <View style={styles.summaryBox}>
              <Text style={styles.summaryValue}>{nodes.length}</Text>
              <Text style={styles.summaryLabel}>登记节点</Text>
            </View>
            <View style={styles.summaryBox}>
              <Text style={styles.summaryValue}>
                {nodes.filter((n) => n.models && n.models.length > 0).length}
              </Text>
              <Text style={styles.summaryLabel}>可服务模型</Text>
            </View>
          </View>

          {visible.map((node) => (
            <View key={node.node_id} style={styles.nodeRow} testID={`public-node-${node.node_id}`}>
              <View style={styles.nodeHead}>
                <View style={styles.nodeHeadLeft}>
                  <Text style={styles.nodeName}>
                    {node.node_name || node.node_id}
                  </Text>
                  <Text style={styles.nodeMeta}>
                    {node.node_id}
                    {node.hardware_type ? ` · ${node.hardware_type}` : ''}
                    {node.agent_version ? ` · Agent ${node.agent_version}` : ''}
                  </Text>
                </View>
                <View style={styles.nodeHeadRight}>
                  <Pill
                    label={node.node_tier || 'C0'}
                    color={colors.purple}
                  />
                  <Pill
                    label={node.status_label || node.status || '未知'}
                    color={node.alive ? colors.accent : colors.textMuted}
                    dot
                  />
                </View>
              </View>

              <View style={styles.nodeStatRow}>
                <StatusDot
                  color={node.alive ? colors.accent : colors.textMuted}
                  variant={node.alive ? 'live' : 'static'}
                  size={6}
                />
                <Text style={styles.nodeStat}>
                  {node.alive ? '心跳在线' : '心跳离线'}
                  {node.vram_total_gb > 0 ? ` · 显存 ${node.vram_total_gb.toFixed(1)} GB` : ''}
                </Text>
              </View>

              {node.models && node.models.length > 0 ? (
                <View style={styles.modelChips}>
                  {node.models.slice(0, 6).map((m) => (
                    <View key={m} style={styles.modelChip}>
                      <Text style={styles.modelChipText}>{m}</Text>
                    </View>
                  ))}
                  {node.models.length > 6 ? (
                    <View style={styles.modelChip}>
                      <Text style={styles.modelChipText}>+{node.models.length - 6}</Text>
                    </View>
                  ) : null}
                </View>
              ) : (
                <Text style={styles.nodeNoModel}>未上报可服务模型</Text>
              )}
            </View>
          ))}

          {nodes.length > 4 ? (
            <TouchableOpacity
              testID="public-node-toggle"
              style={styles.toggleBtn}
              onPress={() => setExpanded((v) => !v)}
              activeOpacity={0.8}
            >
              <Text style={styles.toggleBtnText}>
                {expanded ? '收起' : `展开全部 ${nodes.length} 台`}
              </Text>
            </TouchableOpacity>
          ) : null}
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
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  refreshBtnText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },

  summaryRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  summaryBox: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  summaryValue: { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '800' },
  summaryLabel: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  nodeRow: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  nodeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nodeHeadLeft: { flexShrink: 1, paddingRight: spacing.sm },
  nodeHeadRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  nodeName: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  nodeMeta: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  nodeStatRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  nodeStat: { color: colors.textSecondary, fontSize: fontSize.xs },
  nodeNoModel: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.sm },

  modelChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  modelChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  modelChipText: { color: colors.textSecondary, fontSize: fontSize.xs },

  toggleBtn: { alignSelf: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  toggleBtnText: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },

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
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs },
});

export default PublicNodeCard;
