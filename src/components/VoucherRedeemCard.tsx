import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { describeRedeemError, redeemVoucher } from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 买家自助「兑换充值码」（阶段九 P2）。
 *
 * 卡密的价值在于**不需要钱包、不需要绑卡**，拿到一串 `paw-topup-…` 就能储值。
 * 服务端保证：核销与入账在同一事务里，失败 409，重放与并发都只到账一次。
 *
 * 前端只做「把码递过去、把结果说出来」；**金额到账以服务端账本为准**，
 * 到账后回填余额显示（余额本身由 ``GET /api/v1/user/usage`` 权威回写）。
 */
const VoucherRedeemCard: React.FC = () => {
  const apiKey = usePawStore((s) => s.apiKey);
  const setBalanceUsd = usePawStore((s) => s.setBalanceUsd);

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setErrMsg('请输入充值码');
      setOkMsg(null);
      return;
    }
    setBusy(true);
    setErrMsg(null);
    setOkMsg(null);
    try {
      const res = await redeemVoucher(trimmed);
      setOkMsg(`已到账 $${Number(res.amount_usd).toFixed(2)}`);
      setBalanceUsd(Number(res.balance_usd));
      setCode('');
    } catch (e: unknown) {
      setErrMsg(describeRedeemError(e));
    } finally {
      setBusy(false);
    }
  }, [code, setBalanceUsd]);

  return (
    <View style={styles.box} testID="voucher-redeem-box">
      <Text style={styles.title}>兑换充值码</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="paw-topup-xxxxxxxx"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          testID="voucher-redeem-input"
        />
        <TouchableOpacity
          style={[styles.btn, busy && styles.btnDisabled]}
          onPress={() => void submit()}
          disabled={busy}
          activeOpacity={0.8}
          testID="voucher-redeem-btn"
        >
          {busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.btnText}>兑换</Text>
          )}
        </TouchableOpacity>
      </View>
      {okMsg ? (
        <Text style={styles.okText} testID="voucher-redeem-ok">
          ✓ {okMsg}
        </Text>
      ) : null}
      {errMsg ? (
        <Text style={styles.errText} testID="voucher-redeem-error">
          {errMsg}
        </Text>
      ) : null}
      {!apiKey ? (
        <Text style={styles.hint}>需要先配置 API Key 才能核销充值码。</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  box: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    gap: spacing.sm,
  },
  title: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  },
  btn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  btnText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },
  okText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },
  errText: { color: colors.danger, fontSize: fontSize.xs },
  hint: { color: colors.textMuted, fontSize: fontSize.xs },
});

export default VoucherRedeemCard;
