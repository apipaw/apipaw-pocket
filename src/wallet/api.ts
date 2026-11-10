import axios from 'axios';
import { CLOUD_BASE_URL, CLOUD_REQUEST_TIMEOUT_MS } from '../api/cloudClient';
import { WalletError } from './types';

/**
 * 钱包认证接口（阶段四 P3 后端 / P4 前端）。
 *
 * 刻意**不复用** cloudApi —— cloudApi 的拦截器会注入 `Authorization` 头，
 * 而 nonce / verify 是**匿名**接口，携带旧凭证反而语义混乱。
 */

const authApi = axios.create({
  baseURL: CLOUD_BASE_URL,
  timeout: CLOUD_REQUEST_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

export interface AuthNonceResponse {
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  chain_id: number;
  expires_at: number;
}

export interface AuthVerifyUser {
  handle: string;
  role: string;
  wallet: string;
  status: string;
  account_type?: string;
}

export interface AuthVerifyResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: AuthVerifyUser;
}

/** 把后端的 HTTP 错误翻译成给用户看的中文提示 */
const readDetail = (e: unknown, fallback: string): string => {
  const err = e as { response?: { status?: number; data?: { detail?: string } }; message?: string };
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail) {
    // 后端 detail 可能是英文原文 —— 保留原文但加前缀，方便定位
    return `${fallback}（${detail}）`;
  }
  if (err?.response?.status === 429) return `${fallback}：请求过于频繁，请稍后再试`;
  return fallback;
};

/** 领取一次性签名挑战 —— 服务端会存下 nonce 与拼好的完整消息 */
export const fetchAuthNonce = async (
  address: string,
  chainId: number,
): Promise<AuthNonceResponse> => {
  try {
    const res = await authApi.post('/api/v1/auth/nonce', { address, chain_id: chainId });
    return res.data as AuthNonceResponse;
  } catch (e) {
    throw new WalletError(readDetail(e, '获取签名挑战失败'));
  }
};

/** 提交签名换取会话 JWT */
export const verifyWalletSignature = async (payload: {
  address: string;
  message: string;
  signature: string;
  nonce: string;
}): Promise<AuthVerifyResponse> => {
  try {
    const res = await authApi.post('/api/v1/auth/verify', payload);
    return res.data as AuthVerifyResponse;
  } catch (e) {
    const err = e as { response?: { status?: number } };
    if (err?.response?.status === 401) {
      throw new WalletError('签名验证未通过：请确认签名钱包与登录地址一致，且 nonce 未被使用过');
    }
    if (err?.response?.status === 400) {
      throw new WalletError('签名消息与服务端不一致（可能已被篡改或过期），请重新发起登录');
    }
    throw new WalletError(readDetail(e, '签名验证失败'));
  }
};

/** 撤销当前会话（登出）—— 服务端按 jti 立即作废 */
export const revokeSession = async (token: string): Promise<void> => {
  try {
    await authApi.post(
      '/api/v1/auth/logout',
      undefined,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (e) {
    // 登出失败不影响本地清理 —— 服务端会话还有 TTL 兜底；但必须留痕，不能静默吞掉
    console.warn('[wallet] 服务端会话撤销失败，本地会话已清除', e);
  }
};
