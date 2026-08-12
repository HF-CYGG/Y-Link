import React from 'react';
import { View, Text, StyleSheet, ColorValue } from 'react-native';
import { theme } from '../theme';

export interface BottomTabIconProps {
  name: string;
  focused: boolean;
  color: string | ColorValue;
}

export function BottomTabIcon({ name, focused, color }: BottomTabIconProps) {
  // 简易的文本表情图标作为占位，后续可替换为 @expo/vector-icons 或自定义 SVG
  const getIcon = () => {
    switch (name) {
      case 'mall': return '🛍️';
      case 'orders': return '🧾';
      case 'feedback': return '💬';
      case 'profile': return '👤';
      default: return '❓';
    }
  };

  return (
    <View style={styles.container}>
      <Text style={[styles.icon, { opacity: focused ? 1 : 0.5 }]}>
        {getIcon()}
      </Text>
      {focused && <View style={[styles.dot, { backgroundColor: color }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 24,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 2,
    position: 'absolute',
    bottom: -8,
  },
});
