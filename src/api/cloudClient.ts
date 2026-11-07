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

// 统一注入买家 API Key（后续所有请求自动带上 Authorization 头）
cloudApi.interceptors.request.use((config) => {
  const apiKey = usePawStore.getState().apiKey;
  if (apiKey) {
    config.headers.Authorization = `Bearer ${apiKey}`;
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
    const config = error?.config as (AxiosRequestConfig & { __apipawRetry?: number }) | undefined;
    if (!config) return Promise.reject(error);

    const method = (config.method || 'get').toLowerCase();
    const status = error?.response?.status;
    const isNetworkError = !status && error?.code !== 'ECONNABORTED';
    const isServerError = !!status && status >= 500;
    const retried = config.__apipawRetry || 0;

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
export const describeCloudError = (e: unknown): string => {
  const err = e as {
    response?: { status?: number; data?: { detail?: string } };
    message?: string;
    code?: string;
  };
  const status = err?.response?.status;
  if (status === 401) return 'API Key 无效或未设置，请点击右上角「设置密钥」填入有效密钥';
  if (status === 403) return '当前账号未绑定创作者钱包，无法访问创作者接口';
  if (status === 404) return '云端网关接口不存在，请确认后端版本';
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

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cgas: number;
  node_earn_usd?: number;
  creator_royalty_usd?: number;
  platform_fee_usd?: number;
}

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

export interface StreamChatOptions {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  apiKey?: string;
  onOpen?: () => void;
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
  onUsage?: (usage: ChatUsage) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export interface StreamChatHandle {
  abort: () => void;
}

/**
 * 以 XHR 增量读取 SSE 流。
 * 相比 fetch 的 ReadableStream，XMLHttpRequest 在 Expo Web 与原生端均可稳定拿到分片文本。
 */
export const streamChat = (options: StreamChatOptions): StreamChatHandle => {
  const { model, messages, onOpen, onReasoning, onContent, onUsage, onDone, onError } = options;
  const apiKey = options.apiKey ?? usePawStore.getState().apiKey;

  const xhr = new XMLHttpRequest();
  let pending = '';
  let consumed = 0;
  let settled = false;
  /** 是否已经收到过正文 —— 用于区分「流被截断」与「流正常结束」 */
  let receivedContent = false;

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    onError?.(message);
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
    try {
      const parsed = JSON.parse(xhr.responseText);
      message = parsed?.error?.message || parsed?.detail || message;
    } catch {
      /* 保留默认错误信息 */
    }
    fail(message);
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
  xhr.send(JSON.stringify({ model, messages, stream: true }));

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
