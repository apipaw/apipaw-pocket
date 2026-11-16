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
  VoucherRow,
  describeCloudError,
  fetchOwnerVouchers,
  issueVouchers,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 业主签发充值卡密（阶段九 P2 · OWNER 专属）。
 *
 * 合规要点（前端也必须守住）：
 * - **明文只回吐这一次** —— 服务端只存 `sha256(code)`，之后任何接口都拿不回明文；
 * - 台账列表**只有前缀与状态**（`paw-topup-xxxxxx`），没有明文列；
 * - 面额区间 $1 ~ $100、数量 1 ~ 50 由服务端把关，非法 ⇒ 400。
 *
 * 面板在签发成功后把明文整块显示出来，并提示「只此一次可见，请立即分发」。
 */
const VoucherIssueCard: React.FC = () => {
  const sessionRole = usePawStore((s) => s.sessionRole);
  const sessionToken = usePawStore((s) => s.sessionToken);

  const [amount, setAmount] = useState('10');
  const [count, setCount] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plaintext, setPlaintext] = useState<string[]>([]);
  const [rows, setRows] = useState<VoucherRow[]>([]);
  const [loading, setLoading] = useState(true);

  const isOwner = sessionRole === 'OWNER';

  const loadRows = useCallback(async () => {
    try {
      const res = await fetchOwnerVouchers('', 50);
      setRows(res.vouchers ?? []);
    } catch (e: unknown) {
      console.log('读取卡密台账失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!sessionToken || !isOwner) {
      setLoading(false);
      return;
    }
    void loadRows();
  }, [sessionToken, isOwner, loadRows]);

  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPlaintext([]);
    try {
      const res = await issueVouchers(Number(amount) || 0, Number(count) || 1);
      setPlaintext((res.vouchers ?? []).map((v) => v.code));
      await loadRows();
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setBusy(false);
    }
  }, [amount, count, loadRows]);

  if (!sessionToken) {
    return (
      <View style={styles.card} testID="voucher-issue-card">
        <Text style={styles.cardTitle}>签发充值卡密</Text>
        <Text style={styles.hint}>连接钱包（OWNER）后可在此批量签发充值码。</Text>
      </View>
    );
  }

  if (!isOwner) {
    return (
      <View style={styles.card} testID="voucher-issue-card">
        <Text style={styles.cardTitle}>签发充值卡密</Text>
        <Text style={styles.hint}>当前会话不是 OWNER 角色，无权签发充值码（服务端按角色鉴权）。</Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="voucher-issue-card" id="apx-glass-voucher-issue">
      <View style={styles.cardTitleWrap}>
        <View style={styles.titleDot} />
        <Text style={styles.cardTitle}>签发充值卡密（OWNER）</Text>
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>面额 (USD, 1 ~ 100)</Text>
        <TextInput
          style={styles.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="10"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          testID="voucher-issue-amount"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>数量 (1 ~ 50)</Text>
        <TextInput
          style={styles.input}
          value={count}
          onChangeText={setCount}
          placeholder="1"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          testID="voucher-issue-count"
        />
      </View>

      <TouchableOpacity
        style={[styles.submitBtn, busy && styles.btnDisabled]}
        onPress={() => void issue()}
        disabled={busy}
        activeOpacity={0.8}
        testID="voucher-issue-btn"
      >
        {busy ? (
          <ActivityIndicator color="#04211A" />
        ) : (
          <Text style={styles.submitBtnText}>签发</Text>
        )}
      </TouchableOpacity>

      {error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText} testID="voucher-issue-error">
            ⚠️ {error}
          </Text>
        </View>
      ) : null}

      {plaintext.length > 0 ? (
        <View style={styles.plainBox} testID="voucher-issue-plaintext">
          <Text style={styles.plainTitle}>明文只此一次可见 —— 请立即分发</Text>
          {plaintext.map((code) => (
            <Text key={code} style={styles.plainCode} selectable>
              {code}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>卡密台账（只含前缀与状态）</Text>
        {loading ? (
          <Text style={styles.hint}>正在读取台账…</Text>
        ) : rows.length === 0 ? (
          <Text style={styles.hint}>还没有签发过充值码</Text>
        ) : (
          rows.map((row) => (
            <View key={row.id} style={styles.row} testID={`voucher-row-${row.id}`}>
              <Text style={styles.rowPrefix}>{row.code_prefix}…</Text>
              <Text style={styles.rowAmount}>${Number(row.amount_usd).toFixed(2)}</Text>
              <Text
                style={[
                  styles.rowStatus,
                  row.status === 'REDEEMED' && styles.rowStatusUsed,
                  row.status === 'REVOKED' && styles.rowStatusRevoked,
                ]}
              >
                {row.status}
              </Text>
            </View>
          ))
        )}
      </View>
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
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.warn,
    shadowColor: colors.warn,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },

  fieldRow: { marginTop: spacing.md },
  label: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700', marginBottom: 4 },
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  },

  submitBtn: {
    marginTop: spacing.lg,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.xl,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.warn,
  },
  submitBtnText: { color: '#1A1204', fontSize: fontSize.sm, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },

  errorWrap: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700' },

  plainBox: {
    marginTop: spacing.md,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn,
    padding: spacing.md,
    gap: 4,
  },
  plainTitle: { color: colors.warn, fontSize: fontSize.xs, fontWeight: '800' },
  plainCode: { color: colors.textPrimary, fontSize: fontSize.sm, fontFamily: 'monospace' },

  section: { marginTop: spacing.lg },
  sectionTitle: {
    color: colors.textBody,
    fontSize: fontSize.sm,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    marginBottom: 4,
  },
  rowPrefix: { color: colors.textPrimary, fontSize: fontSize.xs, fontFamily: 'monospace', flex: 1 },
  rowAmount: { color: colors.textSecondary, fontSize: fontSize.xs, fontFamily: 'monospace' },
  rowStatus: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '800' },
  rowStatusUsed: { color: colors.textMuted },
  rowStatusRevoked: { color: colors.danger },
});

export default VoucherIssueCard;
