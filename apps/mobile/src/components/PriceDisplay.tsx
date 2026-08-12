import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { theme } from '../theme';

export interface PriceDisplayProps {
  price: number;
  originalPrice?: number;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  style?: ViewStyle;
}

export function PriceDisplay({ price, originalPrice, size = 'md', style }: PriceDisplayProps) {
  const getFontSize = () => {
    switch(size) {
      case 'sm': return theme.fontSize.sm;
      case 'md': return theme.fontSize.md;
      case 'lg': return theme.fontSize.lg;
      case 'xl': return theme.fontSize.xl;
      default: return theme.fontSize.md;
    }
  };

  const currentSize = getFontSize();

  return (
    <View style={[styles.container, style]}>
      <Text style={[styles.currency, { fontSize: currentSize * 0.7 }]}>¥</Text>
      <Text style={[styles.price, { fontSize: currentSize }]}>
        {price.toFixed(2)}
      </Text>
      {originalPrice && originalPrice > price ? (
        <Text style={[styles.originalPrice, { fontSize: currentSize * 0.7 }]}>
          ¥{originalPrice.toFixed(2)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  currency: {
    color: theme.colors.danger,
    fontWeight: 'bold',
    marginRight: 2,
  },
  price: {
    color: theme.colors.danger,
    fontWeight: 'bold',
  },
  originalPrice: {
    color: theme.colors.subtext,
    textDecorationLine: 'line-through',
    marginLeft: theme.spacing.sm,
  },
});
