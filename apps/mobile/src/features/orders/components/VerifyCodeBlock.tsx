import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { theme } from '../../../theme';
// import QRCode from 'react-native-qrcode-svg'; // Do not install extra dependencies

export interface VerifyCodeBlockProps {
  code: string;
  style?: ViewStyle;
}

export function VerifyCodeBlock({ code, style }: VerifyCodeBlockProps) {
  return (
    <View style={[styles.container, style]}>
      <Text style={styles.title}>核销码</Text>
      <View style={styles.qrPlaceholder}>
        <Text style={styles.qrText}>[QR CODE]</Text>
      </View>
      <Text style={styles.codeText}>{code.replace(/(.{4})/g, '$1 ')}</Text>
      <Text style={styles.hint}>请向店员出示此二维码核销</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
    alignItems: 'center',
    ...theme.shadows.sm,
  },
  title: {
    ...theme.typography.h3,
    marginBottom: theme.spacing.md,
  },
  qrPlaceholder: {
    width: 150,
    height: 150,
    backgroundColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  qrText: {
    color: theme.colors.subtext,
    fontSize: theme.fontSize.sm,
  },
  codeText: {
    ...theme.typography.h2,
    letterSpacing: 2,
    marginBottom: theme.spacing.sm,
  },
  hint: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
});
