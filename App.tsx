import React, { useEffect, useState } from 'react';
import {
  Modal,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { HostTab, usePawStore } from './src/store/usePawStore';
import {
  fetchOwnerDashboard,
  fetchUserUsage,
  toggleNodeStatus,
  OwnerDashboard,
} from './src/api/cloudClient';
import PlaygroundCard from './src/components/PlaygroundCard';
import AnalyticsCard from './src/components/AnalyticsCard';
import ModelStudioCard from './src/components/ModelStudioCard';
import PipelineMeshCard from './src/components/PipelineMeshCard';
import RoyaltyCard from './src/components/RoyaltyCard';
import { StatTile, StatusDot, Surface, Toast, Toggle } from './src/components/ui';
import { colors, fontSize, radius, spacing } from './src/theme';
import { injectWebTheme } from './src/ui/webTheme';

// Web 专属视觉层（磨砂、渐变、呼吸灯）必须在首帧前挂载 —— 浏览器里模块顶层即可执行
injectWebTheme();

const HOST_TABS: Array<{ key: HostTab; label: string }> = [
  { key: 'NODES', label: '算力节点' },
  { key: 'STUDIO', label: '模型工作台' },
  { key: 'ROYALTY', label: '版税大盘' },
];

/** 仪表盘在窄屏降级为单列 */
const WIDE_BREAKPOINT = 900;

export default function App() {
  const {
    roleMode,
    setRoleMode,
    apiKey,
    setApiKey,
    balanceUsd,
    setBalanceUsd,
    dailyLimitUsd,
    setDailyLimitUsd,
    spentTodayUsd,
    hostTab,
    setHostTab,
  } = usePawStore();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;

  const [dashboard, setDashboard] = useState<OwnerDashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [keyModalVisible, setKeyModalVisible] = useState(false);
  const [keyInput, setKeyInput] = useState(apiKey);

  const loadData = async () => {
    try {
      const data = await fetchOwnerDashboard();
      setDashboard(data);
    } catch (e) {
      console.log('加载 Cloud API 失败:', e);
    }
  };

  const loadUsage = async () => {
    try {
      const usage = await fetchUserUsage();
      setBalanceUsd(usage.balance_usd);
      setDailyLimitUsd(usage.daily_limit_usd);
    } catch (e) {
      console.log('加载账户额度失败:', e);
    }
  };

  useEffect(() => {
    loadData();
    loadUsage();
    // 首次访问没有可用密钥 —— 直接弹出设置框，避免首屏全是 401
    if (!apiKey) setKeyModalVisible(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载后把主题样式表挪到 <head> 末尾，保证与 RNW 原子类同优先级时本表胜出
  useEffect(() => {
    injectWebTheme();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    await loadUsage();
    setRefreshing(false);
  };

  const handleToggleNode = async (nodeId: string) => {
    await toggleNodeStatus(nodeId);
    await loadData();
  };

  const handleSaveKey = () => {
    const next = keyInput.trim();
    setApiKey(next);
    setKeyModalVisible(false);
    // 换密钥后立即重拉一次面板数据
    loadData();
    loadUsage();
  };

  const handleClearKey = () => {
    setApiKey('');
    setKeyInput('');
  };

  const openKeyModal = () => {
    setKeyInput(apiKey);
    setKeyModalVisible(true);
  };

  const maskedKey = apiKey ? `${apiKey.substring(0, 8)}••••${apiKey.slice(-4)}` : '未配置';

  return (
    <SafeAreaView style={styles.root} id="apx-root">
      <StatusBar barStyle="light-content" />
      {/* 网格纹理层（纯装饰，指针穿透）*/}
      <View style={styles.gridBg} id="apx-grid" pointerEvents="none" />

      {/* ---------------- 顶栏 ---------------- */}
      <View style={styles.header} id="apx-header">
        <View style={styles.brandRow}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>◆</Text>
          </View>
          <View>
            <Text style={styles.brandTitle}>APIPaw Pocket</Text>
            <Text style={styles.brandSub}>DECENTRALIZED COMPUTE · DEPIN</Text>
          </View>
        </View>

        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.keyBtn}
            id="apx-glow-key"
            onPress={openKeyModal}
            activeOpacity={0.8}
            testID="open-key-modal"
          >
            <StatusDot
              variant={apiKey ? 'live' : 'alert'}
              color={apiKey ? colors.accent : colors.danger}
              size={7}
            />
            <Text style={styles.keyBtnText}>{apiKey ? '设置密钥' : '未设置密钥'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.roleBtn}
            id="apx-glow-role"
            onPress={() => setRoleMode(roleMode === 'BUYER' ? 'HOST' : 'BUYER')}
            activeOpacity={0.8}
            testID="switch-role"
          >
            <Text style={styles.roleBtnText}>
              {roleMode === 'BUYER' ? '切换至业主视角' : '切换至买家视角'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ---------------- 右上角 Toast（替代通栏警告条）---------------- */}
      <Toast
        visible={!apiKey}
        tone="warn"
        title="尚未配置 API 凭证"
        message="点击右上角按钮填入 Key，即可连接云端网关拉取余额、节点与用量数据。"
        actionLabel="立即配置"
        onAction={openKeyModal}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        {roleMode === 'BUYER' ? (
          <View style={styles.column}>
            {/* 仪表盘首行：余额大卡 + 三块指标 */}
            <View style={[styles.dashRow, !wide && styles.dashRowNarrow]}>
              <Surface
                webId="apx-grad-border-balance"
                style={[styles.balanceCard, !wide && styles.balanceCardNarrow]}
              >
                <View style={styles.balanceHead}>
                  <Text style={styles.eyebrow} id="apx-eyebrow-balance">
                    API 账户余额与 Token 额度
                  </Text>
                  <View style={styles.balanceLive}>
                    <StatusDot variant="live" color={colors.accent} size={6} />
                    <Text style={styles.balanceLiveText}>CONNECTED</Text>
                  </View>
                </View>

                <View style={styles.balanceAmountRow}>
                  <Text style={styles.balanceValue} id="apx-grad-text-balance">
                    ${balanceUsd.toFixed(2)}
                  </Text>
                  <Text style={styles.balanceUnit}>USD</Text>
                </View>
                <Text style={styles.balanceCaption}>可用余额 · 可直接抵扣推理结算</Text>

                <View style={styles.balanceMeta}>
                  <View style={styles.balanceMetaCell}>
                    <Text style={styles.balanceMetaLabel}>当前密钥</Text>
                    <Text style={styles.balanceMetaValue} id="apx-mono-key" numberOfLines={1}>
                      {maskedKey}
                    </Text>
                  </View>
                  <View style={styles.balanceMetaCell}>
                    <Text style={styles.balanceMetaLabel}>今日消费</Text>
                    <Text style={styles.balanceMetaValue}>${spentTodayUsd.toFixed(4)}</Text>
                  </View>
                  <View style={styles.balanceMetaCell}>
                    <Text style={styles.balanceMetaLabel}>单日上限</Text>
                    <Text style={styles.balanceMetaValue}>${dailyLimitUsd.toFixed(0)}</Text>
                  </View>
                </View>
              </Surface>

              <View style={styles.dashSide}>
                <StatTile
                  label="在线算力节点"
                  value={`${dashboard?.active_nodes_online || 0}`}
                  unit="台"
                  tone="emerald"
                  hint={`全网注册 ${dashboard?.registered_nodes_total || 0} 台`}
                />
                <StatTile
                  label="今日已消费"
                  value={`$${spentTodayUsd.toFixed(4)}`}
                  tone="cyan"
                  hint="按 API Key 实时结算"
                />
                <StatTile
                  label="单日消费上限"
                  value={`$${dailyLimitUsd.toFixed(0)}`}
                  tone="violet"
                  hint="可在用量面板中调整"
                />
              </View>
            </View>

            <PlaygroundCard />
            <AnalyticsCard />
          </View>
        ) : (
          <View style={styles.column}>
            {/* HOST 分段切换 */}
            <View style={styles.segmentWrap} testID="host-tabs">
              {HOST_TABS.map((tab) => {
                const active = tab.key === hostTab;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    testID={`host-tab-${tab.key}`}
                    style={[styles.segment, active && styles.segmentActive]}
                    onPress={() => setHostTab(tab.key)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {hostTab === 'NODES' && (
              <View style={styles.column}>
                <View style={[styles.dashRow, !wide && styles.dashRowNarrow]}>
                  <Surface webId="apx-glass-node-panel" style={styles.nodePanelCard}>
                    <Text style={styles.eyebrow} id="apx-eyebrow-nodes">
                      算力节点远控面板
                    </Text>
                    <View style={styles.nodePanelStats}>
                      <View style={styles.nodePanelStat}>
                        <Text style={styles.nodePanelValue}>{dashboard?.active_nodes_online || 0}</Text>
                        <Text style={styles.nodePanelLabel}>在线挂机节点数 (台)</Text>
                      </View>
                      <View style={styles.nodePanelDivider} />
                      <View style={styles.nodePanelStat}>
                        <Text style={styles.nodePanelValue}>
                          {dashboard?.registered_nodes_total || 0}
                        </Text>
                        <Text style={styles.nodePanelLabel}>全网注册节点数 (台)</Text>
                      </View>
                    </View>
                  </Surface>

                  <Surface webId="apx-glass-node-hint" style={styles.nodeHintCard}>
                    <Text style={styles.nodeHintTitle}>远程指令</Text>
                    <Text style={styles.nodeHintText}>
                      拨动节点卡片右侧的开关即可远程暂停 / 恢复接单，指令经 WebSocket 主通道直达节点，
                      无需等待心跳周期。
                    </Text>
                  </Surface>
                </View>

                {(dashboard?.nodes ?? []).map((node) => (
                  <View
                    key={node.node_id}
                    style={styles.nodeCard}
                    id={`apx-glass-node-${node.node_id}`}
                  >
                    <View style={styles.nodeHead}>
                      <View style={styles.nodeHeadLeft}>
                        <Text style={styles.nodeIdText}>节点: {node.node_id}</Text>
                        <Text style={styles.nodeMetaText}>
                          {node.total_tokens_processed.toLocaleString()} tokens ·{' '}
                          {node.total_earnings_paw.toFixed(4)} PAW
                        </Text>
                      </View>
                      <Toggle
                        testID={`node-toggle-${node.node_id}`}
                        webId="apx-glow-node-toggle"
                        value={!node.is_paused}
                        onChange={() => handleToggleNode(node.node_id)}
                      />
                    </View>

                    <View style={styles.nodeStatusRow}>
                      <StatusDot
                        color={node.is_paused ? colors.danger : colors.accent}
                        size={7}
                      />
                      <Text
                        style={[
                          styles.nodeStatusText,
                          { color: node.is_paused ? colors.danger : colors.accent },
                        ]}
                      >
                        {node.is_paused ? '已暂停接单' : '允许接单'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {hostTab === 'STUDIO' && (
              <View style={styles.column}>
                <ModelStudioCard />
                <PipelineMeshCard />
              </View>
            )}

            {hostTab === 'ROYALTY' && (
              <View style={styles.column}>
                <RoyaltyCard />
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* ---------------- API Key 弹窗 ---------------- */}
      <Modal
        visible={keyModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setKeyModalVisible(false)}
      >
        <View style={styles.modalBackdrop} id="apx-modal">
          <View style={styles.modalCard} id="apx-modal-card">
            <Text style={styles.modalTitle}>设置 API Key</Text>
            <Text style={styles.modalHint}>
              密钥将保存在本机浏览器 (localStorage)，仅用于向云端网关 https://cloud.apipaw.com 发起请求
            </Text>
            <TextInput
              style={styles.modalInput}
              value={keyInput}
              onChangeText={setKeyInput}
              placeholder="paw_xxx / paw-sk-xxx"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              testID="api-key-input"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={handleClearKey}
                testID="api-key-clear"
              >
                <Text style={styles.modalBtnGhostText}>清除</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setKeyModalVisible(false)}
              >
                <Text style={styles.modalBtnGhostText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={handleSaveKey}
                testID="api-key-save"
              >
                <Text style={styles.modalBtnPrimaryText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  gridBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  brandMarkText: { color: colors.accent, fontSize: 13 },
  brandTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800', letterSpacing: 0.2 },
  brandSub: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginTop: 1,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
  keyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keyBtnText: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '700' },
  roleBtn: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  roleBtnText: { color: colors.purple, fontSize: fontSize.xs, fontWeight: '700' },

  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 1180,
  },
  column: { gap: spacing.lg },

  dashRow: { flexDirection: 'row', gap: spacing.lg, alignItems: 'stretch' },
  dashRowNarrow: { flexDirection: 'column' },
  dashSide: { flex: 1, gap: spacing.md, minWidth: 240 },

  balanceCard: { flex: 1.45, gap: spacing.md },
  balanceCardNarrow: { flex: 0 },
  balanceHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  balanceLive: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: 'rgba(52, 211, 153, 0.35)',
  },
  balanceLiveText: { color: colors.accent, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  balanceAmountRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  balanceValue: { fontSize: fontSize.hero, fontWeight: '800', letterSpacing: -1.5 },
  balanceUnit: { color: colors.textSecondary, fontSize: fontSize.lg, fontWeight: '700' },
  balanceCaption: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: -spacing.sm },
  balanceMeta: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  balanceMetaCell: { flex: 1, gap: 4 },
  balanceMetaLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700' },
  balanceMetaValue: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '700' },

  nodePanelCard: { flex: 1.2, gap: spacing.md },
  nodePanelStats: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  nodePanelStat: { gap: 4 },
  nodePanelValue: { color: colors.accent, fontSize: fontSize.xxl, fontWeight: '800' },
  nodePanelLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  nodePanelDivider: { width: 1, height: 38, backgroundColor: colors.divider },

  nodeHintCard: { flex: 1, gap: spacing.sm, justifyContent: 'center' },
  nodeHintTitle: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  nodeHintText: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 18 },

  nodeCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  nodeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  nodeHeadLeft: { flex: 1, gap: 4 },
  nodeIdText: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800' },
  nodeMetaText: { color: colors.textMuted, fontSize: fontSize.xs },
  nodeStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nodeStatusText: { fontSize: fontSize.xs, fontWeight: '700' },

  segmentWrap: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: colors.purpleSoft, borderWidth: 1, borderColor: colors.purple },
  segmentText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  segmentTextActive: { color: colors.purple },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(4, 4, 9, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.cardSolid,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800', marginBottom: 8 },
  modalHint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 18, marginBottom: 14 },
  modalInput: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: fontSize.md,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  modalBtn: { paddingHorizontal: spacing.lg, paddingVertical: 9, borderRadius: radius.md },
  modalBtnGhost: { backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border },
  modalBtnGhostText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  modalBtnPrimary: { backgroundColor: colors.accent },
  modalBtnPrimaryText: { color: '#052E21', fontSize: fontSize.sm, fontWeight: '800' },
});
