import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  DatasetSummary,
  describeCloudError,
  exportDataset,
  fetchDatasetSummary,
} from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 黄金 SFT/DPO **微调语料工坊**（阶段十二 P2 · OWNER 专属）。
 *
 * 数据来自 `feedback_samples` —— 买家在 Playground 的 👍/👎 打分（阶段十二 P1）：
 *   - 👍 有用 且回答非空 ⇒ 自动 `is_golden = 1` ⇒ 进 **SFT 黄金集**；
 *   - 👎 需改进 ⇒ 进 **负向池**（与同 prompt 的 👍 配对即可成 DPO 偏好对）。
 *
 * 两个一键下载：
 *   - **SFT**：`{"messages":[user, assistant], "meta":{...}}` 的 JSONL
 *     （OpenAI / ShareGPT 格式，LLaMA-Factory 可直接吃）；
 *   - **DPO**：`{"prompt","chosen","rejected","meta"}` 的 JSONL
 *     （Unsloth / LLaMA-Factory 的偏好对格式）。
 *
 * ⚠️ 语料里**不含**任何明文密钥：服务端落库前已把 `paw-sk-...` 之类打码。
 */
const GoldenDatasetCard: React.FC = () => {
  const [summary, setSummary] = useState<DatasetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sft' | 'dpo' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

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
