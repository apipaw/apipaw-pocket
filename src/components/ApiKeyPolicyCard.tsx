import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ApiKeyPolicy,
  describeCloudError,
  describePolicyError,
  fetchApiKeyPolicy,
  updateApiKeyPolicy,
} from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';
import QrCodeSvg from './QrCodeSvg';

/**
 * 买家密钥**四重安全锁**面板（阶段十七 P0）。
 *
 * 四道锁（服务端强制，前端只是它们的**控制面**，任何一道都在**预扣费之前**拦截 ⇒ 零扣费）：
 *   1. **冻结** —— 立刻让这把 Key 的推理请求全部 403（`api_key_frozen`）；
 *   2. **IP 白名单** —— 只有白名单里的来源 IP 能调（支持 `203.0.113.*` 尾缀通配）；
 *   3. **模型白名单** —— 只允许指定的 model_id（空 = 不限制）；
 *   4. **单日限额** —— 消费达到上限直接 402（账户级闸门）。
 *
 * ⚠️ **被冻结的 Key 依然能打开这个面板并解冻自己** —— 否则就是死锁
 * （服务端 `/api/v1/user/apikey/policy` 显式放行 frozen，只拒绝 revoked）。
 *
 * 「📱 扫码导入二维码」把**当前这把 Key** 编成二维码，方便在另一台设备上
 * 扫码导入。⚠️ 二维码里是**明文密钥** —— 因此这里明确标注风险，
 * 且**纯前端生成**（`src/utils/qrcode.ts`），明文绝不过服务端。
 */

const STATUS_LABEL: Record<string, string> = {
  active: '正常',
  frozen: '已冻结',
  revoked: '已吊销',
};

const splitCsv = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const ApiKeyPolicyCard: React.FC = () => {
  const apiKey = usePawStore((s) => s.apiKey);

  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<ApiKeyPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [ipText, setIpText] = useState('');
  const [modelText, setModelText] = useState('');
  const [limitText, setLimitText] = useState('');

  const [qrVisible, setQrVisible] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchApiKeyPolicy();
      setPolicy(res);
      setIpText((res.allowed_ips ?? []).join(', '));
      setModelText((res.allowed_models ?? []).join(', '));
      setLimitText(String(res.daily_limit_usd ?? 0));
    } catch (e: unknown) {
      setError(describePolicyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !apiKey) return;
    void load();
  }, [open, apiKey, load]);

  const status = String(policy?.status ?? 'active').toLowerCase();
  const frozen = status === 'frozen';

  const toggleFreeze = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await updateApiKeyPolicy({ status: frozen ? 'active' : 'frozen' });
      if (!res.ok) {
        setError(res.error || '操作失败');
      } else {
        setNotice(frozen ? '已解冻：这把 Key 恢复可用' : '已冻结：这把 Key 的推理请求会被拒绝（零扣费）');
        await load();
      }
    } catch (e: unknown) {
      setError(describePolicyError(e));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const limit = Number(limitText);
    if (!Number.isFinite(limit) || limit < 0) {
      setBusy(false);
      setError('单日限额必须是非负数字（0 = 不限额）');
      return;
    }
    try {
      const res = await updateApiKeyPolicy({
        allowed_ips: splitCsv(ipText),
        allowed_models: splitCsv(modelText),
        daily_limit_usd: limit,
      });
      if (!res.ok) {
        setError(res.error || '保存失败');
      } else {
        setNotice('白名单与单日限额已保存');
        await load();
      }
    } catch (e: unknown) {
      setError(describePolicyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!apiKey) {
    return (
      <View style={styles.card} testID="apikey-policy-card">
        <Text style={styles.title}>🛡️ 密钥安全策略</Text>
        <Text style={styles.hint}>配置 API Key 后可冻结/解冻、设置 IP 白名单与模型白名单。</Text>
      </View>
    );
  }

  const qrPayload = `apipaw://key?h=cloud.apipaw.com&k=${encodeURIComponent(apiKey)}`;

  return (
    <View style={styles.card} testID="apikey-policy-card" id="apx-glass-apikey-policy">
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
        testID="apikey-policy-toggle"
      >
        <View style={styles.titleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.title}>🛡️ 密钥安全策略</Text>
        </View>
        <Text style={styles.chevron}>{open ? '收起 ▲' : '展开 ▼'}</Text>
      </TouchableOpacity>

      {open ? (
        loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.cyan} />
            <Text style={styles.loadingText}>正在读取安全策略…</Text>
          </View>
        ) : (
          <>
            {/* ---- 状态 + 一键冻结 ---- */}
            <View style={styles.statusRow}>
              <Text style={styles.label}>当前状态</Text>
              <Text
                style={[
                  styles.statusBadge,
                  frozen ? styles.statusFrozen : styles.statusActive,
                ]}
                testID="apikey-policy-status"
              >
                {STATUS_LABEL[status] || status}
              </Text>
              <Text style={styles.keyHint} testID="apikey-policy-key-hint">
                {policy?.key_prefix ?? '···'}…{policy?.key_last4 ?? '····'}
              </Text>
            </View>

            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.btn, frozen ? styles.btnOk : styles.btnDanger, busy && styles.btnDisabled]}
                onPress={toggleFreeze}
                disabled={busy || status === 'revoked'}
                activeOpacity={0.8}
                testID="apikey-policy-freeze-toggle"
              >
                {busy ? (
                  <ActivityIndicator size="small" color="#052E21" />
                ) : (
                  <Text style={styles.btnText}>{frozen ? '一键解冻' : '一键冻结'}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost, busy && styles.btnDisabled]}
                onPress={() => setQrVisible(true)}
                disabled={busy}
                activeOpacity={0.8}
                testID="apikey-policy-qr-btn"
              >
                <Text style={styles.btnGhostText}>📱 扫码导入二维码</Text>
              </TouchableOpacity>
            </View>

            {/* ---- 白名单 ---- */}
            <Text style={styles.fieldLabel}>IP 白名单（逗号分隔，空 = 不限制）</Text>
            <TextInput
              style={styles.input}
              value={ipText}
              onChangeText={setIpText}
              placeholder="203.0.113.0/24, 198.51.100.*"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              testID="apikey-policy-ip-input"
            />

            <Text style={styles.fieldLabel}>模型白名单（model_id，空 = 不限制）</Text>
            <TextInput
              style={styles.input}
              value={modelText}
              onChangeText={setModelText}
              placeholder="qwen2.5:0.5b, apipaw-auto"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              testID="apikey-policy-model-input"
            />

            <Text style={styles.fieldLabel}>单日消费上限（USD，0 = 不限额）</Text>
            <TextInput
              style={styles.input}
              value={limitText}
              onChangeText={setLimitText}
              placeholder="5"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              testID="apikey-policy-limit-input"
            />

            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
              onPress={savePolicy}
              disabled={busy}
              activeOpacity={0.8}
              testID="apikey-policy-save"
            >
              {busy ? (
                <ActivityIndicator size="small" color="#052E21" />
              ) : (
                <Text style={styles.btnText}>保存白名单与限额</Text>
              )}
            </TouchableOpacity>

            {error !== null && (
              <Text style={styles.errorText} testID="apikey-policy-error">
                ⚠️ {error}
              </Text>
            )}
            {notice !== null && (
              <Text style={styles.noticeText} testID="apikey-policy-notice">
                ✓ {notice}
              </Text>
            )}
          </>
        )
      ) : (
        <Text style={styles.hint}>
          冻结 / IP 白名单 / 模型白名单 / 单日限额 —— 四道锁在**预扣费之前**拦截，一律零扣费。
        </Text>
      )}

      {/* ---- 扫码导入二维码弹窗 ---- */}
      <Modal
        visible={qrVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setQrVisible(false)}
      >
        <View style={styles.modalBackdrop} id="apx-modal">
          <View style={styles.modalCard} id="apx-modal-card" testID="apikey-policy-qr-modal">
            <Text style={styles.modalTitle}>📱 扫码导入密钥</Text>
            <Text style={styles.modalHint}>
              用手机扫描下方二维码即可把当前这把 API Key 导入另一台设备。
            </Text>
            <QrCodeSvg value={qrPayload} size={240} />
            <Text style={styles.qrWarn} testID="apikey-policy-qr-warn">
              ⚠️ 二维码内含**明文密钥**，请勿截图分享；导入完成后建议「一键冻结」旧设备。
            </Text>
            <Text style={styles.qrPayload} numberOfLines={2} selectable testID="apikey-policy-qr-payload">
              {qrPayload}
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary]}
                onPress={() => setQrVisible(false)}
                activeOpacity={0.8}
                testID="apikey-policy-qr-close"
              >
                <Text style={styles.btnText}>关闭</Text>
              </TouchableOpacity>
            </View>
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
  },
  title: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  chevron: { color: colors.cyan, fontSize: fontSize.xs, fontWeight: '800' },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.xs },
  loadingWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  loadingText: { color: colors.textSecondary, fontSize: fontSize.xs },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  label: { color: colors.textSecondary, fontSize: fontSize.xs },
  statusBadge: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  statusActive: { color: colors.accent, backgroundColor: colors.accentSoft },
  statusFrozen: { color: colors.warn, backgroundColor: colors.warnSoft },
  keyHint: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: monoFont, marginLeft: 'auto' },

  btnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.md,
  },
  btnPrimary: { backgroundColor: colors.accent, marginTop: spacing.sm },
  btnDanger: { backgroundColor: colors.danger, flex: 1 },
  btnOk: { backgroundColor: colors.accent, flex: 1 },
  btnGhost: { backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border, flex: 1 },
  btnText: { color: '#052E21', fontSize: fontSize.sm, fontWeight: '800' },
  btnGhostText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },

  fieldLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    marginTop: spacing.md,
    marginBottom: 2,
  },
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textBody,
    fontSize: fontSize.sm,
    fontFamily: monoFont,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
  },

  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },
  noticeText: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '700', marginTop: spacing.md },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.cardSolid,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: spacing.lg,
    gap: spacing.sm,
    maxWidth: 420,
    width: '100%',
  },
  modalTitle: { color: colors.textPrimary, fontSize: fontSize.title, fontWeight: '800' },
  modalHint: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 19 },
  qrWarn: { color: colors.warn, fontSize: fontSize.xs, lineHeight: 17, fontWeight: '700' },
  qrPayload: { color: colors.textMuted, fontSize: fontSize.xs, fontFamily: monoFont },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.sm },
});

export default ApiKeyPolicyCard;
