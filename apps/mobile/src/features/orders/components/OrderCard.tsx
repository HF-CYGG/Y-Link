import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ViewStyle } from 'react-native';
import { theme } from '../../../theme';
import { OrderStatusBadge, OrderStatus } from './OrderStatusBadge';
import { PriceDisplay } from '../../../components';

export interface MockOrderItem {
  id: string;
  orderNo: string;
  status: OrderStatus;
  createTime: string;
  totalAmount: number;
  totalQuantity: number;
  productImage: string;
  productTitle: string;
}

export interface OrderCardProps {
  order: MockOrderItem;
  onPress: (order: MockOrderItem) => void;
  style?: ViewStyle;
}

export function OrderCard({ order, onPress, style }: OrderCardProps) {
  return (
    <TouchableOpacity 
      style={[styles.container, style]} 
      onPress={() => onPress(order)}
      activeOpacity={0.8}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.orderNoLabel}>订单号: </Text>
          <Text style={styles.orderNo}>{order.orderNo}</Text>
        </View>
        <OrderStatusBadge status={order.status} />
      </View>

      <View style={styles.content}>
        <Image source={{ uri: order.productImage }} style={styles.image} />
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={2}>{order.productTitle}</Text>
          <View style={styles.summaryRow}>
            <Text style={styles.timeText}>{order.createTime}</Text>
            <Text style={styles.quantityText}>共 {order.totalQuantity} 件</Text>
          </View>
        </View>
      </View>

      <View style={styles.footer}>
        <View style={styles.actionPlaceholder} />
        <View style={styles.priceContainer}>
          <Text style={styles.priceLabel}>实付金额: </Text>
          <PriceDisplay price={order.totalAmount} size="md" />
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
    ...theme.shadows.sm,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.background,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  orderNoLabel: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
  orderNo: {
    ...theme.typography.caption,
    color: theme.colors.text,
    fontWeight: '500',
  },
  content: {
    flexDirection: 'row',
    marginBottom: theme.spacing.sm,
  },
  image: {
    width: 60,
    height: 60,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.background,
    marginRight: theme.spacing.md,
  },
  info: {
    flex: 1,
    justifyContent: 'space-between',
  },
  title: {
    ...theme.typography.body,
    fontSize: theme.fontSize.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  timeText: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
  quantityText: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: theme.spacing.sm,
  },
  actionPlaceholder: {
    flex: 1,
  },
  priceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  priceLabel: {
    ...theme.typography.body,
    fontSize: theme.fontSize.sm,
  },
});
