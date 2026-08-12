import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ViewStyle } from 'react-native';
import { theme } from '../theme';
import { PriceDisplay } from './PriceDisplay';
import { StockBadge } from './StockBadge';

// TODO(contract): Replace with actual shared-types DTO when available
export interface MockProduct {
  id: string;
  title: string;
  imageUrl: string;
  price: number;
  originalPrice?: number;
  stock: number;
  tags?: string[];
}

export interface ProductCardProps {
  product: MockProduct;
  onPress?: (product: MockProduct) => void;
  style?: ViewStyle;
}

export function ProductCard({ product, onPress, style }: ProductCardProps) {
  return (
    <TouchableOpacity 
      style={[styles.container, style]} 
      onPress={() => onPress?.(product)}
      activeOpacity={0.8}
    >
      <Image 
        source={{ uri: product.imageUrl }} 
        style={styles.image}
        resizeMode="cover"
      />
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>
          {product.title}
        </Text>
        
        {product.tags && product.tags.length > 0 && (
          <View style={styles.tagsContainer}>
            {product.tags.map((tag, index) => (
              <View key={index} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        )}
        
        <View style={styles.footer}>
          <PriceDisplay 
            price={product.price} 
            originalPrice={product.originalPrice} 
            size="md" 
          />
          <StockBadge stock={product.stock} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    ...theme.shadows.sm,
  },
  image: {
    width: '100%',
    aspectRatio: 1, // Square image
    backgroundColor: theme.colors.background,
  },
  content: {
    padding: theme.spacing.sm,
  },
  title: {
    ...theme.typography.body,
    fontWeight: '500',
    marginBottom: theme.spacing.xs,
    minHeight: 40, // accommodate 2 lines
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: theme.spacing.xs,
  },
  tag: {
    backgroundColor: theme.colors.background,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: theme.radius.sm,
    marginRight: 4,
    marginBottom: 4,
  },
  tagText: {
    fontSize: 10,
    color: theme.colors.primary,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
});
