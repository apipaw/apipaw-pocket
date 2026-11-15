import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  MeteringAccuracy,
  ModelPriceRequest,
  decideOwnerPriceRequest,
  describeCloudError,
  fetchMeteringAccuracy,
  fetchOwnerPriceRequests,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 定价审批面板（阶段六 P3-2 · OWNER 专属）。
 *
 * 两块：
 *   1. **改价申请队列** —— 创作者申请改价，OWNER 签字后才真正写进 `models` 表；
 *      未签字前线上计费基线**分毫不动**（前端绝不自行改价）。
 *   2. **计量对齐评估** —— 估算 token vs 真实 token 的偏差（usage_source 分组），
 *      用于判断"按 usage 结算"到底准不准。
 *
 * ⚠️ 权限口径：**服务端权威**。这里只对 OWNER 会话生效。
 */
const PricingApprovalCard: React.FC = () => {
  const sessionRole = usePawStore((s) => s.sessionRole);
  const sessionToken = usePawStore((s) => s.sessionToken);

  const [requests, setRequests] = useState<ModelPriceRequest[]>([]);
  const [metering, setMetering] = useState<MeteringAccuracy | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isOwner = sessionRole === 'OWNER';

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchOwnerPriceRequests('PENDING', 50);
      setRequests(res.requests ?? []);
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMetering = useCallback(async () => {
    try {
      const data = await fetchMeteringAccuracy(1440);
      setMetering(data);
    } catch (e: unknown) {
      // 计量评估是辅助信息，失败不阻塞审批主流程
      console.log('读取计量评估失败:', e);
    }
  }, []);

  useEffect(() => {
    if (!sessionToken || !isOwner) {
      setLoading(false);
      return;
    }
    void load();
    void loadMetering();
  }, [sessionToken, isOwner, load, loadMetering]);

  const handleDecide = async (req: ModelPriceRequest, approve: boolean) => {
    setBusyId(req.id);
    setError(null);
    setNotice(null);
    try {
      await decideOwnerPriceRequest(req.id, approve, approve ? 'OWNER 批准' : 'OWNER 驳回');
      setNotice(`申请 #${req.id}（${req.model_id}）已${approve ? '批准并生效' : '驳回'}`);
      await load();
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setBusyId(null);
    }
  };

  if (!sessionToken) {
    return (
      <View style={styles.card} testID="pricing-approval-card">
        <Text style={styles.cardTitle}>定价审批</Text>
        <Text style={styles.hint}>
          改价需要 OWNER 签字。连接钱包后，这里显示待审的改价申请队列。
        </Text>
      </View>
    );
  }

  if (!isOwner) {
    return (
      <View style={styles.card} testID="pricing-approval-card">
        <Text style={styles.cardTitle}>定价审批</Text>
        <Text style={styles.hint}>
          当前会话不是 OWNER 角色，无权查看改价申请队列（服务端按角色鉴权）。
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="pricing-approval-card" id="apx-glass-pricing-approval">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>定价审批（OWNER）</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load} activeOpacity={0.75}>
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在读取改价申请队列...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </View>
      ) : (
        <>
          {notice ? <Text style={styles.noticeText}>✓ {notice}</Text> : null}

          {/* ---------------- 改价申请队列 ---------------- */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>待审改价申请（{requests.length}）</Text>
            {requests.length === 0 ? (
              <Text style={styles.emptyText}>当前没有待审的改价申请</Text>
            ) : (
              requests.map((req) => (
                <View key={req.id} style={styles.reqRow} testID={`pricing-req-${req.id}`}>
                  <View style={styles.reqHead}>
                    <Text style={styles.reqTitle}>
                      #{req.id} · {req.model_id}
                    </Text>
                    <Text style={styles.reqMeta}>
                      {req.author_wallet || '未知钱包'} ·{' '}
                      {new Date(req.created_at * 1000).toLocaleString()}
                    </Text>
                  </View>

                  <View style={styles.priceCompare}>
                    <View style={styles.priceBox}>
                      <Text style={styles.priceLabel}>当前</Text>
                      <Text style={styles.priceValue}>
                        ${req.current_prompt_price_per_1k.toFixed(4)} / ${req.current_completion_price_per_1k.toFixed(4)}
                      </Text>
                    </View>
                    <Text style={styles.priceArrow}>→</Text>
                    <View style={styles.priceBox}>
                      <Text style={styles.priceLabel}>申请</Text>
                      <Text style={[styles.priceValue, styles.priceValueNew]}>
                        ${req.prompt_price_per_1k.toFixed(4)} / ${req.completion_price_per_1k.toFixed(4)}
                      </Text>
                    </View>
                  </View>

                  {req.reason ? <Text style={styles.reqReason}>理由：{req.reason}</Text> : null}

                  <View style={styles.reqActions}>
                    <TouchableOpacity
                      testID={`pricing-approve-${req.id}`}
                      style={[styles.approveBtn, busyId === req.id && styles.btnDisabled]}
                      onPress={() => void handleDecide(req, true)}
                      disabled={busyId === req.id}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.approveBtnText}>批准并生效</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`pricing-reject-${req.id}`}
                      style={[styles.rejectBtn, busyId === req.id && styles.btnDisabled]}
                      onPress={() => void handleDecide(req, false)}
                      disabled={busyId === req.id}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.rejectBtnText}>驳回</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
            <Text style={styles.hint}>
              ⚠️ 批准前线上计费按**当前价**走；批准动作才写库改价，且会留下审批留痕。
            </Text>
          </View>

          {/* ---------------- 计量对齐评估 ---------------- */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>计量对齐评估（近 24h）</Text>
            {!metering ? (
              <Text style={styles.emptyText}>暂无评估数据</Text>
            ) : (
              <>
                <View style={styles.meterRow}>
                  <View style={styles.meterBox}>
                    <Text style={styles.meterLabel}>样本</Text>
                    <Text style={styles.meterValue}>{metering.samples}</Text>
                  </View>
                  <View style={styles.meterBox}>
                    <Text style={styles.meterLabel}>判定</Text>
                    <Text style={[styles.meterValue, styles.meterVerdict]}>{metering.verdict}</Text>
                  </View>
                </View>
                {metering.by_source && metering.by_source.length > 0 ? (
                  <View style={styles.srcRow}>
                    {metering.by_source.map((s) => (
                      <View key={s.src} style={styles.srcChip}>
                        <Text style={styles.srcChipText}>
                          {s.src} · {s.c}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <Text style={styles.hint}>{metering.note}</Text>
              </>
            )}
          </View>
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
    marginBottom: spacing.md,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.purple,
    shadowColor: colors.purple,
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

  reqRow: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  reqHead: { marginBottom: spacing.sm },
  reqTitle: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  reqMeta: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  priceCompare: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  priceBox: {
    flex: 1,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.sm,
  },
  priceLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  priceValue: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    marginTop: 2,
  },
  priceValueNew: { color: colors.purple },
  priceArrow: { color: colors.textMuted, fontSize: fontSize.sm },

  reqReason: { color: colors.textBody, fontSize: fontSize.xs, marginTop: spacing.sm },
  reqActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
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

  meterRow: { flexDirection: 'row', gap: spacing.sm },
  meterBox: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  meterLabel: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  meterValue: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800', marginTop: 2 },
  meterVerdict: { color: colors.accent },
  srcRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  srcChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  srcChipText: { color: colors.textSecondary, fontSize: fontSize.xs },

  noticeText: { color: colors.accent, fontSize: fontSize.xs, marginBottom: spacing.sm },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs },

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

export default PricingApprovalCard;
