import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, SafeAreaView, Image } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { Button, LoadingState, ErrorState, Card, SectionHeader } from '../../src/ui';
import { OrderStatusBadge } from '../../src/features/orders/components/OrderStatusBadge';
import { VerifyCodeBlock } from '../../src/features/orders/components/VerifyCodeBlock';
import { OrderTimeline } from '../../src/features/orders/components/OrderTimeline';
import { PriceDisplay } from '../../src/components';
import { MockOrderItem } from '../../src/features/orders/components/OrderCard';

// Extended mock order for details
interface MockOrderDetail extends MockOrderItem {
  items: Array<{
    id: string;
    title: string;
    sku: string;
    price: number;
    quantity: number;
    imageUrl: string;
  }>;
  contactName: string;
  contactPhone: string;
  remark: string;
  verifyCode?: string;
  timeline: Array<{ title: string; time: string; description?: string }>;
}

const mockOrder: MockOrderDetail = {
  id: 'ord_1001',
  orderNo: 'YL202608130001',
  status: 'pending',
  createTime: '2026-08-13 09:30',
  totalAmount: 49.9,
  totalQuantity: 1,
  productImage: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=80',
  productTitle: '校园定制 纯棉印花T恤',
  items: [
    {
      id: 'item_1',
      title: '校园定制 纯棉印花T恤',
      sku: '颜色: 白色; 尺码: L',
      price: 49.9,
      quantity: 1,
      imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=80',
    }
  ],
  contactName: '李同学',
  contactPhone: '13800138000',
  remark: '请在下午6点后送达',
  verifyCode: '839210483920',
  timeline: [
    { title: '订单已支付', time: '2026-08-13 09:31', description: '等待买家核销' },
    { title: '订单已提交', time: '2026-08-13 09:30' },
  ]
};

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  
  const [order, setOrder] = useState<MockOrderDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'success'>('loading');

  useEffect(() => {
    // 模拟加载
    setTimeout(() => {
      setOrder(mockOrder);
      setStatus('success');
    }, 800);
  }, [id]);

  const handleCancel = () => {
    // TODO(contract): real cancel mutation
    alert('撤回订单 (Mock)');
  };

  if (status === 'loading') {
    return <LoadingState message="加载订单详情..." />;
  }

  if (status === 'error' || !order) {
    return <ErrorState message="加载失败，请重试" onRetry={() => router.back()} />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* 头部状态 */}
        <View style={styles.headerArea}>
          <Text style={styles.orderNoLabel}>订单号: {order.orderNo}</Text>
          <OrderStatusBadge status={order.status} style={styles.statusBadge} />
        </View>

        {/* 核销码 (如果待核销) */}
        {order.status === 'pending' && order.verifyCode && (
          <VerifyCodeBlock code={order.verifyCode} style={styles.section} />
        )}

        {/* 商品列表 */}
        <Card style={styles.section}>
          <SectionHeader title="商品信息" />
          {order.items.map(item => (
            <View key={item.id} style={styles.itemRow}>
              <Image source={{ uri: item.imageUrl }} style={styles.itemImage} />
              <View style={styles.itemInfo}>
                <Text style={styles.itemTitle} numberOfLines={2}>{item.title}</Text>
                <Text style={styles.itemSku}>{item.sku}</Text>
                <View style={styles.itemFooter}>
                  <PriceDisplay price={item.price} size="sm" />
                  <Text style={styles.itemQuantity}>x{item.quantity}</Text>
                </View>
              </View>
            </View>
          ))}
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>实付金额</Text>
            <PriceDisplay price={order.totalAmount} size="md" />
          </View>
        </Card>

        {/* 联系方式 */}
        <Card style={styles.section}>
          <SectionHeader title="配送与联系" />
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>联系人</Text>
            <Text style={styles.infoValue}>{order.contactName}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>联系电话</Text>
            <Text style={styles.infoValue}>{order.contactPhone}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>备注信息</Text>
            <Text style={styles.infoValue}>{order.remark || '无'}</Text>
          </View>
        </Card>

        {/* 状态时间线 */}
        <Card style={styles.section}>
          <SectionHeader title="订单轨迹" />
          <OrderTimeline events={order.timeline} />
        </Card>

      </ScrollView>

      {/* 底部操作区 */}
      <View style={styles.bottomBarArea}>
        <View style={styles.bottomBar}>
          <Button 
            title="申请退货" 
            variant="secondary" 
            onPress={() => router.push(`/orders/${order.id}/return`)}
            style={styles.actionBtn}
          />
          {order.status === 'pending' && (
            <Button 
              title="撤回订单" 
              variant="danger" 
              onPress={handleCancel}
              style={[styles.actionBtn, { marginLeft: theme.spacing.sm }] as any}
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    padding: theme.spacing.md,
    paddingBottom: 100,
  },
  headerArea: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
    paddingHorizontal: theme.spacing.xs,
  },
  orderNoLabel: {
    ...theme.typography.body,
    fontWeight: '500',
  },
  statusBadge: {
    transform: [{ scale: 1.1 }],
  },
  section: {
    marginBottom: theme.spacing.md,
  },
  itemRow: {
    flexDirection: 'row',
    marginBottom: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.background,
  },
  itemImage: {
    width: 60,
    height: 60,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.background,
    marginRight: theme.spacing.sm,
  },
  itemInfo: {
    flex: 1,
    justifyContent: 'space-between',
  },
  itemTitle: {
    ...theme.typography.body,
    fontSize: theme.fontSize.sm,
  },
  itemSku: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
    marginTop: 2,
  },
  itemFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
  itemQuantity: {
    ...theme.typography.body,
    color: theme.colors.subtext,
    fontSize: theme.fontSize.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.sm,
  },
  summaryLabel: {
    ...theme.typography.body,
    fontWeight: '500',
  },
  infoRow: {
    flexDirection: 'row',
    marginBottom: theme.spacing.sm,
  },
  infoLabel: {
    ...theme.typography.body,
    color: theme.colors.subtext,
    width: 80,
  },
  infoValue: {
    ...theme.typography.body,
    flex: 1,
  },
  bottomBarArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    ...theme.shadows.md,
  },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  actionBtn: {
    minWidth: 100,
  },
});
