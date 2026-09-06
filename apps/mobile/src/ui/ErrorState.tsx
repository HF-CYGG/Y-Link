import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { Button } from './Button';
import { theme } from '../theme';

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  style?: ViewStyle;
}

export function ErrorState({ 
  title = '加载失败', 
  message, 
  onRetry,
  style
}: ErrorStateProps) {
  return (
    <View style={[styles.container, style]}>
      <Text style={styles.icon}>⚠️</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      
      {onRetry && (
        <Button 
          title="重试" 
          onPress={onRetry} 
          variant="primary"
          style={styles.retryButton}
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
    fontSize: 40,
    marginBottom: theme.spacing.md,
  },
  title: {
    ...theme.typography.h3,
    marginBottom: theme.spacing.sm,
    color: theme.colors.text,
  },
  message: {
    ...theme.typography.body,
    color: theme.colors.subtext,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  },
  retryButton: {
    minWidth: 100,
  }
});
