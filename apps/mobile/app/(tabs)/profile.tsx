import React from 'react';
import { View, Text, StyleSheet, ScrollView, SafeAreaView, TouchableOpacity, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { Button } from '../../src/ui';
import { ProfileHeader, UserProfile } from '../../src/features/profile/components/ProfileHeader';

const mockUser: UserProfile = {
  name: '李同学',
  phone: '13800138000',
  email: 'li@example.com',
  accountType: 'student',
  studentId: '20261001',
};

export default function ProfileScreen() {
  const router = useRouter();

  const handleLogout = () => {
    Alert.alert('退出登录', '确定要退出当前账号吗？', [
      { text: '取消', style: 'cancel' },
      { 
        text: '确定', 
        style: 'destructive',
        onPress: () => {
          // TODO(auth): real logout logic clearing SecureStore
          router.replace('/(auth)/login');
        }
      }
    ]);
  };

  const menuItems = [
    { title: '修改个人资料', icon: '📝', onPress: () => alert('Mock 修改资料') },
    { title: '修改密码', icon: '🔒', onPress: () => alert('Mock 修改密码') },
    { title: '关于 Y-Link', icon: 'ℹ️', onPress: () => alert('Y-Link Mobile App v0.1.0') },
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        <ProfileHeader user={mockUser} style={styles.header} />

        <View style={styles.menuContainer}>
          {menuItems.map((item, index) => (
            <TouchableOpacity 
              key={index} 
              style={[
                styles.menuItem,
                index === menuItems.length - 1 && styles.menuItemLast
              ]}
              onPress={item.onPress}
            >
              <View style={styles.menuLeft}>
                <Text style={styles.menuIcon}>{item.icon}</Text>
                <Text style={styles.menuTitle}>{item.title}</Text>
              </View>
              <Text style={styles.menuArrow}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.logoutContainer}>
          <Button 
            title="退出登录" 
            variant="danger" 
            onPress={handleLogout} 
          />
        </View>
        
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  scrollContent: {
    paddingBottom: theme.spacing.xl,
  },
  header: {
    marginBottom: theme.spacing.md,
  },
  menuContainer: {
    backgroundColor: theme.colors.surface,
    marginBottom: theme.spacing.lg,
  },
  menuItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.background,
  },
  menuItemLast: {
    borderBottomWidth: 0,
  },
  menuLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  menuIcon: {
    fontSize: 20,
    marginRight: theme.spacing.md,
  },
  menuTitle: {
    ...theme.typography.body,
    color: theme.colors.text,
  },
  menuArrow: {
    fontSize: 24,
    color: theme.colors.subtext,
    lineHeight: 24,
  },
  logoutContainer: {
    paddingHorizontal: theme.spacing.lg,
  }
});
