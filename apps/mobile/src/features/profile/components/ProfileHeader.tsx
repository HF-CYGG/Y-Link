import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { theme } from '../../../theme';

export interface UserProfile {
  name: string;
  avatar?: string;
  phone: string;
  email: string;
  accountType: 'student' | 'staff' | 'admin';
  department?: string;
  studentId?: string;
}

export interface ProfileHeaderProps {
  user: UserProfile;
  style?: ViewStyle;
}

export function ProfileHeader({ user, style }: ProfileHeaderProps) {
  const accountTypeLabel = {
    student: '学生',
    staff: '教职工',
    admin: '管理员',
  }[user.accountType];

  return (
    <View style={[styles.container, style]}>
      <View style={styles.avatarContainer}>
        <Text style={styles.avatarPlaceholder}>👤</Text>
      </View>
      <View style={styles.infoContainer}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{user.name}</Text>
          <View style={styles.typeBadge}>
            <Text style={styles.typeText}>{accountTypeLabel}</Text>
          </View>
        </View>
        
        <Text style={styles.subtext}>{user.phone}</Text>
        
        {user.studentId && (
          <Text style={styles.subtext}>学号: {user.studentId}</Text>
        )}
        
        {user.department && (
          <Text style={styles.subtext}>部门: {user.department}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
  },
  avatarContainer: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.lg,
  },
  avatarPlaceholder: {
    fontSize: 40,
  },
  infoContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    ...theme.typography.h3,
    marginRight: theme.spacing.sm,
  },
  typeBadge: {
    backgroundColor: theme.colors.primary + '20',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  typeText: {
    ...theme.typography.caption,
    color: theme.colors.primary,
    fontWeight: '500',
  },
  subtext: {
    ...theme.typography.caption,
    color: theme.colors.subtext,
    marginTop: 2,
  },
});
