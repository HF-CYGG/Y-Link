import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { SectionHeader, EmptyState, LoadingState, Badge } from '../../src/ui';

interface MockSession {
  id: string;
  title: string;
  lastMessage: string;
  time: string;
  unreadCount: number;
}

const mockSessions: MockSession[] = [
  {
    id: 'fb_1',
    title: '关于订单 YL202608130001 的售后',
    lastMessage: '客服：请问您具体遇到了什么问题？',
    time: '10:30',
    unreadCount: 1,
  },
  {
    id: 'fb_2',
    title: '商品咨询',
    lastMessage: '您：这款耳机还有白色吗？',
    time: '昨天',
    unreadCount: 0,
  }
];

export default function FeedbackListScreen() {
  const router = useRouter();
  const [sessions, setSessions] = useState<MockSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setTimeout(() => {
      setSessions(mockSessions);
      setIsLoading(false);
    }, 600);
  }, []);

  const renderItem = ({ item }: { item: MockSession }) => (
    <TouchableOpacity 
      style={styles.sessionRow}
      onPress={() => router.push(`/feedback/${item.id}`)}
      activeOpacity={0.7}
    >
      <View style={styles.iconContainer}>
        <Text style={styles.iconText}>💬</Text>
        {item.unreadCount > 0 && (
          <View style={styles.badgeContainer}>
            <Badge label={item.unreadCount.toString()} variant="danger" />
          </View>
        )}
      </View>
      <View style={styles.contentContainer}>
        <View style={styles.headerRow}>
          <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.time}>{item.time}</Text>
        </View>
        <Text style={styles.lastMessage} numberOfLines={1}>{item.lastMessage}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <SectionHeader 
          title="我的反馈" 
          actionLabel="新建反馈" 
          onAction={() => router.push('/feedback/create')} 
        />
      </View>
      
      {isLoading ? (
        <LoadingState message="加载反馈记录..." />
      ) : sessions.length === 0 ? (
        <EmptyState 
          title="暂无反馈" 
          description="您还没有提交过任何反馈" 
          actionLabel="新建反馈"
          onAction={() => router.push('/feedback/create')} 
        />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  listContent: {
    padding: theme.spacing.md,
  },
  sessionRow: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    marginBottom: theme.spacing.sm,
    ...theme.shadows.sm,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.md,
  },
  iconText: {
    fontSize: 24,
  },
  badgeContainer: {
    position: 'absolute',
    top: -4,
    right: -8,
  },
  contentContainer: {
    flex: 1,
    justifyContent: 'center',
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
    flex: 1,
    marginRight: theme.spacing.sm,
  },
  time: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
  lastMessage: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
  },
});
