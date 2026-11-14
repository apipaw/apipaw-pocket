import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import { usePawStore } from '../store/usePawStore';
import {
  RoyaltyResponse,
  RoyaltyRateRequest,
  describeCloudError,
  fetchCreatorRoyalty,
  fetchCreatorRoyaltyRequests,
  submitCreatorRoyaltyRequest,
  withdrawCreatorRoyalty,
} from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';

const CHART_HEIGHT = 150;
const CHART_PADDING_LEFT = 40;
const CHART_PADDING_RIGHT = 10;
const CHART_PADDING_TOP = 12;
const CHART_PADDING_BOTTOM = 24;

/**
 * 版税走势折线图 (24 小时)
 * 与买家端 AnalyticsCard 保持同一套 SVG 手绘风格。
 */
const RoyaltyTrendChart: React.FC<{ data: RoyaltyResponse | null; width: number }> = ({
  data,
  width,
}) => {
  const hours = data?.hours ?? [];
  const innerW = Math.max(1, width - CHART_PADDING_LEFT - CHART_PADDING_RIGHT);
  const innerH = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

  const maxValue = useMemo(() => {
    const max = Math.max(0.000001, ...hours.map((h) => h.royalty_usd));
    const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
    return Math.ceil(max / magnitude) * magnitude;
  }, [hours]);

  const xAt = (index: number) =>
    CHART_PADDING_LEFT + (hours.length <= 1 ? 0 : (index / (hours.length - 1)) * innerW);
  const yAt = (value: number) => CHART_PADDING_TOP + innerH - (value / maxValue) * innerH;

  const linePath = hours
    .map(
      (h, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(h.royalty_usd).toFixed(2)}`,
    )
    .join(' ');

  const areaPath = hours.length
    ? `${linePath} L ${xAt(hours.length - 1).toFixed(2)} ${(
        CHART_PADDING_TOP + innerH
      ).toFixed(2)} L ${xAt(0).toFixed(2)} ${(CHART_PADDING_TOP + innerH).toFixed(2)} Z`
    : '';

  const gridValues = [0, 0.5, 1].map((ratio) => maxValue * ratio);

  return (
    <Svg width={width} height={CHART_HEIGHT}>
      {gridValues.map((value, i) => {
        const y = yAt(value);
        return (
          <React.Fragment key={`grid-${i}`}>
            <Line
              x1={CHART_PADDING_LEFT}
              y1={y}
              x2={CHART_PADDING_LEFT + innerW}
              y2={y}
              stroke={colors.chartGrid}
              strokeWidth={1}
            />
            <SvgText
              x={CHART_PADDING_LEFT - 6}
              y={y + 3.5}
              fill={colors.textMuted}
              fontSize={9}
              textAnchor="end"
            >
              {value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`}
            </SvgText>
          </React.Fragment>
        );
      })}

      {areaPath ? <Path d={areaPath} fill="rgba(245, 158, 11, 0.14)" /> : null}
      {linePath ? (
        <Path
          d={linePath}
          stroke={colors.chartCreator}
          strokeWidth={2}
          fill="none"
          strokeLinejoin="round"
        />
      ) : null}

      {hours.map((h, i) =>
        i % 6 === 0 ? (
          <SvgText
            key={`x-${h.index}`}
            x={xAt(i)}
            y={CHART_HEIGHT - 6}
            fill={colors.textMuted}
            fontSize={9}
            textAnchor="middle"
          >
            {h.label}
          </SvgText>
        ) : null,
      )}
    </Svg>
  );
};

/**
 * 创作者版税大盘 (CreatorEx)
 * 展示版税实时明细、Token 调用走势与一键提现；生效比例以服务端 `royalty_rate` 为准
 * （阶段六 P2 起不再写死 15%）。
 */
const RoyaltyCard: React.FC = () => {
  const { creatorWallet } = usePawStore();

  const [data, setData] = useState<RoyaltyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(320);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [withdrawDone, setWithdrawDone] = useState<string | null>(null);

  // ---- 版税率申请（阶段六 P2 · D2 / D4 路 A）----
  const [requests, setRequests] = useState<RoyaltyRateRequest[]>([]);
  const [rateInput, setRateInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestDone, setRequestDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchCreatorRoyalty(24);
      setData(res);
    } catch (e: any) {
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 拉取**我提交的**版税率申请（进度追踪）。
   *
   * 失败不打断主面板 —— 版税大盘本身可读，申请列表只是附加信息。
   */
  const loadRequests = useCallback(async () => {
    try {
      const res = await fetchCreatorRoyaltyRequests(50);
      setRequests(res.requests ?? []);
    } catch (e) {
      console.log('读取版税申请失败:', e);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const totals = data?.totals;

  const handleWithdraw = useCallback(async () => {
    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setWithdrawError('请输入有效的提现金额 (USD)');
      return;
    }
    setWithdrawError(null);
    setWithdrawing(true);
    try {
      const res = await withdrawCreatorRoyalty(amount, 'CreatorEx 一键提现');
      setWithdrawDone(
        `✓ 提现申请已提交 · ${res.withdrawal.amount_paw.toFixed(2)} PAW ($${
          res.withdrawal.amount_usd
        }) · 状态 ${res.withdrawal.status}`,
      );
      setWithdrawAmount('');
      await load();
    } catch (e: any) {
      setWithdrawError(describeCloudError(e));
    } finally {
      setWithdrawing(false);
    }
  }, [withdrawAmount, load]);

  /**
   * 提交期望版税率（D4 路 A：平台定价 + 申请 + OWNER 审批）。
   *
   * ⚠️ 本端点**只落申请**，不直接改价 —— 定价级变更必须 OWNER 签字。
   * 输入用**百分比**（如 20 表示 20%），后端收的是 0~1 的比例。
   */
  const handleRequestRate = useCallback(async () => {
    const pct = Number(rateInput);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 30) {
      setRequestError('请输入 0 ~ 30 之间的版税率百分比（如 20 表示 20%）');
      return;
    }
    if (!data?.models.length) {
      setRequestError('当前账号名下没有上架模型，无法提交版税率申请');
      return;
    }
    setRequestError(null);
    setRequesting(true);
    try {
      const res = await submitCreatorRoyaltyRequest(
        data.models[0].model_id,
        pct / 100,
        reasonInput.trim(),
      );
      setRequestDone(
        `✓ 申请已提交 · ${res.request.model_id} · 期望 ${(res.request.requested_rate * 100).toFixed(1)}%`,
      );
      setRateInput('');
      setReasonInput('');
      await loadRequests();
    } catch (e: any) {
      setRequestError(describeCloudError(e));
    } finally {
      setRequesting(false);
    }
  }, [rateInput, reasonInput, data, loadRequests]);

  return (
    <View style={styles.card} testID="royalty-card" id="apx-glass-royalty">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>创作者版税大盘</Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load} activeOpacity={0.75}>
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.warn} />
          <Text style={styles.loadingText}>正在结算 24 小时版税收益...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorHint}>请确认云端网关 cloud.apipaw.com 可达，且当前账号已绑定创作者钱包</Text>
        </View>
      ) : (
        <>
          {/* 版税概览 */}
          <View style={styles.metricRow}>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>24h 版税收益</Text>
              <Text style={[styles.metricValue, styles.metricValueAccent]}>
                ${totals?.royalty_usd.toFixed(4) ?? '0.0000'}
              </Text>
              <Text style={styles.metricSub}>
                {(totals?.royalty_paw ?? 0).toFixed(2)} PAW
              </Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>调用次数</Text>
              <Text style={styles.metricValue}>{totals?.calls ?? 0}</Text>
              <Text style={styles.metricSub}>24 小时窗口</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricLabel}>总 Tokens</Text>
              <Text style={styles.metricValue}>
                {(totals?.total_tokens ?? 0).toLocaleString()}
              </Text>
              <Text style={styles.metricSub}>
                ↑{(totals?.completion_tokens ?? 0).toLocaleString()} 输出
              </Text>
            </View>
          </View>

          {/* 可提余额 + 一键提现 */}
          <View style={styles.balanceBox}>
            <View style={styles.balanceLeft}>
              <Text style={styles.balanceLabel}>可提余额</Text>
              <Text style={styles.balanceValue}>
                ${data?.available_usd.toFixed(4) ?? '0.0000'}
              </Text>
              <Text style={styles.balanceSub}>
                {(data?.available_paw ?? 0).toFixed(2)} PAW · 已提 $
                {(data?.withdrawn_usd ?? 0).toFixed(4)}
              </Text>
            </View>
            <TouchableOpacity
              testID="royalty-withdraw-btn"
              style={[
                styles.withdrawBtn,
                (data?.available_usd ?? 0) <= 0 && styles.withdrawBtnDisabled,
              ]}
              onPress={() => {
                setWithdrawError(null);
                setWithdrawDone(null);
                setWithdrawOpen(true);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.withdrawBtnText}>一键提现</Text>
            </TouchableOpacity>
          </View>

          {/* 版税走势 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {`24 小时版税走势 · ${((data?.royalty_rate ?? 0) * 100).toFixed(0)}% 创作者分成`}
            </Text>
            <View
              style={styles.chartBox}
              onLayout={(e) => setChartWidth(e.nativeEvent.layout.width)}
            >
              <RoyaltyTrendChart data={data} width={chartWidth} />
            </View>
          </View>

          {/* 分模型明细 */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>分模型版税明细</Text>
            {data?.models.length ? (
              data.models.map((model) => (
                <View key={model.model_id} style={styles.modelRow}>
                  <View style={styles.modelRowHeader}>
                    <Text style={styles.modelName}>{model.display_name}</Text>
                    <Text style={styles.modelRoyalty}>${model.royalty_usd.toFixed(4)}</Text>
                  </View>
                  <View style={styles.modelBarTrack}>
                    <View
                      style={[
                        styles.modelBarFill,
                        {
                          width: `${Math.max(
                            2,
                            (model.royalty_usd /
                              Math.max(
                                0.000001,
                                ...(data.models.map((m) => m.royalty_usd)),
                              )) *
                              100,
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.modelMeta}>
                    {model.calls} 次调用 · {model.total_tokens.toLocaleString()} tokens ·{' '}
                    {model.royalty_paw.toFixed(2)} PAW
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.emptyText}>暂无上架模型，先到工作台完成模型上架</Text>
            )}
          </View>

          {/* ---------------- 版税率申请（D4 路 A · D2）---------------- */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>版税率申请</Text>
            <Text style={styles.requestHint}>
              期望版税率由**平台定价 + 业主签字**决定：这里只提交申请，审批通过后即刻生效。
              当前生效比例 {(data?.royalty_rate ?? 0) * 100 > 0
                ? `${((data?.royalty_rate ?? 0) * 100).toFixed(1)}%`
                : '待平台确认'}
              。
            </Text>

            <View style={styles.requestRow}>
              <TextInput
                testID="royalty-rate-input"
                style={styles.requestInput}
                value={rateInput}
                onChangeText={setRateInput}
                placeholder="期望版税率 %（如 20）"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
              />
              <TouchableOpacity
                testID="royalty-rate-submit"
                style={[styles.requestBtn, requesting && styles.btnDisabled]}
                onPress={handleRequestRate}
                disabled={requesting}
                activeOpacity={0.8}
              >
                {requesting ? (
                  <ActivityIndicator color={colors.bg} size="small" />
                ) : (
                  <Text style={styles.requestBtnText}>提交申请</Text>
                )}
              </TouchableOpacity>
            </View>

            <TextInput
              testID="royalty-rate-reason-input"
              style={styles.requestInput}
              value={reasonInput}
              onChangeText={setReasonInput}
              placeholder="申请理由（可选）"
              placeholderTextColor={colors.textMuted}
            />

            {requestError ? <Text style={styles.requestError}>⚠️ {requestError}</Text> : null}
            {requestDone ? <Text style={styles.requestDone}>{requestDone}</Text> : null}

            {requests.length ? (
              <View style={styles.requestList}>
                {requests.map((req) => (
                  <View key={req.id} style={styles.requestItem}>
                    <Text style={styles.requestItemTitle}>{req.model_id}</Text>
                    <Text style={styles.requestItemMeta}>
                      期望 {(req.requested_rate * 100).toFixed(1)}% · 当前{' '}
                      {(req.current_rate * 100).toFixed(1)}% · {req.status}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>

          {/* 提现流水 */}
          {data?.withdrawals.length ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>提现流水</Text>
              {data.withdrawals.slice(0, 5).map((w, i) => (
                <View key={`${w.created_at}-${i}`} style={styles.withdrawRow}>
                  <Text style={styles.withdrawAmount}>
                    ${w.amount_usd.toFixed(4)} · {w.amount_paw.toFixed(2)} PAW
                  </Text>
                  <Text
                    style={[
                      styles.withdrawStatus,
                      w.status === 'DONE' ? styles.withdrawDone : styles.withdrawPending,
                    ]}
                  >
                    {w.status}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <Text style={styles.walletFootnote}>
            创作者身份 (author_wallet): {creatorWallet}
          </Text>
        </>
      )}

      {/* 提现 Modal */}
      <Modal
        visible={withdrawOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setWithdrawOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>提现创作者版税</Text>
            <Text style={styles.modalSub}>
              可提余额 ${data?.available_usd.toFixed(4) ?? '0.0000'} (
              {(data?.available_paw ?? 0).toFixed(2)} PAW)
            </Text>

            <View style={styles.quickRow}>
              {[0.25, 0.5, 1].map((ratio) => {
                const amount = (data?.available_usd ?? 0) * ratio;
                return (
                  <TouchableOpacity
                    key={ratio}
                    style={styles.quickBtn}
                    onPress={() => setWithdrawAmount(amount.toFixed(6))}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.quickBtnText}>
                      {ratio === 1 ? '全部' : `${ratio * 100}%`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.amountRow}>
              <Text style={styles.amountSymbol}>$</Text>
              <TextInput
                testID="royalty-withdraw-input"
                style={styles.amountInput}
                value={withdrawAmount}
                onChangeText={setWithdrawAmount}
                placeholder="0.000000"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
              />
            </View>

            {withdrawError ? <Text style={styles.modalError}>⚠️ {withdrawError}</Text> : null}
            {withdrawDone ? <Text style={styles.modalSuccess}>{withdrawDone}</Text> : null}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setWithdrawOpen(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.modalCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="royalty-withdraw-confirm"
                style={[styles.modalConfirmBtn, withdrawing && styles.btnDisabled]}
                onPress={handleWithdraw}
                disabled={withdrawing}
                activeOpacity={0.8}
              >
                {withdrawing ? (
                  <ActivityIndicator color={colors.bg} size="small" />
                ) : (
                  <Text style={styles.modalConfirmText}>确认提现</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  requestHint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17 },
  requestRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  requestInput: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  requestBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.purple,
    justifyContent: 'center',
  },
  requestBtnText: { color: '#1B1233', fontSize: fontSize.xs, fontWeight: '800' },
  requestError: { color: colors.danger, fontSize: fontSize.xs, marginTop: spacing.sm },
  requestDone: { color: colors.accent, fontSize: fontSize.xs, marginTop: spacing.sm },
  requestList: { marginTop: spacing.sm },
  requestItem: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    marginTop: spacing.xs,
  },
  requestItemTitle: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '700' },
  requestItemMeta: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
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
    backgroundColor: colors.cyan,
    shadowColor: colors.cyan,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  refreshBtn: {
    backgroundColor: colors.warnSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  refreshBtnText: { color: colors.warn, fontSize: fontSize.xs, fontWeight: '700' },

  loadingWrap: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  loadingText: { color: colors.textMuted, fontSize: fontSize.sm },
  errorWrap: { paddingVertical: spacing.lg, gap: spacing.sm },
  errorText: { color: colors.danger, fontSize: fontSize.sm },
  errorHint: { color: colors.textMuted, fontSize: fontSize.xs },

  metricRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  metricBox: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
  },
  metricLabel: { color: colors.textSecondary, fontSize: fontSize.xs, marginBottom: 4 },
  metricValue: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800' },
  metricValueAccent: { color: colors.chartCreator },
  metricSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },

  balanceBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  balanceLeft: { flex: 1 },
  balanceLabel: { color: colors.textSecondary, fontSize: fontSize.xs },
  balanceValue: {
    color: colors.chartCreator,
    fontSize: fontSize.xl,
    fontWeight: '800',
    marginVertical: 2,
  },
  balanceSub: { color: colors.textMuted, fontSize: 12 },
  withdrawBtn: {
    backgroundColor: colors.warn,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginLeft: spacing.md,
  },
  withdrawBtnDisabled: { opacity: 0.45 },
  withdrawBtnText: { color: '#3B2503', fontWeight: '800', fontSize: fontSize.sm },

  section: { marginBottom: spacing.lg },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  chartBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingVertical: spacing.sm,
    overflow: 'hidden',
  },

  modelRow: { marginBottom: spacing.md, gap: 5 },
  modelRowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  modelName: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '700' },
  modelRoyalty: { color: colors.chartCreator, fontSize: fontSize.xs, fontWeight: '700' },
  modelBarTrack: {
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.divider,
    overflow: 'hidden',
  },
  modelBarFill: { height: 7, borderRadius: radius.pill, backgroundColor: colors.chartCreator },
  modelMeta: { color: colors.textMuted, fontSize: 12 },

  emptyText: { color: colors.textMuted, fontSize: fontSize.xs },

  withdrawRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  withdrawAmount: { color: colors.textBody, fontSize: fontSize.xs },
  withdrawStatus: { fontSize: 12, fontWeight: '700' },
  withdrawDone: { color: colors.accent },
  withdrawPending: { color: colors.warn },

  walletFootnote: {
    color: colors.textMuted,
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: spacing.sm,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: 'bold' },
  modalSub: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 4 },
  quickRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  quickBtn: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quickBtnText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  amountSymbol: { color: colors.textMuted, fontSize: fontSize.lg, fontWeight: '700' },
  amountInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: '700',
    paddingVertical: spacing.md,
    marginLeft: 4,
  },
  modalError: { color: colors.danger, fontSize: fontSize.xs, marginTop: spacing.sm },
  modalSuccess: { color: colors.accent, fontSize: fontSize.xs, marginTop: spacing.sm },
  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalCancelText: { color: colors.textSecondary, fontWeight: '700', fontSize: fontSize.sm },
  modalConfirmBtn: {
    flex: 1,
    backgroundColor: colors.warn,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  modalConfirmText: { color: '#3B2503', fontWeight: '800', fontSize: fontSize.sm },
  btnDisabled: { opacity: 0.6 },
});

export default RoyaltyCard;
