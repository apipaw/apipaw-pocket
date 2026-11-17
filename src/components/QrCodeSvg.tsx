import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { ECCLevel, encodeQr } from '../utils/qrcode';
import { colors, fontSize, radius, spacing } from '../theme';

/**
 * 纯前端 QR 码渲染器（阶段十七 P0 · 扫码导入二维码）。
 *
 * 为什么必须是**纯前端**：
 *   - 二维码里装的是**明文 API Key**，一旦经过服务端就等于把密钥落到了
 *     网关日志 / 代理缓存 / 数据库里 —— 那与阶段四「明文只回吐一次」的
 *     契约直接冲突；
 *   - 零依赖：编码器 `src/utils/qrcode.ts` 是本仓自研的 ISO/IEC 18004
 *     实现（GF(256) Reed-Solomon + 8 掩码惩罚评分），与 Python `qrcode`
 *     参考库**逐模块 136/136 完全一致**。
 *
 * 渲染用 `react-native-svg` 的**单条 Path**（而不是每个模块一个 <Rect>）：
 * 一个 v6 码有 1681 个模块，逐个成元素会让 DOM 节点数爆炸。
 */

type Props = {
  /** 二维码载荷（UTF-8） */
  value: string;
  /** 渲染边长（逻辑像素） */
  size?: number;
  /** 静区（quiet zone）模块数 —— ISO 要求至少 4 */
  quietZone?: number;
  /** 纠错等级（默认 M，容错 15%） */
  ecc?: ECCLevel;
  testID?: string;
};

const QrCodeSvg: React.FC<Props> = ({
  value,
  size = 240,
  quietZone = 4,
  ecc = 'M',
  testID = 'qr-code-svg',
}) => {
  const built = useMemo(() => {
    try {
      const result = encodeQr(value, ecc);
      const modules = result.size;
      const total = modules + quietZone * 2;
      // 深色模块合成一条 Path：每个模块一个 1×1 的闭合子路径
      let path = '';
      for (let y = 0; y < modules; y += 1) {
        for (let x = 0; x < modules; x += 1) {
          if (result.matrix[y][x]) {
            path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
          }
        }
      }
      return { ok: true as const, path, total, version: result.version, mask: result.mask };
    } catch (e) {
      return {
        ok: false as const,
        message: e instanceof Error ? e.message : '二维码生成失败',
        total: 0,
        path: '',
        version: 0,
        mask: 0,
      };
    }
  }, [value, ecc, quietZone]);

  if (!built.ok) {
    return (
      <View style={[styles.box, { width: size, height: size }]} testID={`${testID}-error`}>
        <Text style={styles.errText}>二维码生成失败：{built.message}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.box, { width: size, height: size }]} testID={testID}>
      <Svg width={size} height={size} viewBox={`0 0 ${built.total} ${built.total}`}>
        <Rect x={0} y={0} width={built.total} height={built.total} fill="#FFFFFF" />
        <Path d={built.path} fill="#000000" />
      </Svg>
    </View>
  );
};

const styles = StyleSheet.create({
  box: {
    backgroundColor: '#FFFFFF',
    borderRadius: radius.md,
    padding: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  errText: {
    color: colors.danger,
    fontSize: fontSize.xs,
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },
});

export default QrCodeSvg;
