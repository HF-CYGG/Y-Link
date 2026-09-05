import React, { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, ScrollView, SafeAreaView, TextInput, KeyboardAvoidingView, Platform, TouchableOpacity, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { theme } from '../../src/theme';
import { LoadingState } from '../../src/ui';
import { FeedbackBubble } from '../../src/features/feedback/components/FeedbackBubble';
import { AttachmentTile } from '../../src/features/feedback/components/AttachmentTile';

interface Message {
  id: string;
  content: string;
  isSelf: boolean;
  time: string;
}

const mockMessages: Message[] = [
  { id: 'm1', content: '您好，我收到了一件破损的衣服，请问怎么处理？', isSelf: true, time: '10:00' },
  { id: 'm2', content: '您好，请问您方便提供一下包装破损部位的照片吗？', isSelf: false, time: '10:15' },
  { id: 'm3', content: '稍等，我拍一下。', isSelf: true, time: '10:30' },
];

export default function FeedbackDetailScreen() {
  const { id } = useLocalSearchParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    setTimeout(() => {
      setMessages(mockMessages);
      setIsLoading(false);
    }, 600);
  }, [id]);

  const handleSend = () => {
    if (!inputText.trim()) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      content: inputText,
      isSelf: true,
      time: '刚刚',
    };

    setMessages([...messages, newMessage]);
    setInputText('');
    
    // 模拟服务端回复
    setTimeout(() => {
      setMessages(prev => [
        ...prev, 
        { id: Date.now().toString(), content: '客服正在路上... (Mock Reply)', isSelf: false, time: '刚刚' }
      ]);
    }, 2000);
  };

  const handleAddImage = () => {
    // TODO(camera/image-picker): real image picker
    alert('打开相册 (Mock)');
  };

  if (isLoading) {
    return <LoadingState message="连接会话中..." />;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <ScrollView 
          ref={scrollViewRef}
          contentContainerStyle={styles.scrollContent}
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
        >
          {messages.map(msg => (
            <FeedbackBubble 
              key={msg.id}
              content={msg.content}
              isSelf={msg.isSelf}
              time={msg.time}
            />
          ))}
        </ScrollView>

        <View style={styles.inputArea}>
          <TouchableOpacity style={styles.attachBtn} onPress={handleAddImage}>
            <Text style={styles.attachIcon}>➕</Text>
          </TouchableOpacity>
          
          <TextInput 
            style={styles.input}
            placeholder="回复消息..."
            placeholderTextColor={theme.colors.placeholder}
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={500}
          />
          
          <TouchableOpacity 
            style={[styles.sendBtn, !inputText.trim() && styles.sendBtnDisabled]} 
            onPress={handleSend}
            disabled={!inputText.trim()}
          >
            <Text style={[styles.sendIcon, !inputText.trim() && styles.sendIconDisabled]}>⬆️</Text>
          </TouchableOpacity>
        </View>
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
    padding: theme.spacing.md,
    paddingBottom: theme.spacing.lg,
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
  },
  attachBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  attachIcon: {
    fontSize: 20,
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingTop: 10,
    paddingBottom: 10,
    minHeight: 40,
    maxHeight: 100,
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
    marginHorizontal: theme.spacing.sm,
  },
  sendBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: 20,
    marginBottom: 4,
  },
  sendBtnDisabled: {
    backgroundColor: theme.colors.background,
  },
  sendIcon: {
    fontSize: 16,
    color: theme.colors.white,
  },
  sendIconDisabled: {
    opacity: 0.3,
  },
});
