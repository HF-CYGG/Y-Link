import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { theme } from '../../../theme';

export interface FeedbackBubbleProps {
  content: string;
  isSelf: boolean;
  time: string;
  style?: ViewStyle;
}

export function FeedbackBubble({ content, isSelf, time, style }: FeedbackBubbleProps) {
  return (
    <View style={[styles.container, isSelf ? styles.containerSelf : styles.containerOther, style]}>
      <View style={[styles.bubble, isSelf ? styles.bubbleSelf : styles.bubbleOther]}>
        <Text style={[styles.text, isSelf ? styles.textSelf : styles.textOther]}>{content}</Text>
      </View>
      <Text style={styles.time}>{time}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: theme.spacing.sm,
    maxWidth: '80%',
  },
  containerSelf: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  containerOther: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  bubble: {
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    ...theme.shadows.sm,
  },
  bubbleSelf: {
    backgroundColor: theme.colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: theme.colors.surface,
    borderBottomLeftRadius: 4,
  },
  text: {
    ...theme.typography.body,
    lineHeight: 22,
  },
  textSelf: {
    color: theme.colors.white,
  },
  textOther: {
    color: theme.colors.text,
  },
  time: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
    marginTop: 4,
    marginHorizontal: 4,
  },
});
