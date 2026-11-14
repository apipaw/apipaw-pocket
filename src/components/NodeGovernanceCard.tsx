import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  describeCloudError,
  fetchOwnerNodeAppeals,
  fetchOwnerNodesGovernance,
  GovernanceNode,
  NodeAppeal,
  decideOwnerNodeAppeal,
  submitNodeAppeal,
  toggleNodePause,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';
import { Pill, StatusDot, Toggle } from './ui';

/**
 * 节点治理面板（阶段六 P2 · 模块 C3）。
 *
 * 三件事：
 *   1. **看**：全网节点的在途 / 信用分 / 让退次数 / 派单成功率 / 累计收益；
 *   2. **控**：节点业主自助暂停 / 恢复接单（不再只能找平台代劳）；
 *   3. **申**：让退误判可提交申诉，OWNER 在这里签字受理 / 驳回。
 *
 * ⚠️ 权限口径：**服务端权威**。``sessionRole`` 来自钱包会话，
 *    本地角色切换（顶部 BUYER/HOST）只是视图偏好，不是权限。
 */
const NodeGovernanceCard: React.FC = () => {
  const sessionRole = usePawStore((s) => s.sessionRole);
  const sessionToken = usePawStore((s) => s.sessionToken);

  const [nodes, setNodes] = useState<GovernanceNode[]>([]);
  const [appeals, setAppeals] = useState<NodeAppeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyNode, setBusyNode] = useState<string | null>(null);

  const [appealOpen, setAppealOpen] = useState(false);
  const [appealNode, setAppealNode] = useState<GovernanceNode | null>(null);
  const [appealReason, setAppealReason] = useState('');
  const [appealDetail, setAppealDetail] = useState('');
  const [appealError, setAppealError] = useState<string | null>(null);
  const [appealSubmitting, setAppealSubmitting] = useState(false);

  const isOwner = sessionRole === 'OWNER';

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchOwnerNodesGovernance();
      setNodes(res.nodes ?? []);
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAppeals = useCallback(async () => {
    try {
      const res = await fetchOwnerNodeAppeals('PENDING', 50);
      setAppeals(res.appeals ?? []);
    } catch (e: unknown) {
      // 申诉队列是 OWNER 专属 —— 非 OWNER 静默跳过，不影响主面板
      console.log('读取申诉队列失败:', e);
    }
  }, []);

  useEffect(() => {
    if (!sessionToken) {
      setLoading(false);
      return;
    }
    load();
    loadAppeals();
  }, [sessionToken, load, loadAppeals]);

  const totalOnline = useMemo(() => nodes.filter((n) => n.alive).length, [nodes]);
  const totalPaused = useMemo(() => nodes.filter((n) => n.is_paused).length, [nodes]);
  const totalEarnings = useMemo(
    () => nodes.reduce((acc, n) => acc + (n.earnings_usd || 0), 0),
    [nodes],
  );

  const handleTogglePause = async (node: GovernanceNode) => {
    setBusyNode(node.node_id);
    setNotice(null);
    try {
      const res = await toggleNodePause(node.node_id);
      setNotice(`${node.node_id} · ${res.current_status}`);
      await load();
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setBusyNode(null);
    }
  };

  const handleSubmitAppeal = async () => {
    if (!appealNode) return;
    if (!appealReason.trim()) {
      setAppealError('请填写申诉原因');
      return;
    }
    setAppealError(null);
    setAppealSubmitting(true);
    try {
      await submitNodeAppeal(appealNode.node_id, appealReason.trim(), appealDetail.trim());
      setAppealOpen(false);
      setAppealReason('');
      setAppealDetail('');
      setNotice(`申诉已提交 · ${appealNode.node_id} · 等待平台复核`);
    } catch (e: unknown) {
      setAppealError(describeCloudError(e, 'session'));
    } finally {
      setAppealSubmitting(false);
    }
  };

  const handleDecideAppeal = async (appeal: NodeAppeal, approve: boolean) => {
    setBusyNode(appeal.node_id);
    setNotice(null);
    try {
      await decideOwnerNodeAppeal(appeal.id, approve, approve ? '受理' : '驳回');
      setNotice(`申诉 #${appeal.id} 已${approve ? '受理' : '驳回'}`);
      await loadAppeals();
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setBusyNode(null);
    }
  };

  if (!sessionToken) {
    return (
      <View style={styles.card} testID="governance-card" id="apx-glass-governance">
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleWrap}>
            <View style={styles.titleDot} />
            <Text style={styles.cardTitle}>节点治理</Text>
          </View>
        </View>
        <Text style={styles.hint}>
          治理面板需要**钱包会话**（服务端按登录钱包判定角色与节点归属）。
          请先在右上角连接钱包。
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="governance-card" id="apx-glass-governance">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>节点治理</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load} activeOpacity={0.75}>
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在读取节点治理数据...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorHint}>请确认钱包会话有效，且当前账号具备 OWNER 角色</Text>
        </View>
      ) : (
        <>
          <View style={styles.metricRow}>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>在线节点</Text>
              <Text style={[styles.metricValue, styles.metricValueAccent]}>
                {totalOnline}
              </Text>
              <Text style={styles.metricSub}>全网 {nodes.length} 台</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>已暂停</Text>
              <Text style={styles.metricValue}>{totalPaused}</Text>
              <Text style={styles.metricSub}>暂停即不接单</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>节点收益</Text>
              <Text style={styles.metricValue}>
                ${totalEarnings.toFixed(4)}
              </Text>
              <Text style={styles.metricSub}>累计美元分成</Text>
            </View>
          </View>

          {notice ? <Text style={styles.noticeText}>✓ {notice}</Text> : null}

          {/* ---------------- 节点列表 ---------------- */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>节点列表</Text>
            {nodes.length === 0 ? (
              <Text style={styles.emptyText}>暂无节点 —— 先在 Agent 侧注册节点</Text>
            ) : (
              nodes.map((node) => (
                <View key={node.node_id} style={styles.nodeRow} testID={`gov-node-${node.node_id}`}>
                  <View style={styles.nodeHead}>
                    <View style={styles.nodeHeadLeft}>
                      <Text style={styles.nodeId}>{node.node_id}</Text>
                      <Text style={styles.nodeMeta}>
                        {node.agent_version ? `Agent ${node.agent_version}` : '版本未知'}
                        {node.hardware_type ? ` · ${node.hardware_type}` : ''}
                      </Text>
                    </View>
                    <View style={styles.nodeHeadRight}>
                      <Pill
                        label={node.is_paused ? '已暂停' : node.status || 'IDLE'}
                        color={node.is_paused ? colors.danger : colors.accent}
                        dot
                      />
                      <Toggle
                        testID={`gov-pause-${node.node_id}`}
                        value={!node.is_paused}
                        disabled={busyNode === node.node_id}
                        onChange={() => handleTogglePause(node)}
                      />
                    </View>
                  </View>

                  <View style={styles.nodeStatRow}>
                    <Text style={styles.nodeStat}>在途 {node.inflight}</Text>
                    <Text style={styles.nodeStat}>信用 {node.reliability_score.toFixed(2)}</Text>
                    <Text style={styles.nodeStat}>让退 {node.yields_24h}</Text>
                    <Text style={styles.nodeStat}>
                      派单 {node.dispatches_24h} · {(node.success_rate_24h * 100).toFixed(0)}%
                    </Text>
                    <Text style={styles.nodeStat}>收益 ${(node.earnings_usd || 0).toFixed(4)}</Text>
                  </View>

                  <View style={styles.nodeActions}>
                    <StatusDot
                      color={node.alive ? colors.accent : colors.textMuted}
                      variant={node.alive ? 'live' : 'static'}
                      size={6}
                    />
                    <Text style={styles.nodeState}>
                      {node.alive ? '心跳在线' : '心跳离线'}
                      {node.dispatchable ? ' · 可派单' : ' · 不可派单'}
                      {node.owner_wallet ? '' : ' · 无归属'}
                    </Text>
                    <TouchableOpacity
                      testID={`gov-appeal-${node.node_id}`}
                      style={styles.appealBtn}
                      onPress={() => {
                        setAppealNode(node);
                        setAppealReason('');
                        setAppealDetail('');
                        setAppealError(null);
                        setAppealOpen(true);
                      }}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.appealBtnText}>提交申诉</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>

          {/* ---------------- OWNER 申诉队列 ---------------- */}
          {isOwner ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>待处理申诉（{appeals.length}）</Text>
              {appeals.length === 0 ? (
                <Text style={styles.emptyText}>当前没有待处理的节点申诉</Text>
              ) : (
                appeals.map((appeal) => (
                  <View key={appeal.id} style={styles.appealRow}>
                    <View style={styles.appealHead}>
                      <Text style={styles.nodeId}>#{appeal.id} · {appeal.node_id}</Text>
                      <Text style={styles.nodeMeta}>
                        {appeal.owner_wallet || '无归属'} · {new Date(appeal.created_at * 1000).toLocaleString()}
                      </Text>
                    </View>
                    <Text style={styles.appealReason}>{appeal.reason}</Text>
                    {appeal.detail ? <Text style={styles.appealDetail}>{appeal.detail}</Text> : null}
                    <View style={styles.appealActions}>
                      <TouchableOpacity
                        testID={`gov-appeal-approve-${appeal.id}`}
                        style={[styles.approveBtn, busyNode === appeal.node_id && styles.btnDisabled]}
                        onPress={() => handleDecideAppeal(appeal, true)}
                        activeOpacity={0.8}
                        disabled={busyNode === appeal.node_id}
                      >
                        <Text style={styles.approveBtnText}>受理</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        testID={`gov-appeal-reject-${appeal.id}`}
                        style={[styles.rejectBtn, busyNode === appeal.node_id && styles.btnDisabled]}
                        onPress={() => handleDecideAppeal(appeal, false)}
                        activeOpacity={0.8}
                        disabled={busyNode === appeal.node_id}
                      >
                        <Text style={styles.rejectBtnText}>驳回</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
              <Text style={styles.hint}>
                ⚠️ 受理申诉**只留痕**：信用分是自动派单信号，人工签字不会自动恢复信用分、也不会自动解除暂停。
              </Text>
            </View>
          ) : null}
        </>
      )}

      {/* ---------------- 申诉 Modal ---------------- */}
      <Modal
        visible={appealOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAppealOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>提交让退误判申诉</Text>
            <Text style={styles.modalSub}>节点 {appealNode?.node_id ?? ''}</Text>

            <TextInput
              testID="gov-appeal-reason-input"
              style={styles.input}
              value={appealReason}
              onChangeText={setAppealReason}
              placeholder="申诉原因（如：明明空闲却被判让退）"
              placeholderTextColor={colors.textMuted}
            />
            <TextInput
              testID="gov-appeal-detail-input"
              style={styles.input}
              value={appealDetail}
              onChangeText={setAppealDetail}
              placeholder="补充说明（可选，如时间点）"
              placeholderTextColor={colors.textMuted}
            />

            {appealError ? <Text style={styles.modalError}>⚠️ {appealError}</Text> : null}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setAppealOpen(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.modalCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="gov-appeal-submit"
                style={[styles.modalConfirmBtn, appealSubmitting && styles.btnDisabled]}
                onPress={handleSubmitAppeal}
                disabled={appealSubmitting}
                activeOpacity={0.8}
              >
                {appealSubmitting ? (
                  <ActivityIndicator color={colors.bg} size="small" />
                ) : (
                  <Text style={styles.modalConfirmText}>提交申诉</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
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

  metricRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  metricBox: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  metricLabel: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  metricValue: {
    color: colors.textPrimary,
    fontSize: fontSize.xl,
    fontWeight: '800',
    marginTop: 4,
  },
  metricValueAccent: { color: colors.accent },
  metricSub: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  section: { marginTop: spacing.md },
  sectionTitle: {
    color: colors.textBody,
    fontSize: fontSize.sm,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },

  nodeRow: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  nodeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nodeHeadLeft: { flexShrink: 1 },
  nodeHeadRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nodeId: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  nodeMeta: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  nodeStatRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  nodeStat: { color: colors.textSecondary, fontSize: fontSize.xs },
  nodeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  nodeState: { color: colors.textMuted, fontSize: fontSize.xs, flex: 1 },
  appealBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  appealBtnText: { color: colors.warn, fontSize: fontSize.xs, fontWeight: '800' },

  appealRow: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  appealHead: { marginBottom: 4 },
  appealReason: { color: colors.textBody, fontSize: fontSize.sm },
  appealDetail: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  appealActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  approveBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  approveBtnText: { color: '#04211A', fontSize: fontSize.xs, fontWeight: '800' },
  rejectBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  rejectBtnText: { color: colors.danger, fontSize: fontSize.xs, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },

  noticeText: { color: colors.accent, fontSize: fontSize.xs, marginBottom: spacing.sm },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs },

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
  errorHint: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 4 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.cardSolid,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: spacing.lg,
  },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800' },
  modalSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  input: {
    marginTop: spacing.md,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.sm,
  },
  modalError: { color: colors.danger, fontSize: fontSize.xs, marginTop: spacing.sm },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  modalCancelBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  modalCancelText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '800' },
  modalConfirmBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  modalConfirmText: { color: '#04211A', fontSize: fontSize.xs, fontWeight: '800' },
});

export default NodeGovernanceCard;
