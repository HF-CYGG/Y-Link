import React, { useState, useEffect, useMemo } from 'react';
import { View, StyleSheet, ScrollView, SafeAreaView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { LoadingState, EmptyState, ErrorState } from '../../src/ui';
import { CartItemRow, CartItem } from '../../src/features/cart/components/CartItemRow';
import { CartSummaryBar } from '../../src/features/cart/components/CartSummaryBar';

const mockCartData: CartItem[] = [
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
  },
  {
    id: 'cart_2',
    productId: 'p_102',
    title: '便携式迷你加湿器 宿舍静音大雾量',
    skuText: '颜色: 樱花粉',
    price: 35.0,
    quantity: 2,
    imageUrl: 'https://images.unsplash.com/photo-1595859702882-938b8eb97e28?w=400&q=80',
    stock: 0,
    status: 'out_of_stock',
  },
  {
    id: 'cart_3',
    productId: 'p_103',
    title: '已下架的旧商品',
    skuText: '型号: 默认',
    price: 99.0,
    quantity: 1,
    imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400&q=80',
    stock: 0,
    status: 'unavailable',
  },
];

export default function CartScreen() {
  const router = useRouter();
  
  const [items, setItems] = useState<CartItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'loading' | 'error' | 'success'>('loading');

  useEffect(() => {
    loadCart();
  }, []);

  const loadCart = () => {
    setStatus('loading');
    setTimeout(() => {
      setItems(mockCartData);
      setSelectedIds(new Set(['cart_1'])); // 默认选中第一个
      setStatus('success');
    }, 800);
  };

  const handleSelect = (id: string, selected: boolean) => {
    const next = new Set(selectedIds);
    if (selected) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setSelectedIds(next);
  };

  const handleSelectAll = (selected: boolean) => {
    if (selected) {
      const allAvailableIds = items.filter(i => i.status === 'normal').map(i => i.id);
      setSelectedIds(new Set(allAvailableIds));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleChangeQuantity = (id: string, quantity: number) => {
    setItems(items.map(i => i.id === id ? { ...i, quantity } : i));
  };

  const handleDelete = (id: string) => {
    Alert.alert('删除商品', '确认将该商品移出购物车吗？', [
      { text: '取消', style: 'cancel' },
      { text: '确定', onPress: () => {
          setItems(items.filter(i => i.id !== id));
          if (selectedIds.has(id)) {
            const next = new Set(selectedIds);
            next.delete(id);
            setSelectedIds(next);
          }
        }, style: 'destructive'
      }
    ]);
  };

  const handleCheckout = () => {
    router.push('/checkout');
  };

  const availableItems = items.filter(i => i.status === 'normal');
  const isAllSelected = availableItems.length > 0 && selectedIds.size === availableItems.length;
  
  const totalAmount = useMemo(() => {
    return items.reduce((sum, item) => {
      if (selectedIds.has(item.id)) {
        return sum + item.price * item.quantity;
      }
      return sum;
    }, 0);
  }, [items, selectedIds]);

  if (status === 'loading') {
    return <LoadingState message="正在加载购物车..." style={{ backgroundColor: theme.colors.background }} />;
  }

  if (status === 'error') {
    return <ErrorState message="获取购物车失败" onRetry={loadCart} style={{ backgroundColor: theme.colors.background }} />;
  }

  if (items.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <EmptyState 
          title="购物车为空" 
          description="去商城看看有没有需要的商品吧" 
          actionLabel="去逛逛"
          onAction={() => router.push('/(tabs)/mall')}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {items.map(item => (
          <CartItemRow 
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onSelect={handleSelect}
            onChangeQuantity={handleChangeQuantity}
            onDelete={handleDelete}
          />
        ))}
      </ScrollView>

      <CartSummaryBar 
        totalAmount={totalAmount}
        selectedCount={selectedIds.size}
        isAllSelected={isAllSelected}
        onToggleAll={handleSelectAll}
        onCheckout={handleCheckout}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
});
