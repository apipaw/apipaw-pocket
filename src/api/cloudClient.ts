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

const isJwtOnlyPath = (url: string | undefined): boolean => {
  if (!url) return false;
  return JWT_ONLY_PATHS.some((p) => url.includes(p));
};

const isOwnerPath = (url: string | undefined): boolean => {
  if (!url) return false;
  return url.includes(OWNER_PATH_PREFIX);
};

// 统一注入凭证：会话端点用 JWT，业主端点「会话优先、回落 API Key」，其余用买家 API Key
cloudApi.interceptors.request.use((config) => {
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

cloudApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config as
      | (AxiosRequestConfig & { __apipawRetry?: number; __apipawUsedSession?: boolean })
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

    if (method !== 'get' || (!isNetworkError && !isServerError) || retried >= MAX_GET_RETRIES) {
      return Promise.reject(error);
    }

    config.__apipawRetry = retried + 1;
    await new Promise((resolve) => setTimeout(resolve, 1500 * config.__apipawRetry!));
    return cloudApi(config);
  },
);

/**
 * 把 axios 异常翻译成看板可直接展示的中文提示。
 * 401 是上云后最常见的失败原因（密钥缺失/失效），必须给出可操作指引。
 */
export const describeCloudError = (e: unknown, mode: 'key' | 'session' = 'key'): string => {
  const err = e as {
    response?: { status?: number; data?: { detail?: string } };
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
  return err?.response?.data?.detail || err?.message || '网络请求失败';
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
  tier: 'BASE' | 'CREATOR';
  tier_label: string;
  context_window: number;
  reasoning: boolean;
  pricing: ModelPricing;
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

/** 创作者发布模型 —— 落现有 models 表 (tier=CREATOR) */
export const registerCreatorModel = async (
  payload: RegisterCreatorModelPayload,
): Promise<{ status: string; message: string; model: Record<string, unknown> }> => {
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

// ----------------- SSE 流式推理 -----------------

export interface ChatOnceOptions {
  model: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  apiKey?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface ChatOnceResult {
  content: string;
  reasoning: string;
  usage: ChatUsage;
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

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await cloudApi.post('/v1/chat/completions', body, { headers });
  const data = (res.data ?? {}) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: ChatUsage;
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
  return { content, reasoning, usage: (data.usage ?? {}) as ChatUsage };
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
  onOpen?: () => void;
  /** 阶段五 P2 · 回答来源（响应头 X-APIPaw-Dispatch）：node / simulated / fallback。
   *  头在 readyState=2 时就可用 ⇒ 徽标能在流开始时就亮出来。 */
  onDispatch?: (mode: string) => void;
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
  const { model, messages, onOpen, onDispatch, onReasoning, onContent, onUsage, onDone, onError } = options;
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
