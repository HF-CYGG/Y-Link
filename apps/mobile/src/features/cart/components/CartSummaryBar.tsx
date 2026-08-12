import React from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
import { theme } from '../../../theme';
import { Checkbox } from '../../../ui/Checkbox';
import { Button } from '../../../ui';

export interface CartSummaryBarProps {
  totalAmount: number;
  selectedCount: number;
  isAllSelected: boolean;
  onToggleAll: (selected: boolean) => void;
  onCheckout: () => void;
}

export function CartSummaryBar({ 
  totalAmount, 
  selectedCount, 
  isAllSelected, 
  onToggleAll, 
  onCheckout 
}: CartSummaryBarProps) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.leftCol}>
          <Checkbox 
            checked={isAllSelected} 
            onChange={onToggleAll} 
          />
          <Text style={styles.selectAllText}>全选</Text>
        </View>
        
        <View style={styles.rightCol}>
          <View style={styles.priceInfo}>
            <Text style={styles.totalLabel}>合计: </Text>
            <Text style={styles.currency}>¥</Text>
            <Text style={styles.totalPrice}>{totalAmount.toFixed(2)}</Text>
          </View>
          
          <Button 
            title={`去结算(${selectedCount})`} 
            onPress={onCheckout} 
            disabled={selectedCount === 0}
            style={styles.checkoutBtn}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    ...theme.shadows.md,
  },
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  leftCol: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  selectAllText: {
    ...theme.typography.body,
    marginLeft: theme.spacing.xs,
  },
  rightCol: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  priceInfo: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginRight: theme.spacing.md,
  },
  totalLabel: {
    ...theme.typography.body,
  },
  currency: {
    color: theme.colors.danger,
    fontWeight: 'bold',
    fontSize: theme.fontSize.sm,
    marginRight: 2,
  },
  totalPrice: {
    color: theme.colors.danger,
    fontWeight: 'bold',
    fontSize: theme.fontSize.lg,
  },
  checkoutBtn: {
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.xl,
  },
});
