import { Linking, Platform } from 'react-native';
import * as ExpoLinking from 'expo-linking';
import { BrowserProvider, getAddress } from 'ethers';
import {
  ConnectedWallet,
  Eip1193Provider,
  WalletAdapter,
  WalletError,
} from './types';

/**
 * 钱包适配器实现。
 *
 * 两种形态：
 *   1. **injected**（Web 静态站，浏览器扩展注入 `window.ethereum`）
 *      —— 这是 console.apipaw.com 今天真正跑得通的那条路。
 *   2. **deeplink**（React Native 原生端，唤起 MetaMask 移动端 App）
 *      —— 通过 `expo-linking` 打开钱包 App 的 universal link，
 *         签名结果再由 App 自己的 URL scheme 接回来。
 *
 * ⚠️ deeplink 这条路**依赖真机 + 已安装的 MetaMask 移动端**才能验证，
 *    本仓库的 e2e 覆盖的是 injected 路径（真实签名，服务端真验签）。
 */

/** 取浏览器注入的 EIP-1193 provider（MetaMask / Rabby / 其他钱包扩展） */
export const getInjectedProvider = (): Eip1193Provider | null => {
  if (Platform.OS === 'web') {
    const w = globalThis as unknown as { ethereum?: Eip1193Provider };
    return w.ethereum ?? null;
  }
  return null;
};

const toHexChainId = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = value.startsWith('0x') ? parseInt(value, 16) : parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'bigint') return Number(value);
  return 0;
};

const firstAccount = (raw: unknown): string => {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    list = raw.split(',');
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new WalletError('钱包未返回可用账户');
  }
  const first = String(list[0]);
  if (!/^0x[0-9a-fA-F]{40}$/.test(first)) {
    throw new WalletError('钱包返回的账户地址格式非法');
  }
  return getAddress(first);
};

// ---------------------------------------------------------------------------
// 1. 浏览器扩展注入（Web）
// ---------------------------------------------------------------------------

export const injectedAdapter: WalletAdapter = {
  id: 'injected',
  label: '浏览器钱包扩展（MetaMask / Rabby）',

  available(): boolean {
    return Boolean(getInjectedProvider());
  },

  async connect(): Promise<ConnectedWallet> {
    const provider = getInjectedProvider();
    if (!provider) {
      throw new WalletError(
        '未检测到浏览器钱包扩展。请安装 MetaMask（或 Rabby）后在扩展里解锁账户再试。',
      );
    }
    let accounts: unknown;
    try {
      accounts = await provider.request({ method: 'eth_requestAccounts' });
    } catch (e) {
      throw new WalletError(`钱包授权被拒绝：${(e as Error)?.message || '用户取消了授权'}`);
    }
    const address = firstAccount(accounts);
    const chainId = toHexChainId(await provider.request({ method: 'eth_chainId' }));
    return { address, chainId };
  },

  async signMessage(message: string, address: string): Promise<string> {
    const provider = getInjectedProvider();
    if (!provider) {
      throw new WalletError('钱包扩展已不可用（请刷新页面后重试）');
    }
    const browserProvider = new BrowserProvider(provider as never);
    const signer = await browserProvider.getSigner(address);
    return signer.signMessage(message);
  },
};

// ---------------------------------------------------------------------------
// 2. 深链唤起外部钱包 App（React Native 原生端）
// ---------------------------------------------------------------------------

/** 本 App 注册的 URL scheme（见 app.json → expo.scheme） */
const APP_SCHEME = 'apipawpocket';

/** 钱包 App 的 universal link 入口 */
const METAMASK_LINK = 'https://metamask.app.link';

/** 深链请求超时（钱包里确认签名可能要一会儿） */
const DEEPLINK_TIMEOUT_MS = 180000;

const randomId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const encodeBase64 = (text: string): string => {
  // btoa 在 RN 里不存在；用 Buffer 兜底（Metro 会注入 node polyfill）
  const g = globalThis as unknown as {
    btoa?: (s: string) => string;
    Buffer?: { from(s: string, e: string): { toString(e: string): string } };
  };
  if (typeof g.btoa === 'function') return g.btoa(text);
  if (g.Buffer) return g.Buffer.from(text, 'utf-8').toString('base64');
  throw new WalletError('当前环境缺少 base64 编码能力');
};

const decodeBase64 = (text: string): string => {
  const g = globalThis as unknown as {
    atob?: (s: string) => string;
    Buffer?: { from(s: string, e: string): { toString(e: string): string } };
  };
  if (typeof g.atob === 'function') return g.atob(text);
  if (g.Buffer) return g.Buffer.from(text, 'base64').toString('utf-8');
  throw new WalletError('当前环境缺少 base64 解码能力');
};

/**
 * 从钱包回传的深链里取出业务数据。
 *
 * 兼容三种常见回传形态（不同钱包 / 不同版本编码不一致）：
 *   1. `result=<urlencoded JSON-RPC 响应>`
 *   2. `accounts=0x...,0x...` / `address=0x...`
 *   3. `signature=0x...`
 */
const parseDeepLinkPayload = (url: string): Record<string, string> => {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  const raw = `${query}&${hash}`;
  const out: Record<string, string> = {};
  raw.split('&').forEach((pair) => {
    if (!pair) return;
    const idx = pair.indexOf('=');
    const k = decodeURIComponent(idx >= 0 ? pair.slice(0, idx) : pair);
    const v = idx >= 0 ? decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' ')) : '';
    if (k) out[k] = v;
  });

  if (out.result) {
    try {
      const parsed = JSON.parse(out.result) as {
        result?: unknown;
        error?: { message?: string };
      };
      if (parsed?.error?.message) {
        throw new WalletError(`钱包返回错误：${parsed.error.message}`);
      }
      if (parsed?.result !== undefined) {
        out.__value = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
      }
    } catch (e) {
      if (e instanceof WalletError) throw e;
      /* 不是 JSON —— 忽略，走下面的字段兜底 */
    }
  }
  return out;
};

/**
 * 通过深链向钱包 App 发起一次 JSON-RPC 风格请求，并等待结果回传。
 */
const requestViaDeepLink = async (
  method: 'eth_requestAccounts' | 'personal_sign',
  params: Record<string, unknown>,
): Promise<string> => {
  const requestId = randomId();
  const callback = `${ExpoLinking.createURL('/wallet-callback')}?rid=${requestId}`;
  const payload = encodeBase64(JSON.stringify({ method, params }));

  const target = `${METAMASK_LINK}/${method}?redirect=${encodeURIComponent(
    callback,
  )}&payload=${encodeURIComponent(payload)}`;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      subscription.remove();
      clearTimeout(timer);
      fn();
    };

    const subscription = Linking.addEventListener('url', (event) => {
      try {
        const parsed = parseDeepLinkPayload(event.url);
        if (parsed.rid && parsed.rid !== requestId) return; // 不是本次请求的回传
        const value = parsed.__value || parsed.result || parsed.accounts || parsed.address || parsed.signature;
        if (!value) return;
        finish(() => resolve(value));
      } catch (e) {
        finish(() => reject(e instanceof WalletError ? e : new WalletError('解析钱包回传数据失败')));
      }
    });

    const timer = setTimeout(
      () => finish(() => reject(new WalletError('等待钱包响应超时（3 分钟），请重试'))),
      DEEPLINK_TIMEOUT_MS,
    );

    Linking.openURL(target).catch((e) =>
      finish(() =>
        reject(new WalletError(`无法唤起钱包 App：${(e as Error)?.message || '请确认已安装 MetaMask'}`)),
      ),
    );
  });
};

export const deepLinkAdapter: WalletAdapter = {
  id: 'deeplink',
  label: 'MetaMask 移动端（深链唤起）',

  available(): boolean {
    return Platform.OS !== 'web';
  },

  async connect(): Promise<ConnectedWallet> {
    const raw = await requestViaDeepLink('eth_requestAccounts', {});
    const address = firstAccount(raw);
    // 移动端深链不回 chainId —— 签名与验签都与链无关，主网签名同样有效
    return { address, chainId: 1 };
  },

  async signMessage(message: string, address: string): Promise<string> {
    const raw = await requestViaDeepLink('personal_sign', { message, address });
    const signature = raw.startsWith('0x') ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new WalletError('钱包返回的签名长度非法');
    }
    return signature;
  },
};

/** 按平台挑选可用的适配器（Web 优先扩展，原生端走深链） */
export const pickAdapter = (): WalletAdapter => {
  const injected = injectedAdapter.available();
  if (injected) return injectedAdapter;
  if (deepLinkAdapter.available()) return deepLinkAdapter;
  throw new WalletError(
    '当前环境没有可用的钱包通道。Web 端请安装 MetaMask 扩展；移动端请安装 MetaMask App。',
  );
};

/** App 的深链回调地址（注册进 app.json 的 scheme） */
export const APP_URL_SCHEME = APP_SCHEME;
