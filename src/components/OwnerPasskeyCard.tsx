import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { describePasskeyError, ownerPasskeyUnlock } from '../api/cloudClient';
import { usePawStore } from '../store/usePawStore';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 业主**管理口令**解锁（阶段十 P0 · 免钱包插件）。
 *
 * 为什么需要它：
 *     真实业主钱包的私钥我们**没有、也不该有** —— 此前要拿到 `role=OWNER`
 *     会话只有"浏览器装钱包插件"这一条路。网页端业主功能（上架模型、签发卡密、
 *     审批提现）在无插件场景下**完全打不开**。
 *
 * 解锁出来的会话与钱包会话**完全同构**（同一套 JWT / `auth_sessions` /
 * 服务端按 DB 回查角色），所以解锁之后全部业主卡片自动点亮 ——
 * 前端**不需要**任何额外的鉴权分支，服务端也**不需要**改 `require_owner`。
 *
 * 安全口径：
 * - 明文口令只在提交的那一瞬间过网，服务端只存 sha256 哈希；
 * - 失败 5 次 / 900 秒 ⇒ 服务端 429（前端不做本地重试，也不缓存口令）；
 * - 口令**不落盘**：解锁只写会话 JWT，刷新页面需重新输入。
 */
const OwnerPasskeyCard: React.FC<{ onUnlocked?: () => void }> = ({ onUnlocked }) => {
  const setSession = usePawStore((s) => s.setSession);

  const [passkey, setPasskey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const unlock = useCallback(async () => {
    const trimmed = passkey.trim();
    if (!trimmed) {
      setError('请输入管理口令');
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await ownerPasskeyUnlock(trimmed);
      // 立刻清空输入框 —— 口令不该在内存里多待一秒是一秒
      setPasskey('');
      const nowSec = Math.floor(Date.now() / 1000);
      setSession({
        token: res.access_token,
        expiresAt: nowSec + Number(res.expires_in || 7200),
        handle: res.user?.handle ?? '',
        role: res.user?.role ?? 'OWNER',
        status: res.user?.status ?? 'active',
        wallet: res.user?.wallet ?? '',
      });
      setOk(`已解锁 OWNER 视角 · 账户 ${res.user?.handle ?? ''}`);
      onUnlocked?.();
    } catch (e: unknown) {
      setError(describePasskeyError(e));
    } finally {
      setBusy(false);
    }
  }, [passkey, setSession, onUnlocked]);

  return (
    <View style={styles.wrap} testID="owner-passkey-card">
      <Text style={styles.hint}>
        没有钱包插件？用**业主管理口令**直接解锁 OWNER 视角（会话与钱包登录完全等价）。
        口令连续错 5 次会锁 15 分钟。
      </Text>

      <TextInput
        style={styles.input}
        value={passkey}
        onChangeText={setPasskey}
        placeholder="AP-… 管理口令"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        onSubmitEditing={() => void unlock()}
        testID="owner-passkey-input"
      />

      <TouchableOpacity
        style={[styles.btn, busy && styles.btnDisabled]}
        onPress={() => void unlock()}
        disabled={busy}
        activeOpacity={0.85}
        testID="owner-passkey-btn"
      >
        {busy ? (
          <ActivityIndicator color="#04211A" />
        ) : (
          <Text style={styles.btnText}>解锁业主视角</Text>
        )}
      </TouchableOpacity>

      {error ? (
        <Text style={styles.errorText} testID="owner-passkey-error">
          ⚠️ {error}
        </Text>
      ) : null}
      {ok ? (
        <Text style={styles.okText} testID="owner-passkey-ok">
          ✓ {ok}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  hint: { color: colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  input: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    color: colors.textPrimary,
    fontSize: fontSize.sm,
    fontFamily: 'monospace',
  },
  btn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.xl,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  btnText: { color: '#04211A', fontSize: fontSize.sm, fontWeight: '800' },
  btnDisabled: { opacity: 0.5 },
  errorText: { color: colors.danger, fontSize: fontSize.sm, fontWeight: '700' },
  okText: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '700' },
});

export default OwnerPasskeyCard;
