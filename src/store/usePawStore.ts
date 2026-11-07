import { create } from 'zustand';

type RoleMode = 'BUYER' | 'HOST';

/**
 * API Key 持久化 —— 静态站点部署后没有后端会话，
 * 密钥保存在浏览器 localStorage，刷新页面不丢。
 */
const API_KEY_STORAGE_KEY = 'apipaw.api_key';

const readPersistedApiKey = (): string => {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(API_KEY_STORAGE_KEY);
      if (stored) return stored;
    }
  } catch {
    /* 隐私模式 / 非浏览器环境 —— 退化为仅内存 */
  }
  return (process.env.EXPO_PUBLIC_API_KEY as string | undefined) || '';
};

const persistApiKey = (key: string): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(API_KEY_STORAGE_KEY, key);
    }
  } catch {
    /* 忽略写入失败 */
  }
};

/** HOST 端内部分段切换 */
export type HostTab = 'NODES' | 'STUDIO' | 'ROYALTY';

interface PawState {
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
}));
