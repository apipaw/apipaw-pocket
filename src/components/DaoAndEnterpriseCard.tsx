import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  CryptoDepositRow,
  DaoProposalRow,
  ModelManifestRow,
  daoPropose,
  daoVote,
  declareCryptoDeposit,
  decideCryptoDeposit,
  describeCloudError,
  fetchDaoProposals,
  fetchInvoiceJson,
  fetchInvoiceText,
  fetchModelManifests,
  fetchMyDeposits,
  fetchOwnerDeposits,
  fetchSlaPool,
  importPawmodel,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';
import { Pill } from './ui';

/**
 * 阶段十九 P0-P2 · Model DAO 治理锁 + B2B 企业发票 / USDT 储值（合并卡）。
 *
 * 三块内容共用一张卡（**为体积**：阶段十九不能再加新卡把 bundle 顶破 450KB）：
 *   1. **清单哈希锁**：每个上架模型的 ``manifest_sha256`` / ``system_prompt_sha256``
 *      —— 公开可查、可独立复算 ⇒ 谁改了 System Prompt 一眼看得出来；
 *   2. **治理台**：提案 + 投票（赞成票重 > 66% 自动执行，执行哈希不可篡改）；
 *   3. **企业侧**：B2B 发票（json / csv / html）+ USDT 储值申报与业主审批。
 *
 * 买家视角：发票 + 申报 + 公开治理台账；
 * 业主视角（``owner``）：额外给 PAWMODEL 导入、提案、投票与审批台。
 */

const short = (h?: string): string =>
  !h ? '—' : h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;

const money = (v?: number): string => `$${(Number(v ?? 0)).toFixed(6)}`;

interface Props {
  owner?: boolean;
}

const DaoAndEnterpriseCard: React.FC<Props> = ({ owner = false }) => {
  const apiKey = usePawStore((s) => s.apiKey);

  const [manifests, setManifests] = useState<ModelManifestRow[]>([]);
  const [proposals, setProposals] = useState<DaoProposalRow[]>([]);
  const [threshold, setThreshold] = useState(0.66);
  const [gold, setGold] = useState(0);
  const [invoice, setInvoice] = useState<Awaited<
    ReturnType<typeof fetchInvoiceJson>
  > | null>(null);
  const [deposits, setDeposits] = useState<CryptoDepositRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // ---- 表单态 ----
  const [pawmodel, setPawmodel] = useState('');
  const [proposeTitle, setProposeTitle] = useState('');
  const [proposeAction, setProposeAction] = useState('UPDATE_MODEL_PROMPT');
  const [proposeTarget, setProposeTarget] = useState('');
  const [proposePayload, setProposePayload] = useState('');
  const [txHash, setTxHash] = useState('');
  const [txAmount, setTxAmount] = useState('100');
  const [txNetwork, setTxNetwork] = useState('TRC20');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, d, sla] = await Promise.all([
        fetchModelManifests(),
        fetchDaoProposals(),
        fetchSlaPool(),
      ]);
      setManifests(m.manifests ?? []);
      setProposals(d.proposals ?? []);
      setThreshold(Number(d.threshold ?? 0.66));
      setGold(Number(sla.gold_count ?? 0));
      if (apiKey) {
        try {
          setInvoice(await fetchInvoiceJson());
        } catch {
          setInvoice(null);
        }
        try {
          const mine = await fetchMyDeposits();
          setDeposits(mine.deposits ?? []);
        } catch {
          setDeposits([]);
        }
      }
      if (owner) {
        try {
          const list = await fetchOwnerDeposits('PENDING');
          setDeposits(list.deposits ?? []);
        } catch {
          /* 无业主凭证时忽略 */
        }
      }
    } catch (e: unknown) {
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, [apiKey, owner]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<string>) => {
      setBusy(true);
      setNote(null);
      try {
        setNote(await fn());
        await load();
      } catch (e: unknown) {
        setError(describeCloudError(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /** 发票导出：Web 端直接下载文件；原生端落到剪贴板式的纯文本回显 */
  const exportInvoice = useCallback(
    async (format: 'csv' | 'html') => {
      setBusy(true);
      setError(null);
      try {
        const text = await fetchInvoiceText(format);
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
          const blob = new Blob([text], {
            type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/html;charset=utf-8',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `apipaw-invoice.${format}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          setNote(`发票已导出（${format.toUpperCase()}）`);
        } else {
          setNote(`发票已生成（${format.toUpperCase()}，${text.length} 字节）`);
        }
      } catch (e: unknown) {
        setError(describeCloudError(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const declare = useCallback(
    () =>
      act(async () => {
        const res = await declareCryptoDeposit({
          tx_hash: txHash.trim(),
          network: txNetwork,
          amount_usd: Number(txAmount || 0),
        });
        setTxHash('');
        return `申报已受理（单号 ${res.deposit_id}）—— 等业主审批后才会入账`;
      }),
    [act, txAmount, txHash, txNetwork],
  );

  const vote = useCallback(
    (p: DaoProposalRow, approve: boolean) =>
      act(async () => {
        const res = await daoVote(p.proposal_id, approve);
        return res.executed
          ? `提案已通过并自动执行（${res.execution_hash.slice(0, 12)}…）`
          : `已投票（赞成率 ${(Number(res.yes_ratio ?? 0) * 100).toFixed(1)}%）`;
      }),
    [act],
  );

  const decide = useCallback(
    (id: number, approve: boolean) =>
      act(async () => {
        const res = await decideCryptoDeposit(id, approve);
        return approve
          ? `已批准入账 ${money(res.amount_usd)}`
          : '已驳回该笔申报';
      }),
    [act],
  );

  const importPkg = useCallback(
    () =>
      act(async () => {
        const res = await importPawmodel(pawmodel);
        setPawmodel('');
        return `已导入 ${res.manifest.model_id}（清单哈希 ${res.manifest.manifest_sha256.slice(0, 12)}…）`;
      }),
    [act, pawmodel],
  );

  const propose = useCallback(
    () =>
      act(async () => {
        let payload: Record<string, unknown> = {};
        if (proposePayload.trim()) {
          payload = JSON.parse(proposePayload) as Record<string, unknown>;
        }
        const res = await daoPropose({
          title: proposeTitle.trim() || '未命名提案',
          action_type: proposeAction,
          target_id: proposeTarget.trim(),
          payload,
        });
        setProposeTitle('');
        setProposeTarget('');
        setProposePayload('');
        return `提案已受理（${res.proposal_id}）`;
      }),
    [act, proposeAction, proposePayload, proposeTarget, proposeTitle],
  );

  return (
    <View style={styles.card} testID="dao-enterprise-card" id="apx-glass-dao-enterprise">
      <View style={styles.header}>
        <Text style={styles.title}>🏛️ Model DAO 治理锁 · B2B 发票 / USDT 储值</Text>
        <TouchableOpacity style={styles.refresh} onPress={load} testID="dao-refresh">
          <Text style={styles.refreshText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : error ? (
        <Text style={styles.error} testID="dao-error">⚠️ {error}</Text>
      ) : (
        <>
          {/* ---- ① 清单哈希锁（公开）---- */}
          <Text style={styles.section}>模型清单指纹（System Prompt 不可篡改证明）</Text>
          <View style={styles.kpiRow}>
            <View style={styles.kpi}>
              <Text style={styles.kpiValue}>{manifests.length}</Text>
              <Text style={styles.kpiLabel}>已上架模型</Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiValue}>{proposals.length}</Text>
              <Text style={styles.kpiLabel}>治理提案</Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiValue}>{gold}</Text>
              <Text style={styles.kpiLabel}>SLA 金牌节点</Text>
            </View>
          </View>
          {manifests.slice(0, 6).map((m) => (
            <View key={m.model_id} style={styles.row} testID={`manifest-row-${m.model_id}`}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {m.display_name || m.model_id}
              </Text>
              <Text style={styles.mono} testID={`manifest-hash-${m.model_id}`}>
                {short(m.manifest_sha256)}
              </Text>
              <Text style={styles.hashTip}>{short(m.system_prompt_sha256)}</Text>
            </View>
          ))}

          {/* ---- ② 治理台（公开台账 + 业主投票）---- */}
          <Text style={styles.section}>治理台（赞成票重 &gt; {threshold * 100}% 自动执行）</Text>
          {proposals.slice(0, 5).map((p) => (
            <View key={p.proposal_id} style={styles.row} testID={`dao-proposal-${p.proposal_id}`}>
              <View style={styles.rowHead}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {p.title}
                </Text>
                <Pill
                  label={p.status}
                  color={p.status === 'EXECUTED' ? colors.accent : colors.warn}
                />
              </View>
              <Text style={styles.hashTip}>
                {p.action_type} · {p.target_id} · 赞成 {p.yes_weight}/{p.total_eligible_weight}
              </Text>
              {p.execution_hash ? (
                <Text style={styles.mono} testID={`dao-exec-${p.proposal_id}`}>
                  {short(p.execution_hash)}
                </Text>
              ) : null}
              {owner && p.status === 'ACTIVE' ? (
                <View style={styles.btnRow}>
                  <TouchableOpacity
                    style={styles.btnPrimary}
                    onPress={() => vote(p, true)}
                    testID={`dao-vote-yes-${p.proposal_id}`}
                  >
                    <Text style={styles.btnText}>赞成</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.btnGhost}
                    onPress={() => vote(p, false)}
                    testID={`dao-vote-no-${p.proposal_id}`}
                  >
                    <Text style={styles.btnGhostText}>反对</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ))}

          {/* ---- ③ 业主：PAWMODEL 导入 + 提案 ---- */}
          {owner ? (
            <>
              <Text style={styles.section}>导入 PAWMODEL.md（自动锁定两个哈希）</Text>
              <TextInput
                style={styles.input}
                multiline
                numberOfLines={4}
                value={pawmodel}
                onChangeText={setPawmodel}
                placeholder="---&#10;model_id: my-model&#10;tier: CREATOR&#10;---&#10;&#10;# System Prompt&#10;..."
                placeholderTextColor={colors.textMuted}
                testID="pawmodel-input"
              />
              <TouchableOpacity style={styles.btnPrimary} onPress={importPkg} testID="pawmodel-import-btn">
                <Text style={styles.btnText}>导入并锁定哈希</Text>
              </TouchableOpacity>

              <Text style={styles.section}>发起治理提案</Text>
              <TextInput
                style={styles.input}
                value={proposeTitle}
                onChangeText={setProposeTitle}
                placeholder="提案标题"
                placeholderTextColor={colors.textMuted}
                testID="dao-propose-title"
              />
              <TextInput
                style={styles.input}
                value={proposeAction}
                onChangeText={setProposeAction}
                placeholder="UPDATE_MODEL_PROMPT / UPDATE_ROYALTY_RATE / TOGGLE_SLA_THRESHOLD"
                placeholderTextColor={colors.textMuted}
                testID="dao-propose-action"
              />
              <TextInput
                style={styles.input}
                value={proposeTarget}
                onChangeText={setProposeTarget}
                placeholder="目标 model_id"
                placeholderTextColor={colors.textMuted}
                testID="dao-propose-target"
              />
              <TextInput
                style={styles.input}
                value={proposePayload}
                onChangeText={setProposePayload}
                placeholder='payload（JSON，如 {"system_prompt":"..."}）'
                placeholderTextColor={colors.textMuted}
                testID="dao-propose-payload"
              />
              <TouchableOpacity style={styles.btnPrimary} onPress={propose} testID="dao-propose-btn">
                <Text style={styles.btnText}>提交提案</Text>
              </TouchableOpacity>
            </>
          ) : null}

          {/* ---- ④ B2B 发票（买家）---- */}
          <Text style={styles.section}>B2B 商业发票（含默克尔 State Root 存证）</Text>
          {invoice ? (
            <View style={styles.kpiRow} testID="invoice-summary">
              <View style={styles.kpi}>
                <Text style={styles.kpiValue}>{money(invoice.total_recharged_usd)}</Text>
                <Text style={styles.kpiLabel}>累计充值</Text>
              </View>
              <View style={styles.kpi}>
                <Text style={styles.kpiValue}>{money(invoice.total_spent_usd)}</Text>
                <Text style={styles.kpiLabel}>推理消费</Text>
              </View>
              <View style={styles.kpi}>
                <Text style={styles.kpiValue}>{money(invoice.balance_usd)}</Text>
                <Text style={styles.kpiLabel}>当前余额</Text>
              </View>
            </View>
          ) : (
            <Text style={styles.hashTip}>需要 API Key 才能生成发票</Text>
          )}
          {invoice?.attestation?.state_root ? (
            <Text style={styles.mono} testID="invoice-state-root">
              root {short(invoice.attestation.state_root)}
            </Text>
          ) : null}
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={styles.btnGhost}
              onPress={() => exportInvoice('csv')}
              testID="invoice-csv-btn"
            >
              <Text style={styles.btnGhostText}>导出 CSV</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.btnGhost}
              onPress={() => exportInvoice('html')}
              testID="invoice-html-btn"
            >
              <Text style={styles.btnGhostText}>打印 HTML</Text>
            </TouchableOpacity>
          </View>

          {/* ---- ⑤ USDT 储值申报 ---- */}
          <Text style={styles.section}>USDT 储值申报（审批后才入账）</Text>
          <TextInput
            style={styles.input}
            value={txHash}
            onChangeText={setTxHash}
            placeholder="tx_hash（0x + 64 位十六进制）"
            placeholderTextColor={colors.textMuted}
            testID="deposit-tx-input"
          />
          <View style={styles.btnRow}>
            <TextInput
              style={[styles.input, styles.inputHalf]}
              value={txAmount}
              onChangeText={setTxAmount}
              placeholder="金额 USD"
              placeholderTextColor={colors.textMuted}
              testID="deposit-amount-input"
            />
            <TextInput
              style={[styles.input, styles.inputHalf]}
              value={txNetwork}
              onChangeText={setTxNetwork}
              placeholder="TRC20"
              placeholderTextColor={colors.textMuted}
              testID="deposit-network-input"
            />
          </View>
          {!owner ? (
            <TouchableOpacity style={styles.btnPrimary} onPress={declare} testID="deposit-declare-btn">
              <Text style={styles.btnText}>提交申报</Text>
            </TouchableOpacity>
          ) : null}

          {deposits.slice(0, 6).map((d) => (
            <View key={d.id} style={styles.row} testID={`deposit-row-${d.id}`}>
              <View style={styles.rowHead}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {money(d.amount_usd)} · {d.network}
                </Text>
                <Pill
                  label={d.status}
                  color={d.status === 'APPROVED' ? colors.accent : colors.warn}
                />
              </View>
              <Text style={styles.mono}>{short(d.tx_hash)}</Text>
              {owner && d.status === 'PENDING' ? (
                <View style={styles.btnRow}>
                  <TouchableOpacity
                    style={styles.btnPrimary}
                    onPress={() => decide(d.id, true)}
                    testID={`deposit-approve-${d.id}`}
                  >
                    <Text style={styles.btnText}>批准入账</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.btnGhost}
                    onPress={() => decide(d.id, false)}
                    testID={`deposit-reject-${d.id}`}
                  >
                    <Text style={styles.btnGhostText}>驳回</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ))}
        </>
      )}

      {note ? (
        <Text style={styles.note} testID="dao-note">
          {note}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '600', flex: 1 },
  refresh: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  refreshText: { color: colors.textSecondary, fontSize: fontSize.xs },
  center: { paddingVertical: spacing.lg, alignItems: 'center' },
  section: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.04,
  },
  kpiRow: { flexDirection: 'row', gap: spacing.sm },
  kpi: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  kpiValue: { color: colors.cyan, fontSize: fontSize.md, fontFamily: monoFont },
  kpiLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  row: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: 2,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { color: colors.textBody, fontSize: fontSize.sm, flex: 1 },
  mono: { color: colors.accent, fontSize: fontSize.xs, fontFamily: monoFont },
  hashTip: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: monoFont },
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    padding: spacing.sm,
  },
  inputHalf: { flex: 1 },
  btnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  btnPrimary: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  btnText: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '600' },
  btnGhost: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnGhostText: { color: colors.textSecondary, fontSize: fontSize.sm },
  error: { color: colors.danger, fontSize: fontSize.sm },
  note: { color: colors.cyan, fontSize: fontSize.xs },
});

export default DaoAndEnterpriseCard;
