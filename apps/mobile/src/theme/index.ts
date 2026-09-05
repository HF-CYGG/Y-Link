import { Platform, StyleSheet } from 'react-native';

// 基础设计令牌 (模拟从 design-tokens 接入，并在 Mobile 层做拓展)
export const colors = {
  // 品牌色：青蓝
  primary: '#005b52',
  primaryLight: '#33887d',
  primaryDark: '#003b35',
  
  // 背景与表面
  background: '#f5f7fa',
  surface: '#ffffff',
  
  // 文本
  text: '#0f172a',
  subtext: '#64748b',
  placeholder: '#94a3b8',
  
  // 边框与占位
  border: '#dbe2ea',
  divider: '#e2e8f0',
  
  // 状态色
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#3b82f6',
  
  // 其他
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
};

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  xxl: 24,
};

export const typography = {
  h1: { fontSize: fontSize.xxl, fontWeight: 'bold' as const, color: colors.text },
  h2: { fontSize: fontSize.xl, fontWeight: 'bold' as const, color: colors.text },
  h3: { fontSize: fontSize.lg, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: fontSize.md, color: colors.text },
  subtext: { fontSize: fontSize.sm, color: colors.subtext },
  caption: { fontSize: fontSize.xs, color: colors.subtext },
};

export const shadows = StyleSheet.create({
  sm: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
    },
    android: {
      elevation: 2,
    },
    default: {
      boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
    },
  }),
  md: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
    },
    android: {
      elevation: 4,
    },
    default: {
      boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    },
  }),
});

export const theme = {
  colors,
  spacing,
  radius,
  fontSize,
  typography,
  shadows,
};

export default theme;
