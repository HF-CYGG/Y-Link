import React from 'react';
import { ViewStyle } from 'react-native';
import { Badge } from '../../../ui/Badge';

export type OrderStatus = 'pending' | 'verified' | 'cancelled';

export interface OrderStatusBadgeProps {
  status: OrderStatus;
  style?: ViewStyle;
}

export function OrderStatusBadge({ status, style }: OrderStatusBadgeProps) {
  switch (status) {
    case 'pending':
      return <Badge label="待核销" variant="warning" style={style} />;
    case 'verified':
      return <Badge label="已完成" variant="success" style={style} />;
    case 'cancelled':
      return <Badge label="已取消" variant="default" style={style} />;
    default:
      return <Badge label="未知" variant="default" style={style} />;
  }
}
