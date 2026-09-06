import React, { useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, KeyboardAvoidingView, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Input, Button } from '../../src/ui';
import { theme } from '../../src/theme';

export default function LoginScreen() {
  const router = useRouter();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = () => {
    if (!account || !password) {
      setError('请输入账号和密码');
      return;
    }
    
    setIsLoading(true);
    setError('');
    
    // Mock login delay
    setTimeout(() => {
      setIsLoading(false);
      // Navigate to tabs
      router.replace('/(tabs)/mall');
    }, 1000);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <View style={styles.logoPlaceholder}>
              <Text style={styles.logoText}>Y</Text>
            </View>
            <Text style={styles.title}>欢迎登录 Y-Link</Text>
            <Text style={styles.subtitle}>校园 O2O 服务平台</Text>
          </View>

          <View style={styles.form}>
            <Input
              label="账号"
              placeholder="请输入学号或手机号"
              value={account}
              onChangeText={(text) => {
                setAccount(text);
                setError('');
              }}
              autoCapitalize="none"
              keyboardType="default"
            />
            
            <Input
              label="密码"
              placeholder="请输入密码"
              value={password}
              onChangeText={(text) => {
                setPassword(text);
                setError('');
              }}
              secureTextEntry
            />

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Button 
              title="登录" 
              onPress={handleLogin} 
              loading={isLoading}
              style={styles.loginButton}
            />

            <View style={styles.footerLinks}>
              <TouchableOpacity onPress={() => router.push('/(auth)/forgot-password')}>
                <Text style={styles.linkText}>忘记密码</Text>
              </TouchableOpacity>
              <Text style={styles.linkDivider}>|</Text>
              <TouchableOpacity onPress={() => router.push('/(auth)/register')}>
                <Text style={styles.linkText}>新用户注册</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: theme.spacing.xl,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: theme.spacing.xxl,
  },
  logoPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.lg,
    ...theme.shadows.md,
  },
  logoText: {
    fontSize: 40,
    fontWeight: 'bold',
    color: theme.colors.white,
  },
  title: {
    ...theme.typography.h1,
    marginBottom: theme.spacing.xs,
  },
  subtitle: {
    ...theme.typography.body,
    color: theme.colors.subtext,
  },
  form: {
    width: '100%',
  },
  loginButton: {
    marginTop: theme.spacing.lg,
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.danger,
    marginBottom: theme.spacing.md,
  },
  footerLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: theme.spacing.xl,
  },
  linkText: {
    ...theme.typography.body,
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
  },
  linkDivider: {
    color: theme.colors.border,
    marginHorizontal: theme.spacing.md,
  }
});
