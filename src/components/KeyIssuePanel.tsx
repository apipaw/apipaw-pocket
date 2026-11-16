import React, { useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  claimTrialFaucet,
  describeCloudError,
  describeFaucetError,
  issueApiKey,
  IssuedApiKey,
} from '../api/cloudClient';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';

/**
 * 买家签发台（阶段四 P2）
 *
 * 挂在「设置 API Key」弹窗内 —— 没有密钥的人不必去别处找入口。
 *
 * 三条硬约束必须在界面上说清楚（不是可选文案，是**契约**）:
 *   1. 明文 Key **只显示这一次** —— 服务端只存 sha256 哈希，关闭后无法再查看；
 *   2. 新账户余额恒为 **$0** —— 想发起推理必须先充值（充值走后端充值接口，
 *      公开页**不提供**充值按钮，见 P2 决策）；
 *   3. 限流 5 把/小时 —— 超限返回 429，要给出明确的下一步动作。
 *
 * 因此结果区必须**先勾选「我已保存」才能保存并使用** —— 避免用户误关弹窗丢密钥。
 */

type Props = {
  /** 用户确认保存后回调（父组件负责写入 localStorage 并关闭弹窗） */
  onAdopt: (apiKey: string) => void;
  /** 体验金到账后回调（父组件刷新余额显示） */
  onFaucet?: (balanceUsd: number) => void;
};

export default function KeyIssuePanel({ onAdopt, onFaucet }: Props) {
  const [issuing, setIssuing] = useState(false);
  const [result, setResult] = useState<IssuedApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // 阶段八 P1：新手体验金（终身一次）
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [faucetOk, setFaucetOk] = useState(false);

  const handleIssue = async () => {
    setIssuing(true);
    setError(null);
    setResult(null);
    setCopied(false);
    setConfirmed(false);
    try {
      const rec = await issueApiKey();
      setResult(rec);
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      setError(
        status === 429
          ? '签发过于频繁（每个 IP 每小时最多 5 次），请稍后再试。'
          : describeCloudError(e),
      );
    } finally {
      setIssuing(false);
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await Clipboard.setStringAsync(result.api_key);
      setCopied(true);
    } catch {
      // 剪贴板不可用（非安全上下文 / 权限被拒）—— 明文仍在界面上, 手动选中即可
      setCopied(false);
    }
  };

  /**
   * 领取新手体验金 $0.50（阶段八 P1）。
   *
   * 走到这一步的用户手里只有一把 $0 余额的 Key —— 没有一分钱可花，
   * 于是「真流式推理」根本跑不起来。这个按钮把最后一块拼图补上：
   * **点一下 → 到账 $0.50 → 立刻能跑一次真推理**。
   */
  const handleFaucet = async () => {
    if (!result) return;
    setFaucetBusy(true);
    setFaucetMsg(null);
    try {
      const rec = await claimTrialFaucet(result.api_key);
      setFaucetOk(true);
      setFaucetMsg(`已到账 $${(rec.amount_usd ?? 0).toFixed(2)} —— 现在就能发起真实推理了`);
      onFaucet?.(rec.balance_usd ?? 0);
    } catch (e) {
      setFaucetOk(false);
      setFaucetMsg(describeFaucetError(e));
    } finally {
      setFaucetBusy(false);
    }
  };

  return (
    <View style={styles.wrap} testID="key-issue-panel">
      <View style={styles.headRow}>
        <Text style={styles.headTitle}>自助签发</Text>
        <Text style={styles.headTag}>30 秒 · 无需邮箱</Text>
      </View>

      {!result && (
        <>
          <Text style={styles.desc}>
            没有现成密钥？点一下即刻签发一把专属 API Key。
          </Text>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary]}
            onPress={handleIssue}
            disabled={issuing}
            activeOpacity={0.8}
            testID="issue-key-btn"
          >
            {issuing ? (
              <ActivityIndicator size="small" color="#052E21" />
            ) : (
              <Text style={styles.btnPrimaryText}>签发新 Key</Text>
            )}
          </TouchableOpacity>
        </>
      )}

      {error !== null && (
        <View style={styles.errorBox} testID="issue-key-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {result !== null && (
        <View style={styles.resultBox} testID="issue-key-result">
          <View style={styles.warnRow}>
            <Text style={styles.warnDot}>▲</Text>
            <Text style={styles.warnText} testID="issue-key-once-warning">
              明文密钥只显示这一次，关闭后无法再次查看
            </Text>
          </View>

          <View style={styles.keyBox}>
            <Text style={styles.keyText} testID="issue-key-plaintext" selectable>
              {result.api_key}
            </Text>
          </View>

          <View style={styles.metaRow}>
            <Text style={styles.metaText} testID="issue-key-meta">
              账户 {result.account_handle} · 前缀 {result.key_prefix} · 后四位 {result.key_last4}
            </Text>
          </View>
          <Text style={styles.balanceNote} testID="issue-key-balance-note">
            初始余额 ${result.balance_usd.toFixed(2)} —— 领完新手体验金即可发起真实推理
          </Text>

          {/* 阶段八 P1 · 新手体验金水龙头 —— 签发成功弹窗内的领取入口 */}
          {faucetOk ? (
            <Text style={styles.faucetOk} testID="issue-key-faucet-ok">
              ✓ {faucetMsg}
            </Text>
          ) : (
            <TouchableOpacity
              style={[styles.btn, styles.btnGhost, styles.faucetBtn]}
              onPress={handleFaucet}
              disabled={faucetBusy}
              activeOpacity={0.8}
              testID="issue-key-faucet-btn"
            >
              {faucetBusy ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Text style={styles.btnGhostText}>免费领取 $0.50 新手体验金</Text>
              )}
            </TouchableOpacity>
          )}
          {faucetMsg && !faucetOk ? (
            <Text style={styles.faucetErr} testID="issue-key-faucet-error">
              {faucetMsg}
            </Text>
          ) : null}

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.btn, styles.btnGhost, styles.actionBtn]}
              onPress={handleCopy}
              activeOpacity={0.8}
              testID="issue-key-copy"
            >
              <Text style={styles.btnGhostText}>{copied ? '已复制' : '复制密钥'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnGhost, styles.actionBtn]}
              onPress={handleIssue}
              disabled={issuing}
              activeOpacity={0.8}
              testID="issue-key-again"
            >
              <Text style={styles.btnGhostText}>重新签发</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.confirmRow}
            onPress={() => setConfirmed((v) => !v)}
            activeOpacity={0.8}
            testID="issue-key-confirm"
          >
            <View style={[styles.checkbox, confirmed && styles.checkboxOn]}>
              {confirmed && <Text style={styles.checkboxMark}>✓</Text>}
            </View>
            <Text style={styles.confirmText}>我已保存以上密钥</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, !confirmed && styles.btnDisabled]}
            onPress={() => onAdopt(result.api_key)}
            disabled={!confirmed}
            activeOpacity={0.8}
            testID="issue-key-save"
          >
            <Text style={styles.btnPrimaryText}>保存并使用此密钥</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headTitle: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  headTag: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '700',
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  desc: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },

  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.md,
  },
  btnPrimary: { backgroundColor: colors.accent },
  btnPrimaryText: { color: '#052E21', fontSize: fontSize.sm, fontWeight: '800' },
  btnGhost: { backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border },
  btnGhostText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },

  errorBox: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.sm,
  },
  errorText: { color: colors.danger, fontSize: fontSize.sm, lineHeight: 18 },

  resultBox: { gap: spacing.sm },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  warnDot: { color: colors.warn, fontSize: fontSize.xs },
  warnText: { color: colors.warn, fontSize: fontSize.xs, fontWeight: '700', flex: 1 },

  keyBox: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.sm,
  },
  keyText: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontFamily: monoFont,
    lineHeight: 18,
  },

  metaRow: { flexDirection: 'row', alignItems: 'center' },
  metaText: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: monoFont, flex: 1 },
  balanceNote: { color: colors.warn, fontSize: fontSize.xs, fontWeight: '700' },

  faucetBtn: { width: '100%' },
  faucetOk: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },
  faucetErr: { color: colors.danger, fontSize: fontSize.xs },

  actionRow: { flexDirection: 'row', gap: spacing.sm },
  actionBtn: { flex: 1 },

  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkboxMark: { color: '#052E21', fontSize: 11, fontWeight: '900' },
  confirmText: { color: colors.textBody, fontSize: fontSize.sm },
});
