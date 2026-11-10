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
export type HostTab = 'NODES' | 'STUDIO' | 'ROYALTY';

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
  creatorWallet: string;
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

  setRoleMode: (mode: RoleMode) => void;
  setApiKey: (key: string) => void;
  setBalanceUsd: (balance: number) => void;
  setSpentTodayUsd: (spent: number) => void;
  setDailyLimitUsd: (limit: number) => void;
  setSelectedModelId: (modelId: string) => void;

  setHostTab: (tab: HostTab) => void;
  setCreatorWallet: (wallet: string) => void;
  setCreatorModelId: (modelId: string) => void;
  setTopologyModelId: (modelId: string) => void;

  /** 写入钱包会话（同时落盘到 SecureStore） */
  setSession: (session: WalletSession) => void;
  /** 清空钱包会话（同时擦掉 SecureStore 里的 JWT） */
  clearSession: () => void;
  /** 标记会话恢复完成 */
  markSessionReady: () => void;
}

export const usePawStore = create<PawState>((set) => ({
  roleMode: 'BUYER',
  apiKey: readPersistedApiKey(),
  balanceUsd: 100.0,
  spentTodayUsd: 0,
  dailyLimitUsd: 500.0,
  selectedModelId: 'deepseek-r1',

  hostTab: 'NODES',
  creatorWallet: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  creatorModelId: 'qwen-2.5-72b',
  topologyModelId: 'qwen-2.5-72b',

  sessionToken: '',
  sessionExpiresAt: 0,
  sessionHandle: '',
  sessionRole: '',
  sessionStatus: '',
  sessionWallet: '',
  sessionReady: false,

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
  setCreatorWallet: (creatorWallet) => set({ creatorWallet }),
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
