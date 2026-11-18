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
  NodeEarnings,
  describeCloudError,
  fetchNodeEarnings,
  submitNodeWithdrawal,
} from '../api/cloudClient';
import { getInjectedProvider } from '../wallet/providers';
import { encodeErc20Transfer, toUnits } from '../wallet/eth';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 节点业主收益与提现（阶段六 P3 · 模块 C）。
 *
 * 两条通道：
 *   · **内部台账**（默认，唯一在生产打开的）—— 登记提现申请，云端记账；
 *   · **链上 PAW**（需服务端配置代币合约 + 收款地址）—— **由业主自己的钱包**
 *     在前端用 ethers 广播 ERC-20 转账，然后把 tx_hash 回传云端。
 *
 * 🔴 **云端不托管私钥、不代签**：这里调的是用户钱包扩展的 provider，
 *    签名发生在 MetaMask 里，私钥从不进过本应用。
 */

/** ERC-20 `transfer(address,uint256)` —— calldata 由 `encodeErc20Transfer` 本地拼 */
const PAW_DECIMALS = 18;

/** 取钱包当前账户（钱包未显式带出登录地址时的兜底） */
const firstInjectedAccount = async (provider: {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}): Promise<string> => {
  const accounts = await provider.request({ method: 'eth_accounts' });
  const list = Array.isArray(accounts) ? accounts : [];
  const first = String(list[0] || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(first)) {
    throw new Error('钱包未返回可用账户，请先解锁钱包扩展');
  }
  return first;
};

/** 轮询交易回执（最多约 60 秒；拿不到就回退用交易哈希记账） */
const waitForReceipt = async (
  provider: { request(args: { method: string; params?: unknown[] }): Promise<unknown> },
  txHash: string,
): Promise<string | null> => {
  for (let i = 0; i < 15; i += 1) {
    try {
      const receipt = await provider.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt && typeof receipt === 'object') {
        return txHash;
      }
    } catch (e: any) {
      // 钱包/节点不支持该方法（EIP-1193 4200）—— 直接放弃等待，用哈希记账
      if (e?.code === 4200) return null;
      /* 节点还没索引到这笔交易 —— 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
};

const NodePayoutCard: React.FC = () => {
  const { sessionToken, sessionWallet } = usePawStore();

  const [earnings, setEarnings] = useState<NodeEarnings | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [chainInfo, setChainInfo] = useState<{
    token: string;
    recipient: string;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchNodeEarnings();
      setEarnings(data);
    } catch (e: any) {
      setError(describeCloudError(e, 'session'));
    }
  }, []);

  useEffect(() => {
    if (!sessionToken) {
      setEarnings(null);
      return;
    }
    void load();
  }, [sessionToken, load]);

  const handleWithdraw = useCallback(async () => {
    setError(null);
    setSuccess(null);
    const value = parseFloat(amount.trim());
    if (!Number.isFinite(value) || value <= 0) {
      setError('请输入大于 0 的提现金额（美元）');
      return;
    }
    setBusy(true);
    try {
      const res = await submitNodeWithdrawal(value, '', '节点收益提现');
      setChainInfo(
        res.chain_channel_enabled
          ? { token: res.payout_token_address, recipient: (res as any).payout_recipient || '' }
          : null,
      );
      setSuccess(
        `✅ 已登记提现 $${value.toFixed(4)}（${res.withdrawal.amount_paw.toFixed(2)} PAW），状态 ${res.withdrawal.status}`,
      );
      setAmount('');
      await load();
    } catch (e: any) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setBusy(false);
    }
  }, [amount, load]);

  /** 链上广播：用业主钱包转 PAW，然后把 tx_hash 回传云端记账 */
  const handleBroadcast = useCallback(
    async (withdrawalId: number, amountPaw: number) => {
      setError(null);
      setSuccess(null);
      if (!chainInfo?.token || !chainInfo?.recipient) {
        setError('链上通道未启用（服务端未配置代币合约与收款地址）');
        return;
      }
      const provider = getInjectedProvider();
      if (!provider) {
        setError('链上广播需要浏览器钱包扩展（Web 端）；原生端暂不支持直接广播');
        return;
      }
      setBusy(true);
      try {
        // 用钱包原生 `eth_sendTransaction` 广播 ERC-20 transfer：
        // calldata 由本地拼（transfer 选择器 + 两个 32 字节槽位），
        // 签名与广播都在业主钱包里完成，云端不托管私钥。
        const from = sessionWallet || (await firstInjectedAccount(provider));
        const data = encodeErc20Transfer(
          chainInfo.recipient,
          toUnits(String(amountPaw), PAW_DECIMALS),
        );
        const txHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: chainInfo.token, value: '0x0', data }],
        });
        if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
          throw new Error('钱包未返回合法的交易哈希');
        }
        const receipt = await waitForReceipt(provider, txHash);
        const { broadcastNodeWithdrawal } = await import('../api/cloudClient');
        await broadcastNodeWithdrawal(withdrawalId, receipt || txHash);
        setSuccess(`🔗 链上广播成功（tx ${txHash.slice(0, 10)}…），云端已记账`);
        await load();
      } catch (e: any) {
        setError(`链上广播失败：${(e as Error)?.message || String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [chainInfo, sessionWallet, load],
  );

  if (!sessionToken) {
    return (
      <View style={styles.card} testID="node-payout-card">
        <Text style={styles.title}>节点收益与提现</Text>
        <Text style={styles.hint}>连接钱包后，这里显示**你名下**节点的收益与提现入口。</Text>
      </View>
    );
  }

  const pending = (earnings?.withdrawals || []).filter((w) => w.status === 'PENDING');

  return (
    <View style={styles.card} testID="node-payout-card">
      <View style={styles.header}>
        <Text style={styles.title}>节点收益与提现</Text>
        <Text style={styles.sub}>钱包会话口径 · 云端不托管私钥</Text>
      </View>

      <View style={styles.statRow}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>${(earnings?.earned_usd ?? 0).toFixed(4)}</Text>
          <Text style={styles.statLabel}>累计收益</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>${(earnings?.available_usd ?? 0).toFixed(4)}</Text>
          <Text style={styles.statLabel}>可提余额</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statValue}>${(earnings?.withdrawn_usd ?? 0).toFixed(4)}</Text>
          <Text style={styles.statLabel}>已提</Text>
        </View>
      </View>

      <View style={styles.inputRow}>
        <TextInput
          testID="node-payout-amount"
          style={[styles.input, styles.amountInput]}
          value={amount}
          onChangeText={setAmount}
          placeholder="提现金额 (USD)"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
        />
        <TouchableOpacity
          testID="node-payout-btn"
          style={[styles.primaryBtn, busy && styles.btnDisabled]}
          onPress={handleWithdraw}
          disabled={busy}
          activeOpacity={0.8}
        >
          {busy ? (
            <ActivityIndicator color={colors.bg} size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>登记提现</Text>
          )}
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </View>
      ) : null}
      {success ? (
        <View style={styles.successBox}>
          <Text style={styles.successText}>{success}</Text>
        </View>
      ) : null}

      {pending.length > 0 ? (
        <View style={styles.list} testID="node-payout-pending">
          <Text style={styles.listTitle}>待处理提现</Text>
          {pending.map((w) => (
            <View key={w.id} style={styles.listRow}>
              <Text style={styles.listMain}>
                #{w.id} · ${w.amount_usd.toFixed(4)} · {w.amount_paw.toFixed(2)} PAW
              </Text>
              {chainInfo ? (
                <TouchableOpacity
                  testID={`node-payout-broadcast-${w.id}`}
                  style={styles.chainBtn}
                  onPress={() => void handleBroadcast(w.id, w.amount_paw)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.chainBtnText}>链上广播</Text>
                </TouchableOpacity>
              ) : null}
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
    marginTop: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  sub: { color: colors.textMuted, fontSize: fontSize.xs },
  hint: { color: colors.textMuted, fontSize: fontSize.sm },

  statRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  stat: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.sm,
  },
  statValue: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  statLabel: { color: colors.textMuted, fontSize: 12, marginTop: 2 },

  inputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  amountInput: { flex: 1 },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#04211A', fontWeight: '800', fontSize: fontSize.sm },
  btnDisabled: { opacity: 0.6 },

  errorBox: {
    marginTop: spacing.md,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: fontSize.sm },
  successBox: {
    marginTop: spacing.md,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.md,
  },
  successText: { color: colors.accent, fontSize: fontSize.sm },

  list: { marginTop: spacing.md, gap: spacing.xs },
  listTitle: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listMain: { color: colors.textBody, fontSize: 12, fontFamily: 'monospace' },
  chainBtn: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  chainBtnText: { color: colors.purple, fontSize: fontSize.xs, fontWeight: '700' },
});

export default NodePayoutCard;
