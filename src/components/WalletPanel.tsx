import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { usePawStore } from '../store/usePawStore';
import { connectWallet } from '../wallet/connectWallet';
import { revokeSession } from '../wallet/api';
import { WalletError } from '../wallet/types';
import { Surface, StatusDot } from './ui';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';

/**
 * 钱包登录面板（阶段四 P4）。
 *
 * 展示当前会话状态，并提供「连接钱包 / 断开连接」两个动作。
 *
 * ⚠️ 这里的签名是**真签名**：走钱包 App 的 `personal_sign`，
 *    服务端会用 ecrecover 恢复出签名者地址再比对 —— 前端没有任何「跳过验签」开关。
 */

const shortAddress = (addr: string): string =>
  addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;

export interface WalletPanelProps {
  /** 登录成功后回调（App 用来关弹窗并刷新数据） */
  onConnected?: () => void;
}

const WalletPanel: React.FC<WalletPanelProps> = ({ onConnected }) => {
  const { sessionToken, sessionWallet, sessionRole, sessionStatus, sessionHandle, setSession, clearSession } =
    usePawStore();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const connected = Boolean(sessionToken);

  const handleConnect = async () => {
    setBusy(true);
    setError('');
    setProgress('正在准备钱包连接…');
    try {
      const session = await connectWallet(undefined, (step) => setProgress(step));
      setSession(session);
      setProgress('');
      onConnected?.();
    } catch (e) {
      setProgress('');
      setError(e instanceof WalletError ? e.message : (e as Error)?.message || '钱包连接失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await revokeSession(sessionToken);
    } finally {
      clearSession();
      setBusy(false);
      setError('');
    }
  };

  if (connected) {
    const pending = sessionStatus && sessionStatus !== 'active';
    return (
      <Surface webId="apx-glass-wallet" style={styles.card} testID="wallet-panel">
        <View style={styles.headRow}>
          <StatusDot variant="live" color={pending ? colors.warn : colors.accent} size={7} />
          <Text style={styles.title}>钱包已连接</Text>
          <View style={styles.spacer} />
          <Text style={styles.role} testID="wallet-role">
            {sessionRole === 'OWNER' ? '业主' : '买家'}
          </Text>
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>登录钱包</Text>
          <Text style={styles.value} testID="wallet-address">
            {shortAddress(sessionWallet)}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>账户句柄</Text>
          <Text style={styles.value}>{sessionHandle || '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>会话状态</Text>
          <Text style={[styles.value, pending && { color: colors.warn }]}>
            {pending ? '待审核（暂无业主权限）' : '已生效 · 2 小时有效'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.btn, styles.btnGhost]}
          onPress={handleDisconnect}
          disabled={busy}
          activeOpacity={0.8}
          testID="wallet-disconnect"
        >
          <Text style={styles.btnGhostText}>断开连接</Text>
        </TouchableOpacity>
      </Surface>
    );
  }

  return (
    <Surface webId="apx-glass-wallet" style={styles.card} testID="wallet-panel">
      <View style={styles.headRow}>
        <StatusDot variant="alert" color={colors.cyan} size={7} />
        <Text style={styles.title}>钱包签名登录</Text>
      </View>
      <Text style={styles.desc}>
        用你的钱包私钥对一次性挑战消息签名，换取 2 小时有效的会话令牌。
        服务端只恢复公钥比对地址，**不会**代你签名，也**不会**接触你的私钥。
      </Text>

      {progress ? <Text style={styles.progress}>{progress}</Text> : null}
      {error ? (
        <Text style={styles.error} testID="wallet-error">
          {error}
        </Text>
      ) : null}

      <TouchableOpacity
        style={[styles.btn, styles.btnPrimary]}
        onPress={handleConnect}
        disabled={busy}
        activeOpacity={0.8}
        testID="wallet-connect"
      >
        <Text style={styles.btnPrimaryText}>{busy ? '连接中…' : '连接钱包'}</Text>
      </TouchableOpacity>
      <Text style={styles.footNote}>
        支持浏览器钱包扩展（MetaMask / Rabby）；移动端 App 会唤起 MetaMask 移动端。
      </Text>
    </Surface>
  );
};

export default WalletPanel;

const styles = StyleSheet.create({
  card: { gap: spacing.md },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800' },
  spacer: { flex: 1 },
  role: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '800' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: colors.textSecondary, fontSize: fontSize.sm },
  value: {
    color: colors.textBody,
    fontSize: fontSize.sm,
    fontWeight: '700',
    fontFamily: monoFont,
  },
  desc: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
  progress: { color: colors.cyan, fontSize: fontSize.sm, fontWeight: '700' },
  error: { color: colors.danger, fontSize: fontSize.sm, lineHeight: 19 },
  btn: {
    paddingVertical: 11,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnPrimaryText: { color: '#052E21', fontSize: fontSize.md, fontWeight: '800' },
  btnGhost: { backgroundColor: colors.bgElevated, borderColor: colors.border },
  btnGhostText: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: '700' },
  footNote: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17 },
});
