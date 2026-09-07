import React from 'react';
import { ViewStyle } from 'react-native';
import { Badge } from '../../../ui/Badge';
import type { O2oOrderStatus, O2oOrderStatusReport } from '@ylink/shared-types';

export type OrderStatus = O2oOrderStatus;

export interface OrderStatusBadgeProps {
  status: OrderStatus;
  statusReport?: O2oOrderStatusReport | null;
  style?: ViewStyle;
}

export function OrderStatusBadge({ status, statusReport, style }: OrderStatusBadgeProps) {
  switch (status) {
    case 'pending':
      return <Badge label="待核销" variant="warning" style={style} />;
    case 'verified':
      return <Badge label="已完成" variant="success" style={style} />;
    case 'cancelled':
      return <Badge label={statusReport?.cancellationSource === 'client' ? '已撤回' : '已取消'} variant="default" style={style} />;
    default:
      return <Badge label="未知" variant="default" style={style} />;
  }
}
