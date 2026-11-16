import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  OwnerModelUpsertPayload,
  describeCloudError,
  upsertOwnerModel,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 模型工坊 · 网页一键上架与配置（阶段九 P1 · OWNER 专属）。
 *
 * 此前上新模型只有两条路：**手写 YAML** 或 **直接改库**。
 * 后者绕过全部校验与留痕（谁改的、改成什么价，全靠人记）——
 * 于是「模型上架」这件事实际上没法由非运维角色完成。
 *
 * 本面板把「新增 + 改配置 + 留痕」收进**一个事务**：
 * - 服务端校验（tier / 版税率区间 / CREATOR 必须有创作者钱包 / 价格非负）⇒ 400；
 * - 每次写入都追加一条 `model_pricing_changes` 审计流水（append-only）；
 * - 成功后立刻 `bumpModelCatalog()` —— Playground 的模型列表**当场**出现新模型。
 */
const ModelUpsertCard: React.FC = () => {
  const sessionRole = usePawStore((s) => s.sessionRole);
  const sessionToken = usePawStore((s) => s.sessionToken);
  const bumpModelCatalog = usePawStore((s) => s.bumpModelCatalog);

  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tier, setTier] = useState<'BASE' | 'CREATOR'>('BASE');
  const [promptPrice, setPromptPrice] = useState('0.35');
  const [completionPrice, setCompletionPrice] = useState('0.42');
  const [minVram, setMinVram] = useState('4');
  const [royaltyRate, setRoyaltyRate] = useState('0');
  const [royaltyMode, setRoyaltyMode] = useState<'RATE' | 'NONE'>('NONE');
  const [creatorId, setCreatorId] = useState('');
  const [authorWallet, setAuthorWallet] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isOwner = sessionRole === 'OWNER';

  const toggleTier = useCallback((next: 'BASE' | 'CREATOR') => {
    setTier(next);
    // BASE 是平台基座模型 ⇒ 版税率恒为 0；CREATOR 才可能拿版税。
    if (next === 'BASE') {
      setRoyaltyRate('0');
      setRoyaltyMode('NONE');
    } else if (royaltyMode === 'NONE') {
      setRoyaltyMode('RATE');
    }
  }, [royaltyMode]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const payload: OwnerModelUpsertPayload = {
      model_id: modelId.trim(),
      display_name: displayName.trim() || modelId.trim(),
      tier,
      prompt_price_per_1k: Number(promptPrice) || 0,
      completion_price_per_1k: Number(completionPrice) || 0,
      min_vram_gb: Number(minVram) || 0,
      royalty_rate: Number(royaltyRate) || 0,
      royalty_mode: tier === 'BASE' ? 'NONE' : royaltyMode,
      creator_id: creatorId.trim() || undefined,
      author_wallet: authorWallet.trim() || undefined,
    };
    try {
      const res = await upsertOwnerModel(payload);
      const m = res.model;
      setNotice(
        `${m.created ? '已上架' : '已更新'} ${m.model_id}（${m.tier}）· ` +
          `版税率 ${(Number(m.royalty_rate) * 100).toFixed(0)}%`,
      );
      // Playground 的模型列表当场重拉 —— 上架即可用，不用刷新整页。
      bumpModelCatalog();
    } catch (e: unknown) {
      setError(describeCloudError(e, 'session'));
    } finally {
      setBusy(false);
    }
  }, [
    modelId, displayName, tier, promptPrice, completionPrice, minVram,
    royaltyRate, royaltyMode, creatorId, authorWallet, bumpModelCatalog,
  ]);

  if (!sessionToken) {
    return (
      <View style={styles.card} testID="model-upsert-card">
        <Text style={styles.cardTitle}>上架 / 配置推理模型</Text>
        <Text style={styles.hint}>
          上架模型是定价级动作，只有 OWNER 能做。连接钱包后这里会打开自助表单。
        </Text>
      </View>
    );
  }

  if (!isOwner) {
    return (
      <View style={styles.card} testID="model-upsert-card">
        <Text style={styles.cardTitle}>上架 / 配置推理模型</Text>
        <Text style={styles.hint}>
          当前会话不是 OWNER 角色，无权上架模型（服务端按角色鉴权，改价同理）。
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card} testID="model-upsert-card" id="apx-glass-model-upsert">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>上架 / 配置推理模型（OWNER）</Text>
        </View>
      </View>
      <Text style={styles.hint}>
        同一个 model_id 重复提交即为**更新配置**（幂等）。每次写入都会留一条审计流水。
      </Text>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>模型 ID</Text>
        <TextInput
          style={styles.input}
          value={modelId}
          onChangeText={setModelId}
          placeholder="qwen2.5:0.5b"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          testID="model-upsert-model-id"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>显示名</Text>
        <TextInput
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Qwen2.5 0.5B（创作者档）"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          testID="model-upsert-display-name"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>档位</Text>
        <View style={styles.segWrap}>
          {(['BASE', 'CREATOR'] as const).map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.seg, tier === t && styles.segActive]}
              onPress={() => toggleTier(t)}
              activeOpacity={0.75}
              testID={`model-upsert-tier-${t}`}
            >
              <Text style={[styles.segText, tier === t && styles.segTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>输入价 / 1k</Text>
        <TextInput
          style={styles.input}
          value={promptPrice}
          onChangeText={setPromptPrice}
          placeholder="0.35"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          testID="model-upsert-prompt-price"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>输出价 / 1k</Text>
        <TextInput
          style={styles.input}
          value={completionPrice}
          onChangeText={setCompletionPrice}
          placeholder="0.42"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          testID="model-upsert-completion-price"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>最小显存 (GB)</Text>
        <TextInput
          style={styles.input}
          value={minVram}
          onChangeText={setMinVram}
          placeholder="4"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          testID="model-upsert-min-vram"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>版税率 (0 ~ 0.5)</Text>
        <TextInput
          style={styles.input}
          value={royaltyRate}
          onChangeText={setRoyaltyRate}
          placeholder="0.15"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          editable={tier === 'CREATOR'}
          testID="model-upsert-royalty-rate"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>创作者 ID</Text>
        <TextInput
          style={styles.input}
          value={creatorId}
          onChangeText={setCreatorId}
          placeholder="creator_xxx"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          testID="model-upsert-creator-id"
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.label}>创作者钱包</Text>
        <TextInput
          style={styles.input}
          value={authorWallet}
          onChangeText={setAuthorWallet}
          placeholder="0x…（CREATOR 必填）"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          testID="model-upsert-author-wallet"
        />
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText} testID="model-upsert-error">
            ⚠️ {error}
          </Text>
        </View>
      ) : null}
      {notice ? (
        <Text style={styles.noticeText} testID="model-upsert-result">
          ✓ {notice}
        </Text>
      ) : null}

      <TouchableOpacity
        style={[styles.submitBtn, busy && styles.btnDisabled]}
        onPress={() => void submit()}
        disabled={busy}
        activeOpacity={0.8}
        testID="model-upsert-submit"
      >
        {busy ? (
          <ActivityIndicator color="#04211A" />
        ) : (
          <Text style={styles.submitBtnText}>上架 / 更新模型</Text>
        )}
      </TouchableOpacity>
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
    marginBottom: spacing.sm,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.purple,
    shadowColor: colors.purple,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },

  fieldRow: { marginTop: spacing.md },
  label: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700', marginBottom: 4 },
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
  },

  segWrap: { flexDirection: 'row', gap: spacing.sm },
  seg: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  segActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  segText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  segTextActive: { color: colors.accent },

  errorWrap: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700' },
  noticeText: { color: colors.accent, fontSize: fontSize.xs, marginTop: spacing.md, fontWeight: '700' },

  submitBtn: {
    marginTop: spacing.lg,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.xl,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  submitBtnText: { color: '#04211A', fontSize: fontSize.sm, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },
});

export default ModelUpsertCard;
