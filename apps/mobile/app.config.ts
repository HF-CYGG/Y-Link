import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Y-Link Mobile',
  slug: 'y-link-mobile',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // `src/app/providers` 是 Provider 目录，不是路由目录；显式保持任务约定的根 `app/` 路由入口。
  plugins: [['expo-router', { root: 'app' }]],
  experiments: {
    typedRoutes: true,
  },
  // 发布阶段再由正式签名与商店账号共同确认 Android applicationId 和 iOS bundleIdentifier。
  // 当前脚手架禁止预填 EAS projectId、第三方凭据或任何环境 secrets。
});
