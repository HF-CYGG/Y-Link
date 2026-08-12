import React from 'react';
import { View, StyleSheet, ViewProps } from 'react-native';
import { theme } from '../theme';

export interface CardProps extends ViewProps {
  elevated?: boolean;
}

export function Card({ children, elevated = false, style, ...props }: CardProps) {
  return (
    <View 
      style={[
        styles.card, 
        elevated && styles.elevated,
        style
      ]} 
      {...props}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  elevated: {
    ...theme.shadows.sm,
    borderColor: 'transparent',
  },
});
