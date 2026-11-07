import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
  ParsedModel,
  describeCloudError,
  parseCreatorModel,
  registerCreatorModel,
} from '../api/cloudClient';
import Slider from './Slider';
import { colors, fontSize, radius, spacing } from '../theme';

const MIN_VRAM_GB = 4;
const MAX_VRAM_GB = 24;
const VRAM_STEP = 0.5;

const DEFAULT_HF_URL = 'https://huggingface.co/Qwen/Qwen2.5-72B-Instruct';

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

/**
 * 模型发布工作台 (CreatorEx)
 * 流程：抓取 HuggingFace 链接 → mock 解析元数据 → 调节 VRAM 阈值 → 预览 PAWMODEL → 提交上架
 */
const ModelStudioCard: React.FC = () => {
  const { creatorWallet, setCreatorModelId, setTopologyModelId } = usePawStore();

  const [hfUrl, setHfUrl] = useState(DEFAULT_HF_URL);
  const [parsed, setParsed] = useState<ParsedModel | null>(null);
  const [vramGb, setVramGb] = useState(8);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleParse = useCallback(async () => {
    setError(null);
    setSuccess(null);
    setParsing(true);
    try {
      const meta = await parseCreatorModel(hfUrl);
      setParsed(meta);
      setVramGb(meta.min_vram_gb);
    } catch (e: any) {
      setParsed(null);
      setError(describeCloudError(e));
    } finally {
      setParsing(false);
    }
  }, [hfUrl]);

  // PAWMODEL 预览随 VRAM 阈值实时刷新
  const pawmodelYaml = useMemo(() => {
    if (!parsed) return '';
    return [
      `model_id: "${parsed.model_id}"`,
      `author_wallet: "${creatorWallet}"`,
      `min_vram_gb: ${vramGb}`,
      'distribution:',
      '  node_operator_share: 0.85',
      '  model_creator_share: 0.15',
      '  protocol_fee_share: 0.00',
    ].join('\n');
  }, [parsed, creatorWallet, vramGb]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(pawmodelYaml);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }, [pawmodelYaml]);

  const handleSubmit = useCallback(async () => {
    if (!parsed) return;
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      await registerCreatorModel({
        hf_url: parsed.hf_url,
        model_id: parsed.model_id,
        display_name: parsed.display_name,
        author_wallet: creatorWallet,
        min_vram_gb: vramGb,
        num_hidden_layers: parsed.num_hidden_layers,
        architecture: parsed.architecture,
        framework: parsed.framework,
        quantization: parsed.quantization,
        total_params: parsed.total_params,
        context_window: parsed.context_window,
        prompt_price_per_1k: 0.35,
        completion_price_per_1k: 0.42,
        description: `${parsed.display_name} · 社区创作者上架模型，含 15% 创作者版税叠加结算`,
      });
      setCreatorModelId(parsed.model_id);
      setTopologyModelId(parsed.model_id);
      setSuccess(`✅ 模型 ${parsed.model_id} 已上架生态，已同步至买家 Playground 模型列表`);
    } catch (e: any) {
      setError(describeCloudError(e));
    } finally {
      setSubmitting(false);
    }
  }, [parsed, creatorWallet, vramGb, setCreatorModelId, setTopologyModelId]);

  const layers = parsed?.num_hidden_layers ?? 28;

  return (
    <View style={styles.card} testID="model-studio-card" id="apx-glass-studio">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>模型发布工作台</Text>
        </View>
        <Text style={styles.cardSub}>PAWMODEL · 免代码上架</Text>
      </View>

      {/* 步骤 1 —— 抓取链接 */}
      <View style={styles.stepBlock}>
        <View style={styles.stepHeader}>
          <Text style={styles.stepBadge}>1</Text>
          <Text style={styles.stepTitle}>抓取 HuggingFace 模型链接</Text>
        </View>

        <TextInput
          testID="studio-hf-url"
          style={styles.input}
          value={hfUrl}
          onChangeText={setHfUrl}
          placeholder="https://huggingface.co/org/model"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <TouchableOpacity
          testID="studio-parse-btn"
          style={[styles.primaryBtn, parsing && styles.btnDisabled]}
          onPress={handleParse}
          disabled={parsing}
          activeOpacity={0.8}
        >
          {parsing ? (
            <ActivityIndicator color={colors.bg} size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>解析模型元数据</Text>
          )}
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </View>
      ) : null}

      {success ? (
        <View style={styles.successBox}>
          <Text style={styles.successText}>{success}</Text>
        </View>
      ) : null}

      {parsed ? (
        <>
          {/* 步骤 2 —— 解析结果 */}
          <View style={styles.stepBlock}>
            <View style={styles.stepHeader}>
              <Text style={styles.stepBadge}>2</Text>
              <Text style={styles.stepTitle}>模型元数据</Text>
            </View>

            <View style={styles.metaGrid}>
              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>架构</Text>
                <Text style={styles.metaValue}>{parsed.architecture}</Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>隐藏层数</Text>
                <Text style={[styles.metaValue, styles.metaValueAccent]}>
                  {parsed.num_hidden_layers}L
                </Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>参数量</Text>
                <Text style={styles.metaValue}>{parsed.total_params}</Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>上下文</Text>
                <Text style={styles.metaValue}>
                  {(parsed.context_window / 1024).toFixed(0)}K
                </Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>量化</Text>
                <Text style={styles.metaValue}>{parsed.quantization}</Text>
              </View>
              <View style={styles.metaCell}>
                <Text style={styles.metaLabel}>框架</Text>
                <Text style={styles.metaValueSmall}>{parsed.framework}</Text>
              </View>
            </View>
          </View>

          {/* 步骤 3 —— VRAM 阈值 */}
          <View style={styles.stepBlock}>
            <View style={styles.stepHeader}>
              <Text style={styles.stepBadge}>3</Text>
              <Text style={styles.stepTitle}>算力准入阈值 (VRAM)</Text>
            </View>

            <Slider
              testID="studio-vram-slider"
              trackTestID="studio-vram-track"
              thumbTestID="studio-vram-thumb"
              label="最低显存要求"
              value={vramGb}
              min={MIN_VRAM_GB}
              max={MAX_VRAM_GB}
              step={VRAM_STEP}
              onChange={setVramGb}
              formatValue={(v) => `${v} GB`}
              scaleLabels={[`${MIN_VRAM_GB} GB`, `${MAX_VRAM_GB} GB`]}
              hint={`≥ ${vramGb} GB 显存的节点方可承载该模型切片 · ${layers} 层将按节点均分`}
              accentColor={colors.purple}
            />
          </View>

          {/* 步骤 4 —— PAWMODEL 预览 */}
          <View style={styles.stepBlock}>
            <View style={styles.stepHeader}>
              <Text style={styles.stepBadge}>4</Text>
              <Text style={styles.stepTitle}>PAWMODEL 预览</Text>
              <TouchableOpacity style={styles.copyBtn} onPress={handleCopy} activeOpacity={0.75}>
                <Text style={styles.copyBtnText}>{copied ? '✓ 已复制' : '复制'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.codeBox}>
              <ScrollView nestedScrollEnabled horizontal showsHorizontalScrollIndicator={false}>
                <Text style={styles.codeText} testID="studio-yaml-preview">
                  {pawmodelYaml}
                </Text>
              </ScrollView>
            </View>

            <View style={styles.walletRow}>
              <Text style={styles.walletLabel}>创作者钱包 (身份)</Text>
              <Text style={styles.walletValue}>{creatorWallet}</Text>
            </View>
          </View>

          {/* 步骤 5 —— 提交 */}
          <TouchableOpacity
            testID="studio-submit-btn"
            style={[styles.primaryBtn, submitting && styles.btnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator color={colors.bg} size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>提交上架 · 场景 B 创作者模型</Text>
            )}
          </TouchableOpacity>
        </>
      ) : null}
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
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  cardSub: { color: colors.textMuted, fontSize: fontSize.xs },

  stepBlock: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  stepBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.purpleSoft,
    color: colors.purple,
    fontSize: fontSize.xs,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 20,
    overflow: 'hidden',
  },
  stepTitle: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },

  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },

  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#04211A', fontWeight: '800', fontSize: fontSize.md },
  btnDisabled: { opacity: 0.6 },

  errorBox: {
    marginTop: spacing.md,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: fontSize.sm },
  successBox: {
    marginTop: spacing.md,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.md,
  },
  successText: { color: colors.accent, fontSize: fontSize.sm },

  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metaCell: {
    width: '31%',
    minWidth: 96,
    flexGrow: 1,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.sm,
  },
  metaLabel: { color: colors.textMuted, fontSize: 12, marginBottom: 3 },
  metaValue: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  metaValueSmall: { color: colors.textPrimary, fontSize: 12, fontWeight: '600' },
  metaValueAccent: { color: colors.purple },

  codeBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
  },
  codeText: {
    color: colors.chartCompletion,
    fontSize: 13,
    lineHeight: 17,
    fontFamily: 'monospace',
  },

  copyBtn: {
    marginLeft: 'auto',
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
  },
  copyBtnText: { color: colors.purple, fontSize: fontSize.xs, fontWeight: '700' },

  walletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  walletLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  walletValue: {
    color: colors.textBody,
    fontSize: 12,
    fontFamily: 'monospace',
    flexShrink: 1,
    marginLeft: spacing.md,
    textAlign: 'right',
  },
});

export default ModelStudioCard;
