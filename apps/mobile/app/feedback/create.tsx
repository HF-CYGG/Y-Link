import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, SafeAreaView, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { theme } from '../../src/theme';
import { Button, Input, SectionHeader, Card } from '../../src/ui';
import { AttachmentTile } from '../../src/features/feedback/components/AttachmentTile';

export default function CreateFeedbackScreen() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // 仅模拟本地图片路径
  const [images, setImages] = useState<string[]>([]);

  const handleAddImage = () => {
    // TODO(camera/image-picker): real image picker
    alert('打开相册 (Mock)');
    // 模拟添加了一张图片
    if (images.length < 3) {
      setImages([...images, 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=100&q=80']);
    }
  };

  const handleDeleteImage = (index: number) => {
    const next = [...images];
    next.splice(index, 1);
    setImages(next);
  };

  const handleSubmit = () => {
    if (!title.trim() || !content.trim()) {
      alert('请填写标题和内容');
      return;
    }

    setIsSubmitting(true);
    setTimeout(() => {
      setIsSubmitting(false);
      // TODO(contract): real create feedback mutation
      alert('反馈提交成功 (Mock)');
      router.back();
    }, 1000);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Card style={styles.section}>
            <SectionHeader title="问题或建议" />
            
            <Input 
              placeholder="一句话描述问题 (如: 售后申请)"
              value={title}
              onChangeText={setTitle}
            />
            
            <TextInput 
              style={styles.contentInput}
              multiline
              numberOfLines={6}
              placeholder="请详细描述您遇到的问题或建议，我们会尽快为您解答..."
              placeholderTextColor={theme.colors.placeholder}
              value={content}
              onChangeText={setContent}
              textAlignVertical="top"
            />
          </Card>

          <Card style={styles.section}>
            <SectionHeader title={`图片附件 (${images.length}/3)`} />
            <View style={styles.imagesContainer}>
              {images.map((url, index) => (
                <AttachmentTile 
                  key={index}
                  url={url}
                  onDelete={() => handleDeleteImage(index)}
                />
              ))}
              {images.length < 3 && (
                <AttachmentTile isPlaceholder onPress={handleAddImage} />
              )}
            </View>
          </Card>
        </ScrollView>

        <View style={styles.bottomBarArea}>
          <View style={styles.bottomBar}>
            <Button 
              title="提交反馈" 
              onPress={handleSubmit} 
              loading={isSubmitting}
              style={styles.submitBtn}
            />
          </View>
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
    paddingBottom: 100,
  },
  section: {
    marginBottom: theme.spacing.md,
  },
  contentInput: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    minHeight: 150,
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
  },
  imagesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  bottomBarArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    ...theme.shadows.md,
  },
  bottomBar: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  submitBtn: {
    width: '100%',
    borderRadius: theme.radius.full,
  },
});
