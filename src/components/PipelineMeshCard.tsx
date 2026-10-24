import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { usePawStore } from '../store/usePawStore';
import {
  ModelTopology,
  TopologyNode,
  fetchCreatorModels,
  fetchCreatorTopology,
} from '../api/cloudClient';
import { colors, fontSize, radius, spacing } from '../theme';

const MESH_HEIGHT = 208;
const HEADER_HEIGHT = 26;
const FOOTER_HEIGHT = 30;
const COL_GAP = 14;
const LAYER_GAP = 2;
const MIN_LAYER_H = 3;

/** 节点状态配色 */
const statusColor = (node: TopologyNode): string => {
  if (!node.online) return colors.textMuted;
  if (node.status === 'BUSY' || node.status === 'RUNNING') return colors.warn;
  if (node.status === 'ERROR') return colors.danger;
  return colors.accent;
};

const statusLabel = (node: TopologyNode): string => {
  if (!node.online) return '离线';
  if (node.status === 'BUSY' || node.status === 'RUNNING') return '推理中';
  if (node.status === 'ERROR') return '异常';
  return '在线';
};

/**
 * 算力拓扑网格 (CreatorEx)
 * 用 SVG 绘制 28 层隐藏层在多节点之间的切片流转，标注节点在线状态与延迟。
 */
const PipelineMeshCard: React.FC = () => {
  const { topologyModelId, setTopologyModelId } = usePawStore();

  const [models, setModels] = useState<Array<{ model_id: string; display_name: string }>>([]);
  const [topology, setTopology] = useState<ModelTopology | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meshWidth, setMeshWidth] = useState(320);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetchCreatorModels();
      const list = res.models.map((m) => ({
        model_id: m.model_id,
        display_name: m.display_name,
      }));
      setModels(list);
      if (list.length > 0 && !list.some((m) => m.model_id === topologyModelId)) {
        setTopologyModelId(list[0].model_id);
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || '加载创作者模型失败');
    }
  }, [topologyModelId, setTopologyModelId]);

  const loadTopology = useCallback(async () => {
    if (!topologyModelId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCreatorTopology(topologyModelId);
      setTopology(res);
      setSelectedIndex(0);
    } catch (e: any) {
      setTopology(null);
      setError(e?.response?.data?.detail || e?.message || '加载拓扑失败');
    } finally {
      setLoading(false);
    }
  }, [topologyModelId]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    loadTopology();
  }, [loadTopology]);

  const nodes = topology?.nodes ?? [];
  const selected = nodes[selectedIndex] ?? null;

  // ---- SVG 布局计算 ----
  const layout = useMemo(() => {
    const count = Math.max(1, nodes.length);
    const colWidth = Math.max(64, (meshWidth - COL_GAP * (count - 1)) / count);
    const bodyTop = HEADER_HEIGHT + 8;
    const bodyHeight = MESH_HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT - 8;
    const maxLayers = Math.max(1, ...nodes.map((n) => n.layer_count));
    // 每层高度按最大层数归一，保证所有列底端对齐
    const layerHeight = Math.max(
      MIN_LAYER_H,
      Math.min(14, (bodyHeight - LAYER_GAP * (maxLayers - 1)) / maxLayers),
    );
    return { colWidth, bodyTop, bodyHeight, layerHeight, count };
  }, [nodes.length, meshWidth]);

  return (
    <View style={styles.card} testID="pipeline-mesh-card">
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>🕸️ 算力拓扑网格</Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={loadTopology} activeOpacity={0.75}>
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {/* 模型切换 */}
      {models.length > 0 && (
        <View style={styles.modelChips}>
          {models.map((model) => {
            const active = model.model_id === topologyModelId;
            return (
              <TouchableOpacity
                key={model.model_id}
                testID={`mesh-model-${model.model_id}`}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setTopologyModelId(model.model_id)}
                activeOpacity={0.75}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {model.display_name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在拉取节点切片拓扑...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorHint}>请确认 APIPaw Cloud 网关已启动，并在工作台完成模型上架</Text>
        </View>
      ) : topology ? (
        <>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryText}>
              {topology.display_name} · {topology.total_layers} 层 · 切分为 {topology.slice_count} 个节点
            </Text>
            <Text style={styles.summaryLatency}>总延迟 {topology.total_latency_ms}ms</Text>
          </View>

          <View
            style={styles.meshBox}
            onLayout={(e) => setMeshWidth(e.nativeEvent.layout.width)}
          >
            <Svg width={meshWidth} height={MESH_HEIGHT}>
              <Defs>
                <LinearGradient id="meshFlow" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor={colors.purple} stopOpacity="0.9" />
                  <Stop offset="1" stopColor={colors.accent} stopOpacity="0.9" />
                </LinearGradient>
              </Defs>

              {/* 节点之间的层流转箭头 */}
              {nodes.slice(0, -1).map((node, i) => {
                const x1 = i * (layout.colWidth + COL_GAP) + layout.colWidth;
                const x2 = x1 + COL_GAP;
                const midY = layout.bodyTop + layout.bodyHeight / 2;
                return (
                  <G key={`flow-${node.node_id}`}>
                    <Path
                      d={`M ${x1} ${midY} C ${x1 + COL_GAP / 2} ${midY - 18}, ${
                        x2 - COL_GAP / 2
                      } ${midY + 18}, ${x2} ${midY}`}
                      stroke="url(#meshFlow)"
                      strokeWidth={2}
                      fill="none"
                      strokeDasharray="4 3"
                    />
                    <Path
                      d={`M ${x2 - 7} ${midY - 5} L ${x2} ${midY} L ${x2 - 7} ${midY + 5} Z`}
                      fill={colors.accent}
                    />
                  </G>
                );
              })}

              {/* 每个节点的层柱 */}
              {nodes.map((node, i) => {
                const x = i * (layout.colWidth + COL_GAP);
                const active = i === selectedIndex;
                const color = statusColor(node);
                const stackHeight =
                  node.layer_count * layout.layerHeight + (node.layer_count - 1) * LAYER_GAP;
                const stackTop = layout.bodyTop + layout.bodyHeight - stackHeight;

                return (
                  <G key={node.node_id}>
                    {/* 节点外框 */}
                    <Rect
                      x={x}
                      y={HEADER_HEIGHT}
                      width={layout.colWidth}
                      height={MESH_HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT}
                      rx={10}
                      fill={active ? colors.purpleSoft : colors.cardAlt}
                      stroke={active ? colors.purple : colors.border}
                      strokeWidth={active ? 1.6 : 1}
                    />

                    {/* 节点标题 */}
                    <SvgText
                      x={x + layout.colWidth / 2}
                      y={HEADER_HEIGHT - 8}
                      fill={active ? colors.textPrimary : colors.textSecondary}
                      fontSize={10}
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {node.label}
                    </SvgText>

                    {/* 层切片 */}
                    {Array.from({ length: node.layer_count }).map((_, layerIndex) => {
                      const layerY =
                        stackTop + layerIndex * (layout.layerHeight + LAYER_GAP);
                      return (
                        <Rect
                          key={`${node.node_id}-layer-${layerIndex}`}
                          x={x + 8}
                          y={layerY}
                          width={layout.colWidth - 16}
                          height={layout.layerHeight}
                          rx={Math.min(3, layout.layerHeight / 2)}
                          fill={color}
                          opacity={active ? 0.95 : 0.5}
                        />
                      );
                    })}

                    {/* 状态点 */}
                    <Circle
                      cx={x + layout.colWidth - 12}
                      cy={HEADER_HEIGHT + 8}
                      r={3.5}
                      fill={color}
                    />

                    {/* 层范围 */}
                    <SvgText
                      x={x + layout.colWidth / 2}
                      y={MESH_HEIGHT - FOOTER_HEIGHT + 14}
                      fill={colors.textSecondary}
                      fontSize={9}
                      textAnchor="middle"
                    >
                      {`L${node.layer_start}-${node.layer_end}`}
                    </SvgText>
                    <SvgText
                      x={x + layout.colWidth / 2}
                      y={MESH_HEIGHT - FOOTER_HEIGHT + 25}
                      fill={colors.textMuted}
                      fontSize={8}
                      textAnchor="middle"
                    >
                      {`${node.latency_ms}ms`}
                    </SvgText>
                  </G>
                );
              })}
            </Svg>
          </View>

          {/* 节点详情 (点击柱体切换) */}
          <View style={styles.nodeList}>
            {nodes.map((node, i) => {
              const active = i === selectedIndex;
              return (
                <TouchableOpacity
                  key={node.node_id}
                  testID={`mesh-node-${node.node_id}`}
                  style={[styles.nodeChip, active && styles.nodeChipActive]}
                  onPress={() => setSelectedIndex(i)}
                  activeOpacity={0.75}
                >
                  <View style={[styles.nodeDot, { backgroundColor: statusColor(node) }]} />
                  <Text style={[styles.nodeChipText, active && styles.nodeChipTextActive]}>
                    {node.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {selected && (
            <View style={styles.detailBox} testID="mesh-detail">
              <View style={styles.detailHeader}>
                <Text style={styles.detailTitle}>
                  {selected.label} · {selected.node_id}
                </Text>
                <Text style={[styles.detailStatus, { color: statusColor(selected) }]}>
                  {statusLabel(selected)}
                </Text>
              </View>
              <View style={styles.detailGrid}>
                <View style={styles.detailCell}>
                  <Text style={styles.detailLabel}>承载层</Text>
                  <Text style={styles.detailValue}>
                    Layer {selected.layer_start} - {selected.layer_end}
                  </Text>
                </View>
                <View style={styles.detailCell}>
                  <Text style={styles.detailLabel}>层数</Text>
                  <Text style={styles.detailValue}>{selected.layer_count}</Text>
                </View>
                <View style={styles.detailCell}>
                  <Text style={styles.detailLabel}>算力占比</Text>
                  <Text style={styles.detailValue}>
                    {(selected.share * 100).toFixed(0)}%
                  </Text>
                </View>
                <View style={styles.detailCell}>
                  <Text style={styles.detailLabel}>单片显存</Text>
                  <Text style={styles.detailValue}>{selected.vram_gb} GB</Text>
                </View>
                <View style={styles.detailCell}>
                  <Text style={styles.detailLabel}>推理延迟</Text>
                  <Text style={styles.detailValue}>{selected.latency_ms} ms</Text>
                </View>
                <View style={styles.detailCell}>
                  <Text style={styles.detailLabel}>准入阈值</Text>
                  <Text style={styles.detailValue}>{topology.min_vram_gb} GB</Text>
                </View>
              </View>
            </View>
          )}
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
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: 'bold' },
  refreshBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  refreshBtnText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },

  modelChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.purpleSoft, borderColor: colors.purple },
  chipText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  chipTextActive: { color: colors.purple },

  loadingWrap: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  loadingText: { color: colors.textMuted, fontSize: fontSize.sm },
  errorWrap: { paddingVertical: spacing.lg, gap: spacing.sm },
  errorText: { color: colors.danger, fontSize: fontSize.sm },
  errorHint: { color: colors.textMuted, fontSize: fontSize.xs },

  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  summaryText: { color: colors.textSecondary, fontSize: fontSize.xs, flexShrink: 1 },
  summaryLatency: { color: colors.warn, fontSize: fontSize.xs, fontWeight: '700' },

  meshBox: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    overflow: 'hidden',
  },

  nodeList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  nodeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  nodeChipActive: { borderColor: colors.purple, backgroundColor: colors.purpleSoft },
  nodeDot: { width: 8, height: 8, borderRadius: 4 },
  nodeChipText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  nodeChipTextActive: { color: colors.purple },

  detailBox: {
    marginTop: spacing.md,
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  detailTitle: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '700' },
  detailStatus: { fontSize: fontSize.xs, fontWeight: '700' },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  detailCell: { width: '31%', minWidth: 92, flexGrow: 1 },
  detailLabel: { color: colors.textMuted, fontSize: 10, marginBottom: 2 },
  detailValue: { color: colors.textBody, fontSize: fontSize.xs, fontWeight: '700' },
});

export default PipelineMeshCard;
