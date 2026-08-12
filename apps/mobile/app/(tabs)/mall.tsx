import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, SafeAreaView, FlatList, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { SearchBar, SectionHeader, Skeleton, EmptyState, ErrorState, Badge } from '../../src/ui';
import { ProductCard, MockProduct } from '../../src/components';
import { mockProducts } from '../../src/features/mall/mock/products';

const CATEGORIES = ['全部', '推荐', '日用百货', '零食饮料', '数码周边', '学习用品'];

export default function MallScreen() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('全部');
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [products, setProducts] = useState<MockProduct[]>([]);

  useEffect(() => {
    // 模拟数据加载
    loadData();
  }, [activeCategory]);

  const loadData = () => {
    setIsLoading(true);
    setIsError(false);
    
    setTimeout(() => {
      // 模拟偶尔报错 (为了展示ErrorState，可以注释掉这部分)
      // if (Math.random() > 0.8) {
      //   setIsError(true);
      //   setIsLoading(false);
      //   return;
      // }
      
      if (activeCategory === '全部' || activeCategory === '推荐') {
        setProducts(mockProducts);
      } else {
        // 模拟空状态
        setProducts([]);
      }
      setIsLoading(false);
    }, 1000);
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <View style={styles.gridContainer}>
          {[1, 2, 3, 4].map((item) => (
            <View key={item} style={styles.skeletonCard}>
              <Skeleton height={160} style={styles.skeletonImage} />
              <Skeleton height={20} width="80%" style={{ marginBottom: 8 }} />
              <Skeleton height={14} width="40%" style={{ marginBottom: 16 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Skeleton height={20} width={60} />
                <Skeleton height={20} width={40} />
              </View>
            </View>
          ))}
        </View>
      );
    }

    if (isError) {
      return <ErrorState message="加载商品失败，请检查网络" onRetry={loadData} />;
    }

    if (products.length === 0) {
      return <EmptyState title="暂无商品" description="该分类下暂无商品，去看看别的吧" />;
    }

    return (
      <View style={styles.gridContainer}>
        {products.map((product) => (
          <View key={product.id} style={styles.cardWrapper}>
            <ProductCard 
              product={product} 
              onPress={(p) => router.push(`/products/${p.id}`)}
            />
          </View>
        ))}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.welcomeArea}>
          <Text style={styles.greeting}>下午好，</Text>
          <Text style={styles.username}>李同学</Text>
        </View>
        
        <SearchBar 
          placeholder="搜索您需要的商品" 
          value={searchQuery}
          onChangeText={setSearchQuery}
          onClear={() => setSearchQuery('')}
          style={styles.searchBar}
        />
      </View>

      <View style={styles.categoriesContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoriesScroll}>
          {CATEGORIES.map((cat) => (
            <TouchableOpacity 
              key={cat} 
              style={[
                styles.categoryChip, 
                activeCategory === cat && styles.categoryChipActive
              ]}
              onPress={() => setActiveCategory(cat)}
            >
              <Text style={[
                styles.categoryText,
                activeCategory === cat && styles.categoryTextActive
              ]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <SectionHeader title="为你推荐" />
        {renderContent()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    padding: theme.spacing.lg,
    paddingBottom: theme.spacing.md,
    backgroundColor: theme.colors.surface,
  },
  welcomeArea: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: theme.spacing.md,
  },
  greeting: {
    ...theme.typography.h2,
    fontWeight: 'normal',
  },
  username: {
    ...theme.typography.h2,
    color: theme.colors.primary,
  },
  searchBar: {
    marginBottom: theme.spacing.xs,
  },
  categoriesContainer: {
    backgroundColor: theme.colors.surface,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  categoriesScroll: {
    paddingHorizontal: theme.spacing.md,
  },
  categoryChip: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.full,
    marginRight: theme.spacing.sm,
    backgroundColor: theme.colors.background,
  },
  categoryChipActive: {
    backgroundColor: theme.colors.primary,
  },
  categoryText: {
    ...theme.typography.body,
    fontSize: theme.fontSize.sm,
    color: theme.colors.text,
  },
  categoryTextActive: {
    color: theme.colors.white,
    fontWeight: 'bold',
  },
  scrollContent: {
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  cardWrapper: {
    width: '48%',
    marginBottom: theme.spacing.md,
  },
  skeletonCard: {
    width: '48%',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  skeletonImage: {
    width: '100%',
    marginBottom: theme.spacing.md,
    borderRadius: theme.radius.sm,
  },
});
