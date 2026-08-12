import React, { useState } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, SafeAreaView, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { Input, Button } from '../../src/ui';

export default function RegisterScreen() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const handleSendCode = () => {
    if (!phone) {
      Alert.alert('提示', '请输入手机号码');
      return;
    }
    setCountdown(60);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    // TODO(auth): real send code mutation
    Alert.alert('提示', '验证码已发送 (Mock)');
  };

  const handleRegister = () => {
    if (!phone || !code || !password) {
      Alert.alert('提示', '请填写完整信息');
      return;
    }
    
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
      // TODO(auth): real register mutation
      Alert.alert('提示', '注册成功 (Mock)', [
        { text: '确定', onPress: () => router.replace('/(auth)/login') }
      ]);
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
            <Text style={styles.title}>注册账号</Text>
            <Text style={styles.subtitle}>欢迎加入 Y-Link</Text>
          </View>

          <View style={styles.form}>
            <Input 
              label="手机号码" 
              placeholder="请输入手机号码" 
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
            />
            
            <View style={styles.codeRow}>
              <View style={styles.codeInputContainer}>
                <Input 
                  label="验证码" 
                  placeholder="请输入验证码" 
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  containerStyle={styles.codeInput}
                />
              </View>
              <Button 
                title={countdown > 0 ? `${countdown}s` : "获取验证码"} 
                variant="secondary"
                onPress={handleSendCode}
                disabled={countdown > 0}
                style={styles.codeBtn}
              />
            </View>

            <Input 
              label="设置密码" 
              placeholder="请设置至少6位密码" 
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />

            <Button 
              title="注册" 
              onPress={handleRegister}
              loading={isLoading}
              style={styles.submitBtn}
            />

            <View style={styles.footer}>
              <Text style={styles.footerText}>已有账号？ </Text>
              <Text style={styles.linkText} onPress={() => router.replace('/(auth)/login')}>
                立即登录
              </Text>
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
    backgroundColor: theme.colors.surface,
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
    marginBottom: theme.spacing.xxl,
  },
  title: {
    ...theme.typography.h1,
    color: theme.colors.primary,
    marginBottom: theme.spacing.sm,
  },
  subtitle: {
    ...theme.typography.body,
    color: theme.colors.subtext,
  },
  form: {
    width: '100%',
  },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  codeInputContainer: {
    flex: 1,
    marginRight: theme.spacing.sm,
  },
  codeInput: {
    marginBottom: 0,
  },
  codeBtn: {
    height: 48,
    width: 100,
    marginBottom: theme.spacing.md,
  },
  submitBtn: {
    marginTop: theme.spacing.lg,
    width: '100%',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: theme.spacing.xl,
  },
  footerText: {
    ...theme.typography.body,
    color: theme.colors.subtext,
  },
  linkText: {
    ...theme.typography.body,
    color: theme.colors.primary,
    fontWeight: '600',
  },
});
