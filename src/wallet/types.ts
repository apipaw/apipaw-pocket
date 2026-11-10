/**
 * 钱包会话（阶段四 P4）类型定义。
 *
 * 术语：
 *   - **登录钱包** = 用户用私钥签名的那个钱包（决定账户身份）
 *   - **创作者钱包** = 收益归属用的钱包（`creatorWallet`，与登录钱包无关）
 * 两者**必须区分** —— 蓝图 §4.7 明确要求 UI 上说清楚。
 */

/** 最小 EIP-1193 提供者接口 —— 只声明本项目实际调用的方法 */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** 授权后的钱包连接 */
export interface ConnectedWallet {
  /** EIP-55 校验和地址（展示用） */
  address: string;
  /** 十进制链 ID */
  chainId: number;
}

/**
 * 钱包适配器 —— 把「不同形态的钱包」统一成两个动作：授权 + 签名。
 *
 * 为什么要这层抽象：Pocket 既是 React Native App（唤起外部钱包 App），
 * 也是 Expo Web 静态站（浏览器扩展注入 provider）。
 * 两种形态的调用方式完全不同，但**上层流程完全一致**
 * （连接 → 领 nonce → 签 → 换 JWT），所以流程只写一份，差异全部收敛到适配器。
 */
export interface WalletAdapter {
  id: 'injected' | 'deeplink';
  /** UI 展示名 */
  label: string;
  /** 当前运行环境是否支持该适配器 */
  available(): boolean;
  /** 唤起钱包完成授权，返回地址与链 ID */
  connect(): Promise<ConnectedWallet>;
  /** 用钱包私钥对消息做 EIP-191 personal_sign */
  signMessage(message: string, address: string): Promise<string>;
}

/** 一次成功的钱包登录所建立的服务端会话 */
export interface WalletSession {
  /** JWT（Bearer 凭证，2 小时有效） */
  token: string;
  /** 过期时间（epoch 秒） */
  expiresAt: number;
  /** 账户句柄 `acct_xxx` */
  handle: string;
  /** 服务端权威角色：OWNER / BUYER —— **不是**本地 UI 开关 */
  role: string;
  /** 账户状态：active / pending（pending = 待审核，无业主权限） */
  status: string;
  /** 登录钱包地址 */
  wallet: string;
}

/** 与服务端 auth_wallet.ALLOWED_CHAIN_IDS 保持一致 */
export const ALLOWED_CHAIN_IDS: number[] = [1, 11155111];

/** 钱包链路错误 —— UI 直接展示 message */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}
