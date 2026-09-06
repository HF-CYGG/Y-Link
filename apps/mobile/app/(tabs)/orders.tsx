import React, { useState, useEffect } from 'react';
import { View, StyleSheet, FlatList, SafeAreaView, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { SectionHeader, EmptyState, ErrorState, LoadingState } from '../../src/ui';
import { OrderCard, MockOrderItem } from '../../src/features/orders/components/OrderCard';

const mockOrders: MockOrderItem[] = [
  {
    id: 'ord_1001',
    orderNo: 'YL202608130001',
    status: 'pending',
    createTime: '2026-08-13 09:30',
    totalAmount: 49.9,
    totalQuantity: 1,
    productImage: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=80',
    productTitle: '校园定制 纯棉印花T恤',
  },
  {
    id: 'ord_1002',
    orderNo: 'YL202608120099',
    status: 'verified',
    createTime: '2026-08-12 14:20',
    totalAmount: 70.0,
    totalQuantity: 2,
    productImage: 'https://images.unsplash.com/photo-1595859702882-938b8eb97e28?w=400&q=80',
    productTitle: '便携式迷你加湿器 宿舍静音大雾量 等',
  },
  {
    id: 'ord_1003',
    orderNo: 'YL202608100042',
    status: 'cancelled',
    createTime: '2026-08-10 10:15',
    totalAmount: 129.0,
    totalQuantity: 1,
    productImage: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400&q=80',
    productTitle: '真无线蓝牙耳机 半入耳式',
  }
];

export default function OrdersScreen() {
  const router = useRouter();
  const [orders, setOrders] = useState<MockOrderItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'success'>('loading');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadOrders();
  }, []);

  const loadOrders = () => {
    setStatus('loading');
    setTimeout(() => {
      setOrders(mockOrders);
      setStatus('success');
    }, 800);
  };

  const onRefresh = () => {
    setRefreshing(true);
    setTimeout(() => {
      setOrders(mockOrders);
      setRefreshing(false);
    }, 1000);
  };

  const renderContent = () => {
    if (status === 'loading' && !refreshing) {
      return <LoadingState message="加载订单列表中..." />;
    }

    if (status === 'error') {
      return <ErrorState message="加载失败，请重试" onRetry={loadOrders} />;
    }

    if (orders.length === 0) {
      return <EmptyState title="暂无订单" description="您还没有任何订单记录" icon="📝" />;
    }

    return (
      <FlatList
        data={orders}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <OrderCard 
            order={item} 
            onPress={(order) => router.push(`/orders/${order.id}`)}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl 
            refreshing={refreshing} 
            onRefresh={onRefresh} 
            colors={[theme.colors.primary]}
            tintColor={theme.colors.primary}
          />
        }
      />
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <SectionHeader title="我的订单" />
      </View>
      <View style={styles.container}>
        {renderContent()}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  container: {
    flex: 1,
  },
  listContent: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
});
