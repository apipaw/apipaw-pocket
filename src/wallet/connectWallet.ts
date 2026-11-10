import { getAddress, verifyMessage } from 'ethers';
import { fetchAuthNonce, verifyWalletSignature } from './api';
import { pickAdapter } from './providers';
import { ALLOWED_CHAIN_IDS, WalletAdapter, WalletError, WalletSession } from './types';

/**
 * 钱包登录主流程（阶段四 P4）。
 *
 *   连接钱包 → 校验链 ID → 领 nonce → personal_sign → 服务端验签换 JWT
 *
 * 关键约束（与后端 auth_wallet / auth_jwt 一一对应）：
 *   - **消息由服务端拼**：前端只负责把 message 原样交给钱包签名，
 *     绝不自己拼 SIWE 消息（否则会与服务端逐字节比对失败）。
 *   - **签名者地址必须等于登录地址**：服务端恢复公钥后比对，
 *     前端这里也做一次同样口径的自检（防呆，不替代服务端验签）。
 *   - **绝不在前端生成密钥 / 绝不代签**。
 */

export interface ConnectProgress {
  (step: string): void;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const connectWallet = async (
  adapter?: WalletAdapter,
  onProgress?: ConnectProgress,
): Promise<WalletSession> => {
  const wallet = adapter ?? pickAdapter();
  const report = onProgress ?? (() => undefined);

  report(`正在唤起钱包：${wallet.label}`);
  const { address, chainId } = await wallet.connect();

  if (!ALLOWED_CHAIN_IDS.includes(chainId)) {
    throw new WalletError(
      `当前链 ID ${chainId} 不受支持，请切换到以太坊主网 (1) 或 Sepolia (11155111) 后重试`,
    );
  }

  report('正在向云端领取一次性签名挑战');
  const challenge = await fetchAuthNonce(address, chainId);

  report('请在钱包中确认签名');
  const signature = await wallet.signMessage(challenge.message, address);

  // 客户端自检：签名必须能恢复出同一个地址（服务端还会再验一次）
  let recovered = '';
  try {
    recovered = getAddress(verifyMessage(challenge.message, signature));
  } catch {
    throw new WalletError('钱包返回的签名无法解析，请重试');
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new WalletError('签名地址与登录钱包不一致，已拒绝本次登录');
  }

  report('正在校验签名并建立会话');
  const result = await verifyWalletSignature({
    address,
    message: challenge.message,
    signature,
    nonce: challenge.nonce,
  });

  return {
    token: result.access_token,
    expiresAt: nowSeconds() + Number(result.expires_in || 0),
    handle: result.user?.handle || '',
    role: String(result.user?.role || '').toUpperCase(),
    status: String(result.user?.status || 'active'),
    wallet: result.user?.wallet || address,
  };
};
