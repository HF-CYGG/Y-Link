import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { Button } from './Button';
import { theme } from '../theme';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: ViewStyle;
}

export function EmptyState({ 
  title, 
  description, 
  icon = '📭', 
  actionLabel, 
  onAction,
  style
}: EmptyStateProps) {
  return (
    <View style={[styles.container, style]}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      
      {actionLabel && onAction && (
        <Button 
          title={actionLabel} 
          onPress={onAction} 
          style={styles.actionButton}
          variant="secondary"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.xl,
  },
  icon: {
    fontSize: 48,
    marginBottom: theme.spacing.lg,
  },
  title: {
    ...theme.typography.h3,
    marginBottom: theme.spacing.sm,
    textAlign: 'center',
  },
  description: {
    ...theme.typography.body,
    color: theme.colors.subtext,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
  },
  actionButton: {
    minWidth: 120,
  },
});
