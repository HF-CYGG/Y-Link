import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, SafeAreaView, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { theme } from '../../../src/theme';
import { Button, LoadingState, SectionHeader, Card } from '../../../src/ui';
import { ReturnItemRow, ReturnItem } from '../../../src/features/returns/components/ReturnItemRow';

// Mock server response
const mockReturnableItems: ReturnItem[] = [
  {
    id: 'item_1',
    title: '校园定制 纯棉印花T恤',
    sku: '颜色: 白色; 尺码: L',
    price: 49.9,
    imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=80',
    maxReturnableQuantity: 1, // 可退数量必须来自 Mock 服务端字段
  }
];

export default function ReturnApplicationScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  
  const [items, setItems] = useState<ReturnItem[]>([]);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // 模拟拉取可退商品
    setTimeout(() => {
      setItems(mockReturnableItems);
      // 默认全退
      const initialQuantities: Record<string, number> = {};
      mockReturnableItems.forEach(item => {
        initialQuantities[item.id] = item.maxReturnableQuantity;
      });
      setReturnQuantities(initialQuantities);
      setIsLoading(false);
    }, 800);
  }, [id]);

  const handleQuantityChange = (itemId: string, quantity: number) => {
    setReturnQuantities(prev => ({
      ...prev,
      [itemId]: quantity
    }));
  };

  const handleSubmit = () => {
    const totalReturnQty = Object.values(returnQuantities).reduce((a, b) => a + b, 0);
    if (totalReturnQty === 0) {
      alert('请选择要退货的商品及数量');
      return;
    }
    
    if (!reason.trim()) {
      alert('请填写退货原因');
      return;
    }
    
    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      // TODO(contract): real return application mutation
      alert('退货申请已提交 (Mock)');
      router.back();
    }, 1000);
  };

  if (isLoading) {
    return <LoadingState message="加载可退商品信息..." />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        <Card style={styles.section}>
          <SectionHeader title="申请退货的商品" />
          {items.map(item => (
            <ReturnItemRow 
              key={item.id}
              item={item}
              quantity={returnQuantities[item.id] || 0}
              onChangeQuantity={(qty) => handleQuantityChange(item.id, qty)}
            />
          ))}
        </Card>

        <Card style={styles.section}>
          <SectionHeader title="退货原因" />
          <TextInput 
            style={styles.reasonInput}
            multiline
            numberOfLines={4}
            placeholder="请详细描述您的退货原因，以便我们尽快为您处理..."
            placeholderTextColor={theme.colors.placeholder}
            value={reason}
            onChangeText={setReason}
            textAlignVertical="top"
          />
        </Card>

      </ScrollView>

      <View style={styles.bottomBarArea}>
        <View style={styles.bottomBar}>
          <Button 
            title="提交申请" 
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
    paddingBottom: 100,
  },
  section: {
    marginBottom: theme.spacing.md,
  },
  reasonInput: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    minHeight: 120,
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
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
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  submitBtn: {
    width: '100%',
    borderRadius: theme.radius.full,
  },
});
