import React from 'react';
import { View, Text, StyleSheet, Image, ViewStyle } from 'react-native';
import { theme } from '../../../theme';
import { PriceDisplay, QuantityStepper } from '../../../components';

export interface ReturnItem {
  id: string;
  title: string;
  sku: string;
  price: number;
  imageUrl: string;
  maxReturnableQuantity: number;
}

export interface ReturnItemRowProps {
  item: ReturnItem;
  quantity: number;
  onChangeQuantity: (quantity: number) => void;
  style?: ViewStyle;
}

export function ReturnItemRow({ item, quantity, onChangeQuantity, style }: ReturnItemRowProps) {
  return (
    <View style={[styles.container, style]}>
      <Image source={{ uri: item.imageUrl }} style={styles.image} />
      
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
          <Text style={styles.sku}>{item.sku}</Text>
        </View>
        
        <View style={styles.footer}>
          <PriceDisplay price={item.price} size="sm" />
          <View style={styles.stepperContainer}>
            <Text style={styles.maxQuantityHint}>最多可退 {item.maxReturnableQuantity} 件</Text>
            <QuantityStepper 
              value={quantity}
              min={0}
              max={item.maxReturnableQuantity}
              onChange={onChangeQuantity}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    marginBottom: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  image: {
    width: 60,
    height: 60,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.background,
    marginRight: theme.spacing.md,
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
  },
  header: {
    marginBottom: theme.spacing.xs,
  },
  title: {
    ...theme.typography.body,
    fontSize: theme.fontSize.sm,
  },
  sku: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
    marginTop: 2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  stepperContainer: {
    alignItems: 'flex-end',
  },
  maxQuantityHint: {
    ...theme.typography.caption,
    color: theme.colors.warning,
    marginBottom: 4,
  },
});
