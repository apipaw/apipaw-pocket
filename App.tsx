import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ScrollView, SafeAreaView, StatusBar, RefreshControl } from 'react-native';
import { HostTab, usePawStore } from './src/store/usePawStore';
import {
  fetchOwnerDashboard,
  fetchUserUsage,
  toggleNodeStatus,
  OwnerDashboard,
} from './src/api/cloudClient';
import PlaygroundCard from './src/components/PlaygroundCard';
import AnalyticsCard from './src/components/AnalyticsCard';
import ModelStudioCard from './src/components/ModelStudioCard';
import PipelineMeshCard from './src/components/PipelineMeshCard';
import RoyaltyCard from './src/components/RoyaltyCard';
import { colors, fontSize, radius, spacing } from './src/theme';

const HOST_TABS: Array<{ key: HostTab; label: string }> = [
  { key: 'NODES', label: '算力节点' },
  { key: 'STUDIO', label: '模型工作台' },
  { key: 'ROYALTY', label: '版税大盘' },
];

export default function App() {
  const {
    roleMode,
    setRoleMode,
    apiKey,
    balanceUsd,
    setBalanceUsd,
    dailyLimitUsd,
    setDailyLimitUsd,
    spentTodayUsd,
    hostTab,
    setHostTab,
  } = usePawStore();
  const [dashboard, setDashboard] = useState<OwnerDashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = async () => {
    try {
      const data = await fetchOwnerDashboard();
      setDashboard(data);
    } catch (e) {
      console.log('加载 Cloud API 失败:', e);
    }
  };

  const loadUsage = async () => {
    try {
      const usage = await fetchUserUsage();
      setBalanceUsd(usage.balance_usd);
      setDailyLimitUsd(usage.daily_limit_usd);
    } catch (e) {
      console.log('加载账户额度失败:', e);
    }
  };

  useEffect(() => {
    loadData();
    loadUsage();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    await loadUsage();
    setRefreshing(false);
  };

  const handleToggleNode = async (nodeId: string) => {
    await toggleNodeStatus(nodeId);
    await loadData();
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Text style={styles.brandTitle}> APIPaw Pocket</Text>
        <TouchableOpacity
          style={styles.switchBtn}
          onPress={() => setRoleMode(roleMode === 'BUYER' ? 'HOST' : 'BUYER')}
        >
          <Text style={styles.switchText}>
            {roleMode === 'BUYER' ? '切换至业主视角 ' : '切换至买家视角 '}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" />}
      >
        {roleMode === 'BUYER' ? (
          <View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}> API 账户余额与 Token 额度</Text>
              <Text style={styles.balanceText}>${balanceUsd.toFixed(2)} USD</Text>
              <Text style={styles.subText}>当前密钥: {apiKey.substring(0, 16)}...</Text>
              <Text style={styles.subText}>
                今日已消费 ${spentTodayUsd.toFixed(4)} / 单日上限 ${dailyLimitUsd.toFixed(0)}
              </Text>
              <Text style={styles.subText}>在线可用节点: {dashboard?.active_nodes_online || 0} 台</Text>
            </View>

            <PlaygroundCard />

            <AnalyticsCard />
          </View>
        ) : (
          <View>
            {/* HOST 分段切换 */}
            <View style={styles.segmentWrap} testID="host-tabs">
              {HOST_TABS.map((tab) => {
                const active = tab.key === hostTab;
                return (
                  <TouchableOpacity
                    key={tab.key}
                    testID={`host-tab-${tab.key}`}
                    style={[styles.segment, active && styles.segmentActive]}
                    onPress={() => setHostTab(tab.key)}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {tab.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {hostTab === 'NODES' && (
              <View>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}> 算力节点远控面板</Text>
                  <Text style={styles.bodyText}>在线挂机节点数: {dashboard?.active_nodes_online || 0} 台</Text>
                  <Text style={styles.bodyText}>全网注册节点数: {dashboard?.registered_nodes_total || 0} 台</Text>
                </View>

                {dashboard?.nodes.map((node) => (
                  <View key={node.node_id} style={styles.card}>
                    <View style={styles.rowBetween}>
                      <Text style={styles.nodeIdText}>节点: {node.node_id}</Text>
                      <Text style={node.is_paused ? styles.statusPaused : styles.statusActive}>
                        {node.is_paused ? '已暂停' : ' 允许接单'}
                      </Text>
                    </View>
                    <Text style={styles.subText}>累计处理 Tokens: {node.total_tokens_processed}</Text>
                    <Text style={styles.subText}>累计赚取 $PAW: {node.total_earnings_paw.toFixed(4)} PAW</Text>

                    <TouchableOpacity
                      style={[styles.actionBtn, node.is_paused ? styles.btnResume : styles.btnPause]}
                      onPress={() => handleToggleNode(node.node_id)}
                    >
                      <Text style={styles.btnText}>
                        {node.is_paused ? '远程指令: 恢复允许接单' : '远程指令: 一键暂停接单'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {hostTab === 'STUDIO' && (
              <View>
                <ModelStudioCard />
                <PipelineMeshCard />
              </View>
            )}

            {hostTab === 'ROYALTY' && (
              <View>
                <RoyaltyCard />
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  brandTitle: { fontSize: 20, fontWeight: 'bold', color: '#10B981' },
  switchBtn: { backgroundColor: '#1E293B', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  switchText: { color: '#8B5CF6', fontSize: 12, fontWeight: '600' },
  scrollContent: { padding: 16 },
  card: { backgroundColor: '#1E293B', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#334155' },
  cardTitle: { color: '#94A3B8', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  balanceText: { color: '#F8FAFC', fontSize: 28, fontWeight: 'bold', marginVertical: 4 },
  bodyText: { color: '#CBD5E1', fontSize: 14, marginVertical: 2 },
  subText: { color: '#64748B', fontSize: 12, marginTop: 4 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  nodeIdText: { color: '#F8FAFC', fontSize: 16, fontWeight: 'bold' },
  statusActive: { color: '#10B981', fontWeight: 'bold' },
  statusPaused: { color: '#EF4444', fontWeight: 'bold' },
  actionBtn: { backgroundColor: '#10B981', padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 12 },
  btnPause: { backgroundColor: '#DC2626' },
  btnResume: { backgroundColor: '#059669' },
  btnText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 14 },

  segmentWrap: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    marginBottom: spacing.lg,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: colors.purpleSoft },
  segmentText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700' },
  segmentTextActive: { color: colors.purple },
});
