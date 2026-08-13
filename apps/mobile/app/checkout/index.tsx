import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, SafeAreaView, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { Input, Button, Card, SectionHeader } from '../../src/ui';
import { PriceDisplay } from '../../src/components';
import { CartItem } from '../../src/features/cart/components/CartItemRow';

// Mock data
const mockCheckoutItems: CartItem[] = [
  {
    id: 'cart_1',
    productId: 'p_101',
    title: '校园定制 纯棉印花T恤',
    skuText: '颜色: 白色; 尺码: L',
    price: 49.9,
    quantity: 1,
    imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=80',
    stock: 200,
    status: 'normal',
  }
];

export default function CheckoutScreen() {
  const router = useRouter();
  const [contactName, setContactName] = useState('李同学');
  const [contactPhone, setContactPhone] = useState('13800138000');
  const [remark, setRemark] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 金额只使用 Mock 服务端结果，不在 UI 代码里构建最终订单金额业务规则
  const mockOrderSummary = {
    totalAmount: 49.9,
    freightAmount: 0,
    payableAmount: 49.9,
  };

  const handleSubmit = () => {
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      // TODO(contract): real checkout mutation
      alert('预订成功 (Mock)');
      router.replace('/(tabs)/orders');
    }, 1000);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* 联系方式 */}
        <Card style={styles.sectionCard}>
          <SectionHeader title="联系方式" />
          <Input 
            label="联系人" 
            value={contactName}
            onChangeText={setContactName}
            placeholder="请输入联系人姓名"
          />
          <Input 
            label="手机号码" 
            value={contactPhone}
            onChangeText={setContactPhone}
            placeholder="请输入手机号码"
            keyboardType="phone-pad"
            containerStyle={{ marginBottom: 0 }}
          />
        </Card>

        {/* 商品列表 */}
        <Card style={styles.sectionCard}>
          <SectionHeader title="商品清单" />
          {mockCheckoutItems.map(item => (
            <View key={item.id} style={styles.itemRow}>
              <Image source={{ uri: item.imageUrl }} style={styles.itemImage} />
              <View style={styles.itemInfo}>
                <Text style={styles.itemTitle} numberOfLines={2}>{item.title}</Text>
                <Text style={styles.itemSku}>{item.skuText}</Text>
                <View style={styles.itemFooter}>
                  <PriceDisplay price={item.price} size="sm" />
                  <Text style={styles.itemQuantity}>x{item.quantity}</Text>
                </View>
              </View>
            </View>
          ))}
        </Card>

        {/* 备注 */}
        <Card style={styles.sectionCard}>
          <SectionHeader title="订单备注" />
          <Input 
            value={remark}
            onChangeText={setRemark}
            placeholder="选填，给商家留言"
            containerStyle={{ marginBottom: 0 }}
          />
        </Card>

        {/* 金额明细 */}
        <Card style={styles.sectionCard}>
          <SectionHeader title="金额明细" />
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>商品总计</Text>
            <PriceDisplay price={mockOrderSummary.totalAmount} size="sm" />
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>配送费</Text>
            <PriceDisplay price={mockOrderSummary.freightAmount} size="sm" />
          </View>
        </Card>

      </ScrollView>

      {/* 底部悬浮条 */}
      <View style={styles.bottomBarArea}>
        <View style={styles.bottomBar}>
          <View style={styles.priceInfo}>
            <Text style={styles.totalLabel}>应付: </Text>
            <Text style={styles.currency}>¥</Text>
            <Text style={styles.totalPrice}>{mockOrderSummary.payableAmount.toFixed(2)}</Text>
          </View>
          <Button 
            title="提交预订" 
            onPress={handleSubmit} 
            loading={isSubmitting}
            style={styles.submitBtn}
          />
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
    paddingBottom: 100, // 留出底部栏空间
  },
  sectionCard: {
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
    marginBottom: theme.spacing.sm,
  },
  summaryLabel: {
    ...theme.typography.body,
    color: theme.colors.subtext,
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  priceInfo: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  totalLabel: {
    ...theme.typography.body,
  },
  currency: {
    color: theme.colors.danger,
    fontWeight: 'bold',
    fontSize: theme.fontSize.sm,
    marginRight: 2,
  },
  totalPrice: {
    color: theme.colors.danger,
    fontWeight: 'bold',
    fontSize: theme.fontSize.lg,
  },
  submitBtn: {
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.xl,
  },
});
