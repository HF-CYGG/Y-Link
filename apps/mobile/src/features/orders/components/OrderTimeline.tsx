import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { theme } from '../../../theme';

export interface TimelineEvent {
  title: string;
  time: string;
  description?: string;
}

export interface OrderTimelineProps {
  events: TimelineEvent[];
  style?: ViewStyle;
}

export function OrderTimeline({ events, style }: OrderTimelineProps) {
  return (
    <View style={[styles.container, style]}>
      {events.map((event, index) => {
        const isLast = index === events.length - 1;
        const isFirst = index === 0;
        
        return (
          <View key={index} style={styles.eventRow}>
            <View style={styles.lineColumn}>
              <View style={[styles.dot, isFirst && styles.dotActive]} />
              {!isLast && <View style={styles.line} />}
            </View>
            <View style={styles.contentColumn}>
              <View style={styles.headerRow}>
                <Text style={[styles.title, isFirst && styles.titleActive]}>{event.title}</Text>
                <Text style={styles.time}>{event.time}</Text>
              </View>
              {event.description && (
                <Text style={styles.description}>{event.description}</Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: theme.spacing.md,
  },
  eventRow: {
    flexDirection: 'row',
  },
  lineColumn: {
    width: 20,
    alignItems: 'center',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.border,
    marginTop: 6,
  },
  dotActive: {
    backgroundColor: theme.colors.primary,
  },
  line: {
    width: 2,
    flex: 1,
    backgroundColor: theme.colors.border,
    marginVertical: 4,
  },
  contentColumn: {
    flex: 1,
    paddingLeft: theme.spacing.sm,
    paddingBottom: theme.spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  title: {
    ...theme.typography.body,
    fontWeight: '500',
    color: theme.colors.text,
  },
  titleActive: {
    color: theme.colors.primary,
  },
  time: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
  description: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
    marginTop: 4,
  },
});
