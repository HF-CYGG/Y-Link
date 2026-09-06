import React from 'react';
import { ViewStyle } from 'react-native';
import { Badge } from '../ui';

export interface StockBadgeProps {
  stock: number;
  style?: ViewStyle;
}

export function StockBadge({ stock, style }: StockBadgeProps) {
  if (stock <= 0) {
    return <Badge label="缺货" variant="danger" style={style} />;
  }
  
  if (stock <= 5) {
    return <Badge label={`仅剩 ${stock} 件`} variant="warning" style={style} />;
  }
  
  // 对于充足库存通常不需要显示，或者显示"有货"
  // 返回null让UI更干净
  return null;
}
