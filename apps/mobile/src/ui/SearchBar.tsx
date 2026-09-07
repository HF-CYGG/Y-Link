import React from 'react';
import { View, TextInput, StyleSheet, TextInputProps, TouchableOpacity, Text, StyleProp, ViewStyle } from 'react-native';
import { theme } from '../theme';

export interface SearchBarProps extends TextInputProps {
  onClear?: () => void;
  containerStyle?: StyleProp<ViewStyle>;
}

export function SearchBar({ onClear, value, containerStyle, style, ...props }: SearchBarProps) {
  return (
    <View style={[styles.container, containerStyle]}>
      <View style={styles.iconPlaceholder}>
        <Text style={styles.iconText}>🔍</Text>
      </View>
      <TextInput
        style={[styles.input, style]}
        value={value}
        placeholderTextColor={theme.colors.placeholder}
        returnKeyType="search"
        {...props}
      />
      {value ? (
        <TouchableOpacity onPress={onClear} style={styles.clearButton} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
          <Text style={styles.clearText}>×</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.md,
    height: 40,
    ...theme.shadows.sm,
  },
  iconPlaceholder: {
    marginRight: theme.spacing.xs,
  },
  iconText: {
    fontSize: 14,
  },
  input: {
    flex: 1,
    height: '100%',
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
  },
  clearButton: {
    padding: theme.spacing.xs,
    marginLeft: theme.spacing.xs,
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.full,
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  clearText: {
    fontSize: 12,
    color: theme.colors.subtext,
    fontWeight: 'bold',
    lineHeight: 14,
  }
});
