import { create } from 'zustand';
import { secureGet, secureRemove, secureSet, STORAGE_KEYS } from '../wallet/secureStore';
import type { WalletSession } from '../wallet/types';

type RoleMode = 'BUYER' | 'HOST';

/**
 * API Key 持久化 —— 买家通道的凭证。
 *
 * - 原生端：expo-secure-store（Keychain / Keystore）
 * - Web 端：localStorage（浏览器没有系统钥匙串可用）
 *
 * ⚠️ **彻底不读构建期环境变量**：`EXPO_PUBLIC_API_KEY` 会被 Metro 内联进产物，
 * 等于把密钥烤进 bundle（公开仓库里就是公开的）。P4 起 Key 只有两个来源：
 * 「签发 API Key」面板现场签发，或用户手动输入后落盘。
 */
const readPersistedApiKey = (): string => {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEYS.apiKey);
      if (stored) return stored;
    }
  } catch {
    /* 隐私模式 / 非浏览器环境 —— 退化为仅内存 */
  }
  return '';
};

const persistApiKey = (key: string): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.apiKey, key);
    }
  } catch {
    /* 忽略写入失败 */
  }
  // 原生端同步一份进 Keychain（Web 端上一步已完成）
  void secureSet(STORAGE_KEYS.apiKey, key);
};

/** HOST 端内部分段切换 */
export type HostTab = 'NODES' | 'STUDIO' | 'ROYALTY' | 'GOVERNANCE';

interface PawState {
  /** 本地**视图偏好**（买家视角 / 业主视角）—— **不再是权限来源** */
  roleMode: RoleMode;
  apiKey: string;
  balanceUsd: number;
  spentTodayUsd: number;
  dailyLimitUsd: number;
  selectedModelId: string;

  // ---- 创作者端 (CreatorEx) ----
  hostTab: HostTab;
  /**
   * 创作者钱包 —— **服务端权威**（阶段六 P3 · D3）。
   *
   * 🔴 此前这里写死过一个演示钱包（`0x71C7…976F`），前端拿它当"身份"，
   *    于是任何人的上架都挂在同一个地址名下。现在初始值为空串，
   *    由 ``GET /api/v1/creator/identity`` 回填 —— 服务端说什么就是什么，
   *    客户端填的值一律被服务端忽略。
   */
  creatorWallet: string;
  /** 服务端返回的创作者 ID（同样以服务端为准） */
  creatorId: string;
  creatorModelId: string;
  /** 当前查看拓扑的模型（与已上架模型联动） */
  topologyModelId: string;

  // ---- 钱包会话（阶段四 P4）----
  /** 会话 JWT —— 只当**凭证**，角色与归属一律以服务端为准 */
  sessionToken: string;
  /** 过期时间（epoch 秒） */
  sessionExpiresAt: number;
  /** 账户句柄 */
  sessionHandle: string;
  /** 服务端权威角色：OWNER / BUYER */
  sessionRole: string;
  /** 账户状态：active / pending */
  sessionStatus: string;
  /** 登录钱包地址 */
  sessionWallet: string;
  /** 是否已完成会话恢复（避免首屏闪「未登录」） */
  sessionReady: boolean;

  /**
   * 模型目录版本号（阶段九 P1）。
   *
   * 为什么需要它：Playground 的模型列表是**挂载时拉一次**的，
   * 此前「上架新模型」必须刷新整页才看得见 —— 现在 OWNER 在网页上架后
   * 调一次 ``bumpModelCatalog()``，Playground 立刻重新拉目录并把新模型选中。
   * 用版本号而不是事件总线：跨组件的最小耦合，天然幂等。
   */
  modelCatalogVersion: number;

  setRoleMode: (mode: RoleMode) => void;
  setApiKey: (key: string) => void;
  setBalanceUsd: (balance: number) => void;
  setSpentTodayUsd: (spent: number) => void;
  setDailyLimitUsd: (limit: number) => void;
  setSelectedModelId: (modelId: string) => void;

  setHostTab: (tab: HostTab) => void;
  /** 写入创作者身份（服务端权威回填） */
  setCreatorIdentity: (wallet: string, creatorId?: string) => void;
  setCreatorModelId: (modelId: string) => void;
  setTopologyModelId: (modelId: string) => void;

  /** 写入钱包会话（同时落盘到 SecureStore） */
  setSession: (session: WalletSession) => void;
  /** 清空钱包会话（同时擦掉 SecureStore 里的 JWT） */
  clearSession: () => void;
  /** 标记会话恢复完成 */
  markSessionReady: () => void;
  /** 模型目录有变动 —— Playground 重新拉取模型列表（阶段九 P1） */
  bumpModelCatalog: () => void;
}

export const usePawStore = create<PawState>((set) => ({
  roleMode: 'BUYER',
  apiKey: readPersistedApiKey(),
  balanceUsd: 100.0,
  spentTodayUsd: 0,
  dailyLimitUsd: 500.0,
  selectedModelId: 'deepseek-r1',

  hostTab: 'NODES',
  // 阶段六 P3 · D3：**不再硬编码**创作者钱包 —— 由服务端身份端点回填。
  creatorWallet: '',
  creatorId: '',
  creatorModelId: 'qwen-2.5-72b',
  topologyModelId: 'qwen-2.5-72b',

  sessionToken: '',
  sessionExpiresAt: 0,
  sessionHandle: '',
  sessionRole: '',
  sessionStatus: '',
  sessionWallet: '',
  sessionReady: false,

  modelCatalogVersion: 0,

  setRoleMode: (roleMode) => set({ roleMode }),
  setApiKey: (apiKey) => {
    persistApiKey(apiKey);
    set({ apiKey });
  },
  setBalanceUsd: (balanceUsd) => set({ balanceUsd }),
  setSpentTodayUsd: (spentTodayUsd) => set({ spentTodayUsd }),
  setDailyLimitUsd: (dailyLimitUsd) => set({ dailyLimitUsd }),
  setSelectedModelId: (selectedModelId) => set({ selectedModelId }),

  setHostTab: (hostTab) => set({ hostTab }),
  setCreatorIdentity: (creatorWallet, creatorId) =>
    set({
      creatorWallet: creatorWallet || '',
      creatorId: creatorId !== undefined ? creatorId : usePawStore.getState().creatorId,
    }),
  setCreatorModelId: (creatorModelId) => set({ creatorModelId }),
  setTopologyModelId: (topologyModelId) => set({ topologyModelId }),

  setSession: (session) => {
    set({
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      sessionHandle: session.handle,
      sessionRole: session.role,
      sessionStatus: session.status,
      sessionWallet: session.wallet,
      sessionReady: true,
      // OWNER 账户自动切到业主视角（服务端角色优先于本地偏好）
      roleMode: session.role === 'OWNER' ? 'HOST' : 'BUYER',
    });
    void secureSet(STORAGE_KEYS.session, JSON.stringify(session));
  },

  clearSession: () => {
    set({
      sessionToken: '',
      sessionExpiresAt: 0,
      sessionHandle: '',
      sessionRole: '',
      sessionStatus: '',
      sessionWallet: '',
      sessionReady: true,
    });
    void secureRemove(STORAGE_KEYS.session);
  },

  markSessionReady: () => set({ sessionReady: true }),

  bumpModelCatalog: () =>
    set({ modelCatalogVersion: usePawStore.getState().modelCatalogVersion + 1 }),
}));

/**
 * 应用启动时恢复会话（原生端从 Keychain 读 JWT，Web 端从 localStorage 读）。
 *
 * 恢复出来的会话若已过期 —— 直接丢弃，**不静默续期**：
 * 钱包登录不发 refresh token（决策 D11），过期就重新签名。
 */
export const hydrateSession = async (): Promise<void> => {
  const store = usePawStore.getState();

  // ---- API Key（原生端 Keychain 优先）----
  const nativeKey = await secureGet(STORAGE_KEYS.apiKey);
  if (nativeKey && nativeKey !== store.apiKey) {
    store.setApiKey(nativeKey);
  }

  // ---- 钱包会话 ----
  const raw = await secureGet(STORAGE_KEYS.session);
  if (raw) {
    try {
      const session = JSON.parse(raw) as WalletSession;
      const expired = !session.expiresAt || session.expiresAt * 1000 <= Date.now();
      if (expired) {
        await secureRemove(STORAGE_KEYS.session);
      } else {
        store.setSession(session);
        return;
      }
    } catch {
      await secureRemove(STORAGE_KEYS.session);
    }
  }
  store.markSessionReady();
};
