import React from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { theme } from '../theme';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'default';

export interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

export function Badge({ label, variant = 'default', style, textStyle }: BadgeProps) {
  
  const getVariantStyles = () => {
    switch (variant) {
      case 'success':
        return { bg: '#dcfce7', text: theme.colors.success };
      case 'warning':
        return { bg: '#fef3c7', text: theme.colors.warning };
      case 'danger':
        return { bg: '#fee2e2', text: theme.colors.danger };
      case 'info':
        return { bg: '#dbeafe', text: theme.colors.info };
      case 'default':
      default:
        return { bg: theme.colors.background, text: theme.colors.subtext };
    }
  };

  const variantStyles = getVariantStyles();

  return (
    <View style={[styles.container, { backgroundColor: variantStyles.bg }, style]}>
      <Text style={[styles.text, { color: variantStyles.text }, textStyle]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
    borderRadius: theme.radius.sm,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: '600',
  },
});
