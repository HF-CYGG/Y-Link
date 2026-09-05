import React from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, ViewStyle } from 'react-native';
import { theme } from '../../../theme';
import { Checkbox } from '../../../ui/Checkbox';
import { Badge } from '../../../ui/Badge';
import { PriceDisplay, QuantityStepper } from '../../../components';

export interface CartItem {
  id: string;
  productId: string;
  title: string;
  skuText: string;
  price: number;
  quantity: number;
  imageUrl: string;
  stock: number;
  status: 'normal' | 'unavailable' | 'out_of_stock';
}

export interface CartItemRowProps {
  item: CartItem;
  selected: boolean;
  onSelect: (id: string, selected: boolean) => void;
  onChangeQuantity: (id: string, quantity: number) => void;
  onDelete: (id: string) => void;
  style?: ViewStyle;
}

export function CartItemRow({ item, selected, onSelect, onChangeQuantity, onDelete, style }: CartItemRowProps) {
  const isAvailable = item.status === 'normal';
  const isOutOfStock = item.status === 'out_of_stock';
  
  return (
    <View style={[styles.container, !isAvailable && styles.containerUnavailable, style]}>
      <View style={styles.selectCol}>
        <Checkbox 
          checked={selected} 
          onChange={(checked) => onSelect(item.id, checked)} 
          disabled={!isAvailable}
        />
      </View>
      
      <Image source={{ uri: item.imageUrl }} style={[styles.image, !isAvailable && styles.imageUnavailable]} />
      
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, !isAvailable && styles.textUnavailable]} numberOfLines={2}>
            {item.title}
          </Text>
          <TouchableOpacity onPress={() => onDelete(item.id)} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
            <Text style={styles.deleteText}>✕</Text>
          </TouchableOpacity>
        </View>
        
        <View style={styles.skuRow}>
          <Text style={styles.skuText}>{item.skuText}</Text>
        </View>
        
        <View style={styles.footerRow}>
          <PriceDisplay price={item.price} size="md" style={!isAvailable ? { opacity: 0.5 } : {}} />
          
          {item.status === 'unavailable' ? (
            <Badge label="已失效" variant="danger" />
          ) : isOutOfStock ? (
            <Badge label="库存不足" variant="warning" />
          ) : (
            <QuantityStepper 
              value={item.quantity}
              max={item.stock}
              onChange={(val) => onChangeQuantity(item.id, val)}
            />
          )}
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
  containerUnavailable: {
    backgroundColor: theme.colors.background,
  },
  selectCol: {
    justifyContent: 'center',
    marginRight: theme.spacing.xs,
  },
  image: {
    width: 80,
    height: 80,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.background,
    marginRight: theme.spacing.md,
  },
  imageUnavailable: {
    opacity: 0.5,
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: {
    ...theme.typography.body,
    flex: 1,
    marginRight: theme.spacing.sm,
  },
  textUnavailable: {
    color: theme.colors.subtext,
  },
  deleteText: {
    color: theme.colors.subtext,
    fontSize: 14,
  },
  skuRow: {
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.sm,
    alignSelf: 'flex-start',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  skuText: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.xs,
  },
});
