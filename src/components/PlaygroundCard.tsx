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
  fetchModels,
  streamChat,
} from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';

// ----------------- 类型 -----------------

export interface RunStats {
  ttftMs: number;
  tokensPerSec: number;
  costUsd: number;
  cgas: number;
  promptTokens: number;
  completionTokens: number;
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

// ----------------- 思考链 (CoT) 卡片 -----------------

interface ReasoningCardProps {
  text: string;
  live: boolean;
  elapsedMs: number;
  onToggle: () => void;
}

const ReasoningCard: React.FC<ReasoningCardProps> = ({ text, live, elapsedMs, onToggle }) => {
  const [expanded, setExpanded] = useState(false);
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
        </View>
        <Text style={styles.reasonChevron}>{expanded ? '▾' : '▸'}</Text>
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
    <View style={styles.statItem}>
      <Text style={styles.statLabel}>首字延迟 TTFT</Text>
      <Text style={styles.statValue}>{formatMs(stats.ttftMs)}</Text>
    </View>
    <View style={styles.statDivider} />
    <View style={styles.statItem}>
      <Text style={styles.statLabel}>吐字速度</Text>
      <Text style={styles.statValue}>{stats.tokensPerSec.toFixed(1)} tok/s</Text>
    </View>
    <View style={styles.statDivider} />
    <View style={styles.statItem}>
      <Text style={styles.statLabel}>本次花费</Text>
      <Text style={[styles.statValue, styles.statValueAccent]}>
        ${stats.costUsd.toFixed(4)} / {stats.cgas.toFixed(1)} CGas
      </Text>
    </View>
  </View>
);

// ----------------- 主组件 -----------------

const PlaygroundCard: React.FC = () => {
  const { apiKey, selectedModelId, setSelectedModelId } = usePawStore();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [exporterOpen, setExporterOpen] = useState(false);
  const [exporterTab, setExporterTab] = useState<ExporterTab>('curl');
  const [copied, setCopied] = useState(false);

  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [, setTick] = useState(0);

  const streamRef = useRef<StreamChatHandle | null>(null);
  const runRef = useRef({
    startedAt: 0,
    firstTokenAt: 0,
    reasoningStartedAt: 0,
    contentChars: 0,
    usage: null as { completion_tokens: number; prompt_tokens: number; cost_usd: number; cgas: number } | null,
  });

  // 加载模型目录
  useEffect(() => {
    let active = true;
    fetchModels()
      .then((res) => {
        if (!active) return;
        setModels(res.data);
        if (res.data.length > 0 && !res.data.some((m) => m.id === selectedModelId)) {
          setSelectedModelId(res.data[0].id);
        }
      })
      .catch(() => {
        /* 模型目录不可用时下拉框将提示重试 */
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

  // ----------------- 代码导出 -----------------

  const codeSnippets = useMemo(() => {
    const model = selectedModelId;
    const payload = JSON.stringify(
      { model, messages: [{ role: 'user', content: lastPrompt }], stream: true },
      null,
      2,
    );
    const base = `${CLOUD_BASE_URL}/v1`;

    const curl = `curl -N ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $APIPAW_API_KEY" \\
  -d '${payload.replace(/\n\s*/g, ' ')}'`;

    const python = `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="paw-sk-xxxxxx",  # 你的 APIPaw API Key
)

stream = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "${lastPrompt.replace(/"/g, '\\"')}"}],
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta
    # deepseek-r1 等推理模型的思考链位于 reasoning_content
    if delta.reasoning_content:
        print(delta.reasoning_content, end="", flush=True)
    if delta.content:
        print(delta.content, end="", flush=True)`;

    const javascript = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: process.env.APIPAW_API_KEY,
});

const stream = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: ${JSON.stringify(lastPrompt)} }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.reasoning_content) process.stdout.write(delta.reasoning_content);
  if (delta?.content) process.stdout.write(delta.content);
}`;

    return { curl, python, javascript } as Record<ExporterTab, string>;
  }, [selectedModelId, lastPrompt]);

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
    const ttftMs = run.firstTokenAt ? run.firstTokenAt - run.startedAt : endedAt - run.startedAt;
    const generationMs = run.firstTokenAt ? endedAt - run.firstTokenAt : 0;
    const completionTokens = run.usage?.completion_tokens ?? estimateTokens('x'.repeat(run.contentChars));
    const tokensPerSec = generationMs > 0 ? completionTokens / (generationMs / 1000) : 0;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === botId
          ? {
              ...m,
              reasoningEndedAt: run.reasoningStartedAt ? endedAt : undefined,
              stats: {
                ttftMs,
                tokensPerSec,
                costUsd: run.usage?.cost_usd ?? 0,
                cgas: run.usage?.cgas ?? 0,
                promptTokens: run.usage?.prompt_tokens ?? 0,
                completionTokens,
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

    const handle = streamChat({
      model: selectedModelId,
      messages: [...history, { role: 'user', content: text }],
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
  }, [input, messages, streaming, selectedModelId]);

  const handleStop = () => {
    streamRef.current?.abort();
    streamRef.current = null;
    setStreaming(false);
  };

  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : '';

  return (
    <View style={styles.card} testID="playground-card">
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>🧪 掌上 Playground 试炼场</Text>
        <TouchableOpacity
          style={styles.exportBtn}
          onPress={() => setExporterOpen(true)}
          activeOpacity={0.75}
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
          <Text style={styles.modelSelectorValue}>
            {modelsLoading
              ? '加载中...'
              : activeModel
                ? activeModel.display_name
                : '未选择模型'}
          </Text>
        </View>
        <View style={styles.modelSelectorRight}>
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

      {activeModel && (
        <Text style={styles.modelMeta}>
          {activeModel.description} · 输入 ${activeModel.pricing.prompt_per_1k_usd}/1K ·
          输出 ${activeModel.pricing.completion_per_1k_usd}/1K · 上下文 {activeModel.context_window}
        </Text>
      )}

      {/* 对话区 */}
      <View style={styles.conversation}>
        <ScrollView
          style={styles.conversationScroll}
          contentContainerStyle={styles.conversationContent}
          nestedScrollEnabled
        >
          {messages.length === 0 && (
            <View style={styles.emptyHint}>
              <Text style={styles.emptyHintText}>
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

            return (
              <View key={message.id} style={styles.assistantBlock}>
                {message.reasoning ? (
                  <ReasoningCard
                    text={message.reasoning}
                    live={isLive && !message.content}
                    elapsedMs={elapsed}
                    onToggle={() => undefined}
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
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="输入 Prompt，例如：解释一下 DePIN 的结算规则"
          placeholderTextColor={colors.textMuted}
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
            onPress={handleSend}
            disabled={!input.trim()}
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
                style={[
                  styles.pickerItem,
                  model.id === selectedModelId && styles.pickerItemActive,
                ]}
                onPress={() => {
                  setSelectedModelId(model.id);
                  setPickerOpen(false);
                }}
              >
                <View style={styles.pickerItemLeft}>
                  <Text style={styles.pickerItemTitle}>{model.display_name}</Text>
                  <Text style={styles.pickerItemDesc}>{model.description}</Text>
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
              <TouchableOpacity onPress={() => setExporterOpen(false)}>
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
                  onPress={() => setExporterTab(tab.key)}
                >
                  <Text style={[styles.tabText, exporterTab === tab.key && styles.tabTextActive]}>
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <ScrollView style={styles.codeScroll} contentContainerStyle={styles.codeContent}>
              <Text style={styles.codeText}>{codeSnippets[exporterTab]}</Text>
            </ScrollView>

            <TouchableOpacity style={styles.copyBtn} onPress={handleCopy}>
              <Text style={styles.copyBtnText}>{copied ? '✓ 已复制到剪贴板' : '📋 一键复制'}</Text>
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
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
    fontWeight: 'bold',
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
    fontSize: fontSize.xs,
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
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginBottom: 2,
  },
  modelSelectorValue: {
    color: colors.textPrimary,
    fontSize: fontSize.lg,
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
  tierBadgeText: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '700' },
  modelMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: spacing.sm,
  },

  conversation: {
    marginTop: spacing.md,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    height: 320,
  },
  conversationScroll: { flex: 1 },
  conversationContent: { padding: spacing.md, gap: spacing.md },
  emptyHint: { paddingVertical: spacing.xl, alignItems: 'center' },
  emptyHintText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
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
  userBubbleText: { color: colors.textPrimary, fontSize: fontSize.md, lineHeight: 21 },

  assistantBlock: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
    gap: spacing.sm,
  },
  answerText: { color: colors.textBody, fontSize: fontSize.md, lineHeight: 22 },
  cursor: { color: colors.accent },
  errorText: { color: colors.danger, fontSize: fontSize.sm, lineHeight: 19 },

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
  reasonIcon: { fontSize: fontSize.md },
  reasonTitle: { color: colors.purple, fontSize: fontSize.sm, fontWeight: '700', flexShrink: 1 },
  reasonTitleLive: { color: colors.warn },
  reasonChevron: { color: colors.textSecondary, fontSize: fontSize.md, marginLeft: spacing.sm },
  reasonBody: { overflow: 'hidden', paddingHorizontal: spacing.md },
  reasonText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
    paddingBottom: spacing.md,
  },

  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingBottom: spacing.xs,
  },
  statItem: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, height: 26, backgroundColor: colors.divider },
  statLabel: { color: colors.textMuted, fontSize: 10, marginBottom: 3 },
  statValue: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '700' },
  statValueAccent: { color: colors.accent },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: fontSize.md,
  },
  sendBtn: {
    height: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.textMuted },
  stopBtn: { backgroundColor: colors.dangerDark },
  sendBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: fontSize.md },

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
  pickerItemTitle: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  pickerItemDesc: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 3 },
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
    fontSize: 11,
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
