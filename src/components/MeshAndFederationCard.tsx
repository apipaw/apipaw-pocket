import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  FederationStatusResponse,
  GatewayStatus,
  MeshClusterRow,
  MeshLayerSplit,
  MeshTopologyResponse,
  describeCloudError,
  fetchFederationStatus,
  fetchMeshTopology,
  getGatewayStatus,
  registerMeshCluster,
  subscribeGatewayStatus,
} from '../api/cloudClient';
import { colors, fontSize, monoFont, radius, spacing } from '../theme';

/**
 * 阶段二十 P0/P2 · **Pipeline Mesh 异构算力网格 · 多网关容灾联邦与白皮书 v3.0 合规大盘**。
 *
 * 三块内容：
 *   1. **Mesh 拓扑**：局域网内多机显存合体后的集群 / 分片 / 层切片表；
 *   2. **联邦状态**：协议版本、主备网关健康、全局账本状态根、PoI 验真率、
 *      DAO 锁模型数、活跃集群数（外加前端自己的**网关降级标记**）；
 *   3. **五大承诺自检矩阵**：白皮书 v3.0 的实时合规大盘（每项证据取自线上库）。
 *
 * 业主视角额外给一个一键**演练**入口：把当前组网节点（或一份可复现的
 * 2×6GB 模拟集群）登记进网关的 ``mesh_clusters`` 表。
 */

const short = (h?: string): string =>
  !h ? '—' : h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-6)}` : h;

const splitLabel = (sp: MeshLayerSplit, index: number): string => {
  if (sp.label) return sp.label;
  if (sp.layer_start !== undefined && sp.layer_end !== undefined) {
    return `L${sp.layer_start}-${sp.layer_end}`;
  }
  if (sp.layers !== undefined) return `${sp.layers} 层`;
  return `节点 ${index + 1}`;
};

/**
 * 阶段二十二 P2 · 诚实锚定标签。
 *
 * 旧文案一律叫「锚点」，但服务端的 State Root **只通过公开 API 发布**，
 * 从没做过链上 / 第三方外部锚定 —— 叫「锚点」属于误导。
 * 这里把机器可读状态翻成**如实描述**。
 */
const anchorLabel = (status?: string): string => {
  switch (status) {
    case 'published_via_api_not_externally_anchored':
      return '仅经公开 API 发布（未做链上 / 第三方外部锚定）';
    case '':
    case undefined:
    case null:
      return '未标注';
    default:
      return status;
  }
};

interface Props {
  /** 业主视角：额外显示「组建局域网 Pipeline Mesh 合体集群」演练 */
  owner?: boolean;
}

const MeshAndFederationCard: React.FC<Props> = ({ owner = false }) => {
  const [mesh, setMesh] = useState<MeshTopologyResponse | null>(null);
  const [fed, setFed] = useState<FederationStatusResponse | null>(null);
  const [gateway, setGateway] = useState<GatewayStatus>(getGatewayStatus());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [m, f] = await Promise.all([fetchMeshTopology(), fetchFederationStatus()]);
      setMesh(m);
      setFed(f);
    } catch (e: unknown) {
      setError(describeCloudError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 前端网关降级标记（主网关挂掉时会切到备用网关）
  useEffect(() => subscribeGatewayStatus(setGateway), []);

  /**
   * 业主一键演练：把当前组网节点登记成一个 Mesh 集群。
   *
   * 没有真实组网节点时，用一份**可复现**的 2×6GB 模拟集群
   * （80 层切 L0-39 / L40-79）走通全链路 —— 演练的是「登记 + 公示」，
   * 不是凭空捏造节点在线。
   */
  const runDrill = useCallback(async () => {
    setBusy(true);
    setDrill(null);
    try {
      const live = mesh?.live_nodes ?? [];
      const members: string[] = [];
      const splits: MeshLayerSplit[] = [];
      let vram = 0;
      let shards = 0;
      let rtt = 0;

      if (live.length >= 1) {
        live.forEach((n) => {
          if (n.node_id) members.push(n.node_id);
          vram += Number(n.cluster_vram_gb || 0);
          shards = Math.max(shards, Number(n.mesh_shards || 0));
          rtt = Math.max(rtt, Number(n.mesh_rtt_ms || 0));
        });
        const first = live[0];
        if (Array.isArray(first?.layer_splits) && first.layer_splits.length) {
          first.layer_splits.forEach((sp) => splits.push(sp));
        }
      } else {
        // 可复现的模拟拓扑：两台 6GB 节点合体 12GB，80 层对半切
        members.push('drill-node-a', 'drill-node-b');
        vram = 12;
        shards = 2;
        rtt = 3.2;
        splits.push(
          { label: 'drill-node-a', layer_start: 0, layer_end: 39, layers: 40, vram_gb: 6, rtt_ms: 3.2 },
          { label: 'drill-node-b', layer_start: 40, layer_end: 79, layers: 40, vram_gb: 6, rtt_ms: 3.2 },
        );
      }

      const res = await registerMeshCluster({
        leader_node_id: members[0] || 'drill-node-a',
        member_node_ids: members,
        cluster_vram_gb: Number(vram.toFixed(3)),
        mesh_shards: shards,
        mesh_rtt_ms: Number(rtt.toFixed(3)),
        layer_splits: splits,
        mode: 'Pipeline Shards',
      });
      setDrill(
        `演练完成：集群 ${res.cluster?.cluster_id || '—'} 已登记 · ${
          res.cluster?.member_node_ids?.length || members.length
        } 个成员 · 聚合显存 ${Number(vram.toFixed(1))} GB · ${shards} 分片`,
      );
      await load();
    } catch (e: unknown) {
      setDrill(describeCloudError(e, 'session'));
    } finally {
      setBusy(false);
    }
  }, [mesh, load]);

  const clusters: MeshClusterRow[] = mesh?.clusters ?? [];
  const pillars = fed?.compliance?.pillars ?? [];
  const compliant = pillars.filter((p) => p.compliant).length;

  return (
    <View style={styles.card} testID="mesh-federation-card" id="apx-glass-meshfed">
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleWrap}>
          <View style={styles.titleDot} />
          <Text style={styles.cardTitle}>
            🌐 Pipeline Mesh 异构算力网格 · 多网关容灾联邦与白皮书 v3.0 合规大盘
          </Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={load} activeOpacity={0.75}>
          <Text style={styles.refreshBtnText}>刷新</Text>
        </TouchableOpacity>
      </View>

      {/* 前端网关降级标记 */}
      <View style={[styles.gatewayBar, gateway.degraded && styles.gatewayBarDegraded]} testID="gateway-status">
        <Text style={styles.gatewayText}>
          {gateway.degraded ? '🔀 已降级到备用网关' : '🌐 主网关'}
        </Text>
        <Text style={styles.gatewayUrl} numberOfLines={1}>
          {gateway.baseUrl}
        </Text>
        {gateway.count > 1 && (
          <Text style={styles.gatewayMeta}>候选 {gateway.count} 个</Text>
        )}
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.loadingText}>正在拉取 Mesh 拓扑与联邦状态...</Text>
        </View>
      ) : error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <Text style={styles.errorHint}>请确认 APIPaw Cloud 网关已启动</Text>
        </View>
      ) : (
        <>
          {/* ---- 联邦 KPI ---- */}
          <View style={styles.kpiRow} testID="federation-kpis">
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>协议版本</Text>
              <Text style={styles.kpiValue}>{fed?.protocol_version || '—'}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>网关身份</Text>
              <Text style={[styles.kpiValue, styles.kpiMono]}>{fed?.gateway_node_id || '—'}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>网关健康</Text>
              <Text
                style={[
                  styles.kpiValue,
                  { color: fed?.federation?.all_healthy ? colors.accent : colors.warn },
                ]}
              >
                {fed?.federation?.healthy_count ?? 0}/{fed?.federation?.gateway_count ?? 0}
              </Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>PoI 验真率</Text>
              <Text style={styles.kpiValue}>
                {((fed?.poi?.verification_rate ?? 0) * 100).toFixed(1)}%
              </Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>DAO 锁模型</Text>
              <Text style={styles.kpiValue}>{fed?.dao?.locked_model_count ?? 0}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>活跃集群</Text>
              <Text style={styles.kpiValue}>{fed?.mesh?.registered_cluster_count ?? 0}</Text>
            </View>
            <View style={styles.kpiCell}>
              <Text style={styles.kpiLabel}>7 天真实推理</Text>
              <Text style={styles.kpiValue}>{fed?.real_traffic_7d ?? 0}</Text>
            </View>
          </View>

          {/* ---- 全局状态根锚点 ---- */}
          <View style={styles.rootBox} testID="federation-state-root">
            <Text style={styles.rootLabel}>全局账本 State Root 锚点</Text>
            <Text style={styles.rootValue}>{short(fed?.state_root?.state_root)}</Text>
            <Text style={styles.rootMeta}>
              ledger {fed?.state_root?.ledger_leaf_count ?? 0} 叶 · revenue{' '}
              {fed?.state_root?.revenue_leaf_count ?? 0} 叶 · {fed?.state_root?.algorithm || '—'}
            </Text>
            <Text style={styles.rootMeta}>
              锚定状态：{anchorLabel(fed?.state_root?.anchor_status)}
            </Text>
          </View>

          {/* ---- Mesh 分片拓扑 ---- */}
          <View style={styles.section} testID="mesh-shard-topology">
            <Text style={styles.sectionTitle}>🧩 合体集群与张量切片</Text>
            {clusters.length === 0 ? (
              <Text style={styles.emptyText}>
                暂无已登记的 Mesh 集群
                {owner ? '（点下方按钮可做一次演练登记）' : ''}
              </Text>
            ) : (
              clusters.map((c) => (
                <View key={c.cluster_id} style={styles.clusterBox} testID={`mesh-cluster-${c.cluster_id}`}>
                  <View style={styles.clusterHeader}>
                    <Text style={styles.clusterId}>{c.cluster_id}</Text>
                    <Text style={styles.clusterMeta}>
                      {c.mesh_shards} 分片 · {Number(c.cluster_vram_gb || 0).toFixed(1)} GB · RTT{' '}
                      {Number(c.mesh_rtt_ms || 0).toFixed(1)}ms
                    </Text>
                  </View>
                  <Text style={styles.clusterMembers}>
                    成员：{(c.member_node_ids || []).join(' / ') || '—'}
                  </Text>
                  {(c.layer_splits || []).map((sp, i) => (
                    <View key={`${c.cluster_id}-split-${i}`} style={styles.splitRow}>
                      <Text style={styles.splitLabel}>{splitLabel(sp, i)}</Text>
                      <Text style={styles.splitMeta}>
                        {Number(sp.vram_gb || 0).toFixed(1)} GB
                        {sp.rtt_ms !== undefined && sp.rtt_ms !== null
                          ? ` · ${Number(sp.rtt_ms).toFixed(1)}ms`
                          : ''}
                      </Text>
                    </View>
                  ))}
                </View>
              ))
            )}
          </View>

          {/* ---- 五大承诺合规矩阵 ---- */}
          <View style={styles.section} testID="compliance-matrix">
            <Text style={styles.sectionTitle}>
              {compliant === pillars.length && pillars.length > 0 ? '✅' : '🧭'} 白皮书 v3.0 五大承诺实时自检（实测{' '}
              {compliant}/{pillars.length} 合规）
            </Text>
            <Text style={styles.pillarNote}>
              判定依据是线上业务事实（真审计 / 真投票 / 真执行 / 真机流量 / 真实备网关），
              不是配置常量 ⇒ 合规率随真实能力浮动，不保证也不伪装成 100%。
            </Text>
            {pillars.map((p) => (
              <View key={p.id} style={styles.pillarRow} testID={`compliance-${p.id}`}>
                <Text style={[styles.pillarMark, { color: p.compliant ? colors.accent : colors.warn }]}>
                  {p.compliant ? '✔' : '!'}
                </Text>
                <View style={styles.pillarBody}>
                  <Text style={styles.pillarTitle}>{p.title}</Text>
                  <Text style={styles.pillarEvidence}>{summarizeEvidence(p.evidence)}</Text>
                </View>
              </View>
            ))}
          </View>

          {owner && (
            <View style={styles.ownerBox}>
              <TouchableOpacity
                style={[styles.drillBtn, busy && styles.drillBtnBusy]}
                onPress={runDrill}
                disabled={busy}
                activeOpacity={0.75}
                testID="mesh-drill-button"
              >
                <Text style={styles.drillBtnText}>
                  {busy ? '登记中...' : '🔗 组建局域网 Pipeline Mesh 合体集群'}
                </Text>
              </TouchableOpacity>
              {drill && (
                <Text style={styles.drillStatus} testID="mesh-drill-status">
                  {drill}
                </Text>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
};

/** 把自检证据压成一行可读文本（避免把对象直接渲染进 <Text>）。 */
const summarizeEvidence = (evidence: Record<string, unknown>): string => {
  if (!evidence) return '';
  const parts: string[] = [];
  Object.entries(evidence).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      parts.push(`${k}=${v.join('/')}`);
      return;
    }
    if (typeof v === 'object') return;
    const text = String(v);
    parts.push(`${k}=${text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-4)}` : text}`);
  });
  return parts.join(' · ');
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
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
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '800', flexShrink: 1 },
  refreshBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  refreshBtnText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },

  gatewayBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  gatewayBarDegraded: { backgroundColor: colors.warnSoft, borderColor: colors.warn },
  gatewayText: { color: colors.textPrimary, fontSize: fontSize.xs, fontWeight: '700' },
  gatewayUrl: { color: colors.textSecondary, fontSize: fontSize.xs, fontFamily: monoFont, flexShrink: 1 },
  gatewayMeta: { color: colors.textMuted, fontSize: fontSize.xs },

  loadingWrap: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  loadingText: { color: colors.textMuted, fontSize: fontSize.sm },
  errorWrap: { paddingVertical: spacing.lg, gap: spacing.sm },
  errorText: { color: colors.danger, fontSize: fontSize.sm },
  errorHint: { color: colors.textMuted, fontSize: fontSize.xs },

  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  kpiCell: { width: '31%', minWidth: 92, flexGrow: 1 },
  kpiLabel: { color: colors.textMuted, fontSize: 12, marginBottom: 2 },
  kpiValue: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  kpiMono: { fontFamily: monoFont, fontSize: fontSize.xs },

  rootBox: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
    gap: 2,
  },
  rootLabel: { color: colors.textMuted, fontSize: 12 },
  rootValue: { color: colors.cyan, fontSize: fontSize.sm, fontFamily: monoFont, fontWeight: '700' },
  rootMeta: { color: colors.textMuted, fontSize: fontSize.xs },

  section: { gap: spacing.sm },
  sectionTitle: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  emptyText: { color: colors.textMuted, fontSize: fontSize.xs },

  clusterBox: {
    backgroundColor: colors.cardAlt,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.divider,
    padding: spacing.md,
    gap: 4,
  },
  clusterHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  clusterId: { color: colors.purple, fontSize: fontSize.xs, fontFamily: monoFont, fontWeight: '700' },
  clusterMeta: { color: colors.textSecondary, fontSize: fontSize.xs },
  clusterMembers: { color: colors.textMuted, fontSize: fontSize.xs },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  splitLabel: { color: colors.textBody, fontSize: fontSize.xs, fontFamily: monoFont },
  splitMeta: { color: colors.textMuted, fontSize: fontSize.xs },

  pillarRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  pillarMark: { fontSize: fontSize.sm, fontWeight: '800', width: 14 },
  pillarBody: { flexShrink: 1, gap: 2 },
  pillarTitle: { color: colors.textPrimary, fontSize: fontSize.xs, fontWeight: '700' },
  pillarEvidence: { color: colors.textMuted, fontSize: 11, fontFamily: monoFont },

  pillarNote: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: spacing.sm,
  },

  ownerBox: { gap: spacing.sm },
  drillBtn: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.purple,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  drillBtnBusy: { opacity: 0.6 },
  drillBtnText: { color: colors.purple, fontSize: fontSize.sm, fontWeight: '800' },
  drillStatus: { color: colors.textSecondary, fontSize: fontSize.xs },
});

export default MeshAndFederationCard;
