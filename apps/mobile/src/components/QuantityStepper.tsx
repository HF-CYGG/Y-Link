import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ViewStyle } from 'react-native';
import { theme } from '../theme';

export interface QuantityStepperProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  style?: ViewStyle;
}

export function QuantityStepper({ 
  value, 
  min = 1, 
  max = 99, 
  onChange,
  style 
}: QuantityStepperProps) {
  
  const handleDecrease = () => {
    if (value > min) {
      onChange(value - 1);
    }
  };

  const handleIncrease = () => {
    if (value < max) {
      onChange(value + 1);
    }
  };

  return (
    <View style={[styles.container, style]}>
      <TouchableOpacity 
        style={[styles.button, value <= min && styles.buttonDisabled]} 
        onPress={handleDecrease}
        disabled={value <= min}
        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
      >
        <Text style={[styles.buttonText, value <= min && styles.buttonTextDisabled]}>-</Text>
      </TouchableOpacity>
      
      <View style={styles.valueContainer}>
        <Text style={styles.valueText}>{value}</Text>
      </View>
      
      <TouchableOpacity 
        style={[styles.button, value >= max && styles.buttonDisabled]} 
        onPress={handleIncrease}
        disabled={value >= max}
        hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
      >
        <Text style={[styles.buttonText, value >= max && styles.buttonTextDisabled]}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.divider,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
  },
  button: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.background,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 18,
    color: theme.colors.text,
    fontWeight: '500',
  },
  buttonTextDisabled: {
    color: theme.colors.subtext,
  },
  valueContainer: {
    minWidth: 40,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: theme.colors.divider,
  },
  valueText: {
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
    fontWeight: '500',
  },
});
