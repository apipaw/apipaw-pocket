import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  WithdrawalRow,
  decideOwnerWithdrawal,
  describeCloudError,
  fetchOwnerCreatorWithdrawals,
  fetchOwnerNodeWithdrawals,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 提现审批台（阶段九 P3 · OWNER 专属）。
 *
 * 两个队列：节点收益提现 / 创作者版税提现。每一笔申请都必须由 OWNER **签字**，
 * 批准时可回填链上/打款凭证 `tx_hash` —— 没有凭证的批准，服务端一律拒绝
 * （`tx_hash` 必须是 `0x` + 64 位十六进制）。
 *
 * 防超额的**第二道闸**在这里：申请期的额度校验可能被绕过（改库、并发），
 * 审批期会重新核对「已占 + 本笔 ≤ 累计收益」，超额直接 400，**不落库**。
 */
const WithdrawalApprovalCard: React.FC<{
  /**
   * 审批动作完成后的回调（阶段十一 P1 · 同页实时联动）。
   * 父组件借此触发收益卡片的重拉 —— 批准（回填 tx_hash）或驳回（退回额度）
   * 之后，收益面板立即反映新的可提净额。
   */
  onDecided?: () => void;
}> = ({ onDecided }) => {
  const sessionRole = usePawStore((s) => s.sessionRole);
  const sessionToken = usePawStore((s) => s.sessionToken);
  /**
   * 阶段十二 P0 · 零刷新双向联动：
   * 订阅全局「提现台版本号」—— 提现申请一经提交（`EarningsWithdrawCard` 自增），
   * 本审批台**立即**重拉待审列表，不再需要人工点「刷新」。
   */
  const withdrawalsVersion = usePawStore((s) => s.withdrawalsVersion);
  const bumpWithdrawalsVersion = usePawStore((s) => s.bumpWithdrawalsVersion);

  const [nodeRows, setNodeRows] = useState<WithdrawalRow[]>([]);
  const [creatorRows, setCreatorRows] = useState<WithdrawalRow[]>([]);
  const [txInputs, setTxInputs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isOwner = sessionRole === 'OWNER';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nodeRes, creatorRes] = await Promise.all([
        fetchOwnerNodeWithdrawals('PENDING', 50),
        fetchOwnerCreatorWithdrawals('PENDING', 50),
      ]);
      setNodeRows(nodeRes.withdrawals ?? []);
      setCreatorRows(creatorRes.withdrawals ?? []);
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!sessionToken || !isOwner) {
      setLoading(false);
      return;
    }
    void load();
  }, [sessionToken, isOwner, load]);

  // 阶段十二 P0：提现台版本号变化 ⇒ 立即重拉待审列表（首帧不重复拉）
  const lastVersionRef = React.useRef(withdrawalsVersion);
  useEffect(() => {
    if (lastVersionRef.current === withdrawalsVersion) return;
    lastVersionRef.current = withdrawalsVersion;
    if (!sessionToken || !isOwner) return;
    void load();
  }, [withdrawalsVersion, sessionToken, isOwner, load]);

  const decide = useCallback(
    async (kind: 'node' | 'creator', row: WithdrawalRow, approve: boolean) => {
      const key = `${kind}-${row.id}`;
      setBusyKey(key);
      setError(null);
      setNotice(null);
      const txHash = (txInputs[key] ?? '').trim();
      try {
        await decideOwnerWithdrawal(kind, row.id, approve, txHash, 'OWNER 审批');
        setNotice(`#${row.id} 已${approve ? '批准' : '驳回'}`);
        await load();
        // 阶段十二 P0：自增全局提现台版本号 ⇒ 收益卡片立即重拉（零刷新）
        bumpWithdrawalsVersion();
        onDecided?.();
      } catch (e: unknown) {
        setError(describeCloudError(e, 'session'));
      } finally {
        setBusyKey(null);
      }
    },
    [txInputs, load, onDecided, bumpWithdrawalsVersion],
  );

  if (!sessionToken) {
    return (
      <View style={styles.card} testID="withdrawal-approval-card">
        <Text style={styles.cardTitle}>提现审批台</Text>
        <Text style={styles.hint}>连接钱包（OWNER）后可在此审批节点与创作者的提现申请。</Text>
      </View>
    );
  }

  if (!isOwner) {
    return (
      <View style={styles.card} testID="withdrawal-approval-card">
        <Text style={styles.cardTitle}>提现审批台</Text>
        <Text style={styles.hint}>当前会话不是 OWNER 角色，无权审批提现（服务端按角色鉴权）。</Text>
      </View>
    );
  }

  const renderRow = (kind: 'node' | 'creator', row: WithdrawalRow) => {
    const key = `${kind}-${row.id}`;
    return (
      <View key={key} style={styles.row} testID={`${kind}-withdrawal-${row.id}`}>
        <View style={styles.rowHead}>
          <Text style={styles.rowTitle}>
            #{row.id} · {kind === 'node' ? row.node_id || '节点' : row.creator_id || '创作者'}
          </Text>
          <Text style={styles.rowAmount}>${Number(row.amount_usd).toFixed(4)}</Text>
        </View>
        <Text style={styles.rowMeta}>
          {kind === 'node' ? row.owner_wallet || '' : row.author_wallet || ''} ·{' '}
          {new Date(Number(row.created_at) * 1000).toLocaleString()}
        </Text>

        <TextInput
          style={styles.input}
          value={txInputs[key] ?? ''}
          onChangeText={(v) => setTxInputs((prev) => ({ ...prev, [key]: v }))}
          placeholder="tx_hash（0x + 64 位十六进制，批准时必填）"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          testID={`tx-input-${key}`}
        />

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.approveBtn, busyKey === key && styles.btnDisabled]}
            onPress={() => void decide(kind, row, true)}
            disabled={busyKey === key}
            activeOpacity={0.8}
            testID={`approve-${key}`}
          >
            <Text style={styles.approveBtnText}>批准并交割</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.rejectBtn, busyKey === key && styles.btnDisabled]}
            onPress={() => void decide(kind, row, false)}
            disabled={busyKey === key}
            activeOpacity={0.8}
            testID={`reject-${key}`}
          >
            <Text style={styles.rejectBtnText}>驳回</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.card} testID="withdrawal-approval-card" id="apx-glass-withdrawal-approval">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>提现审批台（OWNER）</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load} activeOpacity={0.75} testID="withdrawal-refresh">
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在读取提现申请...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText} testID="withdrawal-error">
            ⚠️ {error}
          </Text>
        </View>
      ) : (
        <>
          {notice ? (
            <Text style={styles.noticeText} testID="withdrawal-notice">
              ✓ {notice}
            </Text>
          ) : null}

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>节点提现（{nodeRows.length}）</Text>
            {nodeRows.length === 0 ? (
              <Text style={styles.hint}>当前没有待审的节点提现申请</Text>
            ) : (
              nodeRows.map((row) => renderRow('node', row))
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>创作者提现（{creatorRows.length}）</Text>
            {creatorRows.length === 0 ? (
              <Text style={styles.hint}>当前没有待审的创作者提现申请</Text>
            ) : (
              creatorRows.map((row) => renderRow('creator', row))
            )}
          </View>

          <Text style={styles.hint}>
            ⚠️ 审批时服务端会重新核对「已占额度 + 本笔 ≤ 累计收益」，超额直接拒绝；
            批准必须带 `tx_hash` 交割凭证。
          </Text>
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
    marginBottom: spacing.sm,
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

  section: { marginTop: spacing.md },
  sectionTitle: {
    color: colors.textBody,
    fontSize: fontSize.sm,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },

  row: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  rowAmount: { color: colors.accent, fontSize: fontSize.md, fontWeight: '800', fontFamily: 'monospace' },
  rowMeta: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    marginTop: spacing.sm,
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
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

  noticeText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
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
});

export default WithdrawalApprovalCard;
