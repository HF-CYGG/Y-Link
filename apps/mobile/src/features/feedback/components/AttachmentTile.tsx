import React from 'react';
import { View, Text, StyleSheet, Image, ViewStyle, TouchableOpacity } from 'react-native';
import { theme } from '../../../theme';

export interface AttachmentTileProps {
  url?: string;
  isPlaceholder?: boolean;
  onPress?: () => void;
  onDelete?: () => void;
  style?: ViewStyle;
}

export function AttachmentTile({ url, isPlaceholder, onPress, onDelete, style }: AttachmentTileProps) {
  if (isPlaceholder) {
    return (
      <TouchableOpacity style={[styles.container, styles.placeholder, style]} onPress={onPress}>
        <Text style={styles.icon}>📷</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <Image source={{ uri: url }} style={styles.image} />
      {onDelete && (
        <TouchableOpacity style={styles.deleteBtn} onPress={onDelete}>
          <Text style={styles.deleteIcon}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 64,
    height: 64,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.background,
    marginRight: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  icon: {
    fontSize: 24,
  },
  deleteBtn: {
    position: 'absolute',
    top: 2,
    right: 2,
    backgroundColor: 'rgba(0,0,0,0.5)',
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteIcon: {
    color: '#fff',
    fontSize: 10,
  }
});
