import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * 凭证存储抽象。
 *
 * - **原生端（iOS / Android）**：`expo-secure-store` → Keychain / Keystore，
 *   凭证由系统加密保管，落在应用沙盒的加密存储里。
 * - **Web 端**：SecureStore 没有实现（其 web 版导出空对象）→ 退化为 `localStorage`。
 *
 * 为什么要这层：钱包会话 JWT 虽是 2 小时短命，但**拿到就能冒用**。
 * 原生端放明文存储在共享设备上等于裸奔；Web 端没有系统钥匙串可用，
 * 至少要保证**不落 URL / 不落日志**，并且能一键清除。
 */

/** 存储键名（集中管理，避免散落魔法字符串） */
export const STORAGE_KEYS = {
  /** 钱包会话 JWT 与元信息 */
  session: 'apipaw.session',
  /** 买家 API Key */
  apiKey: 'apipaw.api_key',
} as const;

const isWeb = Platform.OS === 'web';

export const secureGet = async (key: string): Promise<string | null> => {
  if (!isWeb) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch (e) {
      console.warn('[secureStore] 读取系统钥匙串失败', e);
      return null;
    }
  }
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch (e) {
    console.warn('[secureStore] 读取 localStorage 失败（隐私模式）', e);
    return null;
  }
};

export const secureSet = async (key: string, value: string): Promise<void> => {
  if (!isWeb) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (e) {
      // 存储失败不应打断主流程 —— 会话只在内存里活着，下次重新登录即可；但必须留痕
      console.warn('[secureStore] 写入系统钥匙串失败', e);
    }
    return;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch (e) {
    console.warn('[secureStore] 写入 localStorage 失败（隐私模式 / 配额满）', e);
  }
};

export const secureRemove = async (key: string): Promise<void> => {
  if (!isWeb) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
};
