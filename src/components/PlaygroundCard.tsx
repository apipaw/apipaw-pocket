import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { usePawStore } from '../store/usePawStore';
import {
  CLOUD_BASE_URL,
  ModelInfo,
  StreamChatHandle,
  chatOnce,
  describeCloudError,
  fetchModels,
  streamChat,
} from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';
import { StatTile } from './ui';
import Slider from './Slider';

// ----------------- 类型 -----------------

export interface RunStats {
  ttftMs: number;
  tokensPerSec: number;
  costUsd: number;
  cgas: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 阶段五 P0 · 费用拆解（后端 usage 载荷已下发，前端此前没接） */
  baseComputeUsd: number;
  nodeEarnUsd: number;
  creatorRoyaltyUsd: number;
  platformFeeUsd: number;
  /** 阶段五 P2 · v2 分账明细（切正后的权威口径） */
  royaltyPoolUsd: number;
  creatorShareUsd: number;
  platformTotalUsd: number;
  /** 阶段五 P2 · 回答来源（node / simulated / fallback） */
  answerSource?: string;
  /** 阶段五 P4 · 性能读数来源：node=后端实测 / local=前端本地计时 */
  perfSource?: string;
  /** 阶段五 P2 · D9：流式过程中的临时统计（费用尚未结算，不展示小票） */
  partial?: boolean;
}

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
  stats?: RunStats;
  error?: string;
  /** 阶段五 P2 · 本次回答来源（流开始时就能拿到，用于来源徽标） */
  answerSource?: string;
}

type ExporterTab = 'curl' | 'python' | 'javascript';

// ----------------- 工具函数 -----------------

const stripThinkTags = (text: string): string => text.replace(/<\/?think>/g, '');

/** 粗略 token 估算（与服务端 estimate_tokens 口径一致） */
const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const cjk = Array.from(text).filter((ch) => ch >= '\u4e00' && ch <= '\u9fff').length;
  const other = Array.from(text).length - cjk;
  return Math.max(1, Math.round(cjk + other / 3.6));
};

/** 阶段五 P1 · 场景推导：A = 开源基础模型 / B = 社区创作者模型。
 *  老网关不下发 scenario 字段时按 tier 兜底。 */
const scenarioOf = (model?: ModelInfo | null): 'A' | 'B' =>
  model?.scenario ?? (model?.tier === 'CREATOR' ? 'B' : 'A');

/** 阶段五 P1 · 版税率（**只有场景 B 才有**；老网关按决策 D4 的固定 15% 兜底）。
 *  注意：网关对场景 A 的模型也会下发 royalty_rate=0.15（那是 models 表的列默认值），
 *  前端必须按**场景**判定，否则场景 A 会被凭空加上 15% 的版税。 */
const royaltyRateOf = (model?: ModelInfo | null): number => {
  if (!model) return 0;
  if (scenarioOf(model) !== 'B') return 0;
  if (typeof model.royalty_rate === 'number') return model.royalty_rate;
  return 0.15;
};

const SCENARIO_LABEL: Record<'A' | 'B', string> = {
  A: '场景 A · 开源基础模型',
  B: '场景 B · 社区创作者模型',
};

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }
};

const formatMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

/** 阶段五 P2 · D8 · 回答来源徽标：让买家一眼看出这答案是真节点跑的还是平台模拟的。 */
const SOURCE_META: Record<string, { label: string; color: string }> = {
  node: { label: '真实节点', color: colors.accent },
  simulated: { label: '模拟回答', color: colors.warn },
  fallback: { label: '回退模拟', color: colors.warn },
};

const sourceMetaOf = (mode?: string | null) => SOURCE_META[String(mode || '')] ?? null;

// ----------------- 思考链 (CoT) 卡片 -----------------

interface ReasoningCardProps {
  text: string;
  live: boolean;
  elapsedMs: number;
  onToggle: () => void;
  /** 阶段五 P2 · D8：来源徽标（真实节点 / 模拟回答） */
  sourceLabel?: string;
  sourceColor?: string;
}

const ReasoningCard: React.FC<ReasoningCardProps> = ({
  text,
  live,
  elapsedMs,
  onToggle,
  sourceLabel,
  sourceColor,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const userToggled = useRef(false);

  // 思考进行中默认展开以展示打字机效果, 用户手动折叠后不再自动展开
  useEffect(() => {
    if (live && !userToggled.current) {
      setExpanded(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: 260,
        useNativeDriver: false,
      }).start();
    }
  }, [live, progress]);

  const toggle = () => {
    const next = !expanded;
    userToggled.current = true;
    setExpanded(next);
    Animated.timing(progress, {
      toValue: next ? 1 : 0,
      duration: 240,
      useNativeDriver: false,
    }).start();
    onToggle();
  };

  // 阶段五 P2 · D8：思考链一键复制（折叠状态下也能复制）
  const handleCopy = async () => {
    const ok = await copyToClipboard(stripThinkTags(text));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const maxHeight = progress.interpolate({ inputRange: [0, 1], outputRange: [0, 460] });
  const opacity = progress.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0.4, 1] });

  const tokens = estimateTokens(stripThinkTags(text));
  const seconds = (elapsedMs / 1000).toFixed(1);

  return (
    <View style={styles.reasonCard}>
      <TouchableOpacity style={styles.reasonHeader} onPress={toggle} activeOpacity={0.75}>
        <View style={styles.reasonHeaderLeft}>
          <Text style={styles.reasonIcon}>{live ? '🧠' : '✅'}</Text>
          <Text style={[styles.reasonTitle, live && styles.reasonTitleLive]}>
            {live ? `深度思考中... (耗时 ${seconds}s | ${tokens} Tokens)` : `思考完成 · 耗时 ${seconds}s · ${tokens} Tokens`}
          </Text>
          {sourceLabel ? (
            <View
              style={[styles.sourceBadge, { borderColor: `${sourceColor || colors.cyan}66` }]}
              testID="playground-cot-source"
            >
              <Text style={[styles.sourceBadgeText, { color: sourceColor || colors.cyan }]}>
                {sourceLabel}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.reasonHeaderRight}>
          <TouchableOpacity
            style={styles.reasonCopyBtn}
            onPress={handleCopy}
            activeOpacity={0.7}
            testID="playground-cot-copy"
          >
            <Text style={styles.reasonCopyText}>{copied ? '已复制' : '复制'}</Text>
          </TouchableOpacity>
          <Text style={styles.reasonChevron}>{expanded ? '▾' : '▸'}</Text>
        </View>
      </TouchableOpacity>
      <Animated.View style={[styles.reasonBody, { maxHeight, opacity }]}>
        <Text style={styles.reasonText}>{stripThinkTags(text)}</Text>
      </Animated.View>
    </View>
  );
};

// ----------------- 性能统计条 -----------------

const StatsBar: React.FC<{ stats: RunStats }> = ({ stats }) => (
  <View style={styles.statsBar}>
    {/* 阶段五 P2 · D9：三块 StatTile —— 首字延迟 / 吐字速度 / 总 token。
        阶段五 P4 起：TTFT 与 tok/s **优先用后端实测值**（跨设备可比、可回溯），
        后端没给（模拟回答 / 老网关）时才回退**前端本地计时**。 */}
    <View style={styles.statTilesRow}>
      <View style={styles.statTileWrap} testID="playground-stat-ttft">
        <StatTile
          label="首字延迟 TTFT"
          value={formatMs(stats.ttftMs)}
          tone="cyan"
          hint={stats.perfSource === 'node' ? '后端实测' : '本地计时'}
        />
      </View>
      <View style={styles.statTileWrap} testID="playground-stat-tps">
        <StatTile
          label="吐字速度"
          value={stats.tokensPerSec.toFixed(1)}
          unit="tok/s"
          tone="emerald"
          hint={stats.perfSource === 'node' ? '后端实测' : '本地计时'}
        />
      </View>
      <View style={styles.statTileWrap} testID="playground-stat-tokens">
        <StatTile
          label="总 Tokens"
          value={String(stats.totalTokens)}
          tone="violet"
          hint={`输入 ${stats.promptTokens} / 输出 ${stats.completionTokens}`}
        />
      </View>
    </View>

    {/* 阶段五 P2 · D9：「账单小票」—— 单次请求的四项费用，结算后一目了然。
        口径优先用 v2 明细（切正后的权威口径），老网关不下发时回落旧字段。
        流式过程中费用尚未结算（partial）→ 小票等结算完成再出现。 */}
    {stats.partial ? (
      <Text style={styles.breakdownTitle} testID="playground-cost-pending">
        账单小票 · 结算中…
      </Text>
    ) : (
      <View style={styles.breakdownRow} testID="playground-cost-breakdown">
        <Text style={styles.breakdownTitle}>账单小票</Text>
        <Text style={styles.breakdownItem} testID="playground-cost-compute">
          算力费 ${stats.baseComputeUsd.toFixed(6)}
        </Text>
        <Text style={styles.breakdownItem} testID="playground-cost-royalty">
          创作者版税 ${stats.creatorRoyaltyUsd.toFixed(6)}
        </Text>
        <Text style={styles.breakdownItem} testID="playground-cost-platform">
          平台管理费 ${stats.platformTotalUsd.toFixed(6)}
        </Text>
        <Text style={[styles.breakdownItem, styles.breakdownTotal]} testID="playground-receipt-total">
          买家实付 ${stats.costUsd.toFixed(6)} · {stats.cgas.toFixed(1)} CGas
        </Text>
      </View>
    )}
  </View>
);

// ----------------- 主组件 -----------------

const PlaygroundCard: React.FC = () => {
  const { apiKey, selectedModelId, setSelectedModelId } = usePawStore();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exporterOpen, setExporterOpen] = useState(false);
  const [exporterTab, setExporterTab] = useState<ExporterTab>('curl');
  const [copied, setCopied] = useState(false);

  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [tick, setTick] = useState(0);

  // ----------------- 阶段五 P0 · 参数面板 -----------------
  // 此前 Playground 只能改模型，采样参数一概不可调 —— 即便调了也不会生效
  // （后端既不接收 top_p，也从不下发任何采样参数）。
  const [paramsOpen, setParamsOpen] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.9);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [systemPrompt, setSystemPrompt] = useState('');
  // 阶段五 P3 · 流式开关：默认开（保持既有行为），关掉走非流式一次性请求。
  const [streamEnabled, setStreamEnabled] = useState(true);

  const streamRef = useRef<StreamChatHandle | null>(null);
  const runRef = useRef({
    startedAt: 0,
    firstTokenAt: 0,
    reasoningStartedAt: 0,
    contentChars: 0,
    usage: null as {
      completion_tokens: number;
      prompt_tokens: number;
      total_tokens?: number;
      cost_usd: number;
      cgas: number;
      base_compute_usd?: number;
      node_earn_usd?: number;
      creator_royalty_usd?: number;
      platform_fee_usd?: number;
      // 阶段五 P2 · v2 分账明细
      answer_source?: string;
      p_compute_usd?: number;
      p_royalty_usd?: number;
      node_share_usd?: number;
      creator_share_usd?: number;
      platform_compute_fee_usd?: number;
      platform_royalty_fee_usd?: number;
      platform_total_usd?: number;
      royalty_rate?: number;
      // 阶段五 P4 · 性能读数（后端实测；缺省时前端回退本地计时）
      ttft_ms?: number;
      throughput_tps?: number;
      perf_source?: string;
    } | null,
  });

  // 加载模型目录
  useEffect(() => {
    let active = true;
    fetchModels()
      .then((res) => {
        if (!active) return;
        setModelsError(null);
        setModels(res.data);
        if (res.data.length > 0 && !res.data.some((m) => m.id === selectedModelId)) {
          setSelectedModelId(res.data[0].id);
        }
      })
      .catch((e) => {
        /* 模型目录不可用时给出可读提示，便于判断是网关还是密钥问题 */
        if (!active) return;
        setModelsError(describeCloudError(e));
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 思考链计时刷新
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setTick((t) => t + 1), 120);
    return () => clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    return () => {
      streamRef.current?.abort();
    };
  }, []);

  const activeModel = useMemo(
    () => models.find((m) => m.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );

  const lastPrompt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return '你好，请介绍一下 APIPaw 去中心化算力网络';
  }, [messages]);

  // ----------------- 阶段五 P1 · 本次预计花费 -----------------
  // 按「当前输入内容 + 系统提示词 + 当前模型单价」实时估算本次开销，
  // 让买家在按下发送之前就知道这一单大概要花多少钱。
  //
  // 口径（与后端 settle_cost 对齐）：
  //   算力费 = 输入 tok/1000×输入单价 + 输出 tok/1000×输出单价
  //   场景 B：买家实付 = 算力费 × (1 + 版税率)；场景 A：无版税。
  const costPreview = useMemo(() => {
    const model = activeModel;
    if (!model) return null;
    const sys = systemPrompt.trim();
    const billingText = sys ? `${sys}\n${input}` : input;
    // 空输入时按一个占位词估算，避免显示 $0.00 造成"免费"的错觉
    const promptTokens = estimateTokens(billingText || '你好');
    // 输出 token：优先用上一轮实际值，没有历史就用 256 的保守估计
    let completionTokens = 256;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const stats = messages[i].stats;
      if (stats && stats.completionTokens > 0) {
        completionTokens = stats.completionTokens;
        break;
      }
    }
    completionTokens = Math.min(completionTokens, maxTokens);
    const computeUsd =
      (promptTokens / 1000.0) * model.pricing.prompt_per_1k_usd +
      (completionTokens / 1000.0) * model.pricing.completion_per_1k_usd;
    const rate = royaltyRateOf(model);
    const royaltyUsd = computeUsd * rate;
    const totalUsd = computeUsd + royaltyUsd;
    return {
      promptTokens,
      completionTokens,
      computeUsd,
      royaltyUsd,
      totalUsd,
      rate,
      scenario: scenarioOf(model),
      cgas: totalUsd * (model.pricing.usd_to_cgas || 100),
    };
  }, [activeModel, input, systemPrompt, maxTokens, messages]);

  // ----------------- 代码导出 -----------------

  const codeSnippets = useMemo(() => {
    const model = selectedModelId;
    // 阶段五 P0：导出代码必须与界面上的实际参数一致，否则用户复制出去就跑偏
    // 阶段五 P3：再往前推一步 —— 导出的是**当前实时状态**：
    //   当前输入框内容（有输入用输入框，没输入才回落到上一条已发送的消息）、
    //   当前模型、四个采样参数、System Prompt、以及**流式开关**。
    const system = systemPrompt.trim();
    const prompt = input.trim() || lastPrompt;
    const exportMessages = system
      ? [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'user', content: prompt }];

    const payload = JSON.stringify(
      {
        model,
        messages: exportMessages,
        stream: streamEnabled,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
      },
      null,
      2,
    );
    const base = `${CLOUD_BASE_URL}/v1`;

    // 流式开关关闭时，示例代码也必须**一次性返回** —— 复制出去跑出来的行为
    // 与界面上看到的一致（否则用户会拿到一段会打印半截就结束的示例）。
    const curl = streamEnabled
      ? `curl -N ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $APIPAW_API_KEY" \\
  -d '${payload.replace(/\n\s*/g, ' ')}'`
      : `curl ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $APIPAW_API_KEY" \\
  -d '${payload.replace(/\n\s*/g, ' ')}'`;

    const python = streamEnabled
      ? `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="paw-sk-xxxxxx",  # 你的 APIPaw API Key
)

stream = client.chat.completions.create(
    model="${model}",
    messages=${JSON.stringify(exportMessages, null, 4).replace(/\n/g, '\n    ')},
    stream=True,
    temperature=${temperature},
    top_p=${topP},
    max_tokens=${maxTokens},
)

for chunk in stream:
    delta = chunk.choices[0].delta
    # deepseek-r1 等推理模型的思考链位于 reasoning_content
    if delta.reasoning_content:
        print(delta.reasoning_content, end="", flush=True)
    if delta.content:
        print(delta.content, end="", flush=True)`
      : `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="paw-sk-xxxxxx",  # 你的 APIPaw API Key
)

response = client.chat.completions.create(
    model="${model}",
    messages=${JSON.stringify(exportMessages, null, 4).replace(/\n/g, '\n    ')},
    stream=False,
    temperature=${temperature},
    top_p=${topP},
    max_tokens=${maxTokens},
)

print(response.choices[0].message.content)`;

    const javascript = streamEnabled
      ? `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: process.env.APIPAW_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: ${JSON.stringify(exportMessages, null, 2).replace(/\n/g, '\n  ')},
  stream: true,
  temperature: ${temperature},
  top_p: ${topP},
  max_tokens: ${maxTokens},
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.reasoning_content) process.stdout.write(delta.reasoning_content);
  if (delta?.content) process.stdout.write(delta.content);
}`
      : `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: process.env.APIPAW_API_KEY,
});

const response = await client.chat.completions.create({
  model: "${model}",
  messages: ${JSON.stringify(exportMessages, null, 2).replace(/\n/g, '\n  ')},
  stream: false,
  temperature: ${temperature},
  top_p: ${topP},
  max_tokens: ${maxTokens},
});

console.log(response.choices[0].message.content);`;

    return { curl, python, javascript } as Record<ExporterTab, string>;
  }, [selectedModelId, lastPrompt, input, temperature, topP, maxTokens, systemPrompt, streamEnabled]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(codeSnippets[exporterTab]);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [codeSnippets, exporterTab]);

  // ----------------- 发起推理 -----------------

  const finalizeRun = useCallback((botId: string) => {
    const run = runRef.current;
    const endedAt = Date.now();
    const localTtftMs = run.firstTokenAt ? run.firstTokenAt - run.startedAt : endedAt - run.startedAt;
    const generationMs = run.firstTokenAt ? endedAt - run.firstTokenAt : 0;
    const completionTokens = run.usage?.completion_tokens ?? estimateTokens('x'.repeat(run.contentChars));
    // 极端情况下（首字与结束同毫秒）generationMs 会是 0 → 退回整段耗时，
    // 否则吐字速度会显示 0.0，给用户「没跑起来」的错觉。
    const effectiveMs = generationMs > 0 ? generationMs : Math.max(1, endedAt - run.startedAt);
    const localTokensPerSec = completionTokens / (effectiveMs / 1000);
    const usage = run.usage;

    // 阶段五 P4 · 模块 C（决策 D9）：**后端实测优先，缺省时回退本地计时**。
    // 后端值来自真实节点的分片时序 —— 跨设备可比、可回溯；
    // 老网关（不下发这两个字段）或模拟回答（后端记 0 = 无意义）⇒ 用本地计时。
    const backendTtftMs =
      typeof usage?.ttft_ms === 'number' && usage.ttft_ms > 0 ? usage.ttft_ms : 0;
    const backendTokensPerSec =
      typeof usage?.throughput_tps === 'number' && usage.throughput_tps > 0 ? usage.throughput_tps : 0;
    const ttftMs = backendTtftMs > 0 ? backendTtftMs : localTtftMs;
    const tokensPerSec = backendTokensPerSec > 0 ? backendTokensPerSec : localTokensPerSec;
    const perfSource = backendTtftMs > 0 || backendTokensPerSec > 0 ? 'node' : 'local';

    // 阶段五 P2 · v2 明细优先、老网关回落旧字段（字段缺失时前端自己兜底）
    const baseComputeUsd =
      usage?.p_compute_usd ??
      usage?.base_compute_usd ??
      (usage ? Math.max(0, usage.cost_usd - (usage.creator_royalty_usd ?? 0)) : 0);
    const royaltyPoolUsd = usage?.p_royalty_usd ?? usage?.creator_royalty_usd ?? 0;
    const creatorShareUsd = usage?.creator_share_usd ?? usage?.creator_royalty_usd ?? 0;
    const nodeShareUsd = usage?.node_share_usd ?? usage?.node_earn_usd ?? 0;
    const platformTotalUsd = usage?.platform_total_usd ?? usage?.platform_fee_usd ?? 0;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === botId
          ? {
              ...m,
              reasoningEndedAt: run.reasoningStartedAt ? endedAt : undefined,
              answerSource: usage?.answer_source ?? m.answerSource,
              stats: {
                ttftMs,
                tokensPerSec,
                costUsd: usage?.cost_usd ?? 0,
                cgas: usage?.cgas ?? 0,
                promptTokens: usage?.prompt_tokens ?? 0,
                completionTokens,
                totalTokens:
                  usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + completionTokens,
                // 费用拆解：后端直接下发算力基价；老网关没这个字段时用「实付 - 版税」反推
                baseComputeUsd,
                nodeEarnUsd: nodeShareUsd,
                creatorRoyaltyUsd: creatorShareUsd,
                platformFeeUsd: platformTotalUsd,
                royaltyPoolUsd,
                creatorShareUsd,
                platformTotalUsd,
                answerSource: usage?.answer_source ?? m.answerSource,
                perfSource,
              },
            }
          : m,
      ),
    );
    setStreaming(false);
    streamRef.current = null;
  }, []);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;

    const botId = `a-${Date.now()}`;
    const history = messages
      .filter((m) => m.role === 'user')
      .map((m) => ({ role: 'user' as const, content: m.content }));

    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: text },
      { id: botId, role: 'assistant', content: '', reasoning: '' },
    ]);
    setInput('');
    setStreaming(true);

    runRef.current = {
      startedAt: Date.now(),
      firstTokenAt: 0,
      reasoningStartedAt: 0,
      contentChars: 0,
      usage: null,
    };

    if (!streamEnabled) {
      // 阶段五 P3 · 流式开关关闭 → 走**非流式**一次性请求。
      // 导出代码里的 stream 也是 false ⇒ 界面与复制出去的代码行为一致。
      chatOnce({
        model: selectedModelId,
        messages: [...history, { role: 'user', content: text }],
        temperature,
        topP,
        maxTokens,
        systemPrompt,
      })
        .then((res) => {
          const run = runRef.current;
          run.firstTokenAt = Date.now();
          run.contentChars = res.content.length;
          run.usage = res.usage;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === botId ? { ...m, content: res.content, reasoning: res.reasoning } : m,
            ),
          );
          finalizeRun(botId);
        })
        .catch((e) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === botId ? { ...m, error: describeCloudError(e) } : m)),
          );
          setStreaming(false);
          streamRef.current = null;
        });
      return;
    }

    const handle = streamChat({
      model: selectedModelId,
      messages: [...history, { role: 'user', content: text }],
      // 阶段五 P0：采样参数 + 系统提示词真正下发到网关
      temperature,
      topP,
      maxTokens,
      systemPrompt,
      // 阶段五 P2 · D8：响应头 X-APIPaw-Dispatch 到达即知来源 → 立刻点亮徽标
      onDispatch: (mode) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === botId ? { ...m, answerSource: mode } : m)),
        );
      },
      onReasoning: (delta) => {
        const run = runRef.current;
        if (!run.firstTokenAt) run.firstTokenAt = Date.now();
        if (!run.reasoningStartedAt) run.reasoningStartedAt = Date.now();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botId
              ? {
                  ...m,
                  reasoning: (m.reasoning ?? '') + delta,
                  reasoningStartedAt: m.reasoningStartedAt ?? run.reasoningStartedAt,
                }
              : m,
          ),
        );
      },
      onContent: (delta) => {
        const run = runRef.current;
        if (!run.firstTokenAt) run.firstTokenAt = Date.now();
        run.contentChars += delta.length;
        setMessages((prev) =>
          prev.map((m) => (m.id === botId ? { ...m, content: m.content + delta } : m)),
        );
      },
      onUsage: (usage) => {
        runRef.current.usage = usage;
      },
      onDone: () => {
        finalizeRun(botId);
      },
      onError: (message) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === botId ? { ...m, error: message } : m)),
        );
        setStreaming(false);
        streamRef.current = null;
      },
    });

    streamRef.current = handle;
  }, [input, messages, streaming, selectedModelId, temperature, topP, maxTokens, systemPrompt, streamEnabled]);

  const handleStop = () => {
    streamRef.current?.abort();
    streamRef.current = null;
    setStreaming(false);
  };

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : '';

  // ----------------- 阶段五 P2 · D9：流式性能实时刷新 -----------------
  // TTFT 与 tok/s 都是**前端本地计时**：请求发出 → 第一个有效 delta 为 TTFT，
  // 之后按已产出字符估算流式 tok/s，随流推进实时跳动（流结束后由后端 usage 校准）。
  useEffect(() => {
    if (!streaming) return;
    const run = runRef.current;
    const now = Date.now();
    const ttftMs = run.firstTokenAt ? run.firstTokenAt - run.startedAt : now - run.startedAt;
    const genMs = run.firstTokenAt ? now - run.firstTokenAt : 0;
    const completionTokens = estimateTokens('x'.repeat(run.contentChars));
    const tokensPerSec = genMs > 0 ? completionTokens / (genMs / 1000) : 0;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === lastMessageId && (!m.stats || m.stats.partial)
          ? {
              ...m,
              stats: {
                ttftMs,
                tokensPerSec,
                costUsd: 0,
                cgas: 0,
                promptTokens: 0,
                completionTokens,
                totalTokens: completionTokens,
                baseComputeUsd: 0,
                nodeEarnUsd: 0,
                creatorRoyaltyUsd: 0,
                platformFeeUsd: 0,
                royaltyPoolUsd: 0,
                creatorShareUsd: 0,
                platformTotalUsd: 0,
                // 流式过程中还没有后端实测值 ⇒ 明确标成「本地计时」
                perfSource: 'local',
                partial: true,
              },
            }
          : m,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, streaming, lastMessageId]);

  return (
    <View style={styles.card} testID="playground-card" id="apx-glass-playground">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>掌上 Playground 试炼场</Text>
        </View>
        <TouchableOpacity
          style={styles.exportBtn}
          id="apx-glow-export"
          onPress={() => setExporterOpen(true)}
          activeOpacity={0.75}
          testID="playground-export-open"
        >
          <Text style={styles.exportBtnText}>导出代码</Text>
        </TouchableOpacity>
      </View>

      {/* 模型选择器 */}
      <TouchableOpacity
        style={styles.modelSelector}
        onPress={() => setPickerOpen(true)}
        activeOpacity={0.75}
        disabled={modelsLoading}
      >
        <View style={styles.modelSelectorLeft}>
          <Text style={styles.modelSelectorLabel}>推理模型</Text>
          <Text style={styles.modelSelectorValue} id="apx-model-selector-value">
            {modelsLoading
              ? '加载中...'
              : activeModel
                ? activeModel.display_name
                : modelsError
                  ? '模型目录不可用'
                  : '未选择模型'}
          </Text>
        </View>
        <View style={styles.modelSelectorRight}>
          {activeModel && (
            <View
              style={[
                styles.scenarioBadge,
                scenarioOf(activeModel) === 'B' ? styles.scenarioBadgeB : styles.scenarioBadgeA,
              ]}
              testID="playground-scenario-badge"
            >
              <Text style={styles.scenarioBadgeText}>
                {scenarioOf(activeModel) === 'B'
                  ? `场景B · 版税 ${(royaltyRateOf(activeModel) * 100).toFixed(0)}%`
                  : '场景A · 开源基础'}
              </Text>
            </View>
          )}
          {activeModel && (
            <View style={[styles.tierBadge, activeModel.tier === 'CREATOR' ? styles.tierBadgeCreator : styles.tierBadgeBase]}>
              <Text style={styles.tierBadgeText}>
                {activeModel.tier === 'CREATOR' ? '社区创作者' : '开源基础'}
              </Text>
            </View>
          )}
          <Text style={styles.modelSelectorChevron}>▾</Text>
        </View>
      </TouchableOpacity>

      {modelsError && (
        <Text style={styles.modelsError}>⚠️ {modelsError}</Text>
      )}

      {activeModel && (
        <Text style={styles.modelMeta} id="apx-model-meta">
          {SCENARIO_LABEL[scenarioOf(activeModel)]} · {activeModel.description} ·
          输入 ${activeModel.pricing.prompt_per_1k_usd}/1K ·
          输出 ${activeModel.pricing.completion_per_1k_usd}/1K · 上下文 {activeModel.context_window}
        </Text>
      )}

      {/* 阶段五 P1 · 本次预计花费（按当前输入 + 当前模型单价实时估算） */}
      {activeModel && costPreview && (
        <View style={styles.costPreviewRow} testID="playground-cost-preview">
          <Text style={styles.costPreviewLabel}>本次预计花费</Text>
          <Text style={styles.costPreviewValue} testID="playground-cost-preview-value">
            ≈ ${costPreview.totalUsd.toFixed(6)} / {costPreview.cgas.toFixed(2)} CGas
          </Text>
          <Text style={styles.costPreviewDetail} testID="playground-cost-preview-detail">
            输入 {costPreview.promptTokens} tok · 输出 ~{costPreview.completionTokens} tok ·
            算力 ${costPreview.computeUsd.toFixed(6)}
            {costPreview.rate > 0
              ? ` · 版税 ${(costPreview.rate * 100).toFixed(0)}% $${costPreview.royaltyUsd.toFixed(6)}`
              : ' · 无版税'}
          </Text>
        </View>
      )}

      {/* 阶段五 P0 · 采样参数面板
          此前 Playground 只能选模型，采样参数一概不可调 —— 即便调了也不会生效
          （后端既不接收 top_p，也从不下发任何采样参数）。 */}
      <View style={styles.paramsBar}>
        <TouchableOpacity
          style={styles.paramsToggle}
          onPress={() => setParamsOpen((v) => !v)}
          activeOpacity={0.75}
          testID="playground-params-toggle"
        >
          <Text style={styles.paramsToggleText}>
            {paramsOpen ? '▾ 采样参数' : '▸ 采样参数'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.paramsSummary} testID="playground-params-summary">
          T={temperature.toFixed(2)} · top_p={topP.toFixed(2)} · max={maxTokens}
          {systemPrompt.trim() ? ' · system✓' : ''}
        </Text>
      </View>

      {paramsOpen && (
        <View style={styles.paramsPanel} testID="playground-params-panel">
          <Slider
            label="Temperature（随机性）"
            value={temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={setTemperature}
            formatValue={(v) => v.toFixed(2)}
            hint="越高越发散，0 最确定"
            scaleLabels={['0', '2.0']}
            testID="pg-temp-slider"
            trackTestID="pg-temp-track"
            thumbTestID="pg-temp-thumb"
          />
          <Slider
            label="Top-P（核采样）"
            value={topP}
            min={0.05}
            max={1}
            step={0.05}
            onChange={setTopP}
            formatValue={(v) => v.toFixed(2)}
            hint="只从累计概率前 P 的候选词中采样"
            scaleLabels={['0.05', '1.0']}
            testID="pg-topp-slider"
            trackTestID="pg-topp-track"
            thumbTestID="pg-topp-thumb"
          />
          <Slider
            label="Max Tokens（生成长度上限）"
            value={maxTokens}
            min={128}
            max={8192}
            step={128}
            onChange={setMaxTokens}
            formatValue={(v) => `${v}`}
            hint="单次回复的最大 Token 数"
            scaleLabels={['128', '8192']}
            testID="pg-maxtokens-slider"
            trackTestID="pg-maxtokens-track"
            thumbTestID="pg-maxtokens-thumb"
          />
          <Text style={styles.paramsLabel}>System Prompt（系统提示词）</Text>
          <TextInput
            style={styles.systemInput}
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder="可选，例如：你是一个严谨的分布式系统导师"
            placeholderTextColor={colors.textSecondary}
            multiline
            testID="pg-system-input"
          />
          {/* 阶段五 P3 · 流式开关 —— 关掉后走**非流式**一次性请求，
              导出代码里的 stream 也随之变成 false（复制出去就能跑出同样结果）。 */}
          <TouchableOpacity
            style={styles.streamRow}
            onPress={() => setStreamEnabled((v) => !v)}
            activeOpacity={0.75}
            testID="pg-stream-toggle"
          >
            <View style={[styles.streamBox, streamEnabled && styles.streamBoxOn]}>
              <Text style={[styles.streamBoxText, streamEnabled && styles.streamBoxTextOn]}>
                {streamEnabled ? '✓' : ''}
              </Text>
            </View>
            <Text style={styles.paramsLabel}>流式输出（关闭则一次性返回）</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* 对话区 —— 视觉上是一台真实终端（内阴影 + 顶部高光条）*/}
      <View style={styles.conversation} id="apx-term">
        <View style={styles.termBar} id="apx-term-bar">
          <View style={styles.termDots}>
            <View style={[styles.termDot, { backgroundColor: colors.danger }]} />
            <View style={[styles.termDot, { backgroundColor: colors.warn }]} />
            <View style={[styles.termDot, { backgroundColor: colors.accent }]} />
          </View>
          <Text style={styles.termLabel}>apipaw://playground — streaming session</Text>
        </View>
        <ScrollView
          style={styles.conversationScroll}
          contentContainerStyle={styles.conversationContent}
          nestedScrollEnabled
        >
          {messages.length === 0 && (
            <View style={styles.emptyHint}>
              <Text style={styles.emptyHintTitle}>终端待命</Text>
              <Text style={styles.emptyHintText} id="apx-term-hint">
                选择模型后输入 Prompt，即可体验流式推理与思考链展示。
              </Text>
            </View>
          )}

          {messages.map((message) => {
            if (message.role === 'user') {
              return (
                <View key={message.id} style={styles.userBubble}>
                  <Text style={styles.userBubbleText}>{message.content}</Text>
                </View>
              );
            }

            const isLive = streaming && message.id === lastMessageId;
            const elapsed =
              message.reasoningStartedAt && message.reasoningEndedAt
                ? message.reasoningEndedAt - message.reasoningStartedAt
                : message.reasoningStartedAt
                  ? Date.now() - message.reasoningStartedAt
                  : 0;

            const sourceMeta = sourceMetaOf(message.answerSource);

            return (
              <View key={message.id} style={styles.assistantBlock}>
                {sourceMeta ? (
                  <View style={styles.answerSourceRow}>
                    <View
                      style={[
                        styles.sourceBadge,
                        { borderColor: `${sourceMeta.color}66`, backgroundColor: `${sourceMeta.color}14` },
                      ]}
                      testID="playground-answer-source"
                    >
                      <Text style={[styles.sourceBadgeText, { color: sourceMeta.color }]}>
                        {sourceMeta.label}
                      </Text>
                    </View>
                    <Text style={styles.answerSourceHint}>
                      {sourceMeta.label === '真实节点'
                        ? '由去中心化节点实际推理产生'
                        : '由平台模拟生成，未经过真实节点'}
                    </Text>
                  </View>
                ) : null}

                {message.reasoning ? (
                  <ReasoningCard
                    text={message.reasoning}
                    live={isLive && !message.content}
                    elapsedMs={elapsed}
                    onToggle={() => undefined}
                    sourceLabel={sourceMeta?.label}
                    sourceColor={sourceMeta?.color}
                  />
                ) : null}

                {message.error ? <Text style={styles.errorText}>⚠️ {message.error}</Text> : null}

                {message.content ? (
                  <Text style={styles.answerText}>
                    {message.content}
                    {isLive ? <Text style={styles.cursor}>▋</Text> : null}
                  </Text>
                ) : null}

                {message.stats ? <StatsBar stats={message.stats} /> : null}
              </View>
            );
          })}
        </ScrollView>
      </View>

      {/* 输入区 */}
      <View style={styles.inputRow}>
        <TextInput
          id="apx-playground-input"
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="输入 Prompt，例如：解释一下 DePIN 的结算规则"
          placeholderTextColor={colors.textSecondary}
          multiline
          editable={!streaming}
          onSubmitEditing={handleSend}
        />
        {streaming ? (
          <TouchableOpacity style={[styles.sendBtn, styles.stopBtn]} onPress={handleStop}>
            <Text style={styles.sendBtnText}>停止</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
            id={input.trim() ? 'apx-send-btn' : 'apx-send-btn apx-send-disabled'}
            onPress={handleSend}
            disabled={!input.trim()}
            testID="playground-send"
          >
            <Text style={styles.sendBtnText}>发送</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 模型下拉 Modal */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <TouchableOpacity style={styles.pickerSheet} activeOpacity={1}>
            <Text style={styles.modalTitle}>选择推理模型</Text>
            {models.map((model) => (
              <TouchableOpacity
                key={model.id}
                testID={`playground-model-item-${model.id}`}
                style={[
                  styles.pickerItem,
                  model.id === selectedModelId && styles.pickerItemActive,
                ]}
                onPress={() => {
                  // 阶段五 P1：切换模型**保留会话与参数状态**（只换 model_id）
                  setSelectedModelId(model.id);
                  setPickerOpen(false);
                }}
              >
                <View style={styles.pickerItemLeft}>
                  <Text style={styles.pickerItemTitle}>{model.display_name}</Text>
                  <Text style={styles.pickerItemDesc}>
                    {SCENARIO_LABEL[scenarioOf(model)]}
                    {scenarioOf(model) === 'B'
                      ? ` · 版税 ${(royaltyRateOf(model) * 100).toFixed(0)}%`
                      : ''}
                    {' · '}
                    {model.description}
                  </Text>
                </View>
                <View style={styles.pickerItemRight}>
                  <View
                    style={[
                      styles.tierBadge,
                      model.tier === 'CREATOR' ? styles.tierBadgeCreator : styles.tierBadgeBase,
                    ]}
                  >
                    <Text style={styles.tierBadgeText}>
                      {model.tier === 'CREATOR' ? '创作者' : '基础'}
                    </Text>
                  </View>
                  {model.id === selectedModelId ? <Text style={styles.pickerCheck}>✓</Text> : null}
                </View>
              </TouchableOpacity>
            ))}
            {models.length === 0 && (
              <View style={styles.pickerEmpty}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.pickerItemDesc}>模型目录加载中或网关未启动</Text>
              </View>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* 代码导出 Modal */}
      <Modal visible={exporterOpen} transparent animationType="slide" onRequestClose={() => setExporterOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.exporterSheet}>
            <View style={styles.exporterHeader}>
              <Text style={styles.modalTitle}>一键代码导出器</Text>
              <TouchableOpacity onPress={() => setExporterOpen(false)} testID="playground-export-close">
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.tabRow}>
              {(
                [
                  { key: 'curl', label: 'cURL' },
                  { key: 'python', label: 'Python' },
                  { key: 'javascript', label: 'JavaScript' },
                ] as Array<{ key: ExporterTab; label: string }>
              ).map((tab) => (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.tab, exporterTab === tab.key && styles.tabActive]}
                  onPress={() => {
                    setExporterTab(tab.key);
                    // 切 tab 时清掉"已复制"提示 —— 否则会把上一段代码的复制反馈
                    // 错认成当前这段（这正是"状态化"最容易被抓到的小 bug）。
                    setCopied(false);
                  }}
                  testID={`playground-export-tab-${tab.key}`}
                >
                  <Text style={[styles.tabText, exporterTab === tab.key && styles.tabTextActive]}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <ScrollView style={styles.codeScroll} contentContainerStyle={styles.codeContent}>
              <Text style={styles.codeText} testID="playground-export-code">
                {codeSnippets[exporterTab]}
              </Text>
            </ScrollView>

            <TouchableOpacity style={styles.copyBtn} onPress={handleCopy} testID="playground-export-copy">
              <Text style={styles.copyBtnText} testID="playground-export-copy-state">
                {copied ? '✓ 已复制到剪贴板' : '📋 一键复制'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.cyan,
    shadowColor: colors.cyan,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.title,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  exportBtn: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  exportBtnText: {
    color: colors.purple,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },

  modelSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  modelSelectorLeft: { flex: 1 },
  modelSelectorLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginBottom: 2,
  },
  modelSelectorValue: {
    color: colors.textPrimary,
    fontSize: fontSize.title,
    fontWeight: '700',
  },
  modelSelectorRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  modelSelectorChevron: { color: colors.textSecondary, fontSize: fontSize.lg },
  tierBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  tierBadgeBase: { backgroundColor: 'rgba(59, 130, 246, 0.18)' },
  tierBadgeCreator: { backgroundColor: colors.warnSoft },
  tierBadgeText: { color: colors.textBody, fontSize: fontSize.sm, fontWeight: '700' },
  // 阶段五 P1 · 场景徽标（A 开源基础 / B 社区创作者 + 版税率）
  scenarioBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginRight: spacing.xs,
  },
  scenarioBadgeA: { backgroundColor: colors.cyanSoft },
  scenarioBadgeB: { backgroundColor: colors.purpleSoft },
  scenarioBadgeText: { color: colors.textBody, fontSize: fontSize.sm, fontWeight: '700' },
  modelMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    marginTop: spacing.sm,
  },
  // 阶段五 P1 · 本次预计花费
  costPreviewRow: {
    marginTop: spacing.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  costPreviewLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  costPreviewValue: {
    color: colors.accent,
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginTop: 2,
  },
  costPreviewDetail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  modelsError: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.xs },

  conversation: {
    marginTop: spacing.md,
    backgroundColor: colors.bgDeep,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    height: 340,
    overflow: 'hidden',
  },
  termBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  termDots: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  termDot: { width: 8, height: 8, borderRadius: 4, opacity: 0.85 },
  termLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontFamily: 'monospace',
    letterSpacing: 0.4,
  },
  conversationScroll: { flex: 1 },
  conversationContent: { padding: spacing.md, gap: spacing.md },
  emptyHint: { paddingVertical: spacing.xl, alignItems: 'center', gap: 6 },
  emptyHintTitle: {
    color: colors.cyan,
    fontSize: fontSize.lg,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  emptyHintText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    lineHeight: 20,
  },

  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: 'rgba(139, 92, 246, 0.18)',
    borderRadius: radius.md,
    borderBottomRightRadius: 4,
    padding: spacing.md,
  },
  userBubbleText: { color: colors.textPrimary, fontSize: fontSize.lg, lineHeight: 24 },

  assistantBlock: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
    gap: spacing.sm,
  },
  answerText: { color: colors.textBody, fontSize: fontSize.lg, lineHeight: 25 },
  cursor: { color: colors.accent },
  errorText: { color: colors.danger, fontSize: fontSize.md, lineHeight: 21 },

  reasonCard: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.45)',
    overflow: 'hidden',
  },
  reasonHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  reasonHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: spacing.sm },
  reasonHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  reasonCopyBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardAlt,
  },
  reasonCopyText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  // 阶段五 P2 · D8：来源徽标
  sourceBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  sourceBadgeText: { fontSize: fontSize.xs, fontWeight: '700' },
  answerSourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  answerSourceHint: { color: colors.textMuted, fontSize: fontSize.xs, flexShrink: 1 },

  reasonIcon: { fontSize: fontSize.md },
  reasonTitle: { color: colors.purple, fontSize: fontSize.md, fontWeight: '700', flexShrink: 1 },
  reasonTitleLive: { color: colors.warn },
  reasonChevron: { color: colors.textSecondary, fontSize: fontSize.md, marginLeft: spacing.sm },
  reasonBody: { overflow: 'hidden', paddingHorizontal: spacing.md },
  reasonText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
    paddingBottom: spacing.md,
  },

  statsBar: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingBottom: spacing.xs,
  },
  statRow: { flexDirection: 'row', alignItems: 'center' },
  statItem: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, height: 26, backgroundColor: colors.divider },
  statLabel: { color: colors.textSecondary, fontSize: fontSize.xs, marginBottom: 3 },
  statValue: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  statValueAccent: { color: colors.accent },

  // 阶段五 P2 · D9：TTFT / 吐字速度 / 总 token 三块 StatTile
  statTilesRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  statTileWrap: { flex: 1 },
  breakdownTotal: {
    color: colors.textPrimary,
    fontWeight: '700',
    marginTop: 3,
  },

  // 阶段五 P0 · 费用拆解行
  breakdownRow: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  breakdownTitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    marginBottom: 3,
  },
  breakdownItem: { color: colors.textSecondary, fontSize: fontSize.xs, lineHeight: 16 },

  // 阶段五 P0 · 采样参数面板
  paramsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  paramsToggle: { paddingVertical: 2, paddingRight: spacing.sm },
  paramsToggleText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  paramsSummary: { color: colors.textMuted, fontSize: fontSize.xs },
  paramsPanel: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    gap: spacing.md,
  },
  paramsLabel: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  // 阶段五 P3 · 流式开关
  streamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  streamBox: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streamBoxOn: { borderColor: colors.accent, backgroundColor: `${colors.accent}22` },
  streamBoxText: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '700' },
  streamBoxTextOn: { color: colors.accent },
  systemInput: {
    minHeight: 64,
    maxHeight: 140,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    textAlignVertical: 'top',
  },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.lg,
  },
  sendBtn: {
    height: 44,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.textMuted },
  stopBtn: { backgroundColor: colors.dangerDark },
  sendBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: fontSize.md, letterSpacing: 0.5 },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  pickerSheet: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '78%',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '700' },
  modalClose: { color: colors.textSecondary, fontSize: fontSize.lg, paddingHorizontal: spacing.sm },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    gap: spacing.md,
  },
  pickerItemActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  pickerItemLeft: { flex: 1 },
  pickerItemTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '700' },
  pickerItemDesc: { color: colors.textSecondary, fontSize: fontSize.sm, marginTop: 3 },
  pickerItemRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pickerCheck: { color: colors.accent, fontSize: fontSize.lg, fontWeight: '700' },
  pickerEmpty: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },

  exporterSheet: {
    width: '100%',
    maxWidth: 640,
    maxHeight: '84%',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  exporterHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  tabRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.cardAlt,
    borderWidth: 1,
    borderColor: colors.divider,
  },
  tabActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  tabText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  tabTextActive: { color: colors.accent },
  codeScroll: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    maxHeight: 340,
  },
  codeContent: { padding: spacing.md },
  codeText: {
    color: colors.textBody,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'monospace',
  },
  copyBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  copyBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: fontSize.md },
});

export default PlaygroundCard;
