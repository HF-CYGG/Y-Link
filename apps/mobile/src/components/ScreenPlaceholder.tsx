import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface ScreenPlaceholderProps {
  title: string;
  description: string;
  children?: ReactNode;
}

export function ScreenPlaceholder({ title, description, children }: ScreenPlaceholderProps) {
  return (
    <View style={styles.screen}>
      <Text style={styles.brand}>Y-Link Mobile</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.description}>{description}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: '#f5f7fa',
  },
  brand: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '600',
  },
  title: {
    color: '#111827',
    fontSize: 28,
    fontWeight: '700',
  },
  description: {
    maxWidth: 320,
    color: '#6b7280',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
});
