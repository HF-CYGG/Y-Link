import * as SecureStore from 'expo-secure-store';

/**
 * 这里只提供字符串级安全存储适配，不承担会话或 token 生命周期管理。
 * 调用方禁止写入密码、验证码或可直接使用的明文 Bearer token；应只保存最小化、可撤销的会话引用。
 */
export const secureStorage = {
  get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key);
  },
  set(key: string, value: string): Promise<void> {
    return SecureStore.setItemAsync(key, value);
  },
  delete(key: string): Promise<void> {
    return SecureStore.deleteItemAsync(key);
  },
};
