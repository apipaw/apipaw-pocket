import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { usePawStore } from '../store/usePawStore';
import {
  EarningsSummary,
  describeCloudError,
  fetchEarningsSummary,
  submitCreatorWithdrawal,
  submitNodeWithdrawal,
} from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 算力节点 & 模型创作者「收益看板 & 自助提现」（阶段十一 P1）。
 *
 * 与既有 `NodePayoutCard` 的分工：
 *   · `NodePayoutCard` —— **链上 PAW 广播**通道（ethers 直发 ERC-20 + 回填 tx_hash）；
 *   · 本卡 —— **收益总览 + 自助申请**（含创作者侧），并与业主视角的
 *     `WithdrawalApprovalCard` 构成**同页联动**（申请 → 审批 → 状态回写）。
 *
 * 口径（**服务端权威**，前端不做任何二次估算）：
 *   · 累计分成 ← `revenue_ledger`（已结算分账，9 位小数）
 *   · 已结清   ← 提现台账 APPROVED / DONE / BROADCAST
 *   · 审批中   ← 提现台账 PENDING（**冻结额度**）
 *   · 可提净额 ← 累计 − 已结清 − 审批中
 *
 * 🔴 收款钱包：**必须与账户绑定钱包一致**（服务端会校验）。
 *    允许任意地址等于把提现变成「改收款人」漏洞 —— 钱会打给提交者指定的人。
 */

type Channel = 'node' | 'creator';

/** 金额：9 位小数（0.0073 这类小份额截 2 位就失真） */
const fmtUsd9 = (v: number | undefined | null): string => {
  const n = Number(v ?? 0);
  const trimmed = n.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  const parts = trimmed.split('.');
  if (parts.length === 1) return `$${parts[0]}.00`;
  return `$${parts[0]}.${parts[1].padEnd(2, '0')}`;
};

const fmtTime = (ts: number | undefined | null): string => {
  if (!ts) return '—';
  const d = new Date(Number(ts) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: '审批中',
  APPROVED: '已批准',
  REJECTED: '已驳回',
  BROADCAST: '已广播',
  DONE: '已结清',
};

const EarningsWithdrawCard: React.FC<{
  /** 默认展示的节点（线上真实节点 win_node_01） */
  defaultNodeId?: string;
  /** 默认展示的创作者（线上真实创作者 creator_demo） */
  defaultCreatorId?: string;
  /** 提现成功后回调（父组件可借此刷新审批台） */
  onSubmitted?: () => void;
  /**
   * 外部刷新信号（阶段十一 P1 · 同页实时联动）。
   * 父组件在 OWNER 批准/驳回提现后自增该值 ⇒ 本卡片立即重拉收益与历史。
   */
  refreshKey?: number;
}> = ({
  defaultNodeId = 'win_node_01',
  defaultCreatorId = 'creator_demo',
  onSubmitted,
  refreshKey = 0,
}) => {
  const { sessionToken, sessionWallet } = usePawStore();
  /**
   * 阶段十二 P0 · 零刷新双向联动：
   * 提现台版本号 —— 提交方自增，审批台订阅后立即重拉待审列表；
   * 审批方自增，本卡片立即重拉收益与历史。
   */
  const withdrawalsVersion = usePawStore((s) => s.withdrawalsVersion);
  const bumpWithdrawalsVersion = usePawStore((s) => s.bumpWithdrawalsVersion);

  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>('node');
  const [nodeId, setNodeId] = useState(defaultNodeId);
  const [creatorId, setCreatorId] = useState(defaultCreatorId);
  const [amount, setAmount] = useState('');
  const [payoutWallet, setPayoutWallet] = useState(sessionWallet || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchEarningsSummary(nodeId.trim(), creatorId.trim(), 20);
      setSummary(res);
      setError(null);
    } catch (e: unknown) {
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, [nodeId, creatorId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 外部审批信号 ⇒ 立即重拉（OWNER 批准/驳回后同页看到最新额度与状态）
  // 阶段十二 P0：外部信号与全局提现台版本号合并为一个"刷新票据"，
  // 同一次操作只触发一次重拉（两个来源同拍自增 ⇒ 票据只变一次）。
  const refreshTicket = refreshKey + withdrawalsVersion;
  const lastTicketRef = React.useRef(refreshTicket);
  useEffect(() => {
    if (lastTicketRef.current === refreshTicket) return;
    lastTicketRef.current = refreshTicket;
    void load();
  }, [refreshTicket, load]);

  // 会话建立后自动把收款钱包预填成绑定钱包（服务端只认它）
  useEffect(() => {
    if (sessionWallet) setPayoutWallet(sessionWallet);
  }, [sessionWallet]);

  const node = summary?.node ?? null;
  const creator = summary?.creator ?? null;
  const current = channel === 'node' ? node : creator;
  /** 可提额口径：节点已绑定归属钱包时用 owner-wide（与服务端提现闸门同源），
   *  未绑定时退回到该节点自身的台账净额（并由界面提示无法提现）。 */
  const available =
    channel === 'node'
      ? node?.owner_bound
        ? (node?.owner_available_usd ?? 0)
        : (node?.available_usd ?? 0)
      : (creator?.available_usd ?? 0);

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    setMessage(null);
    const value = Number(amount.trim());
    if (!Number.isFinite(value) || value <= 0) {
      setFormError('请输入大于 0 的提现金额（美元，最多 9 位小数）');
      return;
    }
    if (!sessionToken) {
      setFormError('需要先解锁业主视角（管理口令）或连接钱包，才能发起提现');
      return;
    }
    setBusy(true);
    try {
      if (channel === 'node') {
        const res = await submitNodeWithdrawal(value, nodeId.trim(), '自助提现', payoutWallet.trim());
        setMessage(
          `✅ 节点提现已登记 #${res.withdrawal.id} · ${fmtUsd9(res.withdrawal.amount_usd)} · ${res.withdrawal.status}`,
        );
      } else {
        const res = await submitCreatorWithdrawal(value, '自助提现', payoutWallet.trim());
        setMessage(
          `✅ 创作者提现已登记 #${res.withdrawal.id} · ${fmtUsd9(
            res.withdrawal.amount_usd,
          )} · ${res.withdrawal.status}`,
        );
      }
      setAmount('');
      await load();
      // 阶段十二 P0：自增全局提现台版本号 ⇒ 审批台**立即**重拉（零刷新）
      bumpWithdrawalsVersion();
      onSubmitted?.();
    } catch (e: unknown) {
      setFormError(describeCloudError(e, 'session'));
    } finally {
      setBusy(false);
    }
  }, [
    amount,
    channel,
    nodeId,
    payoutWallet,
    sessionToken,
    load,
    onSubmitted,
    bumpWithdrawalsVersion,
  ]);

  const statRow = (
    label: string,
    value: string,
    strong?: boolean,
    testID?: string,
  ) => (
    <View style={styles.stat}>
      <Text style={[styles.statValue, strong && styles.statValueStrong]} testID={testID}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );

  return (
    <View style={styles.card} testID="earnings-withdraw-card" id="apx-glass-earnings-withdraw">
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>算力节点 & 创作者收益提现</Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => void load()}
          activeOpacity={0.75}
          testID="earnings-withdraw-refresh"
        >
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.subtitle}>
        EARNINGS · WITHDRAWAL · 口径取自已结算分账（9 位小数）
      </Text>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={styles.loadingText}>正在读取收益台账…</Text>
        </View>
      ) : error ? (
        <Text style={styles.errorText}>⚠️ {error}</Text>
      ) : null}

      {/* ---------------- 算力节点 ---------------- */}
      <View style={styles.block} testID="earnings-node-block">
        <Text style={styles.blockTitle}>算力节点收益</Text>
        <View style={styles.filterRow}>
          <TextInput
            style={styles.filterInput}
            value={nodeId}
            onChangeText={setNodeId}
            placeholder="node_id"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            testID="earnings-node-id-input"
          />
          <Text style={styles.filterHint}>
            {node ? `${node.requests} 单 · ${node.tokens} tokens` : '—'}
          </Text>
        </View>
        {node ? (
          <>
            <View style={styles.statRow}>
              {statRow('累计分成', fmtUsd9(node.total_share_usd), true, 'earnings-node-total')}
              {statRow('已结清', fmtUsd9(node.settled_usd), false, 'earnings-node-settled')}
              {statRow('审批中', fmtUsd9(node.pending_usd), false, 'earnings-node-pending')}
              {statRow('可提净额', fmtUsd9(node.available_usd), true, 'earnings-node-available')}
            </View>
            {node.owner_bound ? (
              <Text style={styles.boundHint}>
                归属钱包 {node.owner_wallet_masked} · 名下全部节点可提{' '}
                {fmtUsd9(node.owner_available_usd)}
              </Text>
            ) : (
              <Text style={styles.warnHint}>
                ⚠️ 该节点尚未绑定业主钱包 —— 收益无法归属，也就无法提现（运维可用
                manage_node.py bind 绑定）
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.emptyText}>该节点暂无已结算分账记录</Text>
        )}
      </View>

      {/* ---------------- 创作者 ---------------- */}
      <View style={styles.block} testID="earnings-creator-block">
        <Text style={styles.blockTitle}>模型创作者收益</Text>
        <View style={styles.filterRow}>
          <TextInput
            style={styles.filterInput}
            value={creatorId}
            onChangeText={setCreatorId}
            placeholder="creator_id"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            testID="earnings-creator-id-input"
          />
          <Text style={styles.filterHint}>
            {creator ? `${creator.requests} 单 · ${creator.tokens} tokens` : '—'}
          </Text>
        </View>
        {creator ? (
          <>
            <View style={styles.statRow}>
              {statRow('累计分成', fmtUsd9(creator.total_share_usd), true, 'earnings-creator-total')}
              {statRow('已结清', fmtUsd9(creator.settled_usd), false, 'earnings-creator-settled')}
              {statRow('审批中', fmtUsd9(creator.pending_usd), false, 'earnings-creator-pending')}
              {statRow('可提净额', fmtUsd9(creator.available_usd), true, 'earnings-creator-available')}
            </View>
            <Text style={styles.boundHint}>创作者钱包 {creator.author_wallet_masked}</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>该创作者暂无已结算分账记录</Text>
        )}
      </View>

      {/* ---------------- 自助提现 ---------------- */}
      <View style={styles.block} testID="earnings-withdraw-form">
        <Text style={styles.blockTitle}>发起提现申请</Text>
        <View style={styles.tabRow}>
          {(
            [
              { key: 'node', label: '算力节点' },
              { key: 'creator', label: '模型创作者' },
            ] as Array<{ key: Channel; label: string }>
          ).map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, channel === tab.key && styles.tabActive]}
              onPress={() => setChannel(tab.key)}
              activeOpacity={0.75}
              testID={`earnings-channel-${tab.key}`}
            >
              <Text style={[styles.tabText, channel === tab.key && styles.tabTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {!sessionToken ? (
          <Text style={styles.warnHint} testID="earnings-withdraw-need-session">
            需先「解锁业主视角」（管理口令）或连接钱包，才能发起提现申请。
          </Text>
        ) : null}

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, styles.amountInput]}
            value={amount}
            onChangeText={setAmount}
            placeholder="提现金额 (USD)"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            testID="earnings-withdraw-amount"
          />
          <TouchableOpacity
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
            onPress={() => void handleSubmit()}
            disabled={busy}
            activeOpacity={0.8}
            testID="earnings-withdraw-submit"
          >
            {busy ? (
              <ActivityIndicator color={colors.bg} size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>提交申请</Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, styles.walletInput]}
            value={payoutWallet}
            onChangeText={setPayoutWallet}
            placeholder="收款钱包（须与账户绑定钱包一致）"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            testID="earnings-withdraw-wallet"
          />
        </View>
        <Text style={styles.filterHint}>
          可提净额 {fmtUsd9(available)} · 提交后由业主审批（批准回填 tx_hash / 驳回退回额度）
        </Text>

        {formError ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText} testID="earnings-withdraw-error">
              ⚠️ {formError}
            </Text>
          </View>
        ) : null}
        {message ? (
          <View style={styles.successBox}>
            <Text style={styles.successText} testID="earnings-withdraw-ok">
              {message}
            </Text>
          </View>
        ) : null}
      </View>

      {/* ---------------- 提现历史 ---------------- */}
      {current && current.withdrawals.length > 0 ? (
        <View style={styles.block} testID="earnings-withdraw-history">
          <Text style={styles.blockTitle}>最近提现申请</Text>
          {current.withdrawals.map((w) => (
            <View key={w.id} style={styles.historyRow} testID={`earnings-withdraw-row-${w.id}`}>
              <View style={styles.historyMain}>
                <Text style={styles.historyAmount}>
                  #{w.id} · {fmtUsd9(w.amount_usd)}
                </Text>
                <Text style={styles.historyMeta}>
                  {STATUS_LABEL[w.status] || w.status} · {fmtTime(w.created_at)}
                  {w.tx_hash ? ` · tx ${w.tx_hash.slice(0, 10)}…` : ''}
                </Text>
              </View>
            </View>
          ))}
        </View>
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
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.sm, lineHeight: 17 },

  block: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  blockTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '800',
    marginBottom: spacing.sm,
  },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  filterInput: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    fontFamily: 'monospace',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    flex: 1,
  },
  filterHint: { color: colors.textMuted, fontSize: fontSize.xs, flexShrink: 1 },

  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stat: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  statValue: { color: colors.textBody, fontSize: fontSize.sm, fontWeight: '700', fontFamily: 'monospace' },
  statValueStrong: { color: colors.accent },
  statLabel: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  boundHint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.sm },
  warnHint: { color: colors.danger, fontSize: fontSize.xs, marginTop: spacing.sm, lineHeight: 16 },

  tabRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  tabText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  tabTextActive: { color: colors.accent },

  inputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.sm },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  amountInput: { flex: 1 },
  walletInput: { flex: 1 },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#04211A', fontWeight: '800', fontSize: fontSize.sm },
  btnDisabled: { opacity: 0.6 },

  errorBox: {
    marginTop: spacing.md,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.sm,
  },
  successBox: {
    marginTop: spacing.md,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.sm,
  },
  successText: { color: colors.accent, fontSize: fontSize.xs },

  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  historyMain: { flexShrink: 1 },
  historyAmount: { color: colors.textBody, fontSize: fontSize.xs, fontFamily: 'monospace' },
  historyMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
});

export default EarningsWithdrawCard;
