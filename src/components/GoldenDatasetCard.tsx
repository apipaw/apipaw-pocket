import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  DatasetExportFormat,
  DatasetSummary,
  RlaifPair,
  RlaifRunResult,
  RlaifStats,
  RlaifTask,
  describeCloudError,
  exportDataset,
  fetchDatasetSummary,
  fetchRlaifTasks,
  runRlaif,
} from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 黄金 SFT/DPO **微调语料工坊**（阶段十二 P2 · OWNER 专属）。
 *
 * 数据来自 `feedback_samples` —— 买家在 Playground 的 👍/👎 打分（阶段十二 P1）：
 *   - 👍 有用 且回答非空 ⇒ 自动 `is_golden = 1` ⇒ 进 **SFT 黄金集**；
 *   - 👎 需改进 ⇒ 进 **负向池**（与同 prompt 的 👍 配对即可成 DPO 偏好对）。
 *
 * 四个一键下载：
 *   - **SFT**：`{"messages":[user, assistant], "meta":{...}}` 的 JSONL
 *     （OpenAI / ShareGPT 格式，LLaMA-Factory 可直接吃）；
 *   - **DPO**：`{"prompt","chosen","rejected","meta"}` 的 JSONL
 *     （Unsloth / LLaMA-Factory 的偏好对格式；阶段十三 P1 起**自动配对**，
 *     「高分/聚合采纳」当 chosen、「低分/未采纳」当 rejected）；
 *   - **Ollama Modelfile**（阶段十三 P1）：把黄金问答打成标准 Modelfile，
 *     `ollama create apipaw-custom -f Modelfile` 秒出进化版模型；
 *   - **LoRA 微调脚本**（阶段十三 P1）：Unsloth / HF TRL 单卡模板，
 *     自动对接导出的 `sft.jsonl`，并附 GGUF 导出指南。
 *
 * ⚠️ 语料里**不含**任何明文密钥：服务端落库前已把 `paw-sk-...` 之类打码。
 */
const GoldenDatasetCard: React.FC = () => {
  const [summary, setSummary] = useState<DatasetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<DatasetExportFormat | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 阶段十三 P1：基准模型（Modelfile 的 FROM 行 / LoRA 脚本的 BASE_MODEL）
  const [baseModel, setBaseModel] = useState('qwen2.5:0.5b');
  // 阶段十三 P1：生成物的预览弹窗
  const [preview, setPreview] = useState<{
    title: string;
    content: string;
    filename: string;
  } | null>(null);
  // 阶段十四 P2 · RLAIF 自动验算区
  const [rlaifTasks, setRlaifTasks] = useState<RlaifTask[]>([]);
  const [rlaifStats, setRlaifStats] = useState<RlaifStats | null>(null);
  const [rlaifRunning, setRlaifRunning] = useState(false);
  const [rlaifResult, setRlaifResult] = useState<RlaifRunResult | null>(null);
  const [rlaifError, setRlaifError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchDatasetSummary();
      setSummary(res);
      setError(null);
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 阶段十四 P2：读取 RLAIF 题库 + 历史自动验算统计（失败不影响语料概览）。 */
  const loadRlaif = useCallback(async () => {
    try {
      const res = await fetchRlaifTasks();
      setRlaifTasks(res.tasks ?? []);
      setRlaifStats(res.stats ?? null);
      setRlaifError(null);
    } catch (e: unknown) {
      setRlaifError(describeCloudError(e, 'session'));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRlaif();
  }, [load, loadRlaif]);

  /** 触发浏览器下载（Web 端用 Blob + a[download]） */
  const download = useCallback((content: string, filename: string) => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const blob = new Blob([content], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    }
    return false;
  }, []);

  const handleExport = useCallback(
    async (format: 'sft' | 'dpo') => {
      setBusy(format);
      setNotice(null);
      try {
        const content = await exportDataset(format);
        const lines = content.split('\n').filter((l) => l.trim()).length;
        const filename =
          format === 'sft' ? 'apipaw-golden-sft.jsonl' : 'apipaw-preference-dpo.jsonl';
        const saved = download(content, filename);
        if (saved) {
          setNotice(`✓ 已导出 ${lines} 条${format.toUpperCase()} 语料（${filename}）`);
        } else {
          // 原生端没有文件系统下载 ⇒ 复制到剪贴板，运维可自行取走
          await Clipboard.setStringAsync(content);
          setNotice(`✓ 已导出 ${lines} 条${format.toUpperCase()} 语料（已复制到剪贴板）`);
        }
        void load();
      } catch (e: unknown) {
        setError(describeCloudError(e, 'session'));
      } finally {
        setBusy(null);
      }
    },
    [download, load],
  );

  /** 阶段十三 P1：生成 Modelfile / LoRA 脚本 ⇒ 弹预览（可复制 / 下载）。 */
  const handleGenerate = useCallback(
    async (format: 'modelfile' | 'lora_script') => {
      setBusy(format);
      setNotice(null);
      try {
        const content = await exportDataset(format, baseModel.trim() || undefined);
        const filename =
          format === 'modelfile' ? 'apipaw-custom-Modelfile' : 'apipaw_lora_finetune.py';
        setPreview({
          title: format === 'modelfile' ? 'Ollama Modelfile 预览' : 'LoRA 微调脚本预览',
          content,
          filename,
        });
      } catch (e: unknown) {
        setError(describeCloudError(e, 'session'));
      } finally {
        setBusy(null);
      }
    },
    [baseModel],
  );

  const handlePreviewCopy = useCallback(async () => {
    if (!preview) return;
    await Clipboard.setStringAsync(preview.content);
    setNotice(`✓ ${preview.filename} 已复制到剪贴板`);
  }, [preview]);

  /**
   * 阶段十四 P2 · 一键 RLAIF 跑批。
   *
   * 网关侧：出题 → 双路候选 → 确定性判分 → 通过者 chosen（进黄金池）、
   * 未通过者 rejected（进负向池），同 prompt ⇒ 可直接导出 DPO 偏好对。
   * 跑批只新增语料，**不碰资金账本**。
   */
  const handleRlaifRun = useCallback(async () => {
    setRlaifRunning(true);
    setRlaifError(null);
    setNotice(null);
    try {
      const res = await runRlaif({});
      setRlaifResult(res);
      setNotice(
        `✓ RLAIF 跑批完成：${res.pairs_created} 组偏好对 · 通过率 ${(res.pass_rate * 100).toFixed(1)}%`,
      );
      // 跑批会让黄金池 / 负向池 / DPO 导出池一起变大 ⇒ 刷新计数
      void load();
      void loadRlaif();
    } catch (e: unknown) {
      setRlaifError(describeCloudError(e, 'session'));
    } finally {
      setRlaifRunning(false);
    }
  }, [load, loadRlaif]);

  const handlePreviewDownload = useCallback(() => {
    if (!preview) return;
    const saved = download(preview.content, preview.filename);
    if (saved) {
      setNotice(`✓ ${preview.filename} 已下载`);
      setPreview(null);
    } else {
      void handlePreviewCopy();
    }
  }, [download, handlePreviewCopy, preview]);

  const stats = summary;
  const models = stats?.models ?? [];

  return (
    <View style={styles.card} testID="golden-dataset-card" id="apx-glass-golden-dataset">
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>黄金微调语料工坊</Text>
        </View>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => void load()}
          activeOpacity={0.75}
          testID="golden-dataset-refresh"
        >
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.subtitle}>
        RLHF COLLECTED CORPUS · 👍 自动入黄金池 · 一键导出 SFT / DPO
      </Text>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在读取语料池…</Text>
        </View>
      ) : error ? (
        <Text style={styles.errorText}>⚠️ {error}</Text>
      ) : (
        <>
          <View style={styles.statGrid} testID="golden-dataset-stats">
            <View style={styles.statBox}>
              <Text style={styles.statValue} testID="golden-dataset-total">
                {stats?.total ?? 0}
              </Text>
              <Text style={styles.statLabel}>样本总数</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: colors.accent }]} testID="golden-dataset-golden">
                {stats?.golden ?? 0}
              </Text>
              <Text style={styles.statLabel}>👍 黄金样本</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: colors.danger }]} testID="golden-dataset-negative">
                {stats?.negative ?? 0}
              </Text>
              <Text style={styles.statLabel}>👎 负向样本</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={[styles.statValue, { color: colors.cyan }]}>{stats?.copied ?? 0}</Text>
              <Text style={styles.statLabel}>已复制采纳</Text>
            </View>
          </View>

          {models.length > 0 ? (
            <View style={styles.modelRow} testID="golden-dataset-models">
              {models.slice(0, 6).map((m) => (
                <View key={m.model_id} style={styles.modelChip}>
                  <Text style={styles.modelChipText}>
                    {m.model_id || '(未标注模型)'} · {m.count}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.exportBtn, busy === 'sft' && styles.btnDisabled]}
              onPress={() => void handleExport('sft')}
              disabled={busy !== null}
              activeOpacity={0.8}
              testID="golden-dataset-export-sft"
            >
              <Text style={styles.exportBtnText}>
                {busy === 'sft' ? '导出中…' : '⬇ 导出 SFT 黄金集'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.exportBtnAlt, busy === 'dpo' && styles.btnDisabled]}
              onPress={() => void handleExport('dpo')}
              disabled={busy !== null}
              activeOpacity={0.8}
              testID="golden-dataset-export-dpo"
            >
              <Text style={styles.exportBtnAltText}>
                {busy === 'dpo' ? '导出中…' : '⬇ 导出 DPO 偏好对'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* 阶段十三 P1 · 一键生成进化版模型物料 */}
          <View style={styles.evoHeader}>
            <Text style={styles.evoTitle}>🧬 一键生成进化版模型</Text>
            <Text style={styles.evoHint}>
              基准模型（Ollama 标签，如 qwen2.5:0.5b）
            </Text>
            <TextInput
              style={styles.baseModelInput}
              value={baseModel}
              onChangeText={setBaseModel}
              placeholder="qwen2.5:0.5b"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              testID="golden-dataset-base-model"
            />
          </View>
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.exportBtnAlt, busy === 'modelfile' && styles.btnDisabled]}
              onPress={() => void handleGenerate('modelfile')}
              disabled={busy !== null}
              activeOpacity={0.8}
              testID="golden-dataset-export-modelfile"
            >
              <Text style={styles.exportBtnAltText}>
                {busy === 'modelfile' ? '生成中…' : '🧬 生成 Ollama Modelfile'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.exportBtnAlt, busy === 'lora_script' && styles.btnDisabled]}
              onPress={() => void handleGenerate('lora_script')}
              disabled={busy !== null}
              activeOpacity={0.8}
              testID="golden-dataset-export-lora"
            >
              <Text style={styles.exportBtnAltText}>
                {busy === 'lora_script' ? '生成中…' : '🎓 导出 LoRA 微调脚本'}
              </Text>
            </TouchableOpacity>
          </View>

          {notice ? (
            <Text style={styles.noticeText} testID="golden-dataset-notice">
              {notice}
            </Text>
          ) : null}


          <Text style={styles.sectionTitle}>最近样本（最多 10 条）</Text>
          {(stats?.recent ?? []).length === 0 ? (
            <Text style={styles.emptyText} testID="golden-dataset-empty">
              还没有语料 —— 让买家在 Playground 给回答点个 👍，这里就会长出第一条黄金样本。
            </Text>
          ) : (
            (stats?.recent ?? []).map((row) => (
              <View key={row.id} style={styles.row} testID={`golden-dataset-row-${row.id}`}>
                <View style={styles.rowHead}>
                  <Text style={styles.rowTitle}>
                    {row.model_id || '(未标注模型)'} · {row.node_id || '未知节点'}
                  </Text>
                  <Text style={styles.rowBadge}>
                    {row.is_golden ? '👍 黄金' : row.rating === -1 ? '👎 负向' : '采纳'}
                  </Text>
                </View>
                <Text style={styles.rowPrompt} numberOfLines={2}>
                  问：{row.prompt_text || '(无原文)'}
                </Text>
                <Text style={styles.rowAnswer} numberOfLines={3}>
                  答：{row.completion_text || '(无原文)'}
                </Text>
              </View>
            ))
          )}
        </>
      )}

          {/* 阶段十四 P2 · RLAIF 自动验算与 DPO 自进化跑批 */}
          <View style={styles.rlaifBox} testID="golden-dataset-rlaif-panel">
            <View style={styles.rlaifHead}>
              <Text style={styles.rlaifTitle}>🤖 RLAIF 自动验算与 DPO 自进化跑批</Text>
              <Text style={styles.rlaifHint} testID="golden-dataset-rlaif-tasks">
                题库 {rlaifTasks.length} 道 · 历史跑批 {rlaifStats?.runs ?? 0} 次 ·
                通过率 {((rlaifStats?.pass_rate ?? 0) * 100).toFixed(1)}%
              </Text>
            </View>
            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.exportBtn, rlaifRunning && styles.btnDisabled]}
                onPress={() => void handleRlaifRun()}
                disabled={rlaifRunning}
                activeOpacity={0.8}
                testID="golden-dataset-rlaif-run"
              >
                <Text style={styles.exportBtnText}>
                  {rlaifRunning ? '跑批中…' : '🤖 运行 RLAIF 自动验算合成'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.exportBtnAlt, rlaifRunning && styles.btnDisabled]}
                onPress={() => void loadRlaif()}
                disabled={rlaifRunning}
                activeOpacity={0.8}
                testID="golden-dataset-rlaif-refresh"
              >
                <Text style={styles.exportBtnAltText}>↻ 刷新跑批状态</Text>
              </TouchableOpacity>
            </View>
            {rlaifError ? (
              <Text style={styles.errorText} testID="golden-dataset-rlaif-error">
                ⚠️ {rlaifError}
              </Text>
            ) : null}
            {rlaifResult ? (
              <View style={styles.rlaifResult} testID="golden-dataset-rlaif-result">
                <Text style={styles.rlaifResultLine}>
                  本次生成偏好对{' '}
                  <Text style={styles.rlaifResultValue} testID="golden-dataset-rlaif-pairs">
                    {rlaifResult.pairs_created}
                  </Text>{' '}
                  组 · 通过率{' '}
                  <Text style={styles.rlaifResultValue} testID="golden-dataset-rlaif-passrate">
                    {(rlaifResult.pass_rate * 100).toFixed(1)}%
                  </Text>
                </Text>
                {(rlaifResult.pairs ?? []).slice(0, 5).map((p: RlaifPair) => (
                  <View key={p.task_id} style={styles.rlaifPairRow} testID={`golden-dataset-rlaif-pair-${p.task_id}`}>
                    <Text style={styles.rlaifPairTitle}>
                      {p.task_id} · {p.title}
                    </Text>
                    <Text style={styles.rlaifPairChosen} numberOfLines={2}>
                      ✓ chosen：{p.chosen}
                    </Text>
                    <Text style={styles.rlaifPairRejected} numberOfLines={2}>
                      ✗ rejected：{p.rejected}
                    </Text>
                  </View>
                ))}
                {(rlaifResult.pairs ?? []).length > 5 ? (
                  <Text style={styles.emptyText}>
                    仅预览前 5 组，完整偏好对请用「⬇ 导出 DPO 偏好对」。
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>

      {/* 阶段十三 P1 · 生成物预览弹窗 */}
      <Modal
        visible={preview !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPreview(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="golden-dataset-preview-modal">
            <Text style={styles.modalTitle}>{preview?.title ?? ''}</Text>
            <Text style={styles.modalHint}>
              {preview?.filename} · {preview?.content.length ?? 0} 字符
            </Text>
            <ScrollView style={styles.previewBox} testID="golden-dataset-preview-body">
              <Text style={styles.previewText}>{preview?.content ?? ''}</Text>
            </ScrollView>
            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.exportBtnAlt}
                onPress={() => void handlePreviewCopy()}
                activeOpacity={0.8}
                testID="golden-dataset-preview-copy"
              >
                <Text style={styles.exportBtnAltText}>📋 复制全文</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.exportBtn}
                onPress={handlePreviewDownload}
                activeOpacity={0.8}
                testID="golden-dataset-preview-download"
              >
                <Text style={styles.exportBtnText}>⬇ 下载文件</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setPreview(null)}
              activeOpacity={0.8}
              testID="golden-dataset-preview-close"
            >
              <Text style={styles.modalCloseText}>关闭</Text>
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  refreshBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  refreshBtnText: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    letterSpacing: 0.8,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  loadingText: { color: colors.textSecondary, fontSize: fontSize.xs },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: spacing.sm, lineHeight: 17 },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  statBox: {
    flexGrow: 1,
    minWidth: 70,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  statValue: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  statLabel: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  modelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  modelChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  modelChipText: { color: colors.textSecondary, fontSize: fontSize.xs },

  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },

  evoHeader: { marginTop: spacing.md },
  evoTitle: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '800' },
  evoHint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  baseModelInput: {
    marginTop: spacing.xs,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    maxHeight: '86%',
  },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  modalHint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  previewBox: {
    marginTop: spacing.sm,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    maxHeight: 320,
  },
  previewText: { color: colors.textSecondary, fontSize: fontSize.xs, lineHeight: 16 },
  modalClose: { marginTop: spacing.sm, alignItems: 'center' },
  modalCloseText: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },

  exportBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  exportBtnText: { color: '#04211A', fontSize: fontSize.xs, fontWeight: '800' },
  exportBtnAlt: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.purple,
  },
  exportBtnAltText: { color: colors.purple, fontSize: fontSize.xs, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },

  noticeText: { color: colors.accent, fontSize: fontSize.xs, marginTop: spacing.sm, fontWeight: '700' },

  // 阶段十四 P2 · RLAIF 跑批区
  rlaifBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.cardAlt,
  },
  rlaifHead: { marginBottom: spacing.xs },
  rlaifTitle: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '800' },
  rlaifHint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  rlaifResult: { marginTop: spacing.sm },
  rlaifResultLine: { color: colors.textSecondary, fontSize: fontSize.xs },
  rlaifResultValue: { color: colors.accent, fontWeight: '800' },
  rlaifPairRow: {
    marginTop: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rlaifPairTitle: { color: colors.textPrimary, fontSize: fontSize.xs, fontWeight: '700' },
  rlaifPairChosen: { color: colors.accent, fontSize: fontSize.xs, marginTop: 2 },
  rlaifPairRejected: { color: colors.danger, fontSize: fontSize.xs, marginTop: 1 },
  sectionTitle: {
    color: colors.textBody,
    fontSize: fontSize.sm,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },

  row: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: 4,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '800' },
  rowBadge: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },
  rowPrompt: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 4 },
  rowAnswer: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
});

export default GoldenDatasetCard;
