import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, SafeAreaView, TouchableOpacity, Alert, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import {
  CLIENT_PERSONAL_USERNAME_RULE_MESSAGE,
  getPersonalClientUsernameRuleHint,
  normalizePersonalClientUsername,
} from '@ylink/validation/auth';
import { theme } from '../../src/theme';
import { Button, Input } from '../../src/ui';
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
  const [profileUser, setProfileUser] = useState(mockUser);
  const [profileEditorVisible, setProfileEditorVisible] = useState(false);
  const [username, setUsername] = useState(mockUser.name);
  const normalizedUsername = normalizePersonalClientUsername(username).value;
  const usernameRuleHint = getPersonalClientUsernameRuleHint(username);

  const openProfileEditor = () => {
    setUsername(profileUser.name);
    setProfileEditorVisible(true);
  };

  const saveProfile = () => {
    if (!normalizedUsername || usernameRuleHint) {
      Alert.alert('提示', usernameRuleHint);
      return;
    }
    setProfileUser((current) => ({ ...current, name: normalizedUsername }));
    setProfileEditorVisible(false);
    Alert.alert('提示', '资料已更新（Mock）');
  };

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
    { title: '修改个人资料', icon: '📝', onPress: openProfileEditor },
    { title: '修改密码', icon: '🔒', onPress: () => alert('Mock 修改密码') },
    { title: '关于 Y-Link', icon: 'ℹ️', onPress: () => alert('Y-Link Mobile App v0.1.0') },
  ];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        <ProfileHeader user={profileUser} style={styles.header} />

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

        <Modal
          visible={profileEditorVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setProfileEditorVisible(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>编辑个人资料</Text>
              <Input
                label="用户名"
                placeholder="请输入 2-20 位中文或英文字母"
                value={username}
                onChangeText={setUsername}
                error={usernameRuleHint}
              />
              <View style={styles.modalActions}>
                <Button title="取消" variant="secondary" onPress={() => setProfileEditorVisible(false)} style={styles.modalAction} />
                <Button title="保存" onPress={saveProfile} style={styles.modalAction} />
              </View>
            </View>
          </View>
        </Modal>
        
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
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.lg,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  modalContent: {
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
  },
  modalTitle: {
    ...theme.typography.h3,
    color: theme.colors.text,
    marginBottom: theme.spacing.lg,
  },
  modalActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    justifyContent: 'flex-end',
  },
  modalAction: {
    flex: 1,
  },
});
