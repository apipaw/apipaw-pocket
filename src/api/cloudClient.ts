import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { usePawStore } from '../store/usePawStore';

/**
 * APIPaw Cloud 网关地址。
 * - 云端部署 (Web 静态站 / 已发布 App): https://cloud.apipaw.com
 * - 本地联调: 构建时设置 EXPO_PUBLIC_API_BASE_URL 覆盖为 http://127.0.0.1:8000
 *   (Android 模拟器用 http://10.0.2.2:8000)
 *
 * EXPO_PUBLIC_* 变量由 Metro 在打包时内联进产物，因此该值会随静态站点一同上线。
 */
const FALLBACK_BASE_URL = 'https://cloud.apipaw.com';

export const CLOUD_BASE_URL: string =
  (process.env.EXPO_PUBLIC_API_BASE_URL as string | undefined) || FALLBACK_BASE_URL;

/**
 * 网关经 Cloudflare 回源，24 小时聚合分析接口实测冷路径可达 100s 以上，
 * 因此统一放宽超时，避免看板刚挂载就判定失败。
 */
export const CLOUD_REQUEST_TIMEOUT_MS = 120000;

export const cloudApi = axios.create({
  baseURL: CLOUD_BASE_URL,
  timeout: CLOUD_REQUEST_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * 阶段二十 P2 · **多网关主备降级**（前端内置容灾）。
 *
 * 后端（Agent 侧）已有主备自动切换；前端同样需要 —— 否则网关整体不可用时
 * 整个看板直接白屏。做法与 Agent 侧同口径：
 *
 * - 只有 **502 / 503 / 504**（网关层错误）与**网络层不可达**才触发切换；
 *   4xx 是「请求不对」，换个网关也一样错，切了纯属浪费；
 * - 幂等请求（GET / HEAD）切到备用网关后**重放**；
 *   非幂等（POST）**不重放**（避免重复下单 / 重复计费），
 *   只把「当前网关」切走，让后续请求走健康网关；
 * - 备用网关成功应答后，**过一道冷却期再切回主网关**（避免抖动来回搬）。
 *
 * 备用网关地址由构建期环境变量 ``EXPO_PUBLIC_CLOUD_BACKUP_URLS`` 提供
 * （逗号分隔）；没配就退化成单网关，行为与从前完全一致。
 */
export const CLOUD_BACKUP_BASE_URLS: string[] = (
  (process.env.EXPO_PUBLIC_CLOUD_BACKUP_URLS as string | undefined) || ''
)
  .split(',')
  .map((u) => u.trim())
  .filter((u) => !!u && u !== CLOUD_BASE_URL);

export const CLOUD_GATEWAY_URLS: string[] = [CLOUD_BASE_URL, ...CLOUD_BACKUP_BASE_URLS];

export interface GatewayStatus {
  /** 当前生效的网关地址 */
  baseUrl: string;
  /** 当前网关在候选列表中的下标（0 = 主网关） */
  index: number;
  /** 候选网关总数 */
  count: number;
  /** 是否处于降级态（当前跑在备用网关上） */
  degraded: boolean;
  /** 最近一次切换原因 */
  lastError: string;
  /** 最近一次切换时间戳（ms） */
  lastSwitchAt: number;
}

/** 切回主网关前的冷却期：避免一次抖动把请求在主备之间来回搬。 */
const GATEWAY_FAILBACK_COOLDOWN_MS = 30000;

let activeGatewayIndex = 0;
let gatewayDegraded = false;
let gatewayLastError = '';
let gatewayLastSwitchAt = 0;
const gatewayListeners = new Set<(status: GatewayStatus) => void>();

export const getGatewayStatus = (): GatewayStatus => ({
  baseUrl: CLOUD_GATEWAY_URLS[activeGatewayIndex] || CLOUD_BASE_URL,
  index: activeGatewayIndex,
  count: CLOUD_GATEWAY_URLS.length,
  degraded: gatewayDegraded,
  lastError: gatewayLastError,
  lastSwitchAt: gatewayLastSwitchAt,
});

/** 订阅网关降级状态（用于在 UI 上打「已降级到备用网关」标记）。 */
export const subscribeGatewayStatus = (
  fn: (status: GatewayStatus) => void,
): (() => void) => {
  gatewayListeners.add(fn);
  return () => {
    gatewayListeners.delete(fn);
  };
};

const notifyGatewayStatus = () => {
  const status = getGatewayStatus();
  gatewayListeners.forEach((fn) => {
    try {
      fn(status);
    } catch {
      /* 监听器异常不得影响请求链路 */
    }
  });
};

/** 切到下一个网关；没有备机时返回 false。 */
const switchGateway = (reason: string): boolean => {
  if (CLOUD_GATEWAY_URLS.length <= 1) return false;
  activeGatewayIndex = (activeGatewayIndex + 1) % CLOUD_GATEWAY_URLS.length;
  gatewayDegraded = activeGatewayIndex !== 0;
  gatewayLastError = reason;
  gatewayLastSwitchAt = Date.now();
  notifyGatewayStatus();
  return true;
};

/** 冷却期过后切回主网关（备用网关已证明可用）。 */
const maybeFailbackToPrimary = () => {
  if (activeGatewayIndex === 0) return;
  if (Date.now() - gatewayLastSwitchAt < GATEWAY_FAILBACK_COOLDOWN_MS) return;
  activeGatewayIndex = 0;
  gatewayDegraded = false;
  notifyGatewayStatus();
};

/**
 * 只接受**钱包会话 JWT** 的端点（阶段四 P3 新增的业主收益端点）。
 *
 * 其余端点继续走 API Key —— 这是阶段四「双通道鉴权：同一个 Authorization 头，
 * 两种凭证」的设计：钱包会话只服务于**钱包身份**那条链路，
 * 不去冒充买家的 API Key 去做推理计费。
 */
const JWT_ONLY_PATHS = ['/api/v1/owner/nodes/revenue'];

/**
 * 阶段四 P5 · 行动 b：**业主端点双通道**（钱包会话 JWT 或 API Key 都收）。
 *
 * 背景: M6 硬切把旧明文 Key 连同影子行一起废掉之后，
 * 线上必须仍有业主通道。后端 `require_owner` 改成两种凭证都接受，
 * 前端相应地：*有会话就优先用会话*（用户已签名登录，语义上更准），
 * *没有会话就回落 API Key*（旧客户端零改动仍可用）。
 *
 * 注意 `/api/v1/owner/nodes/revenue` 是 JWT-**only**（后端不认 API Key），
 * 所以判断顺序必须先判 JWT_ONLY 再判 owner 前缀 —— 否则会误落到 API Key 上。
 */
const OWNER_PATH_PREFIX = '/api/v1/owner';

/**
 * 阶段六 P2 · 节点自助端点（`POST /api/v1/nodes/{id}/pause` 与
 * `POST /api/v1/nodes/{id}/appeal`）**不在** `/api/v1/owner` 路径下，
 * 但它们同样是 OWNER 凭证口径（`require_owner` 收钱包会话 JWT 或 API Key）。
 *
 * 若不把它们算进「业主路径」，拦截器只会发买家 API Key —— 只有钱包会话、
 * 没有 API Key 的业主会直接吃到 401。这两个前缀同样按「会话优先、回落 API Key」
 * 处理。
 *
 * 阶段六 P3 追加两条：
 * - ``/api/v1/creator/`` —— 创作者身份是**钱包身份**（D3），必须走钱包会话；
 *   否则只有买家 API Key 的会话拿到的会是**别人的**创作者钱包。
 * - ``/api/v1/node/``   —— 节点收益 / 提现（业主钱包口径）。
 */
const OWNER_LIKE_PATH_PREFIXES = ['/api/v1/nodes/', '/api/v1/creator/', '/api/v1/node/'];

const isJwtOnlyPath = (url: string | undefined): boolean => {
  if (!url) return false;
  return JWT_ONLY_PATHS.some((p) => url.includes(p));
};

const isOwnerPath = (url: string | undefined): boolean => {
  if (!url) return false;
  if (url.includes(OWNER_PATH_PREFIX)) return true;
  return OWNER_LIKE_PATH_PREFIXES.some((p) => url.includes(p));
};

// 统一注入凭证：会话端点用 JWT，业主端点「会话优先、回落 API Key」，其余用买家 API Key
cloudApi.interceptors.request.use((config) => {
  // 阶段二十 P2：所有请求都打**当前生效的网关**（降级时自动指向备用网关）
  const gateway = CLOUD_GATEWAY_URLS[activeGatewayIndex];
  if (gateway) config.baseURL = gateway;
  const { apiKey, sessionToken } = usePawStore.getState();
  let credential = apiKey;
  if (isJwtOnlyPath(config.url)) {
    credential = sessionToken;
  } else if (isOwnerPath(config.url)) {
    credential = sessionToken || apiKey;
  }
  if (credential) {
    config.headers.Authorization = `Bearer ${credential}`;
    // 记住这次用的是不是会话 —— 401 时只有"确实发了会话"才该清会话，
    // 否则会因为一把坏掉的 API Key 把好端的钱包会话也踢掉。
    (config as AxiosRequestConfig & { __apipawUsedSession?: boolean }).__apipawUsedSession =
      !!sessionToken && credential === sessionToken;
  }
  return config;
});

/**
 * GET 请求的自动重试。
 * 云端网关回源链路 (Cloudflare -> nginx -> uvicorn) 偶发断连，
 * 浏览器会把这类中断记为 ERR_NETWORK（服务端日志里其实已经记成 200）。
 * 这里对幂等的 GET 做有限次退避重试，避免看板因为一次抖动就整块报错。
 * 注意：超时 (ECONNABORTED) 不重试 —— 聚合接口本来就慢，重试只会更久。
 */
const MAX_GET_RETRIES = 2;

/** 阶段二十 P2：网关层错误（与 Agent 侧 ``FAILOVER_STATUS_CODES`` 同口径）。 */
const GATEWAY_FAILOVER_STATUSES = [502, 503, 504];

cloudApi.interceptors.response.use(
  (response) => {
    // 阶段二十 P2：备用网关已证明可用 ⇒ 冷却期过后切回主网关
    maybeFailbackToPrimary();
    return response;
  },
  async (error) => {
    const config = error?.config as
      | (AxiosRequestConfig & {
          __apipawRetry?: number;
          __apipawUsedSession?: boolean;
          __apipawGatewayRetry?: number;
        })
      | undefined;
    if (!config) return Promise.reject(error);

    const method = (config.method || 'get').toLowerCase();
    const status = error?.response?.status;
    const isNetworkError = !status && error?.code !== 'ECONNABORTED';
    const isServerError = !!status && status >= 500;
    const retried = config.__apipawRetry || 0;

    // 钱包会话失效（401）—— 服务端已撤销 / 令牌过期 / 密钥轮换。
    // 这里立刻清掉本地会话，让 UI 提示「需重新签名」，而不是继续拿着废令牌重试。
    // ⚠️ 只在**这次请求确实发了会话**时才清 —— 业主端点现在是「会话优先、回落 API Key」，
    // 一把失效的 API Key 返回 401 不该把好端的钱包会话一起踢掉。
    if (status === 401 && config.__apipawUsedSession && usePawStore.getState().sessionToken) {
      usePawStore.getState().clearSession();
    }

    // 阶段二十 P2 · 多网关容灾：网关层错误 / 网络不可达 ⇒ 切备用网关。
    const isGatewayError = !!status && GATEWAY_FAILOVER_STATUSES.includes(status);
    if (CLOUD_GATEWAY_URLS.length > 1 && (isGatewayError || isNetworkError)) {
      const reason = isGatewayError ? `HTTP ${status}` : 'network unreachable';
      const switched = switchGateway(reason);
      const gatewayRetried = config.__apipawGatewayRetry || 0;
      // 幂等请求才重放；POST 不重放（避免重复下单 / 重复计费）
      const replayable = method === 'get' || method === 'head';
      if (switched && replayable && gatewayRetried < MAX_GET_RETRIES) {
        config.__apipawGatewayRetry = gatewayRetried + 1;
        config.baseURL = CLOUD_GATEWAY_URLS[activeGatewayIndex];
        return cloudApi(config);
      }
    }

    if (method !== 'get' || (!isNetworkError && !isServerError) || retried >= MAX_GET_RETRIES) {
      return Promise.reject(error);
    }

    config.__apipawRetry = retried + 1;
    await new Promise((resolve) => setTimeout(resolve, 1500 * config.__apipawRetry!));
    return cloudApi(config);
  },
);

/**
 * 阶段十六 P0 · 乐观锁冲突（409 version_conflict）识别。
 *
 * 服务端在"你看到的 updated_at 已经不是最新"时回 409，detail 是
 * `{code, current_updated_at}` 对象 ⇒ 前端要**单独识别**才能给出可操作提示，
 * 也避免把对象直接渲染进 `<Text>`（React 会抛 "Objects are not valid as a child"）。
 */
export const isVersionConflict = (e: unknown): boolean => {
  const err = e as {
    response?: {
      status?: number;
      data?: { detail?: string | { code?: string; current_updated_at?: number } };
    };
  };
  if (err?.response?.status !== 409) return false;
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail === 'version_conflict';
  return !!detail && typeof detail === 'object' && detail.code === 'version_conflict';
};

/**
 * 把 axios 异常翻译成看板可直接展示的中文提示。
 * 401 是上云后最常见的失败原因（密钥缺失/失效），必须给出可操作指引。
 */
export const describeCloudError = (e: unknown, mode: 'key' | 'session' = 'key'): string => {
  const err = e as {
    response?: {
      status?: number;
      data?: { detail?: string | { code?: string; current_updated_at?: number } };
    };
    message?: string;
    code?: string;
  };
  const status = err?.response?.status;
  if (status === 401) {
    return mode === 'session'
      ? '钱包会话已失效，请重新连接钱包并签名'
      : 'API Key 无效或未设置，请点击右上角「设置密钥」填入有效密钥';
  }
  if (status === 403) return '当前账号未绑定创作者钱包，无法访问创作者接口';
  if (status === 404) return '云端网关接口不存在，请确认后端版本';
  if (status === 429) return '请求过于频繁，请稍后再试';
  // 阶段十六 P0 · 乐观锁冲突（并发编辑）⇒ 明确提示"刷新后再改"
  if (status === 409) return '内容已被他人修改（并发冲突），请刷新后重新编辑';
  // 阶段六 P1 · 严格模式容量错误（503 no_capacity / 504 dispatch_timeout）：
  // 这两种**不计费**，提示口径必须是「未产生服务、未产生费用」，别让用户以为白花了钱。
  const cap = capacityErrorOf(e);
  if (cap) {
    return cap.code === 'dispatch_timeout'
      ? cap.message || '算力节点响应超时，本次请求未产生服务、未产生费用，请稍后重试'
      : cap.message || '算力池当前没有可用节点，本次请求未产生服务、未产生费用，请稍后重试';
  }
  if (status && status >= 500) return `云端网关异常 (HTTP ${status})，请稍后重试`;
  if (err?.code === 'ECONNABORTED') return '请求超时，云端聚合耗时较长，请稍后重试';
  if (!status && err?.code === 'ERR_NETWORK') return '网络不可达，请检查到 cloud.apipaw.com 的连接';
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  // ⚠️ detail 可能是对象（如 409 的 {code, current_updated_at}）⇒ 不可直接渲染
  if (detail && typeof detail === 'object') {
    return (detail as { code?: string }).code || '请求失败（服务端返回了结构化错误）';
  }
  return err?.message || '网络请求失败';
};

// ----------------- 类型定义 -----------------

export interface UserUsage {
  api_key: string;
  balance_usd: number;
  daily_limit_usd: number;
  spent_today_usd: number;
  usd_to_cgas: number;
}

export interface ModelPricing {
  prompt_per_1k_usd: number;
  completion_per_1k_usd: number;
  prompt_per_1k_cgas: number;
  completion_per_1k_cgas: number;
  usd_to_cgas: number;
}

export interface ModelInfo {
  id: string;
  object?: string;
  display_name: string;
  description: string;
  tier: 'BASE' | 'CREATOR' | 'AUTO' | 'MOA';
  tier_label: string;
  context_window: number;
  reasoning: boolean;
  pricing: ModelPricing;
  /** 阶段十二 P3 · 虚拟元模型（``apipaw-auto``）标记 —— 计价按实际路由结果 */
  is_virtual?: boolean;
  /** 阶段十三 P0 · 虚拟元模型（``apipaw-moa``）标记 —— 多节点协同深度思考 */
  moa?: boolean;
  /**
   * 阶段五 P1 · 场景标识：
   * A = 开源基础模型（无版税，买家实付 = 算力基价）
   * B = 社区创作者模型（含版税，买家实付 = 算力基价 × (1 + 版税率)）
   * 老网关不下发该字段时按 tier 兜底推导。
   */
  scenario?: 'A' | 'B';
  /** 阶段五 P1 · 版税率（0.15 = 15%）；仅场景 B 有效。 */
  royalty_rate?: number;
  /** 阶段五 P1 · 版税模式（RATE = 按比例；ABSOLUTE 为预留位，当前不实现）。 */
  royalty_mode?: string;
}

export interface ModelListResponse {
  object: string;
  data: ModelInfo[];
}

export interface AnalyticsHour {
  index: number;
  start_ts: number;
  label: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  requests: number;
}

export interface AnalyticsTier {
  tier: 'BASE' | 'CREATOR';
  label: string;
  share_note: string;
  cost_usd: number;
  cgas: number;
  ratio: number;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
}

export interface AnalyticsResponse {
  window_hours: number;
  generated_at: number;
  hours: AnalyticsHour[];
  tiers: AnalyticsTier[];
  models: Array<{
    model_id: string;
    tier: string;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
    requests: number;
  }>;
  settlement: {
    node_earn_usd: number;
    creator_royalty_usd: number;
    platform_fee_usd: number;
    total_usd: number;
    total_cgas: number;
    /** 阶段五 P2 · v2 权威口径（老网关可能不下发 ⇒ undefined，前端必须容错） */
    p_compute_usd?: number;
    p_royalty_usd?: number;
    royalty_pool_usd?: number;
    node_share_usd?: number;
    creator_share_usd?: number;
    platform_total_usd?: number;
  };
  /**
   * 阶段五 P3 · **二元费用结构**（基础算力费 vs 版税池）+ 三方分账。
   *
   * 后端按「总额 − 版税池」反推基础算力费 ⇒ 历史 v1 行与 v2 新行**同口径**，
   * 直接求和 v2 列会让历史行的基础算力费显示成 0。
   */
  split?: {
    base_compute_usd: number;
    royalty_pool_usd: number;
    creator_share_usd: number;
    node_share_usd: number;
    platform_total_usd: number;
    total_usd: number;
    total_cgas: number;
  };
  totals: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
    cgas: number;
    requests: number;
  };
}

export interface OwnerDashboard {
  active_nodes_online: number;
  registered_nodes_total: number;
  nodes: Array<{
    node_id: string;
    total_tokens_processed: number;
    total_earnings_paw: number;
    is_paused: number;
    last_seen: number;
  }>;
}

/**
 * 业主钱包的**本人节点收益**（阶段四 P3 新端点）。
 *
 * 与 `fetchOwnerDashboard()` 的区别是**权限口径**：
 *   - dashboard 走 API Key，看的是**全网**节点概览；
 *   - revenue 走钱包会话 JWT，服务端按登录钱包过滤，**只返回本人名下节点**。
 */
export interface OwnerRevenue {
  owner_wallet: string;
  nodes_total: number;
  total_earnings_paw: number;
  total_tokens_processed: number;
  nodes: Array<{
    node_id: string;
    total_tokens_processed: number;
    total_earnings_paw: number;
    is_paused: number;
    last_seen: number;
  }>;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cgas: number;
  /** 算力基价（P_compute）—— 阶段五 P0 起后端随 usage 一并下发 */
  base_compute_usd?: number;
  node_earn_usd?: number;
  creator_royalty_usd?: number;
  platform_fee_usd?: number;
  /** 阶段五 P2 · 回答来源：node=真实节点 / simulated=模拟回答 / fallback=回退模拟 */
  answer_source?: string;
  /** 阶段五 P2 · v2 分账明细（切正后的权威口径；老网关不下发时前端回落旧字段） */
  p_compute_usd?: number;
  p_royalty_usd?: number;
  node_share_usd?: number;
  creator_share_usd?: number;
  platform_compute_fee_usd?: number;
  platform_royalty_fee_usd?: number;
  platform_total_usd?: number;
  royalty_rate?: number;
  /** 阶段五 P3 · 节点能力等级（空串 = 未启用等级单价） */
  node_compute_class?: string;
  /** 阶段五 P4 · 首字延迟（毫秒）—— 后端实测；模拟回答为 0（前端回退本地计时） */
  ttft_ms?: number;
  /** 阶段五 P4 · 吐字速度（tokens/秒）—— 后端实测；模拟回答为 0 */
  throughput_tps?: number;
  /** 阶段五 P4 · 性能读数来源：node=后端实测 / local=前端本地计时 */
  perf_source?: string;
  /** 阶段六 D10 · **节点硬件档位**（C0~C3；空串 = 节点未上报显存） */
  node_tier?: string;
  /** 阶段六 D10 · **模型需求档位**（C0~C3）—— 与节点档位是两回事 */
  model_capability_class?: string;
  /** 阶段六 D5/D6 · 免单标记（模拟回答 / 断流 ⇒ 本次 $0） */
  waived?: boolean;
  /** 阶段六 · 免单原因（后端回传，如「流未完成（断流）」） */
  waive_reason?: string;
  /** 阶段六 D6 · 断流原因（流未完成时的错误码，如 backend_unavailable） */
  stream_error?: string;
  /** 阶段六 P1 · 用量来源：node=节点真实上报 / estimate=估算 */
  usage_source?: string;
}

// ----------------- 阶段六 P1 · 严格模式容量错误 -----------------

/**
 * 严格模式（网关 ``APIPAW_DISPATCH_STRICT=1``）下的容量错误。
 *
 * 网关返回 503 ``no_capacity``（算力池没有可用节点）或 504 ``dispatch_timeout``
 * （节点接了但没回），并带 ``Retry-After`` 头。两种情况**都不计费**
 * （预扣已按 WAIVED 原路释放），所以前端要给的是「友好提示 + 何时可重试」，
 * 而不是一坨 HTTP 错误码。
 */
export interface CapacityError {
  code: 'no_capacity' | 'dispatch_timeout';
  status: number;
  message: string;
  /** 网关建议的重试等待秒数（来自 Retry-After 头） */
  retryAfterSec?: number;
}

const CAPACITY_CODES = ['no_capacity', 'dispatch_timeout'];

/** 从网关错误响应体里认出容量错误（认不出返回 null）。 */
export const extractCapacityError = (
  status: number,
  body: unknown,
  retryAfter?: string | null,
): CapacityError | null => {
  const err = (body as { error?: { code?: string; message?: string }; detail?: string } | null) ?? null;
  const code = String(err?.error?.code || '');
  if (!code || CAPACITY_CODES.indexOf(code) < 0) return null;
  const secs = Number(retryAfter ?? '');
  return {
    code: code as CapacityError['code'],
    status,
    message: String(err?.error?.message || err?.detail || ''),
    retryAfterSec: Number.isFinite(secs) && secs > 0 ? secs : undefined,
  };
};

/** 从 axios 异常里提取容量错误（严格模式下的 503/504）。 */
export const capacityErrorOf = (e: unknown): CapacityError | null => {
  const err = e as {
    response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
  };
  const status = Number(err?.response?.status || 0);
  if (!status) return null;
  const headers = (err?.response?.headers || {}) as Record<string, unknown>;
  const retryAfter =
    (headers['retry-after'] as string | undefined) ??
    (headers['Retry-After'] as string | undefined) ??
    null;
  return extractCapacityError(status, err?.response?.data, retryAfter);
};

// ----------------- 创作者端类型 (CreatorEx) -----------------

/** HuggingFace 链接 mock 解析出的模型元数据 */
export interface ParsedModel {
  hf_url: string;
  repo_id: string;
  model_id: string;
  display_name: string;
  architecture: string;
  num_hidden_layers: number;
  min_vram_gb: number;
  context_window: number;
  quantization: string;
  framework: string;
  total_params: string;
  params_b: number;
  author_wallet: string;
  pawmodel_yaml: string;
  parsed_at: number;
}

/** 节点切片拓扑中的一个切片 */
export interface TopologyNode {
  node_id: string;
  label: string;
  layer_start: number;
  layer_end: number;
  layer_count: number;
  share: number;
  status: string;
  online: boolean;
  latency_ms: number;
  vram_gb: number;
}

export interface TopologyPipelineStage {
  stage: string;
  node_id: string;
  label: string;
  layer_count: number;
  status: string;
  latency_ms: number;
}

export interface ModelTopology {
  model_id: string;
  display_name: string;
  architecture: string;
  total_layers: number;
  slice_count: number;
  min_vram_gb: number;
  context_window: number;
  nodes: TopologyNode[];
  pipeline: TopologyPipelineStage[];
  total_latency_ms: number;
}

export interface RoyaltyModelStat {
  model_id: string;
  display_name: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  royalty_usd: number;
  royalty_paw: number;
}

export interface RoyaltyHour {
  index: number;
  start_ts: number;
  label: string;
  royalty_usd: number;
  total_tokens: number;
  calls: number;
}

export interface RoyaltyResponse {
  creator_id: string;
  creator_name: string;
  author_wallet: string;
  royalty_rate: number;
  window_hours: number;
  models: RoyaltyModelStat[];
  totals: {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    royalty_usd: number;
    royalty_paw: number;
  };
  available_usd: number;
  available_paw: number;
  withdrawn_usd: number;
  withdrawn_paw: number;
  hours: RoyaltyHour[];
  withdrawals: Array<{
    amount_usd: number;
    amount_paw: number;
    status: string;
    created_at: number;
  }>;
}

export interface RegisterCreatorModelPayload {
  hf_url?: string;
  model_id: string;
  display_name?: string;
  author_wallet?: string;
  min_vram_gb?: number;
  num_hidden_layers?: number;
  architecture?: string;
  framework?: string;
  quantization?: string;
  total_params?: string;
  context_window?: number;
  prompt_price_per_1k?: number;
  completion_price_per_1k?: number;
  description?: string;
}

// ----------------- 买家签发台 (阶段四 P2) -----------------

/**
 * 自助签发一把新 API Key 的返回体。
 *
 * 后端约束（阶段四 P0/P1/P2, 全部是**契约**, 不是实现细节）:
 *   - 端点**不接受任何请求体** —— 初始余额由服务端写死 $0, 客户端无从指定额度;
 *   - 按**真实客户端 IP** 限流 5 把/小时, 超限返回 429;
 *   - **明文只在这一刻返回一次** —— 服务端只存 sha256 哈希, 之后无法再取回。
 */
export interface IssuedApiKey {
  status: string;
  api_key: string;
  balance_usd: number;
  account_handle: string;
  key_prefix: string;
  key_last4: string;
  role: string;
  daily_limit_usd: number;
}

/** 买家自助签发新 Key —— 明文仅此一次返回 */
export const issueApiKey = async (): Promise<IssuedApiKey> => {
  const res = await cloudApi.post('/api/v1/auth/apikey');
  return res.data;
};

// ----------------- 阶段八 P1 · 新手体验金水龙头 -----------------

/**
 * 领取新手体验金的返回体。
 *
 * 后端约束（**契约**，不是实现细节）:
 *   - 每个账户**终身一次** —— 已有充值/消费流水或余额 > 0 的账户一律拒绝;
 *   - 每 IP 每小时 5 次 —— 超限返回 429;
 *   - 入账走唯一白名单入口 ``db.add_balance`` ⇒ 余额与流水同事务同生共死。
 */
export interface FaucetResult {
  status: string;
  account_handle: string;
  amount_usd: number;
  balance_usd: number;
  duplicate: boolean;
  trial: boolean;
}

/**
 * 领取新手体验金 $0.50。
 *
 * ⚠️ 这里**不走** ``cloudApi`` 拦截器 —— 刚签发的 Key 还没进 store，
 * 拦截器会塞旧 Key（那就领到别人头上去了）。因此显式带 Authorization 头。
 */
export const claimTrialFaucet = async (apiKey: string): Promise<FaucetResult> => {
  const res = await axios.post<FaucetResult>(
    `${CLOUD_BASE_URL}/api/v1/user/faucet`,
    {},
    {
      timeout: CLOUD_REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    },
  );
  return res.data;
};

/** 体验金失败时后端给出的机器可读原因（前端据此给不同提示） */
export const describeFaucetError = (e: unknown): string => {
  const anyErr = e as {
    response?: { status?: number; data?: { detail?: string; code?: string } };
  };
  const status = anyErr?.response?.status;
  const detail = anyErr?.response?.data?.detail;
  if (status === 429) return '领取过于频繁（每个 IP 每小时最多 5 次），请稍后再试。';
  if (status === 409) return detail || '该账户不符合新手体验金条件。';
  if (status === 401) return 'API Key 无效 —— 请重新签发或设置密钥。';
  return detail || describeCloudError(e);
};

// ----------------- 买家 API -----------------

export const fetchUserUsage = async (): Promise<UserUsage> => {
  const res = await cloudApi.get('/api/v1/user/usage');
  return res.data;
};

export const fetchModels = async (): Promise<ModelListResponse> => {
  const res = await cloudApi.get('/v1/models');
  return res.data;
};

export const fetchAnalytics = async (hours: number = 24): Promise<AnalyticsResponse> => {
  const res = await cloudApi.get('/api/v1/user/analytics', { params: { hours } });
  return res.data;
};

/** 可视化限额滑块 —— 同步单日消费上限至后端 */
export const updateDailyLimit = async (
  dailyLimitUsd: number,
): Promise<{ status: string; daily_limit_usd: number; spent_today_usd: number }> => {
  const res = await cloudApi.put('/api/v1/user/limit', { daily_limit_usd: dailyLimitUsd });
  return res.data;
};

export const fetchOwnerDashboard = async (): Promise<OwnerDashboard> => {
  const res = await cloudApi.get('/api/v1/owner/dashboard');
  return res.data;
};

/**
 * 拉取**本人**节点收益 —— 只认钱包会话 JWT（拦截器会自动注入）。
 *
 * 没有会话时后端返回 401，调用方据此提示「请先连接钱包」。
 */
export const fetchOwnerRevenue = async (): Promise<OwnerRevenue> => {
  const res = await cloudApi.get('/api/v1/owner/nodes/revenue');
  return res.data;
};

export const toggleNodeStatus = async (nodeId: string) => {
  const res = await cloudApi.post(`/api/v1/owner/node/${nodeId}/toggle`);
  return res.data;
};

// ----------------- 阶段七 P2 · 节点凭证自助签发 -----------------

/**
 * 自助签发节点凭证（**一次性**回显明文密钥）。
 *
 * 此前新增一台算力节点必须 SSH 上源站跑 `manage_node.py gen`，
 * 明文密钥还要从终端里抠出来 —— 流程长、密钥容易进日志/工单。
 * 这里一次点击拿到 node_id + 明文 node_secret，直接填进 Agent 面板。
 *
 * ⚠️ `node_secret` **只在这一份响应里出现**，刷新页面就没了 —— 这是设计：
 * 密钥只回显一次，之后一律用指纹核对。
 */
export interface IssuedNodeCredential {
  status: string;
  node_id: string;
  node_secret: string;
  secret_fingerprint: string;
  rotated: boolean;
  note: string;
  issued_at: number;
  message: string;
}

export const issueNodeCredential = async (
  nodeId: string = '',
  note: string = '',
): Promise<IssuedNodeCredential> => {
  const res = await cloudApi.post('/api/v1/owner/nodes/issue-credential', {
    node_id: nodeId,
    note,
  });
  return res.data;
};

// ----------------- 阶段六 P2 · 网络健康 / 节点治理 / 版税申请 -----------------

/**
 * 算力网络健康度 —— **公开可读**（只含聚合计数，不含节点 id / 钱包 / 收益）。
 *
 * 为什么需要它：买家端「在线算力节点」此前依赖 OWNER-only 的
 * `/api/v1/owner/dashboard`，普通买家恒为 0。本端点让任何人都能读到真实的
 * 全网在线节点数与可服务模型数。
 */
export interface NetworkHealth {
  status: string;
  online_nodes: number;
  dispatchable_nodes: number;
  busy_nodes: number;
  servable_models: number;
  catalog_models: number;
  saturated: boolean;
  queue_wait_sec: number;
  strict_mode: boolean;
  dispatch_enabled: boolean;
  real_stream: boolean;
  checked_at: number;
}

export const fetchNetworkHealth = async (): Promise<NetworkHealth> => {
  const res = await cloudApi.get('/api/v1/network/health');
  return res.data;
};

/**
 * 推荐模型列表（**公开可读**）—— 每个模型当前**在线且可服务**的节点数。
 *
 * 为什么前端需要它：`/v1/models` 只下发目录（模型 id / 单价 / 场景），
 * **不下发在线节点数** ⇒ 前端无法判断「这个模型现在有没有节点在跑」。
 * Playground 的默认值若落在离线模型（如 DeepSeek-R1）上，用户一进来就撞
 * 「算力池当前没有可用节点」。本端点是**只读公开聚合**，零凭证即可读，
 * 因此前端可以据此做「只展示在线模型」的**展示层**决策 —— 无需改动后端。
 */
export interface RecommendedModelInfo {
  model_id: string;
  display_name: string;
  description: string;
  tier: string;
  min_vram_gb: number;
  prompt_price_per_1k: number;
  completion_price_per_1k: number;
  royalty_rate: number;
  /** 当前在线且能证明可服务该模型的节点数（0 = 暂无在线节点） */
  online_nodes: number;
  /** online_nodes > 0 */
  recommended: boolean;
}

export interface RecommendedModelsResponse {
  models: RecommendedModelInfo[];
}

export const fetchRecommendedModels = async (): Promise<RecommendedModelsResponse> => {
  const res = await cloudApi.get('/api/v1/network/recommended-models');
  return res.data;
};

/** 业主视角的派单统计（按节点：派单量 / 成功率 / 让退 / 冷却 / 平均排队等待） */
export interface OwnerDispatchNodeStat {
  node_id: string;
  dispatches: number;
  successes: number;
  failures: number;
  success_rate: number;
  yields: number;
  cooldowns: number;
  avg_wait_ms: number;
  reliability_score: number;
}

export interface OwnerDispatchStats {
  window_minutes: number;
  by_node: OwnerDispatchNodeStat[];
  totals?: Record<string, unknown>;
}

export const fetchOwnerDispatchStats = async (
  windowMinutes: number = 60,
): Promise<OwnerDispatchStats> => {
  const res = await cloudApi.get('/api/v1/owner/dispatch/stats', {
    params: { window_minutes: windowMinutes },
  });
  return res.data;
};

/** 节点治理视图里的一台节点 */
export interface GovernanceNode {
  node_id: string;
  node_name?: string | null;
  hardware_type?: string | null;
  agent_version?: string | null;
  status?: string | null;
  alive: boolean;
  dispatchable: boolean;
  dispatch_eligible: boolean;
  is_paused: number;
  inflight: number;
  reliability_score: number;
  yields_24h: number;
  dispatches_24h: number;
  success_rate_24h: number;
  total_earnings_paw: number;
  earnings_usd: number;
  requests: number;
  tokens: number;
  owner_wallet: string;
  last_heartbeat?: number | null;
  /** 阶段十七 P2：GPU 温度（°C，None = 节点未上报 / 无独显） */
  gpu_temp_c?: number | null;
  /** 阶段十七 P2：风扇转速百分比 */
  gpu_fan_pct?: number | null;
  /** 阶段十七 P2：高温告警标记（服务端阈值 75°C） */
  overheat_warning?: boolean;
}

export const fetchOwnerNodesGovernance = async (): Promise<{ nodes: GovernanceNode[] }> => {
  const res = await cloudApi.get('/api/v1/owner/nodes/governance');
  return res.data;
};

export const fetchOwnerNodeDetail = async (
  nodeId: string,
): Promise<{ node: GovernanceNode }> => {
  const res = await cloudApi.get(`/api/v1/owner/node-detail/${nodeId}`);
  return res.data;
};

/** 节点业主自助暂停 / 恢复接单 */
export const toggleNodePause = async (
  nodeId: string,
): Promise<{ status: string; node_id: string; is_paused: number; current_status: string }> => {
  const res = await cloudApi.post(`/api/v1/nodes/${nodeId}/pause`);
  return res.data;
};

/** 节点业主提交让退误判申诉 */
export interface NodeAppeal {
  id: number;
  node_id: string;
  owner_wallet: string;
  reason: string;
  detail: string;
  status: string;
  decided_by: string;
  decision_note: string;
  decided_at: number;
  created_at: number;
}

export const submitNodeAppeal = async (
  nodeId: string,
  reason: string,
  detail: string = '',
): Promise<{ status: string; appeal: NodeAppeal }> => {
  const res = await cloudApi.post(`/api/v1/nodes/${nodeId}/appeal`, { reason, detail });
  return res.data;
};

export const fetchOwnerNodeAppeals = async (
  status: string = 'PENDING',
  limit: number = 50,
): Promise<{ appeals: NodeAppeal[] }> => {
  const res = await cloudApi.get('/api/v1/owner/node-appeals', {
    params: { status, limit },
  });
  return res.data;
};

export const decideOwnerNodeAppeal = async (
  appealId: number,
  approve: boolean,
  note: string = '',
): Promise<{ status: string; result: { appeal_id: number; status: string; decided_by: string } }> => {
  const res = await cloudApi.post(`/api/v1/owner/node-appeal/${appealId}/decide`, {
    approve,
    note,
  });
  return res.data;
};

/** 创作者提交期望版税率申请（D4 路 A：平台定价 + 申请 + OWNER 审批） */
export interface RoyaltyRateRequest {
  id: number;
  model_id: string;
  creator_id: string;
  author_wallet: string;
  requested_rate: number;
  current_rate: number;
  status: string;
  reason: string;
  decided_by: string;
  decision_note: string;
  decided_at: number;
  created_at: number;
}

export const submitCreatorRoyaltyRequest = async (
  modelId: string,
  requestedRate: number,
  reason: string = '',
): Promise<{ status: string; request: RoyaltyRateRequest }> => {
  const res = await cloudApi.post('/api/v1/creator/royalty/request', {
    model_id: modelId,
    requested_rate: requestedRate,
    reason,
  });
  return res.data;
};

export const fetchCreatorRoyaltyRequests = async (
  limit: number = 50,
): Promise<{ requests: RoyaltyRateRequest[] }> => {
  const res = await cloudApi.get('/api/v1/creator/royalty/requests', { params: { limit } });
  return res.data;
};

/** OWNER 审批队列：列出版税申请 */
export const fetchOwnerRoyaltyRequests = async (
  status: string = 'PENDING',
  limit: number = 50,
): Promise<{ requests: RoyaltyRateRequest[] }> => {
  const res = await cloudApi.get('/api/v1/owner/royalty/requests', {
    params: { status, limit },
  });
  return res.data;
};

/** OWNER 签字：批准 / 驳回一笔版税申请 */
export const decideOwnerRoyaltyRequest = async (
  requestId: number,
  approve: boolean,
  note: string = '',
): Promise<{ status: string; result: Record<string, unknown> }> => {
  const res = await cloudApi.post(`/api/v1/owner/royalty/request/${requestId}/decide`, {
    approve,
    note,
  });
  return res.data;
};

// ----------------- 创作者端 API (CreatorEx) -----------------

/** 抓取 HuggingFace 链接并 mock 解析模型元数据 */
export const parseCreatorModel = async (
  hfUrl: string,
  overrides?: { min_vram_gb?: number; num_hidden_layers?: number; quantization?: string },
): Promise<ParsedModel> => {
  const res = await cloudApi.post('/api/v1/creator/models/parse', {
    hf_url: hfUrl,
    ...(overrides || {}),
  });
  return res.data.model;
};

/** 创作者名下的上架模型列表 */
export const fetchCreatorModels = async (): Promise<{
  creator_id: string;
  author_wallet: string;
  models: Array<{
    model_id: string;
    display_name: string;
    tier: string;
    description: string;
    num_hidden_layers: number;
    min_vram_gb: number;
    architecture: string;
    hf_url: string;
    quantization: string;
    total_params: string;
    context_window: number;
  }>;
}> => {
  const res = await cloudApi.get('/api/v1/creator/models');
  return res.data;
};

/** 创作者发布模型 —— 落现有 models 表 (tier=CREATOR)
 *
 * ⚠️ 阶段六 P3：**上架价以服务端受控价为准**，客户端传的 `author_wallet`
 * 与价格一律被服务端忽略；期望价 ≠ 生效价时，服务端会落一条**改价申请**
 * （`pricing.price_request`），OWNER 审批后才生效。
 */
export const registerCreatorModel = async (
  payload: RegisterCreatorModelPayload,
): Promise<{
  status: string;
  message: string;
  model: Record<string, unknown>;
  pricing?: {
    effective_prompt_price_per_1k: number;
    effective_completion_price_per_1k: number;
    requested_prompt_price_per_1k: number;
    requested_completion_price_per_1k: number;
    price_request: Record<string, unknown> | null;
    note: string;
  };
}> => {
  const res = await cloudApi.post('/api/v1/creator/models/register', payload);
  return res.data;
};

/** 模型在算力池中的节点切片拓扑 */
export const fetchCreatorTopology = async (modelId: string): Promise<ModelTopology> => {
  const res = await cloudApi.get(`/api/v1/creator/topology/${modelId}`);
  return res.data;
};

/** 创作者 15% 版税大盘 */
export const fetchCreatorRoyalty = async (hours: number = 24): Promise<RoyaltyResponse> => {
  const res = await cloudApi.get('/api/v1/creator/royalty', { params: { hours } });
  return res.data;
};

/** 一键提现 —— 落库提现申请, 扣减可提余额 */
export const withdrawCreatorRoyalty = async (
  amountUsd: number,
  note: string = '',
): Promise<{
  status: string;
  withdrawal: {
    status: string;
    amount_usd: number;
    amount_paw: number;
    author_wallet: string;
    remaining_usd: number;
  };
}> => {
  const res = await cloudApi.post('/api/v1/creator/royalty/withdraw', {
    amount_usd: amountUsd,
    note,
  });
  return res.data;
};

// ----------------- 阶段六 P3 · 身份 / 定价 / 节点收益 -----------------

/** 当前登录身份的**服务端权威**创作者口径（D3）。 */
export interface CreatorIdentity {
  account_handle: string;
  role: string;
  creator_id: string;
  author_wallet: string;
}

export const fetchCreatorIdentity = async (): Promise<CreatorIdentity> => {
  const res = await cloudApi.get('/api/v1/creator/identity');
  return res.data;
};

/** 平台受控价（公开）：上架默认单价 + 改价区间。 */
export interface PlatformPricing {
  prompt_price_per_1k: number;
  completion_price_per_1k: number;
  min_price_per_1k: number;
  max_price_per_1k: number;
  usd_per_paw: number;
  note: string;
}

export const fetchPlatformPricing = async (): Promise<PlatformPricing> => {
  const res = await cloudApi.get('/api/v1/pricing/default');
  return res.data;
};

export interface ModelPriceRequest {
  id: number;
  model_id: string;
  author_wallet: string;
  status: string;
  prompt_price_per_1k: number;
  completion_price_per_1k: number;
  current_prompt_price_per_1k: number;
  current_completion_price_per_1k: number;
  reason: string;
  decided_by: string;
  decision_note: string;
  created_at: number;
  decided_at: number | null;
}

/** 创作者提交**期望单价**申请（只落申请，OWNER 审批后才生效）。 */
export const submitCreatorPriceRequest = async (
  modelId: string,
  promptPricePer1k: number,
  completionPricePer1k: number,
  reason: string = '',
): Promise<{ status: string; request: ModelPriceRequest; note: string }> => {
  const res = await cloudApi.post('/api/v1/creator/models/pricing/request', {
    model_id: modelId,
    prompt_price_per_1k: promptPricePer1k,
    completion_price_per_1k: completionPricePer1k,
    reason,
  });
  return res.data;
};

/** 创作者查看自己的改价申请 */
export const fetchCreatorPriceRequests = async (
  limit: number = 50,
): Promise<{ requests: ModelPriceRequest[] }> => {
  const res = await cloudApi.get('/api/v1/creator/models/pricing/requests', {
    params: { limit },
  });
  return res.data;
};

/** OWNER 审批队列：改价申请 */
export const fetchOwnerPriceRequests = async (
  status: string = 'PENDING',
  limit: number = 50,
): Promise<{ requests: ModelPriceRequest[] }> => {
  const res = await cloudApi.get('/api/v1/owner/pricing/requests', {
    params: { status, limit },
  });
  return res.data;
};

/** OWNER 签字：批准 / 驳回改价申请 */
export const decideOwnerPriceRequest = async (
  requestId: number,
  approve: boolean,
  note: string = '',
): Promise<{ status: string; result: Record<string, unknown> }> => {
  const res = await cloudApi.post(`/api/v1/owner/pricing/request/${requestId}/decide`, {
    approve,
    note,
  });
  return res.data;
};

/** 计量对齐评估（OWNER）：估算 vs 真实 token 的偏差 */
export interface MeteringAccuracy {
  window_minutes: number;
  samples: number;
  verdict: string;
  note: string;
  by_source?: Array<{ src: string; c: number }>;
  prompt?: Record<string, number>;
  completion?: Record<string, number>;
}

export const fetchMeteringAccuracy = async (
  windowMinutes: number = 1440,
): Promise<MeteringAccuracy> => {
  const res = await cloudApi.get('/api/v1/owner/metering/accuracy', {
    params: { window_minutes: windowMinutes },
  });
  return res.data;
};

/** 公开的节点身份视图（买家可读，不含钱包 / 收益 / 密钥）。 */
export interface PublicNode {
  node_id: string;
  node_name: string;
  hardware_type: string;
  agent_version: string;
  status: string;
  status_label: string;
  models: string[];
  vram_total_gb: number;
  node_tier: string;
  alive: boolean;
}

export const fetchPublicNodes = async (): Promise<{ nodes: PublicNode[]; count: number }> => {
  const res = await cloudApi.get('/api/v1/network/nodes');
  return res.data;
};

export interface NodeEarnings {
  owner_wallet: string;
  earned_usd: number;
  withdrawn_usd: number;
  pending_usd: number;
  available_usd: number;
  tokens: number;
  requests: number;
  nodes: Array<{ node_id: string; earned_usd: number; tokens: number; requests: number }>;
  withdrawals: Array<{
    id: number;
    node_id: string;
    amount_usd: number;
    amount_paw: number;
    channel: string;
    status: string;
    tx_hash: string;
    created_at: number;
  }>;
}

/** 节点业主收益大盘（钱包会话口径） */
export const fetchNodeEarnings = async (): Promise<NodeEarnings> => {
  const res = await cloudApi.get('/api/v1/node/earnings');
  return res.data;
};

/** 登记一笔节点提现（内部 USD 台账） */
export const submitNodeWithdrawal = async (
  amountUsd: number,
  nodeId: string = '',
  note: string = '',
  payoutWallet: string = '',
): Promise<{
  status: string;
  withdrawal: {
    id: number;
    amount_usd: number;
    amount_paw: number;
    status: string;
    payout_wallet: string;
  };
  payout_token_address: string;
  chain_channel_enabled: boolean;
}> => {
  const res = await cloudApi.post('/api/v1/node/withdraw', {
    amount_usd: amountUsd,
    node_id: nodeId,
    note,
    payout_wallet: payoutWallet,
  });
  return res.data;
};

/** 回填链上交易哈希（广播由业主钱包在前端完成，云端只记账） */
export const broadcastNodeWithdrawal = async (
  withdrawalId: number,
  txHash: string,
): Promise<{ status: string; result: Record<string, unknown> }> => {
  const res = await cloudApi.post(`/api/v1/node/withdraw/${withdrawalId}/broadcast`, {
    tx_hash: txHash,
  });
  return res.data;
};

// ----------------- SSE 流式推理 -----------------

export interface ChatOnceOptions {
  model: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  apiKey?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  systemPrompt?: string;
  /** 阶段十四 P1 · 黄金记忆增强（Few-Shot 注入）。
   *  `true` ⇒ 请求体显式带 `golden_boost: true`（虚拟元模型默认已开，这里是显式确认）；
   *  `false` ⇒ 显式关闭；`undefined` ⇒ 不下发该字段，由网关按模型类型自行判定。 */
  goldenBoost?: boolean;
}

export interface ChatOnceResult {
  content: string;
  reasoning: string;
  usage: ChatUsage;
  /** 阶段十二 P1 · 本次推理的 request_id（评价采集的幂等键） */
  requestId?: string;
  /** 阶段十二 P3 · 智能路由解析出的真实模型（请求的是 apipaw-auto 时才有） */
  resolvedModelId?: string;
  /** 阶段十三 P0 · MoA 协同模式（multi_node / self_refine / simulated） */
  moaMode?: string;
  /** 阶段十四 P1 · 本次注入的黄金记忆条数（0 = 未开启 / 无命中） */
  goldenBoostCount?: number;
}

/**
 * 阶段五 P3 · **非流式**一次性请求。
 *
 * Playground 的「流式开关」关掉时走这里（导出代码里的 `stream` 也随之变成 false，
 * 复制出去就能跑出与界面一致的结果）。
 * 网关对 `stream: false` 返回标准 OpenAI 形状：`choices[0].message` + `usage`。
 */
export const chatOnce = async (options: ChatOnceOptions): Promise<ChatOnceResult> => {
  const apiKey = options.apiKey ?? usePawStore.getState().apiKey;
  const systemPrompt = (options.systemPrompt ?? '').trim();
  const finalMessages = systemPrompt
    ? [{ role: 'system' as const, content: systemPrompt }, ...options.messages]
    : options.messages;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: finalMessages,
    stream: false,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  // 阶段十四 P1：显式声明是否要黄金记忆增强（undefined ⇒ 交给网关按模型判定）
  if (options.goldenBoost !== undefined) body.golden_boost = !!options.goldenBoost;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await cloudApi.post('/v1/chat/completions', body, { headers });
  const data = (res.data ?? {}) as {
    id?: string;
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: ChatUsage;
    resolved_model_id?: string;
    moa_mode?: string;
    golden_boost_count?: number;
  };
  const message = data.choices?.[0]?.message ?? {};
  let content = String(message.content ?? '');
  let reasoning = String(message.reasoning_content ?? '');
  // 网关把思考链塞在 <think> 标签里（非流式路径），拆出来单独展示
  const think = /<think>([\s\S]*?)<\/think>/.exec(content);
  if (think) {
    reasoning = think[1];
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  return {
    content,
    reasoning,
    usage: (data.usage ?? {}) as ChatUsage,
    requestId: String(data.id ?? ''),
    resolvedModelId: String(data.resolved_model_id ?? ''),
    moaMode: String(data.moa_mode ?? ''),
    goldenBoostCount: Number(data.golden_boost_count ?? 0) || 0,
  };
};

export interface StreamChatOptions {
  model: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  apiKey?: string;
  /** 采样温度（0 ~ 2）—— 阶段五 P0 */
  temperature?: number;
  /** Top-P 核采样（0 ~ 1）—— 阶段五 P0 */
  topP?: number;
  /** 单次输出上限 —— 阶段五 P0 */
  maxTokens?: number;
  /** 系统提示词 —— 阶段五 P0 · 决策 D7：计入计费输入 */
  systemPrompt?: string;
  /** 阶段十四 P1 · 黄金记忆增强（显式下发 `golden_boost`）。 */
  goldenBoost?: boolean;
  onOpen?: () => void;
  /** 阶段五 P2 · 回答来源（响应头 X-APIPaw-Dispatch）：node / simulated / fallback。
   *  头在 readyState=2 时就可用 ⇒ 徽标能在流开始时就亮出来。 */
  onDispatch?: (mode: string) => void;
  /** 阶段十二 P1 · 本次推理的 request_id（评价采集的幂等键）。 */
  onRequestId?: (requestId: string) => void;
  /** 阶段十二 P3 · 智能路由解析出的真实模型（响应头 X-APIPaw-Resolved-Model）。 */
  onResolvedModel?: (modelId: string) => void;
  /** 阶段十三 P0 · MoA 协同模式（响应头 X-APIPaw-MoA-Mode）。 */
  onMoaMode?: (mode: string) => void;
  /** 阶段十四 P1 · 本次注入的黄金记忆条数（响应头 X-APIPaw-Golden-Boost-Count）。 */
  onGoldenBoost?: (count: number) => void;
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
  onUsage?: (usage: ChatUsage) => void;
  onDone?: () => void;
  /** 阶段六 P1 · 容量错误（严格模式 503/504）会作为第二参数带出来，
   *  让 UI 能渲染「友好提示视图」而不是一坨错误文本。 */
  onError?: (message: string, capacity?: CapacityError | null) => void;
}

export interface StreamChatHandle {
  abort: () => void;
}

/**
 * 以 XHR 增量读取 SSE 流。
 * 相比 fetch 的 ReadableStream，XMLHttpRequest 在 Expo Web 与原生端均可稳定拿到分片文本。
 */
export const streamChat = (options: StreamChatOptions): StreamChatHandle => {
  const { model, messages, onOpen, onDispatch, onRequestId, onResolvedModel, onMoaMode, onGoldenBoost, onReasoning, onContent, onUsage, onDone, onError } = options;
  const apiKey = options.apiKey ?? usePawStore.getState().apiKey;

  const xhr = new XMLHttpRequest();
  let pending = '';
  let consumed = 0;
  let settled = false;
  /** 是否已经收到过正文 —— 用于区分「流被截断」与「流正常结束」 */
  let receivedContent = false;

  const fail = (message: string, capacity?: CapacityError | null) => {
    if (settled) return;
    settled = true;
    onError?.(message, capacity ?? null);
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    onDone?.();
  };

  const handleFrame = (frame: string) => {
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        finish();
        return;
      }

      let chunk: {
        error?: { message?: string };
        usage?: ChatUsage;
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }

      if (chunk.error) {
        fail(chunk.error.message || '推理请求失败');
        return;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        receivedContent = true;
        onReasoning?.(delta.reasoning_content);
      }
      if (delta?.content) {
        receivedContent = true;
        onContent?.(delta.content);
      }
      if (chunk.usage) onUsage?.(chunk.usage);
    }
  };

  const consume = (text: string) => {
    pending += text;
    const blocks = pending.split('\n\n');
    pending = blocks.pop() ?? '';
    blocks.forEach(handleFrame);
  };

  xhr.onreadystatechange = () => {
    if (xhr.readyState === 2) {
      onOpen?.();
      // 阶段五 P2：响应头带本次回答来源（真实节点 / 模拟回答）
      try {
        const mode = xhr.getResponseHeader('X-APIPaw-Dispatch');
        if (mode) onDispatch?.(mode);
        // 阶段十二 P1：request_id 头（评价采集的幂等键）
        const requestId = xhr.getResponseHeader('X-Request-ID');
        if (requestId) onRequestId?.(requestId);
        // 阶段十二 P3：智能路由解析出的真实模型
        const resolvedModel = xhr.getResponseHeader('X-APIPaw-Resolved-Model');
        if (resolvedModel) onResolvedModel?.(resolvedModel);
        // 阶段十三 P0：MoA 协同模式
        const moaMode = xhr.getResponseHeader('X-APIPaw-MoA-Mode');
        if (moaMode) onMoaMode?.(moaMode);
        // 阶段十四 P1：本次注入的黄金记忆条数
        const goldenCount = xhr.getResponseHeader('X-APIPaw-Golden-Boost-Count');
        if (goldenCount !== null && goldenCount !== undefined && goldenCount !== '') {
          onGoldenBoost?.(Number(goldenCount) || 0);
        }
      } catch {
        /* 某些环境不支持读响应头，忽略即可（usage 里还有一份 answer_source） */
      }
      return;
    }
    if (xhr.readyState !== 4) return;

    if (xhr.status >= 200 && xhr.status < 300) {
      if (pending.trim()) {
        handleFrame(pending);
        pending = '';
      }
      finish();
      return;
    }

    // 网关回源链路 (Cloudflare -> nginx -> uvicorn) 结束 SSE 响应时,
    // 连接可能没有以规范的 chunked 结尾收束, 浏览器会把它判为网络错误 (status=0),
    // 尽管正文已经完整送达。此时按正常结束处理, 不再提示用户「推理请求失败」。
    if (xhr.status === 0 && receivedContent) {
      finish();
      return;
    }

    let message = `推理请求失败 (HTTP ${xhr.status})`;
    let capacity: CapacityError | null = null;
    try {
      const parsed = JSON.parse(xhr.responseText);
      message = parsed?.error?.message || parsed?.detail || message;
      // 阶段六 P1 · 严格模式：503 no_capacity / 504 dispatch_timeout
      let retryAfter: string | null = null;
      try {
        retryAfter = xhr.getResponseHeader('Retry-After');
      } catch {
        /* 某些环境不支持读响应头 */
      }
      capacity = extractCapacityError(xhr.status, parsed, retryAfter);
    } catch {
      /* 保留默认错误信息 */
    }
    fail(message, capacity);
  };

  xhr.onprogress = () => {
    const text = xhr.responseText;
    if (typeof text === 'string' && text.length > consumed) {
      const slice = text.slice(consumed);
      consumed = text.length;
      consume(slice);
    }
  };

  xhr.onerror = () => fail('网络错误：无法连接 APIPaw Cloud 网关');
  xhr.ontimeout = () => fail('推理请求超时，请稍后重试');

  xhr.open('POST', `${CLOUD_BASE_URL}/v1/chat/completions`, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('Accept', 'text/event-stream');
  if (apiKey) xhr.setRequestHeader('Authorization', `Bearer ${apiKey}`);
  xhr.timeout = 120000;

  // 阶段五 P0：系统提示词作为 **首条 system 消息**下发（决策 D7：计入计费输入），
  // 采样参数（temperature / top_p / max_tokens）真正送到后端 ——
  // 此前后端既不接收 top_p，也从不下发任何采样参数，前端调参对真实节点完全无效。
  const systemPrompt = (options.systemPrompt ?? '').trim();
  const finalMessages = systemPrompt
    ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
    : messages;
  const requestBody: Record<string, unknown> = {
    model,
    messages: finalMessages,
    stream: true,
  };
  if (options.temperature !== undefined) requestBody.temperature = options.temperature;
  if (options.topP !== undefined) requestBody.top_p = options.topP;
  if (options.maxTokens !== undefined) requestBody.max_tokens = options.maxTokens;
  // 阶段十四 P1：显式声明是否要黄金记忆增强（undefined ⇒ 交给网关按模型判定）
  if (options.goldenBoost !== undefined) requestBody.golden_boost = !!options.goldenBoost;
  xhr.send(JSON.stringify(requestBody));

  return {
    abort: () => {
      // 必须先置 settled —— xhr.abort() 会同步触发 onreadystatechange (readyState=4, status=0)，
      // 若此时 settled 仍为 false，会被误判成一次真实失败并弹出「推理请求失败 (HTTP 0)」
      settled = true;
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
    },
  };
};

// ----------------- 阶段九 P0~P3 · 公示 / 上架 / 卡密 / 提现审批 -----------------

/**
 * 全网实时结算公示的一行（``GET /api/v1/network/recent-settlements``）。
 *
 * ⚠️ ``request_id`` 已由服务端脱敏（只回末段前 8 位）——
 * 公开端点不能回吐可回溯到单次调用的原始请求标识。
 */
export interface RecentSettlement {
  request_id: string;
  model_id: string;
  node_id: string;
  model_tier: string;
  prompt_tokens: number;
  completion_tokens: number;
  ttft_ms: number | null;
  throughput_tps: number | null;
  gross_usd: number;
  node_share_usd: number;
  creator_share_usd: number;
  platform_fee_usd: number;
  royalty_rate: number | null;
  usage_source: string;
  settled_at: number;
}

/** 拉取全网实时分账流水（**公开端点**，无需鉴权） */
export const fetchRecentSettlements = async (
  limit: number = 20,
): Promise<{ status: string; count: number; limit: number; settlements: RecentSettlement[]; note: string }> => {
  const res = await cloudApi.get('/api/v1/network/recent-settlements', {
    params: { limit },
  });
  return res.data;
};

/** 阶段九 P1 · 网页自助上架/配置模型的表单载荷 */
export interface OwnerModelUpsertPayload {
  model_id: string;
  display_name: string;
  tier: 'BASE' | 'CREATOR';
  prompt_price_per_1k: number;
  completion_price_per_1k: number;
  min_vram_gb: number;
  royalty_rate: number;
  royalty_mode: 'RATE' | 'NONE';
  creator_id?: string;
  creator_name?: string;
  author_wallet?: string;
  context_window?: number;
  description?: string;
}

export interface OwnerModelUpsertResult {
  created: boolean;
  model_id: string;
  display_name: string;
  tier: string;
  prompt_price_per_1k: number;
  completion_price_per_1k: number;
  min_vram_gb: number;
  royalty_rate: number;
  royalty_mode: string;
}

/** OWNER 在网页上一键上架/配置推理模型 */
export const upsertOwnerModel = async (
  payload: OwnerModelUpsertPayload,
): Promise<{ status: string; model: OwnerModelUpsertResult }> => {
  const res = await cloudApi.post('/api/v1/owner/models/upsert', payload);
  return res.data;
};

/** 阶段九 P2 · 充值卡密（明文只在签发那一刻回吐一次） */
export interface IssuedVoucher {
  id: number;
  code: string;
  code_prefix: string;
  amount_usd: number;
  status: string;
}

/** OWNER 签发充值卡密 */
export const issueVouchers = async (
  amountUsd: number,
  count: number = 1,
): Promise<{
  status: string;
  amount_usd: number;
  count: number;
  vouchers: IssuedVoucher[];
  note: string;
}> => {
  const res = await cloudApi.post('/api/v1/owner/vouchers/issue', {
    amount_usd: amountUsd,
    count,
  });
  return res.data;
};

/** OWNER 查看卡密台账（**只有前缀与状态，没有明文**） */
export interface VoucherRow {
  id: number;
  code_prefix: string;
  amount_usd: number;
  status: string;
  created_by: string;
  redeemed_by: string;
  redeemed_at: number;
  created_at: number;
}

export const fetchOwnerVouchers = async (
  status: string = '',
  limit: number = 50,
): Promise<{ status: string; vouchers: VoucherRow[]; count: number }> => {
  const res = await cloudApi.get('/api/v1/owner/vouchers', { params: { status, limit } });
  return res.data;
};

/**
 * 买家核销充值卡密（**API Key 鉴权**）。
 *
 * 服务端语义：核销与入账在**同一事务**里，失败回 409 并带机器可读 ``code``。
 */
export const redeemVoucher = async (
  code: string,
): Promise<{ status: string; amount_usd: number; balance_usd: number; account_handle: string }> => {
  const res = await cloudApi.post('/api/v1/user/redeem', { code });
  return res.data;
};

/** 把核销失败（409）翻译成可读提示 */
export const describeRedeemError = (e: unknown): string => {
  const err = e as { response?: { status?: number; data?: { detail?: string; code?: string } } };
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  const detail = err?.response?.data?.detail;
  if (status === 409) {
    if (code === 'already_redeemed') return '该充值码已被核销';
    if (code === 'invalid_code') return '充值码无效';
    if (code === 'code_required') return '请输入充值码';
    return detail || '兑换失败';
  }
  if (status === 429) return '兑换过于频繁，请稍后再试';
  if (status === 401) return '需要有效的 API Key 才能兑换';
  return detail || '兑换失败，请重试';
};

/** 阶段九 P3 · 提现审批台的一行 */
export interface WithdrawalRow {
  id: number;
  status: string;
  amount_usd: number;
  amount_paw: number;
  created_at: number;
  tx_hash?: string;
  decided_by?: string;
  decided_at?: number;
  note?: string;
  node_id?: string;
  owner_wallet?: string;
  creator_id?: string;
  author_wallet?: string;
}

export const fetchOwnerNodeWithdrawals = async (
  status: string = 'PENDING',
  limit: number = 50,
): Promise<{ status: string; withdrawals: WithdrawalRow[]; count: number }> => {
  const res = await cloudApi.get('/api/v1/owner/node-withdrawals', {
    params: { status, limit },
  });
  return res.data;
};

export const fetchOwnerCreatorWithdrawals = async (
  status: string = 'PENDING',
  limit: number = 50,
): Promise<{ status: string; withdrawals: WithdrawalRow[]; count: number }> => {
  const res = await cloudApi.get('/api/v1/owner/creator-withdrawals', {
    params: { status, limit },
  });
  return res.data;
};

/** OWNER 审批提现（批准时可回填链上凭证 ``tx_hash``） */
export const decideOwnerWithdrawal = async (
  kind: 'node' | 'creator',
  withdrawalId: number,
  approve: boolean,
  txHash: string = '',
  note: string = '',
): Promise<{ status: string; withdrawal: WithdrawalRow }> => {
  const res = await cloudApi.post(
    `/api/v1/owner/${kind}-withdrawals/${withdrawalId}/decide`,
    { approve, tx_hash: txHash, note },
  );
  return res.data;
};

/* ===================== 阶段十 P0 · 业主管理口令解锁 ===================== */

/**
 * 用**管理口令**换取一个标准 OWNER 会话（免钱包插件）。
 *
 * 与钱包会话**完全同构**：同一套 JWT / `auth_sessions` / 服务端按 DB 回查角色，
 * 所以解锁之后全部业主卡片自动点亮，不需要任何额外的前端鉴权分支。
 *
 * ⚠️ 服务端对失败做 IP 频控（900s 内 5 次 ⇒ 429），前端不做本地重试。
 */
export const ownerPasskeyUnlock = async (
  passkey: string,
): Promise<{
  access_token: string;
  token_type: string;
  expires_in: number;
  user: {
    handle: string;
    role: string;
    wallet: string;
    status: string;
    account_type: string;
  };
}> => {
  const res = await cloudApi.post('/api/v1/auth/owner-passkey', { passkey });
  return res.data;
};

/** 管理口令失败提示（401/429/503 各说各的话） */
export const describePasskeyError = (e: unknown): string => {
  const err = e as { response?: { status?: number; data?: { detail?: string } } };
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  if (status === 401) return '管理口令不正确';
  if (status === 429) return '口令错误次数过多，请 15 分钟后再试';
  if (status === 503) return '服务端未配置业主管理口令';
  return detail || '解锁失败，请重试';
};

/* ===================== 阶段十 P1 · 卡密作废 + 买家账单 ===================== */

/** OWNER 作废一张尚未核销的充值卡密（已核销 ⇒ 409） */
export const revokeVoucher = async (
  voucherId: number,
): Promise<{ status: string; voucher: VoucherRow }> => {
  const res = await cloudApi.post('/api/v1/owner/vouchers/revoke', {
    voucher_id: voucherId,
  });
  return res.data;
};

/** 买家个人收支流水的一行（金额 9 位小数，服务端不截断） */
export interface LedgerEntry {
  id: number;
  entry_type: string;
  direction: number;
  amount_usd: number;
  balance_after_usd: number;
  model_id: string;
  node_id: string;
  request_id: string;
  note: string;
  created_at: number;
}

export const fetchBuyerLedger = async (
  limit: number = 30,
): Promise<{
  status: string;
  account_handle: string;
  count: number;
  entries: LedgerEntry[];
}> => {
  const res = await cloudApi.get('/api/v1/user/ledger', { params: { limit } });
  return res.data;
};

/* ===================== 阶段十 P2 · 全网算力节点排行榜 ===================== */

/** 排行榜的一行（公开、脱敏：只回产能与贡献） */
export interface LeaderboardNode {
  node_id: string;
  node_name: string;
  online: boolean;
  status: string;
  models: string[];
  is_paused: boolean;
  requests: number;
  tokens: number;
  avg_ttft_ms: number | null;
  peak_ttft_ms: number | null;
  avg_throughput_tps: number | null;
  peak_throughput_tps: number | null;
  total_node_share_usd: number;
  credit_score: number;
  /** 阶段十二 P1 · 买家好评数 */
  positive_feedbacks?: number;
  /** 阶段十二 P1 · 收到的评价总数 */
  feedback_total?: number;
  /** 阶段十二 P1 · 好评率（无样本为 null） */
  approval_rate?: number | null;
  last_seen: number;
}

export const fetchNodeLeaderboard = async (
  limit: number = 20,
): Promise<{ status: string; count: number; nodes: LeaderboardNode[] }> => {
  const res = await cloudApi.get('/api/v1/network/leaderboard', { params: { limit } });
  return res.data;
};

/* ===================== 阶段十一 P1 · 收益与提现明细聚合 ===================== */

/** 提现台账的一行（钱包地址已脱敏） */
export interface EarningsWithdrawalRow {
  id: number;
  amount_usd: number;
  amount_paw: number;
  status: string;
  tx_hash: string;
  note: string;
  payout_wallet: string;
  created_at: number;
}

/** 算力节点的收益概览 */
export interface NodeEarningsSummary {
  node_id: string;
  requests: number;
  tokens: number;
  /** 累计分成总额（revenue_ledger 已结算口径，9 位小数） */
  total_share_usd: number;
  /** 已结清金额 */
  settled_usd: number;
  /** 审批中冻结金额 */
  pending_usd: number;
  /** 本节点可提现净额 */
  available_usd: number;
  /** 该节点是否已绑定业主钱包（未绑定 ⇒ 收益无法归属，也就无法提现） */
  owner_bound: boolean;
  owner_wallet_masked: string;
  /** 该钱包名下**所有**节点的累计分成（提现闸门口径） */
  owner_total_share_usd: number;
  /** 该钱包名下所有节点的可提现净额（提现闸门口径） */
  owner_available_usd: number;
  withdrawals: EarningsWithdrawalRow[];
}

/** 模型创作者的收益概览 */
export interface CreatorEarningsSummary {
  creator_id: string;
  author_wallet_masked: string;
  requests: number;
  tokens: number;
  total_share_usd: number;
  settled_usd: number;
  pending_usd: number;
  available_usd: number;
  withdrawals: EarningsWithdrawalRow[];
}

export interface EarningsSummary {
  status: string;
  node: NodeEarningsSummary | null;
  creator: CreatorEarningsSummary | null;
  note: string;
  limit: number;
}

/**
 * 收益与提现明细聚合（**公开只读**）。
 *
 * 累计口径取自服务端已结算的 ``revenue_ledger``，与双账本对账同源；
 * 前端不做任何二次估算，只负责展示。
 */
export const fetchEarningsSummary = async (
  nodeId: string = '',
  creatorId: string = '',
  limit: number = 20,
): Promise<EarningsSummary> => {
  const params: Record<string, string | number> = { limit };
  if (nodeId) params.node_id = nodeId;
  if (creatorId) params.creator_id = creatorId;
  const res = await cloudApi.get('/api/v1/earnings/summary', { params });
  return res.data;
};

/**
 * 创作者自助提现（阶段十一 P1）。
 *
 * `payoutWallet` 必须与账户绑定钱包一致 —— 服务端会校验并拒绝不一致的地址
 * （否则等于把提现变成「改收款人」漏洞）。
 */
export const submitCreatorWithdrawal = async (
  amountUsd: number,
  note: string = '',
  payoutWallet: string = '',
): Promise<{
  status: string;
  withdrawal: {
    id: number;
    status: string;
    amount_usd: number;
    amount_paw: number;
    author_wallet: string;
    payout_wallet: string;
    remaining_usd: number;
  };
}> => {
  const res = await cloudApi.post('/api/v1/creator/royalty/withdraw', {
    amount_usd: amountUsd,
    note,
    payout_wallet: payoutWallet,
  });
  return res.data;
};


/* ===================== 阶段十二 P1/P2 · 回答质量打分与黄金语料工坊 ===================== */

/** 提交买家对一次回答的评价（👍 1 / 👎 -1 / 采纳 0）。
 *
 * 服务端按 `request_id` **幂等**更新；`rating === 1` 且回答非空时
 * 自动进入黄金语料池（`is_golden = 1`）。
 */
export const submitFeedback = async (payload: {
  rating: number;
  request_id?: string;
  prompt_text?: string;
  completion_text?: string;
  model_id?: string;
  node_id?: string;
  copied?: number;
  ttft_ms?: number;
  throughput_tps?: number;
}): Promise<{
  status: string;
  request_id: string;
  sample_id: number;
  created: boolean;
  rating: number;
  is_golden: boolean;
}> => {
  const res = await cloudApi.post('/api/v1/user/feedback', payload);
  return res.data;
};

/** 黄金语料池概览（OWNER） */
export interface DatasetSummary {
  status: string;
  total: number;
  golden: number;
  positive: number;
  negative: number;
  adopted: number;
  copied: number;
  models: Array<{ model_id: string; count: number }>;
  recent: Array<{
    id: number;
    request_id: string;
    account_handle: string;
    model_id: string;
    node_id: string;
    prompt_text: string;
    completion_text: string;
    rating: number;
    copied: number;
    is_golden: number;
    ttft_ms: number;
    throughput_tps: number;
    created_at: number;
    /** 阶段十六 P0：乐观锁基准值（编辑时回传，冲突 ⇒ 409） */
    updated_at: number;
  }>;
}

export const fetchDatasetSummary = async (): Promise<DatasetSummary> => {
  const res = await cloudApi.get('/api/v1/owner/datasets/summary');
  return res.data;
};

/** 语料导出格式（阶段十二 P2 + 阶段十三 P1）。
 *  - `sft` / `dpo`：JSONL 语料（LLaMA-Factory / Unsloth 直接吃）；
 *  - `modelfile`：标准 Ollama Modelfile（`ollama create` 秒出进化版模型）；
 *  - `lora_script`：开箱即用的单卡 LoRA 微调脚本（Unsloth / HF TRL 模板）。 */
export type DatasetExportFormat = 'sft' | 'dpo' | 'modelfile' | 'lora_script';

/** 一键导出语料 / 生成进化版模型物料（OWNER）。
 *
 * 后端返回纯文本（JSONL 或 Modelfile / Python 脚本）⇒ 这里拿到的是**文本**，
 * 前端直接生成 Blob 触发浏览器下载。
 *
 * @param format 导出格式
 * @param baseModel 基准模型（仅 `modelfile` / `lora_script` 用；如 `qwen2.5:0.5b`）
 */
export const exportDataset = async (
  format: DatasetExportFormat,
  baseModel?: string,
): Promise<string> => {
  const res = await cloudApi.get('/api/v1/owner/datasets/export', {
    params: {
      format,
      ...(baseModel ? { base_model: baseModel } : {}),
    },
    responseType: 'text',
  });
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
};

// ----------------- 阶段十四 P2 · RLAIF 自动验算与 DPO 自进化 -----------------

/** 题库条目（**不含答案** —— 答案与规则只有网关内部知道） */
export interface RlaifTask {
  id: string;
  title: string;
  category: string;
  prompt: string;
  must_contain?: string[];
  must_not_contain?: string[];
  min_length?: number;
  /** 阶段十五 P1：true = 业主自定义考题（可删）；false = 内置题库 */
  custom?: boolean;
  /** 阶段十六 P0：乐观锁基准值（编辑已有考题时回传，冲突 ⇒ 409） */
  updated_at?: number;
  /** 服务端把判分规则嵌在 rules 里（顶层字段为兼容旧结构保留） */
  rules?: {
    must_contain: string[];
    must_not_contain: string[];
    min_length: number;
  };
}

/** 历史跑批统计 */
export interface RlaifStats {
  runs: number;
  total_candidates: number;
  passed_candidates: number;
  pass_rate: number;
  last_run_id?: string;
  last_run_at?: number;
}

export interface RlaifTaskBank {
  status: string;
  tasks: RlaifTask[];
  stats: RlaifStats;
}

export interface RlaifPair {
  task_id: string;
  title: string;
  category: string;
  prompt: string;
  chosen: string;
  rejected: string;
  checks: Array<{
    path: string;
    passed: boolean;
    checks: Array<{ rule: string; pattern: string; ok: boolean }>;
  }>;
}

export interface RlaifRunResult {
  status: string;
  run_id: string;
  tasks: number;
  pairs_created: number;
  total_candidates: number;
  passed_candidates: number;
  pass_rate: number;
  pairs: RlaifPair[];
  dry_run: boolean;
}

/** 读取 RLAIF 题库 + 历史自动验算统计（OWNER） */
export const fetchRlaifTasks = async (): Promise<RlaifTaskBank> => {
  const res = await cloudApi.get('/api/v1/owner/rlaif/tasks');
  return res.data;
};

/**
 * 一键跑批（OWNER）：出题 → 双路候选 → 确定性判分 → 自动配成偏好对。
 * 通过 ⇒ chosen（进黄金池），未通过 ⇒ rejected（进负向池），两者同 prompt ⇒ 可导 DPO。
 */
export const runRlaif = async (options?: {
  taskIds?: string[];
  maxTasks?: number;
  dryRun?: boolean;
}): Promise<RlaifRunResult> => {
  const res = await cloudApi.post('/api/v1/owner/rlaif/run', {
    task_ids: options?.taskIds ?? [],
    max_tasks: options?.maxTasks ?? 0,
    dry_run: options?.dryRun ?? false,
  });
  return res.data;
};

// ----------------- 阶段十五 P1 · 黄金记忆策展 + 自定义验算考题 -----------------

/** 手工录入 / 编辑一条黄金记忆（OWNER）。
 *
 * - `requestId` 留空 ⇒ 服务端自动生成 `curated:<hex>`；
 * - 传已存在的 `curated:*` ⇒ **就地更新**（不新增行）；
 * - `isGolden = 0` ⇒ 只取消黄金标记，样本本体仍留在池里。
 */
export const upsertCuratedGolden = async (payload: {
  requestId?: string;
  promptText: string;
  completionText: string;
  modelId?: string;
  isGolden?: boolean;
  /** 阶段十六 P0：乐观锁 —— 编辑已有样本时带上"我看到的" updated_at */
  expectedUpdatedAt?: number;
}): Promise<{
  status: string;
  request_id: string;
  is_golden: number;
  created: boolean;
  updated_at?: number;
}> => {
  const res = await cloudApi.post('/api/v1/owner/datasets/golden-upsert', {
    request_id: payload.requestId ?? '',
    prompt_text: payload.promptText,
    completion_text: payload.completionText,
    model_id: payload.modelId ?? '',
    is_golden: payload.isGolden === false ? 0 : 1,
    ...(payload.expectedUpdatedAt !== undefined
      ? { expected_updated_at: payload.expectedUpdatedAt }
      : {}),
  });
  return res.data;
};

/** 给**任意**样本打/撤黄金标记（OWNER · 编辑权，不改写正文）。
 *
 * ⚠️ 阶段十六 P0：带 `expectedUpdatedAt` 时，若库内 `updated_at` 已被别人改动
 * ⇒ 服务端回 **409 version_conflict**（不静默覆盖）。
 */
export const setCuratedGoldenFlag = async (
  requestId: string,
  isGolden: boolean,
  expectedUpdatedAt?: number,
): Promise<{ status: string; request_id: string; is_golden: number; updated_at?: number }> => {
  const res = await cloudApi.post('/api/v1/owner/datasets/golden-flag', {
    request_id: requestId,
    is_golden: isGolden ? 1 : 0,
    ...(expectedUpdatedAt !== undefined
      ? { expected_updated_at: expectedUpdatedAt }
      : {}),
  });
  return res.data;
};

/** 删除一条策展件 / 自动验算产物（OWNER）。
 *
 * ⚠️ 真实买家评价（`chatcmpl-*`）**删不掉** —— 服务端会回 400
 * `protected_sample`，保证原始真机黄金基线不被误伤。
 */
export const deleteCuratedSample = async (
  requestId: string,
): Promise<{ status: string; request_id: string }> => {
  const res = await cloudApi.delete(
    `/api/v1/owner/datasets/golden/${encodeURIComponent(requestId)}`,
  );
  return res.data;
};

/** 新增 / 更新一道自定义 RLAIF 验算考题（OWNER）。
 *
 * ⚠️ 阶段十六 P0：编辑已有考题时带 `expectedUpdatedAt` ⇒ 与库内 `updated_at`
 * 不一致时服务端回 **409 version_conflict**（防止"后写覆盖先写"）。
 */
export const upsertRlaifTask = async (payload: {
  taskId?: string;
  title?: string;
  category?: string;
  prompt: string;
  mustContain?: string[];
  mustNotContain?: string[];
  minLength?: number;
  expectedUpdatedAt?: number;
}): Promise<{ status: string; task_id: string; created: boolean; updated_at?: number }> => {
  const res = await cloudApi.post('/api/v1/owner/rlaif/tasks', {
    task_id: payload.taskId ?? '',
    title: payload.title ?? '',
    category: payload.category ?? 'custom',
    prompt: payload.prompt,
    must_contain: payload.mustContain ?? [],
    must_not_contain: payload.mustNotContain ?? [],
    min_length: payload.minLength ?? 1,
    ...(payload.expectedUpdatedAt !== undefined
      ? { expected_updated_at: payload.expectedUpdatedAt }
      : {}),
  });
  return res.data;
};

/** 删除一道自定义 RLAIF 验算考题（OWNER）。 */
export const deleteRlaifTask = async (
  taskId: string,
): Promise<{ status: string; task_id: string }> => {
  const res = await cloudApi.delete(
    `/api/v1/owner/rlaif/tasks/${encodeURIComponent(taskId)}`,
  );
  return res.data;
};

// ----------------- 阶段十六 P2 · 进化前后 A/B 智商对比评测 -----------------

/** 单题对比明细 */
export interface RlaifBenchmarkDetail {
  task_id: string;
  title: string;
  category: string;
  custom: boolean;
  baseline_passed: boolean;
  evolved_passed: boolean;
  improved: boolean;
  /** 召回到的黄金条数（含兜底件） */
  golden_count: number;
  /** 真正相关（matched=1）的黄金条数 —— 进化答案只来自这些 */
  golden_relevant: number;
  golden_request_ids: string[];
  golden_scores: number[];
  baseline_preview: string;
  evolved_preview: string;
}

/** A/B 评测结果 */
export interface RlaifBenchmarkResult {
  status: string;
  dry_run: boolean;
  total_tasks: number;
  baseline_passed: number;
  baseline_pass_rate: number;
  evolved_passed: number;
  evolved_pass_rate: number;
  /** 提升（**百分点**，如 12.5 = +12.5%） */
  improvement_delta: number;
  /** 相对提升（基线为 0 时无意义 ⇒ 0） */
  improvement_ratio: number;
  improved_tasks: number;
  details: RlaifBenchmarkDetail[];
}

/**
 * 一键运行「进化前后 A/B 智商对比评测」（OWNER）。
 *
 * - **Baseline** = 关闭黄金记忆注入（`golden_boost=false`）时的通过率；
 * - **Evolved** = 开启黄金记忆注入 + 黄金检索召回后的通过率。
 *
 * ⚠️ 本接口**恒不写库**（只读黄金样本 + 内存判分）⇒ 跑多少次都不污染正式
 * 语料池；`dryRun` 只是把这条契约显式化。
 */
export const runRlaifBenchmark = async (options?: {
  taskIds?: string[];
  maxTasks?: number;
  dryRun?: boolean;
}): Promise<RlaifBenchmarkResult> => {
  const res = await cloudApi.post('/api/v1/owner/rlaif/benchmark', {
    task_ids: options?.taskIds ?? [],
    max_tasks: options?.maxTasks ?? 0,
    dry_run: options?.dryRun ?? true,
  });
  return res.data;
};

/* ===================== 阶段十七 P0 · API Key 安全策略 ===================== */

/** 同账户下**另一把** Key 的概览（掩码，无明文） */
export interface ApiKeyPolicyKeyRow {
  key_prefix: string;
  key_last4: string;
  label: string;
  status: string;
  daily_limit_usd: number;
  allowed_ips: string[];
  allowed_models: string[];
  updated_at: number;
  created_at: number;
  /** true = 当前正在操作的这把 Key */
  current: boolean;
}

/** 当前 API Key 的安全策略快照 */
export interface ApiKeyPolicy {
  ok?: boolean;
  found: boolean;
  status: string;
  daily_limit_usd: number;
  allowed_ips: string[];
  allowed_models: string[];
  updated_at: number;
  key_prefix: string;
  key_last4: string;
  label: string;
  keys: ApiKeyPolicyKeyRow[];
  account_handle?: string;
}

/**
 * 读取当前 API Key 的安全策略（冻结状态 / IP 白名单 / 模型白名单 / 单日限额）。
 *
 * ⚠️ **被冻结的 Key 也能调用本端点** —— 否则用户被冻之后连"解冻自己"
 * 都做不到（死锁）。但推理 / 消费接口依然拒绝被冻的 Key。
 */
export const fetchApiKeyPolicy = async (): Promise<ApiKeyPolicy> => {
  const res = await cloudApi.get('/api/v1/user/apikey/policy');
  return res.data;
};

/** 更新当前 API Key 的安全策略（部分字段 = 不改动该项） */
export const updateApiKeyPolicy = async (payload: {
  status?: 'active' | 'frozen';
  daily_limit_usd?: number;
  allowed_ips?: string[];
  allowed_models?: string[];
}): Promise<{
  ok: boolean;
  status?: string;
  daily_limit_usd?: number;
  allowed_ips?: string[];
  allowed_models?: string[];
  error?: string;
}> => {
  const res = await cloudApi.post('/api/v1/user/apikey/policy', payload);
  return res.data;
};

/** 安全策略更新失败的可读提示（400 + {code}） */
export const describePolicyError = (e: unknown): string => {
  const err = e as {
    response?: { status?: number; data?: { detail?: string | { code?: string } } };
  };
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;
  const code = typeof detail === 'object' && detail ? detail.code : '';
  if (status === 401) return 'API Key 无效或已吊销，请重新设置密钥';
  if (status === 403) return '当前 Key 无权修改安全策略';
  if (code === 'revoke_not_allowed') return '吊销（revoked）是不可逆操作，请联系平台';
  if (code === 'revoked_immutable') return '已吊销的 Key 无法恢复';
  if (code === 'bad_daily_limit') return '单日限额必须是非负数字';
  if (code === 'key_not_found') return '找不到这把 API Key';
  if (typeof detail === 'string' && detail) return detail;
  return describeCloudError(e);
};

/* ===================== 阶段十七 P1 · 智能告警中心 + 场景 A/B 拆解 ===================== */

/** 一个场景（A = 开源基础模型 / B = 创作者版税模型）的聚合口径 */
export interface ScenarioBucket {
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  calls: number;
  /** 该场景累计产生的创作者版税 */
  royalty_usd: number;
  /** 费用占比（0~1） */
  cost_share: number;
  /** Token 占比（0~1） */
  token_share: number;
}

/** 一条智能风控告警 */
export interface SmartAlert {
  code: string;
  level: 'high' | 'medium' | 'low';
  message: string;
  value?: number;
  threshold?: number;
  limit?: number;
  ratio?: number;
  node_id?: string;
}

/** 买家总览（带 Key = 账户口径；不带 Key = 全网公开基准） */
export interface OverviewAnalytics {
  /** true = 账户口径；false = 全网公开汇总 */
  scoped: boolean;
  account_handle: string;
  scenario_a: ScenarioBucket;
  scenario_b: ScenarioBucket;
  total_cost_usd: number;
  total_tokens: number;
  total_calls: number;
  alerts: SmartAlert[];
  balance_usd?: number;
  balance_frozen_usd?: number;
  daily_limit_usd?: number;
}

/**
 * 智能告警中心 + 场景 A/B 费用拆解。
 *
 * - 带**有效** API Key ⇒ 账户口径（余额 / 限额 / 冻结状态 + 账户消费拆解）；
 * - 不带或无效凭证 ⇒ 全网公开基准（只有 A/B 拆解与节点侧告警，无账户信息）。
 */
export const fetchOverviewAnalytics = async (): Promise<OverviewAnalytics> => {
  const res = await cloudApi.get('/api/v1/user/overview-analytics');
  return res.data;
};

/* ===================== 阶段十七 P2 · 网关内容安全拦截（业主视角） ===================== */

/** 一条拦截记录（业主后台查看用） */
export interface ModerationBlockRow {
  id: number;
  account_handle: string;
  request_id: string;
  rule: string;
  snippet: string;
  client_ip: string;
  model_id: string;
  created_at: number;
}

/** 拦截计数 + 规则表 + 最近明细（OWNER） */
export interface ModerationBlocksResponse {
  total: number;
  rules: Array<{ name: string; description?: string; pattern?: string }>;
  enabled: boolean;
  recent: ModerationBlockRow[];
}

export const fetchOwnerModerationBlocks = async (
  limit: number = 20,
): Promise<ModerationBlocksResponse> => {
  const res = await cloudApi.get('/api/v1/owner/moderation/blocks', { params: { limit } });
  return res.data;
};

/* ============ 阶段十八 P0-P2 · PoI 推理证明 + 默克尔状态根（公开 + 业主） ============ */

/** 一条 PoI 审计流水（抽检 / 守卫触发 / 业主手动复核） */
export interface PoiAuditRow {
  id: number;
  request_id: string;
  node_id: string;
  model_id: string;
  audit_type: string;
  verdict: string;
  reason: string;
  reported_tokens: number;
  verified_tokens: number;
  entropy_score: number;
  similarity_score: number;
  slash_penalty: number;
  created_at: number;
}

/** 全网 PoI 汇总（公开脱敏：无任何账户信息） */
export interface PoiSummaryResponse {
  verified_inferences: number;
  total_usage_rows: number;
  slashed_usage_rows: number;
  spot_check_hits: number;
  guard_triggered: number;
  slashing_blocked: number;
  spot_check_rate: number;
  historical_records: Array<{
    request_id: string;
    node_id: string;
    model_id: string;
    prompt_tokens: number;
    completion_tokens: number;
    poi_status: string;
    output_sha256: string;
    receipt_sig: string;
  }>;
  recent_audits: PoiAuditRow[];
  generated_at: number;
}

/** 分布式状态机默克尔状态根（公开） */
export interface StateRootResponse {
  state_root: string;
  ledger_root: string;
  revenue_root: string;
  ledger_leaf_count: number;
  revenue_leaf_count: number;
  timestamp: number;
  algorithm?: string;
  /** 阶段二十二 P2：锚定状态（当前仅通过 API 发布，未做外部锚定）。 */
  anchor_status?: string;
  /** 阶段二十五 P0：默克尔状态根的**外部锚定**元信息（检查点链）。 */
  anchor_ref?: string;
  latest_epoch_no?: number;
  chain_valid?: boolean;
}

/** 默克尔包含性证明（浏览器端可本地重算根并自证） */
export interface MerkleProofResponse {
  ok: boolean;
  code?: string;
  message?: string;
  ledger?: string;
  leaf_index?: number;
  leaf_count?: number;
  leaf_hash?: string;
  leaf_canonical?: string;
  siblings?: string[];
  /** 每层兄弟的方位（"L" 在左 / "R" 在右）—— 缺了就按旧口径恒在右处理 */
  sibling_sides?: string[];
  root_hash?: string;
  verified?: boolean;
  scoped?: boolean;
  ledger_root?: string;
  revenue_root?: string;
  state_root?: string;
}

/** 全网 PoI 汇总（公开） */
export const fetchPoiSummary = async (limit: number = 20): Promise<PoiSummaryResponse> => {
  const res = await cloudApi.get('/api/v1/network/poi-summary', { params: { limit } });
  return res.data;
};

/** 默克尔状态根（公开） */
export const fetchStateRoot = async (): Promise<StateRootResponse> => {
  const res = await cloudApi.get('/api/v1/network/state-root');
  return res.data;
};

/**
 * 默克尔包含性证明。
 *
 * 带买家 API Key 时，网关会返回**该账户最后一行**账本在**全网默克尔树**里的
 * 兄弟链 ⇒ 本地重算出的根必然等于公示的 ``ledger_root``。
 */
export const fetchMerkleProof = async (
  ledger: 'balance' | 'revenue' = 'balance',
  leafIndex?: number,
): Promise<MerkleProofResponse> => {
  const params: Record<string, number | string> = { ledger };
  if (leafIndex !== undefined) params.leaf_index = leafIndex;
  const res = await cloudApi.get('/api/v1/network/merkle-proof', { params });
  return res.data;
};

/** 业主主动验真 / 模拟欺诈演练（OWNER） */
export const runOwnerPoiAudit = async (body: {
  request_id?: string;
  simulate_fraud_type?: 'token_inflation' | 'low_entropy' | 'bad_signature';
  node_id?: string;
  model_id?: string;
}): Promise<{
  ok: boolean;
  message?: string;
  fraud_type?: string;
  node_id?: string;
  request_id?: string;
  reason?: string;
  score?: number;
  penalty?: number;
}> => {
  const res = await cloudApi.post('/api/v1/owner/poi/audit', body);
  return res.data;
};


// ===========================================================================
// 阶段十九 P0-P2 · PAWMODEL 哈希锁 / Model DAO / SLA 金牌池 / B2B 发票 / USDT 储值
// ===========================================================================

/** 清单指纹（公开口径：不含 System Prompt 原文） */
export interface ModelManifestRow {
  model_id: string;
  display_name: string;
  tier: string;
  prompt_price_per_1k: number;
  completion_price_per_1k: number;
  royalty_rate: number;
  author_wallet: string;
  system_prompt_sha256: string;
  manifest_sha256: string;
  created_at: number;
}

/** 治理提案（公开台账） */
export interface DaoProposalRow {
  proposal_id: string;
  title: string;
  action_type: string;
  target_id: string;
  payload_json: string;
  proposer: string;
  yes_weight: number;
  no_weight: number;
  total_eligible_weight: number;
  status: string;
  execution_hash: string;
  created_at: number;
  executed_at: number;
}

/** USDT 储值申报行 */
export interface CryptoDepositRow {
  id: number;
  tx_hash: string;
  account_handle: string;
  network: string;
  amount_usd: number;
  status: string;
  note: string;
  created_at: number;
  decided_at: number;
}

/** 公开：全网模型清单指纹 */
export const fetchModelManifests = async (): Promise<{
  count: number;
  manifests: ModelManifestRow[];
}> => {
  const res = await cloudApi.get('/api/v1/network/model-manifests');
  return res.data;
};

/** 公开：治理提案台账 */
export const fetchDaoProposals = async (status: string = ''): Promise<{
  count: number;
  threshold: number;
  action_types: string[];
  proposals: DaoProposalRow[];
}> => {
  const res = await cloudApi.get('/api/v1/network/dao/proposals', {
    params: status ? { status } : undefined,
  });
  return res.data;
};

/** 公开：企业级 SLA 金牌池现状 */
export const fetchSlaPool = async (): Promise<{
  min_reliability: number;
  max_gpu_temp_c: number;
  gold_count: number;
  gold_nodes: { node_id: string; reliability_score: number; gpu_temp_c: number | null; alive: boolean }[];
}> => {
  const res = await cloudApi.get('/api/v1/network/sla-pool');
  return res.data;
};

/** 购买者：B2B 发票 JSON（含默克尔 State Root 存证） */
export const fetchInvoiceJson = async (): Promise<{
  ok: boolean;
  account_handle: string;
  total_recharged_usd: number;
  total_spent_usd: number;
  balance_usd: number;
  call_count: number;
  reconciled: boolean;
  per_model?: { model_id: string; calls: number; cost_usd: number }[];
  attestation?: { state_root: string; ledger_root: string; revenue_root: string };
}> => {
  const res = await cloudApi.get('/api/v1/user/invoice', { params: { format: 'json' } });
  return res.data;
};

/** 购买者：发票原文（csv / html） */
export const fetchInvoiceText = async (format: 'csv' | 'html'): Promise<string> => {
  const res = await cloudApi.get('/api/v1/user/invoice', {
    params: { format },
    responseType: 'text',
  });
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
};

/** OWNER：导入 PAWMODEL.md 模型包（带两个哈希锁） */
export const importPawmodel = async (content: string): Promise<{
  status: string;
  manifest: { model_id: string; manifest_sha256: string; system_prompt_sha256: string };
  result: { ok?: boolean; error?: string };
}> => {
  const res = await cloudApi.post('/api/v1/owner/models/import-pawmodel', { content });
  return res.data;
};

/** OWNER：发起治理提案 */
export const daoPropose = async (body: {
  title: string;
  action_type: string;
  target_id: string;
  payload?: Record<string, unknown>;
}): Promise<{ status: string; proposal_id: string; total_eligible_weight: number }> => {
  const res = await cloudApi.post('/api/v1/owner/dao/propose', body);
  return res.data;
};

/** OWNER：投票（赎成票重占比 > 66% 即自动执行） */
export const daoVote = async (proposal_id: string, approve: boolean): Promise<{
  status: string;
  executed: boolean;
  yes_ratio: number;
  execution_hash: string;
}> => {
  const res = await cloudApi.post('/api/v1/owner/dao/vote', { proposal_id, approve });
  return res.data;
};

/** 购买者：申报 USDT 储值（只登记，不加钱） */
export const declareCryptoDeposit = async (body: {
  tx_hash: string;
  network: string;
  amount_usd: number;
}): Promise<{ status: string; deposit_id: number }> => {
  const res = await cloudApi.post('/api/v1/user/deposit/declare', body);
  return res.data;
};

/** OWNER：审批 / 驳回 USDT 申报（批准才入账） */
export const decideCryptoDeposit = async (
  depositId: number,
  approve: boolean,
): Promise<{ status: string; deposit_id: number; amount_usd: number; duplicate: boolean }> => {
  const res = await cloudApi.post(`/api/v1/owner/deposit/${depositId}/decide`, { approve });
  return res.data;
};

/** 购买者：自查自己的申报流水 */
export const fetchMyDeposits = async (): Promise<{
  count: number;
  deposits: CryptoDepositRow[];
}> => {
  const res = await cloudApi.get('/api/v1/user/deposit/list');
  return res.data;
};

/** OWNER：审批台的申报列表 */
export const fetchOwnerDeposits = async (status: string = ''): Promise<{
  count: number;
  deposits: CryptoDepositRow[];
}> => {
  const res = await cloudApi.get('/api/v1/owner/deposit/list', {
    params: status ? { status } : undefined,
  });
  return res.data;
};

/* ---------------------------------------------------------------------------
 * 阶段二十 P0/P2 · Pipeline Mesh 异构算力网格 + 多网关容灾联邦
 * ------------------------------------------------------------------------- */

/** 一个节点在集群里承载的层区间。 */
export interface MeshLayerSplit {
  node_id?: string;
  label?: string;
  layer_start?: number;
  layer_end?: number;
  layers?: number;
  vram_gb?: number;
  rtt_ms?: number;
  share?: number;
}

/** 已登记的 Pipeline Mesh 合体集群。 */
export interface MeshClusterRow {
  cluster_id: string;
  leader_node_id: string;
  member_node_ids: string[];
  cluster_vram_gb: number;
  mesh_shards: number;
  mesh_rtt_ms: number;
  layer_splits: MeshLayerSplit[];
  mode: string;
  status: string;
  created_at: number;
  updated_at: number;
}

/** 注册表里**实时组网**的节点。 */
export interface MeshLiveNode {
  node_id: string;
  node_name: string;
  alive: boolean;
  mesh_shards: number;
  cluster_vram_gb: number;
  mesh_rtt_ms: number;
  mesh_peers_count: number;
  layer_splits: MeshLayerSplit[];
  agent_version: string;
}

/** 公开：局域网 Pipeline Mesh 合体集群拓扑。 */
export interface MeshTopologyResponse {
  status: string;
  protocol_version: string;
  registered_cluster_count: number;
  live_mesh_node_count: number;
  registered_member_count: number;
  aggregate_cluster_vram_gb: number;
  live_cluster_vram_gb: number;
  clusters: MeshClusterRow[];
  live_nodes: MeshLiveNode[];
  generated_at: number;
  note: string;
}

/** 白皮书 v3.0 五大承诺的实时自检条目。 */
export interface CompliancePillar {
  id: string;
  title: string;
  compliant: boolean;
  evidence: Record<string, unknown>;
  note: string;
}

/** 公开：多网关容灾联邦 + 白皮书 v3.0 合规大盘。 */
export interface FederationStatusResponse {
  status: string;
  protocol_version: string;
  gateway_node_id: string;
  generated_at: number;
  federation: {
    gateways: {
      url: string;
      healthy: boolean;
      http_status?: number;
      rtt_ms?: number;
      error?: string;
      note?: string;
    }[];
    gateway_count: number;
    healthy_count: number;
    all_healthy: boolean;
    failover_ready: boolean;
  };
  state_root: StateRootResponse;
  poi: {
    verification_rate: number;
    verified_inferences: number;
    total_usage_rows: number;
    spot_check_rate: number;
    slashed_usage_rows: number;
  };
  dao: {
    governance_threshold: number;
    locked_model_count: number;
  };
  mesh: {
    registered_cluster_count: number;
    live_mesh_node_count: number;
    aggregate_cluster_vram_gb: number;
    /** 阶段二十二 P2：诚实标注执行阶段（当前只有拓扑规划与展示）。 */
    execution_stage?: string;
  };
  /** 阶段二十二 P2：五大承诺的**业务事实**计数（合规判定的依据）。 */
  business_facts?: {
    poi_audits: number;
    dao_votes: number;
    dao_executed_proposals: number;
    dao_active_proposals: number;
    real_traffic_7d: number;
    real_traffic_total: number;
    node_served_7d: number;
    last_real_traffic_at: number;
    measured_at: number;
  };
  /** 近 7 天真实推理（真实节点执行）的次数。 */
  real_traffic_7d?: number;
  compliance: {
    total: number;
    compliant: number;
    rate: number;
    pillars: CompliancePillar[];
  };
  note: string;
}

/** 公开：Mesh 拓扑大盘。 */
export const fetchMeshTopology = async (): Promise<MeshTopologyResponse> => {
  const res = await cloudApi.get('/api/v1/network/mesh-topology');
  return res.data;
};

/** 公开：联邦状态 + 白皮书 v3.0 合规大盘。 */
export const fetchFederationStatus = async (): Promise<FederationStatusResponse> => {
  const res = await cloudApi.get('/api/v1/network/federation-status');
  return res.data;
};

/**
 * OWNER：组建 / 更新一个局域网 Pipeline Mesh 合体集群。
 *
 * 业主在控制台点「组建局域网 Pipeline Mesh 合体集群」后调用此端点，
 * 集群快照落库 ⇒ 公开拓扑大盘立即可见。
 */
export const registerMeshCluster = async (payload: {
  cluster_id?: string;
  leader_node_id?: string;
  member_node_ids?: string[];
  cluster_vram_gb?: number;
  mesh_shards?: number;
  mesh_rtt_ms?: number;
  layer_splits?: MeshLayerSplit[];
  mode?: string;
}): Promise<{
  status: string;
  ok: boolean;
  cluster: { ok: boolean; cluster_id: string; updated_at: number; member_node_ids?: string[] };
  topology: MeshTopologyResponse;
  message: string;
}> => {
  const res = await cloudApi.post('/api/v1/owner/mesh/register-cluster', payload);
  return res.data;
};
