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
import { HostTab, hydrateSession, usePawStore } from './src/store/usePawStore';
import { useIsMobile } from './src/hooks/useIsMobile';
import {
  claimTrialFaucet,
  describeFaucetError,
  fetchCreatorIdentity,
  fetchOwnerDashboard,
  fetchOwnerRevenue,
  fetchNetworkHealth,
  fetchUserUsage,
  toggleNodeStatus,
  NetworkHealth,
  OwnerDashboard,
  OwnerRevenue,
} from './src/api/cloudClient';
import PlaygroundCard from './src/components/PlaygroundCard';
import AnalyticsCard from './src/components/AnalyticsCard';
import ModelStudioCard from './src/components/ModelStudioCard';
import GoldenDatasetCard from './src/components/GoldenDatasetCard';
import PipelineMeshCard from './src/components/PipelineMeshCard';
import RoyaltyCard from './src/components/RoyaltyCard';
import NodeGovernanceCard from './src/components/NodeGovernanceCard';
import NodePayoutCard from './src/components/NodePayoutCard';
import PricingApprovalCard from './src/components/PricingApprovalCard';
import PublicNodeCard from './src/components/PublicNodeCard';
import LazyMount from './src/components/LazyMount';
import LiveSettlementFeed from './src/components/LiveSettlementFeed';
import ModelUpsertCard from './src/components/ModelUpsertCard';
import VoucherRedeemCard from './src/components/VoucherRedeemCard';
import VoucherIssueCard from './src/components/VoucherIssueCard';
import WithdrawalApprovalCard from './src/components/WithdrawalApprovalCard';
import EarningsWithdrawCard from './src/components/EarningsWithdrawCard';
import KeyIssuePanel from './src/components/KeyIssuePanel';
import WalletPanel from './src/components/WalletPanel';
import OwnerPasskeyCard from './src/components/OwnerPasskeyCard';
import BuyerLedgerCard from './src/components/BuyerLedgerCard';
import NodeLeaderboardCard from './src/components/NodeLeaderboardCard';
// 阶段十七 P0/P1：密钥安全策略（冻结 / IP 白名单 / 模型白名单 / 扫码导入二维码）
//                   + 智能风控告警与场景 A/B 费用拆解
import ApiKeyPolicyCard from './src/components/ApiKeyPolicyCard';
import SmartAlertCard from './src/components/SmartAlertCard';
// 阶段十七 P2：网关内容安全拦截器（业主视角）
import ModerationBlocksCard from './src/components/ModerationBlocksCard';
// 阶段十八 P0-P2：PoI 推理证明 + 默克尔状态根（浏览器端可本地复验）
import PoiConsensusCard from './src/components/PoiConsensusCard';
// 阶段十九 P0-P2：Model DAO 治理锁 + PAWMODEL 导入 + B2B 企业发票 / USDT 储值
import DaoAndEnterpriseCard from './src/components/DaoAndEnterpriseCard';
// 阶段二十 P0/P2：Pipeline Mesh 异构算力网格 + 多网关容灾联邦 + 白皮书 v3.0 合规大盘
import MeshAndFederationCard from './src/components/MeshAndFederationCard';
import { StatTile, StatusDot, Surface, Toast, Toggle } from './src/components/ui';
import { colors, fontSize, radius, spacing } from './src/theme';
import { injectWebTheme } from './src/ui/webTheme';

// Web 专属视觉层（磨砂、渐变、呼吸灯）必须在首帧前挂载 —— 浏览器里模块顶层即可执行
injectWebTheme();

const HOST_TABS: Array<{ key: HostTab; label: string }> = [
  { key: 'NODES', label: '算力节点' },
  { key: 'STUDIO', label: '模型工作台' },
  { key: 'ROYALTY', label: '版税大盘' },
  { key: 'GOVERNANCE', label: '节点治理' },
];

/** 仪表盘在窄屏降级为单列 */
const WIDE_BREAKPOINT = 900;

/**
 * 手机断点（阶段二十七 P0）—— 窄于此宽度即进入「单列 + 允许换行」布局。
 *
 * 为什么要独立于 WIDE_BREAKPOINT：900px 决定的是「多列 vs 单列」，
 * 而手机档要解决的是**另一个**问题 —— 固定 `flex: 1`（basis 0）在纵向
 * 容器里会把子元素高度压成 0，内容溢出后互相穿插（余额卡压住算力节点卡）。
 * 两件事必须分开判断，故设两个断点。
 *
 * 断点值与 `useIsMobile()` 共用同一份定义（src/hooks/useIsMobile.ts），
 * 避免各组件各写一份 768 走偏。
 */

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
    sessionToken,
    sessionWallet,
    sessionRole,
    setCreatorIdentity,
  } = usePawStore();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  /** 手机档：顶栏折行、网格降单列、禁止 basis-0 的 flex 塌陷 */
  const isMobile = useIsMobile();

  const [dashboard, setDashboard] = useState<OwnerDashboard | null>(null);
  const [revenue, setRevenue] = useState<OwnerRevenue | null>(null);
  const [network, setNetwork] = useState<NetworkHealth | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [keyModalVisible, setKeyModalVisible] = useState(false);
  // 阶段八 P1：新手体验金（余额 $0 状态区）
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState<string | null>(null);
  const [faucetOk, setFaucetOk] = useState(false);
  const [walletModalVisible, setWalletModalVisible] = useState(false);
  // 阶段十 P0：业主管理口令解锁弹窗（免钱包插件）
  const [passkeyModalVisible, setPasskeyModalVisible] = useState(false);
  const [keyInput, setKeyInput] = useState(apiKey);
  // 阶段十一 P1：提现审批 ⇒ 收益面板同页实时联动的刷新信号
  const [withdrawRefreshKey, setWithdrawRefreshKey] = useState(0);
  const bumpWithdrawRefresh = () => setWithdrawRefreshKey((v) => v + 1);

  const loadData = async () => {
    try {
      const data = await fetchOwnerDashboard();
      setDashboard(data);
    } catch (e) {
      console.log('加载 Cloud API 失败:', e);
    }
  };

  /**
   * 拉取全网算力网络健康度 —— **公开端点**，买家也能读到真实的在线节点数。
   *
   * 阶段六 P2 之前，这张卡依赖 OWNER-only 的 ``/api/v1/owner/dashboard``，
   * 普通买家恒为 0（摸底结论）。现在改读 ``/api/v1/network/health``。
   */
  const loadNetwork = async () => {
    try {
      setNetwork(await fetchNetworkHealth());
    } catch (e) {
      console.log('加载网络健康度失败:', e);
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

  /**
   * 拉取**本人**节点收益 —— 走钱包会话 JWT（阶段四 P3 新端点）。
   * 没有会话时不发请求（后端会 401，UI 改为提示连接钱包）。
   */
  const loadRevenue = async () => {
    if (!usePawStore.getState().sessionToken) {
      setRevenue(null);
      return;
    }
    try {
      setRevenue(await fetchOwnerRevenue());
    } catch (e) {
      console.log('加载本人节点收益失败:', e);
      setRevenue(null);
    }
  };

  useEffect(() => {
    // 先恢复会话（原生端从 Keychain 读 JWT），再拉数据
    hydrateSession().then(() => {
      loadData();
      loadUsage();
      loadRevenue();
      loadNetwork();
    });
    // 首次访问没有可用密钥 —— 直接弹出设置框，避免首屏全是 401
    if (!apiKey) setKeyModalVisible(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载后把主题样式表挪到 <head> 末尾，保证与 RNW 原子类同优先级时本表胜出
  useEffect(() => {
    injectWebTheme();
  }, []);

  /**
   * **创作者身份绑定（阶段六 P3-3 · D3）** —— 钱包即身份。
   *
   * 会话一建立就把 ``creatorWallet`` / ``creatorId`` 换成**服务端权威**回填值，
   * 不再是本地硬编码的演示地址。这样创作者大盘、版税申请、上架与提现
   * 无论从哪个 Tab 进入，绑的都是当前真实登录身份。
   */
  useEffect(() => {
    if (!sessionToken) {
      setCreatorIdentity('', '');
      return;
    }
    let cancelled = false;
    fetchCreatorIdentity()
      .then((identity) => {
        if (cancelled) return;
        setCreatorIdentity(identity.author_wallet, identity.creator_id);
      })
      .catch((e) => {
        // 非创作者身份 / 后端未配置 —— 清空，绝不保留上一个身份的残留
        if (!cancelled) {
          setCreatorIdentity('', '');
          console.log('创作者身份读取失败:', e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    await loadUsage();
    await loadRevenue();
    await loadNetwork();
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

  /**
   * 签发台签出新 Key 且用户确认已保存后 —— 写入 localStorage、关弹窗、立刻重拉面板。
   * 明文只在签发那一刻返回一次, 之后库里只有哈希, 丢了只能重新签发。
   */
  const handleAdoptIssuedKey = (issued: string) => {
    setApiKey(issued);
    setKeyInput(issued);
    setKeyModalVisible(false);
    loadData();
    loadUsage();
  };

  const openKeyModal = () => {
    setKeyInput(apiKey);
    setKeyModalVisible(true);
  };

  /**
   * 领取新手体验金 $0.50（阶段八 P1）。
   *
   * 余额 $0 的买家**一分钱都花不掉** —— 于是「真流式推理」根本跑不起来。
   * 这个按钮把闭环补上：领取 → 余额立刻刷新 → 马上能发一次真实推理。
   */
  /** 签发弹窗里领到体验金后的回调：只刷新余额显示（钱已经到账了） */
  const handleFaucetGranted = (balance: number) => {
    setBalanceUsd(balance);
    loadUsage();
  };

  const handleClaimFaucet = async (key?: string) => {
    const useKey = key || apiKey;
    if (!useKey) return;
    setFaucetBusy(true);
    setFaucetMsg(null);
    try {
      const rec = await claimTrialFaucet(useKey);
      setFaucetOk(true);
      setFaucetMsg(`已到账 $${(rec.amount_usd ?? 0).toFixed(2)}`);
      setBalanceUsd(rec.balance_usd ?? 0);
      loadUsage();
    } catch (e) {
      setFaucetOk(false);
      setFaucetMsg(describeFaucetError(e));
    } finally {
      setFaucetBusy(false);
    }
  };

  // 只保留 6 位前缀 —— 放大到 18px 后 8 位前缀会挤爆指标格
  const maskedKey = apiKey ? `${apiKey.substring(0, 6)}••••${apiKey.slice(-4)}` : '未配置';

  return (
    <SafeAreaView style={styles.root} id="apx-root">
      <StatusBar barStyle="light-content" />
      {/* 网格纹理层（纯装饰，指针穿透）*/}
      <View style={styles.gridBg} id="apx-grid" pointerEvents="none" />

      {/* ---------------- 顶栏 ---------------- */}
      <View style={[styles.header, isMobile && styles.headerNarrow]} id="apx-header">
        <View style={[styles.brandRow, isMobile && styles.brandRowNarrow]}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>◆</Text>
          </View>
          <View style={styles.brandTextCol}>
            <Text style={styles.brandTitle}>APIPaw Pocket</Text>
            <Text style={styles.brandSub}>DECENTRALIZED COMPUTE · DEPIN</Text>
          </View>
        </View>

        <View style={[styles.headerActions, isMobile && styles.headerActionsNarrow]}>
          {/* 钱包会话入口（阶段四 P4）—— 业主身份走钱包签名，买家走右侧的 API Key */}
          <TouchableOpacity
            style={[styles.walletBtn, isMobile && styles.headerBtnNarrow]}
            id="apx-glow-wallet"
            onPress={() => setWalletModalVisible(true)}
            activeOpacity={0.8}
            testID="open-wallet-modal"
          >
            <StatusDot
              variant={sessionToken ? 'live' : 'static'}
              color={sessionToken ? colors.accent : colors.cyan}
              size={7}
            />
            <Text style={styles.walletBtnText} testID="wallet-chip">
              {sessionToken
                ? `${sessionWallet.slice(0, 6)}…${sessionWallet.slice(-4)}`
                : '连接钱包'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.keyBtn, isMobile && styles.headerBtnNarrow]}
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
            style={[styles.roleBtn, isMobile && styles.headerBtnNarrow]}
            id="apx-glow-role"
            onPress={() => setRoleMode(roleMode === 'BUYER' ? 'HOST' : 'BUYER')}
            activeOpacity={0.8}
            testID="switch-role"
          >
            <Text style={styles.roleBtnText}>
              {roleMode === 'BUYER' ? '切换至业主视角' : '切换至买家视角'}
            </Text>
          </TouchableOpacity>

          {/* 阶段十 P0：业主管理口令解锁（没有钱包插件也能进 OWNER 视角）*/}
          <TouchableOpacity
            style={[styles.passkeyBtn, isMobile && styles.headerBtnNarrow]}
            id="apx-glow-passkey"
            onPress={() => setPasskeyModalVisible(true)}
            activeOpacity={0.8}
            testID="open-passkey-modal"
          >
            <StatusDot
              variant={sessionRole === 'OWNER' ? 'live' : 'static'}
              color={sessionRole === 'OWNER' ? colors.accent : colors.warn}
              size={7}
            />
            <Text style={styles.passkeyBtnText}>
              {sessionRole === 'OWNER' ? '已解锁业主' : '口令解锁'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ---------------- 右上角 Toast（替代通栏警告条）---------------- */}
      <Toast
        visible={!apiKey && !sessionToken}
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
        {/* 阶段二十六 P2 · 封闭公测边界声明（B3 / B6 / B7）
            为什么必须**摆在用户眼前**：单户 $100 储值上限、不提供商用 SLA 承诺
            如果只写在运营手册里，就只是运营口径而不是产品承诺 —— 用户按商用预期
            接入后才发现限制，纠纷成本远高于一行小字。
            体量纪律：一行小字（< 200 字节），不进任何网络请求，
            不影响两站 gzip < 340KB 的体积闸门。 */}
        <View style={styles.betaNotice} testID="beta-boundary-notice">
          <Text style={styles.betaNoticeText}>封闭公测期：单户储值上限 $100 · 不提供商用 SLA 承诺</Text>
        </View>

        {roleMode === 'BUYER' ? (
          <View style={styles.column}>
            {/* 仪表盘首行：余额大卡 + 三块指标 */}
            <View style={[styles.dashRow, !wide && styles.dashRowNarrow]}>
              <Surface
                webId="apx-grad-border-balance"
                style={[styles.balanceCard, !wide && styles.balanceCardNarrow]}
              >
                <View style={[styles.balanceHead, isMobile && styles.balanceHeadNarrow]}>
                  <Text style={[styles.eyebrow, styles.eyebrowShrink]} id="apx-eyebrow-balance">
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

                {/* 阶段八 P1：余额 $0 时给出「一键领体验金」入口 ——
                    没有余额就发不出真实推理，这一步是把闭环补上的最后一块拼图。
                    ⚠️ 领取成功后余额会立刻变成 $0.50 —— 若此时把整块折叠掉，
                    「到账」提示会**跟着余额一起消失**（用户看不到自己领到了）。
                    所以条件里带上 ``faucetOk``：成功提示要留住。 */}
                {apiKey && (balanceUsd <= 0 || faucetOk) ? (
                  <View style={styles.faucetBox} testID="balance-faucet-box">
                    {faucetOk ? (
                      <Text style={styles.faucetOkText} testID="balance-faucet-ok">
                        ✓ {faucetMsg}
                      </Text>
                    ) : (
                      <TouchableOpacity
                        style={[styles.faucetBtn, faucetBusy && styles.btnDisabled]}
                        onPress={() => handleClaimFaucet()}
                        disabled={faucetBusy}
                        activeOpacity={0.8}
                        testID="balance-faucet-btn"
                      >
                        <Text style={styles.faucetBtnText}>免费领取 $0.50 新手体验金</Text>
                      </TouchableOpacity>
                    )}
                    {faucetMsg && !faucetOk ? (
                      <Text style={styles.faucetErrText} testID="balance-faucet-error">
                        {faucetMsg}
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                {/* 阶段九 P2：兑换充值码（买家自助储值入口）*/}
                <VoucherRedeemCard />

                <View style={[styles.balanceMeta, isMobile && styles.balanceMetaNarrow]}>
                  <View style={[styles.balanceMetaCell, isMobile && styles.balanceMetaCellKey]}>
                    <Text style={styles.balanceMetaLabel}>当前密钥</Text>
                    <Text style={[styles.balanceMetaValue, isMobile && styles.balanceMetaValueNarrow]} id="apx-mono-key apx-balance-meta-value" numberOfLines={1}>
                      {maskedKey}
                    </Text>
                  </View>
                  <View style={[styles.balanceMetaCell, isMobile && styles.balanceMetaCellHalf]}>
                    <Text style={styles.balanceMetaLabel}>今日消费</Text>
                    <Text style={[styles.balanceMetaValue, isMobile && styles.balanceMetaValueNarrow]} id="apx-balance-meta-value">${spentTodayUsd.toFixed(4)}</Text>
                  </View>
                  <View style={[styles.balanceMetaCell, isMobile && styles.balanceMetaCellHalf]}>
                    <Text style={styles.balanceMetaLabel}>单日上限</Text>
                    <Text style={[styles.balanceMetaValue, isMobile && styles.balanceMetaValueNarrow]} id="apx-balance-meta-value">${dailyLimitUsd.toFixed(0)}</Text>
                  </View>
                </View>
              </Surface>

              <View style={[styles.dashSide, isMobile && styles.dashSideNarrow]}>
                <StatTile
                  label="在线算力节点"
                  value={`${network?.online_nodes ?? 0}`}
                  unit="台"
                  tone="emerald"
                  style={isMobile ? styles.statTileNarrow : undefined}
                  hint={
                    network
                      ? `可派 ${network.dispatchable_nodes} 台 · 可服务 ${network.servable_models} 个模型`
                      : '正在读取全网算力状态…'
                  }
                />
                <StatTile
                  label="今日已消费"
                  value={`$${spentTodayUsd.toFixed(4)}`}
                  tone="cyan"
                  style={isMobile ? styles.statTileNarrow : undefined}
                  hint="按 API Key 实时结算"
                />
                <StatTile
                  label="单日消费上限"
                  value={`$${dailyLimitUsd.toFixed(0)}`}
                  tone="violet"
                  style={isMobile ? styles.statTileNarrow : undefined}
                  hint="可在用量面板中调整"
                />
              </View>
            </View>

            {/* 阶段二十四 P1 · 首屏之外的重卡片**懒挂载**
                此前这一列一次性挂载 11 张卡片 ⇒ 每张卡 mount 时各发一条 API
                ⇒ 首屏同时等 11 条请求、渲染 11 棵树（低端机又慢又烫）。
                现在：Playground 与 Analytics 保持**立即挂载**（e2e 首屏断言依赖它们，
                且是用户第一眼要用的两块），其余重卡片改为"接近视口就挂载、
                兜底最迟 X ms 内一定挂载"。
                纪律：不删任何 data-testid、不改卡片内容与顺序。 */}
            <PlaygroundCard />
            <LazyMount fallbackMs={1200}>
              <PublicNodeCard />
            </LazyMount>
            {/* 阶段十七 P1：智能风控告警中心 + 场景 A/B 费用拆解（无 Key 时显示全网基准）*/}
            <LazyMount fallbackMs={1320}>
              <SmartAlertCard />
            </LazyMount>
            {/* 阶段十七 P0：买家密钥四重安全锁（冻结 / IP 白名单 / 模型白名单 / 扫码导入）*/}
            <LazyMount fallbackMs={1440}>
              <ApiKeyPolicyCard />
            </LazyMount>
            {/* 阶段十 P1：买家个人收支账单明细（折叠面板，9 位小数）*/}
            <LazyMount fallbackMs={1560}>
              <BuyerLedgerCard />
            </LazyMount>
            {/* 阶段九 P0：全网实时推理与三方分账公示（公开数据）*/}
            <LazyMount fallbackMs={1680}>
              <LiveSettlementFeed />
            </LazyMount>
            {/* 阶段十八 P0-P2：PoI 推理证明 + 默克尔状态根（公开数据 + 本地验真）*/}
            <LazyMount fallbackMs={1800}>
              <PoiConsensusCard />
            </LazyMount>
            {/* 阶段十九 P0-P2：Model DAO 治理锁 + B2B 企业发票 / USDT 储值申报*/}
            <LazyMount fallbackMs={1920}>
              <DaoAndEnterpriseCard />
            </LazyMount>
            {/* 阶段二十 P0/P2：Pipeline Mesh 异构算力网格 + 多网关容灾联邦 + 白皮书 v3.0 合规大盘*/}
            <LazyMount fallbackMs={2040}>
              <MeshAndFederationCard />
            </LazyMount>
            {/* 阶段十 P2：全网算力节点贡献排行榜（公开数据）*/}
            <LazyMount fallbackMs={2160}>
              <NodeLeaderboardCard />
            </LazyMount>
            <AnalyticsCard />
          </View>
        ) : (
          <View style={styles.column}>
            {/* HOST 分段切换 */}
            <View style={[styles.segmentWrap, isMobile && styles.segmentWrapNarrow]} testID="host-tabs">
              {HOST_TABS.map((tab) => {
                const active = tab.key === hostTab;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    testID={`host-tab-${tab.key}`}
                    style={[styles.segment, isMobile && styles.segmentNarrow, active && styles.segmentActive]}
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
                    <View style={[styles.nodePanelStats, isMobile && styles.nodePanelStatsNarrow]}>
                      <View style={styles.nodePanelStat}>
                        <Text style={styles.nodePanelValue}>
                          {network?.online_nodes ?? dashboard?.active_nodes_online ?? 0}
                        </Text>
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

                {/* 本人节点收益 —— 只认钱包会话（阶段四 P3/P4）*/}
                <Surface webId="apx-glass-my-nodes" style={styles.myNodesCard} testID="my-nodes-card">
                  <View style={styles.myNodesHead}>
                    <Text style={styles.eyebrow}>我的节点收益（钱包会话口径）</Text>
                    {sessionRole === 'OWNER' ? (
                      <Text style={styles.myNodesOwner}>OWNER</Text>
                    ) : null}
                  </View>
                  {!sessionToken ? (
                    <Text style={styles.myNodesHint}>
                      连接钱包后，这里只显示**你名下**的节点与收益（服务端按登录钱包过滤）。
                    </Text>
                  ) : !revenue ? (
                    <Text style={styles.myNodesHint}>
                      正在读取本人节点…（若长时间无数据，请确认该钱包在节点注册表里有归属）
                    </Text>
                  ) : revenue.nodes_total === 0 ? (
                    <Text style={styles.myNodesHint}>
                      该钱包名下暂无节点。节点归属写入注册表后，这里会立即出现。
                    </Text>
                  ) : (
                    <>
                      <View style={styles.myNodesStatRow}>
                        <View style={styles.myNodesStat}>
                          <Text style={styles.myNodesValue}>{revenue.nodes_total}</Text>
                          <Text style={styles.myNodesLabel}>名下节点（台）</Text>
                        </View>
                        <View style={styles.myNodesStat}>
                          <Text style={styles.myNodesValue}>
                            {revenue.total_earnings_paw.toFixed(4)}
                          </Text>
                          <Text style={styles.myNodesLabel}>累计收益（PAW）</Text>
                        </View>
                        <View style={styles.myNodesStat}>
                          <Text style={styles.myNodesValue}>
                            {revenue.total_tokens_processed.toLocaleString()}
                          </Text>
                          <Text style={styles.myNodesLabel}>累计 Token</Text>
                        </View>
                      </View>
                      {revenue.nodes.map((node) => (
                        <View key={node.node_id} style={styles.myNodeRow}>
                          <Text style={styles.myNodeId}>{node.node_id}</Text>
                          <Text style={styles.myNodeMeta}>
                            {node.total_tokens_processed.toLocaleString()} tokens ·{' '}
                            {node.total_earnings_paw.toFixed(4)} PAW
                            {node.is_paused ? ' · 已暂停' : ''}
                          </Text>
                        </View>
                      ))}
                    </>
                  )}
                </Surface>

                {/* 节点收益提现（阶段六 P3-4）—— 内部台账 + 链上 PAW 通道 */}
                <NodePayoutCard />

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
                {/* 阶段二十四 P1：切到本页时**懒挂载**这几张重卡片
                    （切一次 tab 不再同时打 4 条重请求；兜底 800ms 内必挂）。*/}
                <LazyMount fallbackMs={800}>
                  <ModelStudioCard />
                </LazyMount>
                {/* 阶段九 P1：网页自助上架/配置推理模型（OWNER）*/}
                <LazyMount fallbackMs={900}>
                  <ModelUpsertCard />
                </LazyMount>
                <LazyMount fallbackMs={1000}>
                  <PipelineMeshCard />
                </LazyMount>
                {/* 阶段十二 P2：黄金 SFT/DPO 微调语料工坊（OWNER）*/}
                <LazyMount fallbackMs={1100}>
                  <GoldenDatasetCard />
                </LazyMount>
              </View>
            )}

            {hostTab === 'ROYALTY' && (
              <View style={styles.column}>
                <RoyaltyCard />
                {/* 阶段十一 P1：算力节点 & 创作者收益看板 + 自助提现申请 */}
                <EarningsWithdrawCard onSubmitted={bumpWithdrawRefresh} />
              </View>
            )}

            {hostTab === 'GOVERNANCE' && (
              <View style={styles.column}>
                {/* 阶段二十四 P1 · 治理页有 11 张重卡片 ⇒ 懒挂载，
                    避免"点一次 tab 就同时发 11 条请求"。兜底 800~2000ms 内必挂。*/}
                <LazyMount fallbackMs={800}>
                  <NodeGovernanceCard />
                </LazyMount>
                {/* 阶段十七 P2：网关内容安全拦截器看板（命中即 400，零扣费）*/}
                <LazyMount fallbackMs={900}>
                  <ModerationBlocksCard />
                </LazyMount>
                {/* 阶段十八 P0-P2：PoI 验真看板 + 模拟欺诈演练（Slashing 扣罚）*/}
                <LazyMount fallbackMs={1000}>
                  <PoiConsensusCard owner />
                </LazyMount>
                {/* 阶段十九 P0-P2：Model DAO 治理台 + PAWMODEL 导入 + USDT 储值审批台（OWNER）*/}
                <LazyMount fallbackMs={1100}>
                  <DaoAndEnterpriseCard owner />
                </LazyMount>
                {/* 阶段二十 P0/P2：Mesh 合体集群组建演练（OWNER）+ 联邦合规大盘 */}
                <LazyMount fallbackMs={1200}>
                  <MeshAndFederationCard owner />
                </LazyMount>
                <LazyMount fallbackMs={1300}>
                  <PricingApprovalCard />
                </LazyMount>
                {/* 阶段九 P2/P3：充值卡密签发 + 提现审批台（OWNER）*/}
                <LazyMount fallbackMs={1400}>
                  <VoucherIssueCard />
                </LazyMount>
                {/* 阶段十一 P1：与审批台同页联动 —— 批准/驳回后收益面板即时刷新 */}
                <LazyMount fallbackMs={1500}>
                  <EarningsWithdrawCard
                    onSubmitted={bumpWithdrawRefresh}
                    refreshKey={withdrawRefreshKey}
                  />
                </LazyMount>
                <LazyMount fallbackMs={1600}>
                  <WithdrawalApprovalCard onDecided={bumpWithdrawRefresh} />
                </LazyMount>
                {/* 阶段九 P0：业主视角同样看得见全网分账公示 */}
                <LazyMount fallbackMs={1700}>
                  <LiveSettlementFeed />
                </LazyMount>
                {/* 阶段十 P2：业主视角同样看得见全网算力节点排行榜 */}
                <LazyMount fallbackMs={1800}>
                  <NodeLeaderboardCard />
                </LazyMount>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* ---------------- 钱包会话弹窗（阶段四 P4）---------------- */}
      <Modal
        visible={walletModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setWalletModalVisible(false)}
      >
        <View style={styles.modalBackdrop} id="apx-modal">
          <View style={[styles.modalCard, isMobile && styles.modalCardNarrow]} id="apx-modal-card">
            <Text style={styles.modalTitle}>钱包登录</Text>
            <Text style={styles.modalHint}>
              钱包私钥始终留在你的设备里，APIPaw 只拿到「签名者地址」与一份 2 小时有效的会话令牌。
            </Text>
            <WalletPanel
              onConnected={() => {
                loadRevenue();
                loadData();
              }}
            />
            <View style={[styles.modalActions, isMobile && styles.modalActionsNarrow]}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setWalletModalVisible(false)}
                testID="wallet-modal-close"
              >
                <Text style={styles.modalBtnGhostText}>关闭</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ---------------- 业主管理口令弹窗（阶段十 P0）---------------- */}
      <Modal
        visible={passkeyModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPasskeyModalVisible(false)}
      >
        <View style={styles.modalBackdrop} id="apx-modal">
          <View style={[styles.modalCard, isMobile && styles.modalCardNarrow]} id="apx-modal-card">
            <Text style={styles.modalTitle}>业主管理口令解锁</Text>
            <Text style={styles.modalHint}>
              没有钱包插件时的备用入口：输入管理口令换取一个标准 OWNER 会话
              （与钱包会话完全等价，服务端仍按数据库回查角色）。
            </Text>
            <OwnerPasskeyCard
              onUnlocked={() => {
                // ⚠️ **不自动关弹窗** —— 关掉会把「✓ 已解锁」提示一起卸载掉，
                //    用户（和验收脚本）都看不到结果。让用户自己点「关闭」。
                void loadData();
                void loadRevenue();
              }}
            />
            <View style={[styles.modalActions, isMobile && styles.modalActionsNarrow]}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setPasskeyModalVisible(false)}
                testID="passkey-modal-close"
              >
                <Text style={styles.modalBtnGhostText}>关闭</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ---------------- API Key 弹窗 ---------------- */}
      <Modal
        visible={keyModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setKeyModalVisible(false)}
      >
        <View style={styles.modalBackdrop} id="apx-modal">
          <View style={[styles.modalCard, isMobile && styles.modalCardNarrow]} id="apx-modal-card">
            <Text style={styles.modalTitle}>设置 API Key</Text>
            <Text style={styles.modalHint}>
              密钥将保存在本机浏览器 (localStorage)，仅用于向云端网关 https://cloud.apipaw.com 发起请求
            </Text>
            <KeyIssuePanel onAdopt={handleAdoptIssuedKey} onFaucet={handleFaucetGranted} />
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
            <View style={[styles.modalActions, isMobile && styles.modalActionsNarrow]}>
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
  /**
   * 手机档顶栏（阶段二十七 P0）—— **上下两行**：
   * 第一行只放品牌标识，第二行放 4 个操作按钮（可换行）。
   * 之前是单行硬挤，390px 下整组按钮溢出到 442px 并压住品牌文字。
   */
  headerNarrow: {
    flexDirection: 'column',
    alignItems: 'stretch',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  brandRowNarrow: { flexShrink: 0, width: '100%' },
  /** 品牌文字列必须允许收缩，否则长副标题会把整行撑破 */
  brandTextCol: { flexShrink: 1 },
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
  brandTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800', letterSpacing: 0.2 },
  brandSub: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginTop: 1,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 0 },
  /** 手机档：按钮组独占一行并允许换行（4 个按钮必然放不下 358px）*/
  headerActionsNarrow: {
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    alignItems: 'center',
    width: '100%',
    flexShrink: 1,
    gap: spacing.sm,
  },
  /** 手机档按钮：收紧内边距，尽量让 4 个按钮排成 2×2 而不是 4 行 */
  headerBtnNarrow: { paddingHorizontal: spacing.sm, paddingVertical: 6 },
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
  keyBtnText: { color: colors.textBody, fontSize: fontSize.sm, fontWeight: '700' },
  walletBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.cyanSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.35)',
  },
  walletBtnText: { color: colors.cyan, fontSize: fontSize.sm, fontWeight: '700' },
  roleBtn: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  roleBtnText: { color: colors.purple, fontSize: fontSize.sm, fontWeight: '700' },

  /** 阶段十 P0 · 业主管理口令入口（无插件场景的备用登录）*/
  passkeyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  passkeyBtnText: { color: colors.warn, fontSize: fontSize.sm, fontWeight: '700' },

  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 1180,
  },
  column: { gap: spacing.lg },

  /* 阶段二十六 P2：封闭公测边界声明（一行小字，零网络开销） */
  betaNotice: {
    borderWidth: 1,
    borderColor: colors.warn,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  betaNoticeText: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 19 },

  dashRow: { flexDirection: 'row', gap: spacing.lg, alignItems: 'stretch' },
  dashRowNarrow: { flexDirection: 'column' },
  dashSide: { flex: 1, gap: spacing.md, minWidth: 240 },
  /**
   * 手机档右侧指标列：纵向排列时**不能**再吃 `flex: 1`（basis 0）——
   * 那会把整列高度压成 0，三块指标卡叠在同一位置互相穿插。
   */
  dashSideNarrow: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    width: '100%',
    minWidth: 0,
  },
  /** 手机档 StatTile：按内容高度排布（桌面端仍等高拉伸）*/
  statTileNarrow: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },

  balanceCard: { flex: 1.45, gap: spacing.md },
  /**
   * 手机档余额卡：同理，纵向排列时必须按内容撑开。
   * 之前 `flex: 0` 等价于 basis 0% ⇒ 卡片高度塌成 0，内容溢出压住下方指标卡。
   */
  balanceCardNarrow: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    width: '100%',
  },
  balanceHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  /** 手机档标题行允许换行（标题 + CONNECTED 徽标并排会溢出）*/
  balanceHeadNarrow: { flexWrap: 'wrap', gap: spacing.sm, rowGap: spacing.xs },
  eyebrow: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  /** 标题允许收缩换行 —— 否则长标题把徽标顶出卡片 */
  eyebrowShrink: { flexShrink: 1 },
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
  balanceLiveText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '800', letterSpacing: 1 },
  balanceAmountRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  balanceValue: { fontSize: fontSize.hero, fontWeight: '800', letterSpacing: -1.5 },
  balanceUnit: { color: colors.textSecondary, fontSize: fontSize.title, fontWeight: '700' },
  balanceCaption: { color: colors.textSecondary, fontSize: fontSize.sm, marginTop: -spacing.sm },

  // 阶段八 P1 · 新手体验金入口
  faucetBox: { marginTop: spacing.sm, gap: 4 },
  faucetBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  faucetBtnText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '800' },
  faucetOkText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },
  faucetErrText: { color: colors.danger, fontSize: fontSize.xs },
  btnDisabled: { opacity: 0.5 },
  balanceMeta: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  /**
   * 手机档指标区：换行排布 —— 「当前密钥」独占一行（等宽密钥太长），
   * 「今日消费 / 单日上限」各占半行。
   */
  balanceMetaNarrow: { flexWrap: 'wrap', rowGap: spacing.md, gap: spacing.sm },
  balanceMetaCell: { flex: 1, gap: 4 },
  balanceMetaCellKey: { flexBasis: '100%', flexGrow: 0, flexShrink: 1, minWidth: 0 },
  balanceMetaCellHalf: { flexBasis: '45%', flexGrow: 1, flexShrink: 1, minWidth: 0 },
  balanceMetaLabel: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  // 渐变卡底部的三个核心指标 —— 放大加粗，在霓虹描边下清晰可读
  balanceMetaValue: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  /** 手机档数值降一档字号，避免等宽密钥被截断 */
  balanceMetaValueNarrow: { fontSize: fontSize.md },

  nodePanelCard: { flex: 1.2, gap: spacing.md },
  nodePanelStats: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  /** 手机档：两个统计数字并排太挤，允许换行 */
  nodePanelStatsNarrow: { flexWrap: 'wrap', gap: spacing.md, rowGap: spacing.sm },
  nodePanelStat: { gap: 4, flexShrink: 1 },
  nodePanelValue: { color: colors.accent, fontSize: fontSize.xxl, fontWeight: '800' },
  nodePanelLabel: { color: colors.textSecondary, fontSize: fontSize.sm },
  nodePanelDivider: { width: 1, height: 38, backgroundColor: colors.divider },

  nodeHintCard: { flex: 1, gap: spacing.sm, justifyContent: 'center' },
  nodeHintTitle: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  nodeHintText: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },

  nodeCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },

  myNodesCard: { gap: spacing.md },
  myNodesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  myNodesOwner: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '800',
    letterSpacing: 1,
  },
  myNodesHint: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },
  myNodesStatRow: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  myNodesStat: { gap: 4 },
  myNodesValue: { color: colors.accent, fontSize: fontSize.xl, fontWeight: '800' },
  myNodesLabel: { color: colors.textSecondary, fontSize: fontSize.xs },
  myNodeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: spacing.sm,
  },
  myNodeId: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  myNodeMeta: { color: colors.textSecondary, fontSize: fontSize.sm },
  nodeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  nodeHeadLeft: { flex: 1, gap: 4 },
  nodeIdText: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  nodeMetaText: { color: colors.textSecondary, fontSize: fontSize.sm },
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
  /** 手机档：4 个分段标签一行放不下 → 2×2 换行 */
  segmentWrapNarrow: { flexWrap: 'wrap' },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  /** 手机档分段按钮：按 45% 基准换行排布 */
  segmentNarrow: { flexBasis: '45%', flexGrow: 1, flexShrink: 1 },
  segmentActive: { backgroundColor: colors.purpleSoft, borderWidth: 1, borderColor: colors.purple },
  segmentText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
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
  /** 手机档弹窗：收紧内边距，给内部表单留出宽度 */
  modalCardNarrow: { padding: spacing.md, maxWidth: '100%' },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800', marginBottom: 8 },
  modalHint: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20, marginBottom: 14 },
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
  /** 手机档弹窗按钮行：允许换行，避免 3 个按钮挤出弹窗 */
  modalActionsNarrow: { flexWrap: 'wrap', justifyContent: 'flex-start' },
  modalBtn: { paddingHorizontal: spacing.lg, paddingVertical: 9, borderRadius: radius.md },
  modalBtnGhost: { backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border },
  modalBtnGhostText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  modalBtnPrimary: { backgroundColor: colors.accent },
  modalBtnPrimaryText: { color: '#052E21', fontSize: fontSize.sm, fontWeight: '800' },
});
