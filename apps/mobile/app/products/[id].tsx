import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, TouchableOpacity, SafeAreaView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { Button, LoadingState, ErrorState, Badge } from '../../src/ui';
import { PriceDisplay, StockBadge, SkuSelectorSheet, MockProduct } from '../../src/components';
import { mockProducts } from '../../src/features/mall/mock/products';

export default function ProductDetailScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  
  const [product, setProduct] = useState<MockProduct | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [skuSheetVisible, setSkuSheetVisible] = useState(false);
  const [actionType, setActionType] = useState<'cart' | 'buy'>('buy');

  useEffect(() => {
    // 模拟根据 ID 加载商品详情
    setTimeout(() => {
      const found = mockProducts.find(p => p.id === id) || mockProducts[0];
      setProduct(found);
      setIsLoading(false);
    }, 600);
  }, [id]);

  const handleOpenSku = (type: 'cart' | 'buy') => {
    setActionType(type);
    setSkuSheetVisible(true);
  };

  const handleConfirm = (quantity: number) => {
    // 仅作 UI 占位，不接真实 API
    alert(`模拟操作：已将 ${quantity} 件商品加入${actionType === 'cart' ? '购物车' : '预订单'}`);
  };

  if (isLoading) {
    return <LoadingState message="加载商品详情..." style={{ backgroundColor: theme.colors.background }} />;
  }

  if (!product) {
    return (
      <View style={styles.errorContainer}>
        <ErrorState message="找不到该商品" onRetry={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* 商品主图 */}
        <Image source={{ uri: product.imageUrl }} style={styles.image} />
        
        {/* 基本信息区 */}
        <View style={styles.infoSection}>
          <View style={styles.priceRow}>
            <PriceDisplay price={product.price} originalPrice={product.originalPrice} size="xl" />
            <StockBadge stock={product.stock} />
          </View>
          
          <Text style={styles.title}>{product.title}</Text>
          
          {product.tags && product.tags.length > 0 && (
            <View style={styles.tagsContainer}>
              {product.tags.map((tag, idx) => (
                <Badge key={idx} label={tag} variant="info" style={styles.tag} />
              ))}
            </View>
          )}
        </View>

        {/* 规格选择入口 */}
        <TouchableOpacity style={styles.selectorSection} onPress={() => handleOpenSku('buy')}>
          <Text style={styles.selectorLabel}>选择规格</Text>
          <Text style={styles.selectorValue}>请选择数量</Text>
          <Text style={styles.selectorIcon}>›</Text>
        </TouchableOpacity>
        
        {/* 详情介绍 (假数据) */}
        <View style={styles.detailSection}>
          <Text style={styles.detailTitle}>商品详情</Text>
          <Text style={styles.detailText}>
            【产品说明】{'\n'}
            这里是商品的详细描述占位符。这是一款非常适合校园生活的产品。{'\n\n'}
            【发货说明】{'\n'}
            通常下单后24小时内配送至宿舍楼下自提点。
          </Text>
        </View>
      </ScrollView>

      {/* 底部操作栏 */}
      <SafeAreaView style={styles.bottomBarArea}>
        <View style={styles.bottomBar}>
          <TouchableOpacity style={styles.iconButton} onPress={() => router.push('/(tabs)/mall')}>
            <Text style={styles.iconButtonText}>🏠</Text>
            <Text style={styles.iconButtonLabel}>商城</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconButton}>
            <Text style={styles.iconButtonText}>🛒</Text>
            <Text style={styles.iconButtonLabel}>购物车</Text>
          </TouchableOpacity>
          
          <View style={styles.actionButtons}>
            <Button 
              title="加入购物车" 
              variant="secondary" 
              style={[styles.actionBtn, styles.cartBtn] as any} 
              onPress={() => handleOpenSku('cart')}
              disabled={product.stock === 0}
            />
            <Button 
              title="立即预订" 
              variant="primary" 
              style={[styles.actionBtn, styles.buyBtn] as any} 
              onPress={() => handleOpenSku('buy')}
              disabled={product.stock === 0}
            />
          </View>
        </View>
      </SafeAreaView>

      <SkuSelectorSheet 
        visible={skuSheetVisible} 
        product={product} 
        onClose={() => setSkuSheetVisible(false)} 
        onConfirm={handleConfirm}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  errorContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    paddingBottom: 100,
  },
  image: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: theme.colors.surface,
  },
  infoSection: {
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  title: {
    ...theme.typography.h2,
    marginBottom: theme.spacing.md,
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tag: {
    marginRight: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  selectorSection: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  selectorLabel: {
    ...theme.typography.body,
    color: theme.colors.subtext,
    width: 80,
  },
  selectorValue: {
    ...theme.typography.body,
    flex: 1,
  },
  selectorIcon: {
    fontSize: 20,
    color: theme.colors.subtext,
  },
  detailSection: {
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
    minHeight: 300,
  },
  detailTitle: {
    ...theme.typography.h3,
    marginBottom: theme.spacing.md,
  },
  detailText: {
    ...theme.typography.body,
    color: theme.colors.subtext,
    lineHeight: 24,
  },
  bottomBarArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.surface,
    ...theme.shadows.md,
  },
  bottomBar: {
    flexDirection: 'row',
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    alignItems: 'center',
  },
  iconButton: {
    paddingHorizontal: theme.spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonText: {
    fontSize: 20,
    marginBottom: 2,
  },
  iconButtonLabel: {
    fontSize: 10,
    color: theme.colors.subtext,
  },
  actionButtons: {
    flex: 1,
    flexDirection: 'row',
    marginLeft: theme.spacing.sm,
  },
  actionBtn: {
    flex: 1,
  },
  cartBtn: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderRightWidth: 0,
  },
  buyBtn: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
  },
});
