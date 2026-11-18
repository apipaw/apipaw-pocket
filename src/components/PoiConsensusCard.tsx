import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  MerkleProofResponse,
  PoiSummaryResponse,
  StateRootResponse,
  describeCloudError,
  fetchMerkleProof,
  fetchPoiSummary,
  fetchStateRoot,
  runOwnerPoiAudit,
} from '../api/cloudClient';
import { merkleRootFrom, sha256Hex } from '../utils/sha256';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';

/**
 * 阶段十八 P0-P2 · PoI 推理证明 + 默克尔状态根看板。
 *
 * 三件事：
 *   1. **实时状态根**：网关公示的 ``state_root`` / ``ledger_root`` / ``revenue_root``；
 *   2. **浏览器端一键验真**：拉取默克尔包含性证明 ⇒ 本地用自带 SHA-256
 *      逐层重算根 ⇒ 与公示根比对（不需要信任网关，只信任数学）；
 *   3. **PoI 抽检统计**：已验真推理数 / 抽检命中 / 守卫拦截 / 扣罚笔数。
 *
 * 业主视角额外给一个**模拟欺诈演练**按钮（Slashing 扣罚沙盒）。
 */

const short = (h?: string): string =>
  !h ? '—' : h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;

const fmtTime = (ts?: number): string => {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

interface Verdict {
  ok: boolean;
  lines: string[];
}

interface Props {
  /** 业主视角：额外显示模拟欺诈演练（Slashing） */
  owner?: boolean;
}

const PoiConsensusCard: React.FC<Props> = ({ owner = false }) => {
  const [summary, setSummary] = useState<PoiSummaryResponse | null>(null);
  const [root, setRoot] = useState<StateRootResponse | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, r] = await Promise.all([fetchPoiSummary(10), fetchStateRoot()]);
      setSummary(s);
      setRoot(r);
    } catch (e: unknown) {
      setError(describeCloudError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 浏览器端默克尔验真：本地重算根 ⇒ 与公示根逐项比对 */
  const verify = useCallback(async (ledger: 'balance' | 'revenue') => {
    setBusy(true);
    setVerdict(null);
    try {
      const proof: MerkleProofResponse = await fetchMerkleProof(ledger);
      if (!proof?.ok) {
        setVerdict({ ok: false, lines: [proof?.message || '账本为空，无法生成包含性证明'] });
        return;
      }
      const sr = await fetchStateRoot();
      const computed = merkleRootFrom(
        proof.leaf_hash || '', proof.siblings || [], proof.sibling_sides || [],
      );
      const advertised = proof.root_hash || '';
      const rootOk = computed === advertised;
      const ledgerOk = computed === sr.ledger_root;
      const stateOk =
        sha256Hex(`ledger:${sr.ledger_root}|revenue:${sr.revenue_root}`) === sr.state_root;
      const lines = [
        `叶子 #${proof.leaf_index} · 兄弟链 ${(proof.siblings || []).length} 层`,
        `本地重算根 ${short(computed)} ${rootOk ? '== 证明根 ✓' : '!= 证明根 ✗'}`,
        `证明根 ${short(advertised)} ${ledgerOk ? '== 全网 ledger_root ✓' : '!= 全网 ledger_root ✗'}`,
        `state_root 本地重算 ${stateOk ? '一致 ✓' : '不一致 ✗'}`,
      ];
      setVerdict({ ok: rootOk && ledgerOk && stateOk, lines });
    } catch (e: unknown) {
      setVerdict({ ok: false, lines: [describeCloudError(e)] });
    } finally {
      setBusy(false);
    }
  }, []);

  /** 业主：模拟欺诈演练（Slashing 扣罚） */
  const runDrill = useCallback(async () => {
    setBusy(true);
    setDrill(null);
    try {
      const res = await runOwnerPoiAudit({ simulate_fraud_type: 'token_inflation' });
      setDrill(
        res.ok
          ? `演练完成：${res.reason || 'token_inflation_fraud'} → 节点 ${res.node_id} 信用分 ${Number(
              res.score ?? 0,
            ).toFixed(3)}`
          : res.message || '演练失败',
      );
      await load();
    } catch (e: unknown) {
      setDrill(describeCloudError(e, 'session'));
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <View style={styles.card} testID="poi-consensus-card" id="apx-glass-poi">
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>🔗 PoI 共识 · 默克尔状态根</Text>
        </View>
        <TouchableOpacity onPress={() => void load()} activeOpacity={0.8} testID="poi-refresh">
          <Text style={styles.chevron}>刷新 ⟳</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.subtitle}>
        推理收据签名验真 + 5% 随机抽检 · 状态根可被浏览器本地重算复验
      </Text>

      {error !== null ? (
        <Text style={styles.errorText} testID="poi-error">
          ⚠️ {error}
        </Text>
      ) : null}

      <View style={styles.rootBox}>
        <Text style={styles.rootLabel}>State Root</Text>
        <Text style={styles.rootValue} testID="poi-state-root">
          {root?.state_root || '读取中…'}
        </Text>
        <Text style={styles.rootMeta} testID="poi-roots">
          ledger {short(root?.ledger_root)} · revenue {short(root?.revenue_root)} · 叶子{' '}
          {root?.ledger_leaf_count ?? 0}/{root?.revenue_leaf_count ?? 0} · {fmtTime(root?.timestamp)}
        </Text>
      </View>

      <View style={styles.kpiRow}>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>已验真推理</Text>
          <Text style={styles.kpiValue} testID="poi-verified">
            {Number(summary?.verified_inferences ?? 0)}
          </Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>抽检命中</Text>
          <Text style={styles.kpiValue} testID="poi-spot-hits">
            {Number(summary?.spot_check_hits ?? 0)}
          </Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>守卫拦截</Text>
          <Text style={styles.kpiValue} testID="poi-guard">
            {Number(summary?.guard_triggered ?? 0)}
          </Text>
        </View>
        <View style={styles.kpi}>
          <Text style={styles.kpiLabel}>扣罚笔数</Text>
          <Text style={styles.kpiValue} testID="poi-slashed">
            {Number(summary?.slashing_blocked ?? 0)}
          </Text>
        </View>
      </View>

      <View style={styles.btnRow}>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => void verify('balance')}
          activeOpacity={0.8}
          testID="poi-verify-balance"
        >
          <Text style={styles.btnText}>🔐 本地验真我的账</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => void verify('revenue')}
          activeOpacity={0.8}
          testID="poi-verify-revenue"
        >
          <Text style={styles.btnText}>🧾 验真分账账</Text>
        </TouchableOpacity>
      </View>

      {busy ? (
        <ActivityIndicator size="small" color={colors.cyan} style={styles.spinner} />
      ) : null}

      {verdict !== null ? (
        <View
          style={[styles.verdict, { borderColor: verdict.ok ? colors.accent : colors.danger }]}
          testID="poi-verdict"
        >
          <Text style={[styles.verdictTitle, { color: verdict.ok ? colors.accent : colors.danger }]}>
            {verdict.ok ? '✓ 默克尔证明本地复验通过' : '✗ 本地复验未通过'}
          </Text>
          {verdict.lines.map((l, i) => (
            <Text key={i} style={styles.verdictLine}>
              {l}
            </Text>
          ))}
        </View>
      ) : null}

      {owner ? (
        <View style={styles.ownerBox}>
          <TouchableOpacity
            style={[styles.btn, styles.btnDanger]}
            onPress={() => void runDrill()}
            activeOpacity={0.8}
            testID="poi-drill"
          >
            <Text style={styles.btnText}>🧪 模拟欺诈演练（Slashing 扣罚）</Text>
          </TouchableOpacity>
          {drill !== null ? (
            <Text style={styles.drillText} testID="poi-drill-result">
              {drill}
            </Text>
          ) : null}
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
  titleDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.cyan },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  chevron: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.xs },

  rootBox: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  rootLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  rootValue: {
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontFamily: monoFont,
    marginTop: 2,
  },
  rootMeta: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: monoFont, marginTop: 4 },

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  kpi: {
    flexGrow: 1,
    flexBasis: 80,
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

  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  btn: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.cyan,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  btnDanger: { borderColor: colors.warn, marginTop: spacing.sm },
  btnText: { color: colors.textPrimary, fontSize: fontSize.xs, fontWeight: '800' },
  spinner: { marginTop: spacing.sm },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },

  verdict: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  verdictTitle: { fontSize: fontSize.sm, fontWeight: '800' },
  verdictLine: { color: colors.textSecondary, fontSize: fontSize.xs, fontFamily: monoFont, marginTop: 2 },

  ownerBox: { marginTop: spacing.xs },
  drillText: { color: colors.warn, fontSize: fontSize.xs, marginTop: spacing.xs },
});

export default PoiConsensusCard;
