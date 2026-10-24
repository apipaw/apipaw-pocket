import { create } from 'zustand';

type RoleMode = 'BUYER' | 'HOST';

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
  apiKey: 'paw-sk-demo1234567890',
  balanceUsd: 100.0,
  spentTodayUsd: 0,
  dailyLimitUsd: 500.0,
  selectedModelId: 'deepseek-r1',

  hostTab: 'NODES',
  creatorWallet: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  creatorModelId: 'qwen-2.5-72b',
  topologyModelId: 'qwen-2.5-72b',

  setRoleMode: (roleMode) => set({ roleMode }),
  setApiKey: (apiKey) => set({ apiKey }),
  setBalanceUsd: (balanceUsd) => set({ balanceUsd }),
  setSpentTodayUsd: (spentTodayUsd) => set({ spentTodayUsd }),
  setDailyLimitUsd: (dailyLimitUsd) => set({ dailyLimitUsd }),
  setSelectedModelId: (selectedModelId) => set({ selectedModelId }),

  setHostTab: (hostTab) => set({ hostTab }),
  setCreatorWallet: (creatorWallet) => set({ creatorWallet }),
  setCreatorModelId: (creatorModelId) => set({ creatorModelId }),
  setTopologyModelId: (topologyModelId) => set({ topologyModelId }),
}));
