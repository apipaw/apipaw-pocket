import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LedgerEntry, describeCloudError, fetchBuyerLedger } from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 买家个人**收支账单明细**（阶段十 P1）。
 *
 * 这块面板回答买家最常见的三个问题：
 *   - 余额为什么涨了？（体验金 / 充值卡密）
 *   - 余额为什么跌了？（哪一次推理、哪个模型、哪个节点）
 *   - 我能不能**逐笔核对**？—— 每行都带 `balance_after_usd` 快照，
 *     从上往下加一遍应当分毫不差地回到当前余额。
 *
 * 口径（与阶段九公示栏一致）：**金额 9 位小数**，绝不截断失真。
 * 例：0.00136425 必须原样显示，截成 6 位就变成 0.001364 —— 那就失去
 * "可核对"的意义了。
 *
 * ⚠️ 本面板只读、且**只回本人**的流水（服务端按 account_handle 过滤）。
 */
const ENTRY_LABEL: Record<string, string> = {
  TOPUP: '充值',
  RECHARGE: '充值到账',
  USAGE: '推理扣费',
  SETTLE: '推理结算',
  HOLD: '预扣冻结',
  FAILED: '失败退回',
  WAIVED: '免单',
  REFUND: '退款',
  REWARD: '奖励',
  OPENER: '期初余额',
  ADJUST: '余额调整',
};

/** 9 位小数（去掉尾随 0，但**至少**保留 2 位，看起来像金额） */
const fmtUsd9 = (v: number | undefined | null): string => {
  const n = Number(v ?? 0);
  const fixed = n.toFixed(9);
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  const parts = trimmed.split('.');
  if (parts.length === 1) return `$${parts[0]}.00`;
  const frac = parts[1].padEnd(2, '0');
  return `$${parts[0]}.${frac}`;
};

const fmtTime = (ts: number): string => {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const BuyerLedgerCard: React.FC = () => {
  const apiKey = usePawStore((s) => s.apiKey);

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBuyerLedger(30);
      setRows(res.entries ?? []);
    } catch (e: unknown) {
      setError(describeCloudError(e, 'key'));
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次展开时才拉 —— 折叠状态下没必要打接口
  useEffect(() => {
    if (!open || !apiKey) return;
    void load();
  }, [open, apiKey, load]);

  if (!apiKey) {
    return (
      <View style={styles.card} testID="buyer-ledger-card">
        <Text style={styles.title}>收支账单明细</Text>
        <Text style={styles.hint}>配置 API Key 后可查看自己账户的每一笔收支流水。</Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="buyer-ledger-card" id="apx-glass-buyer-ledger">
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
        testID="buyer-ledger-toggle"
      >
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>收支账单明细</Text>
        </View>
        <Text style={styles.chevron}>{open ? '收起 ▲' : '展开 ▼'}</Text>
      </TouchableOpacity>

      {open ? (
        loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.cyan} />
            <Text style={styles.loadingText}>正在读取账单流水…</Text>
          </View>
        ) : error ? (
          <Text style={styles.errorText} testID="buyer-ledger-error">
            ⚠️ {error}
          </Text>
        ) : rows.length === 0 ? (
          <Text style={styles.hint} testID="buyer-ledger-empty">
            还没有任何流水（首次充值或发起一次推理后就会出现）
          </Text>
        ) : (
          <>
            <Text style={styles.subtitle}>
              最近 {rows.length} 笔 · 金额 9 位小数 · 每行带余额快照可逐笔核对
            </Text>
            {rows.map((row) => (
              <View key={row.id} style={styles.row} testID={`buyer-ledger-row-${row.id}`}>
                <View style={styles.rowHead}>
                  <Text style={styles.rowType}>
                    {ENTRY_LABEL[row.entry_type] || row.entry_type || '流水'}
                  </Text>
                  <Text
                    style={[
                      styles.rowAmount,
                      row.direction > 0 ? styles.rowAmountIn : styles.rowAmountOut,
                    ]}
                  >
                    {row.direction > 0 ? '+' : '-'}
                    {fmtUsd9(Math.abs(Number(row.amount_usd ?? 0))).replace('$', '$')}
                  </Text>
                </View>
                <View style={styles.rowMeta}>
                  <Text style={styles.rowMetaText} numberOfLines={1}>
                    {row.model_id ? `模型 ${row.model_id}` : row.note || '—'}
                    {row.node_id ? ` · 节点 ${row.node_id}` : ''}
                  </Text>
                  <Text style={styles.rowMetaText}>{fmtTime(Number(row.created_at ?? 0))}</Text>
                </View>
                <Text style={styles.rowAfter}>
                  余额快照 {fmtUsd9(Number(row.balance_after_usd ?? 0))}
                </Text>
              </View>
            ))}
          </>
        )
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
    backgroundColor: colors.cyan,
    shadowColor: colors.cyan,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  chevron: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },

  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  loadingText: { color: colors.textSecondary, fontSize: fontSize.xs },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },

  row: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    marginTop: 4,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowType: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '800' },
  rowAmount: { fontSize: fontSize.sm, fontWeight: '800', fontFamily: 'monospace' },
  rowAmountIn: { color: colors.accent },
  rowAmountOut: { color: colors.warn },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: 2,
  },
  rowMetaText: { color: colors.textMuted, fontSize: fontSize.xs, flexShrink: 1 },
  rowAfter: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: 'monospace', marginTop: 2 },
});

export default BuyerLedgerCard;
