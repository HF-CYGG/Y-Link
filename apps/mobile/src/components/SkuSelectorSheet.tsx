import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, SafeAreaView } from 'react-native';
import { theme } from '../theme';
import { Button } from '../ui';
import { PriceDisplay } from './PriceDisplay';
import { QuantityStepper } from './QuantityStepper';
import { MockProduct } from './ProductCard';

export interface SkuSelectorSheetProps {
  visible: boolean;
  product: MockProduct | null;
  onClose: () => void;
  onConfirm: (quantity: number) => void;
}

export function SkuSelectorSheet({ visible, product, onClose, onConfirm }: SkuSelectorSheetProps) {
  const [quantity, setQuantity] = React.useState(1);

  if (!product) return null;

  const handleConfirm = () => {
    onConfirm(quantity);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={styles.bottomSheet}>
          <TouchableOpacity activeOpacity={1} style={styles.content}>
            <View style={styles.header}>
              <View style={styles.imagePlaceholder} />
              <View style={styles.headerInfo}>
                <PriceDisplay price={product.price} size="lg" />
                <Text style={styles.stockText}>库存: {product.stock}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                <Text style={styles.closeIcon}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.scrollArea}>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>数量</Text>
                <QuantityStepper 
                  value={quantity} 
                  onChange={setQuantity} 
                  max={product.stock}
                />
              </View>
            </ScrollView>

            <SafeAreaView>
              <View style={styles.footer}>
                <Button 
                  title="确定" 
                  onPress={handleConfirm} 
                  style={styles.confirmButton} 
                />
              </View>
            </SafeAreaView>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  bottomSheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    minHeight: 300,
    maxHeight: '80%',
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    padding: theme.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  imagePlaceholder: {
    width: 80,
    height: 80,
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.md,
    marginRight: theme.spacing.md,
  },
  headerInfo: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: theme.spacing.xs,
  },
  stockText: {
    ...theme.typography.caption,
    marginTop: theme.spacing.xs,
  },
  closeButton: {
    padding: theme.spacing.sm,
  },
  closeIcon: {
    fontSize: 20,
    color: theme.colors.subtext,
  },
  scrollArea: {
    padding: theme.spacing.lg,
  },
  section: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
  },
  sectionTitle: {
    ...theme.typography.h3,
  },
  footer: {
    padding: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  confirmButton: {
    width: '100%',
  },
});
