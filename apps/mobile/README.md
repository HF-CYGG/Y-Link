# Y-Link Mobile

Y-Link 的独立 Expo 移动端工程。当前阶段只建立可运行的路由、Provider 和平台边界，不连接后端 API，也不代表最终视觉方案。

## 环境与安装

- Node.js：`22.13.1`
- 包管理器：npm；本目录使用独立 `package.json` 与 `package-lock.json`
- 依赖源：本目录 `.npmrc` 固定官方 npm registry；lockfile 保留 tarball `resolved` 与 `integrity` 供 CI 校验
- Expo SDK：`~57.0.0`
- React Native：`0.86.x`
- React：`19.2.3`

首次安装：

```bash
npm --prefix apps/mobile install
```

不要从根目录 workspace 安装，不要使用 `../..` 直接引用根项目或 `packages/*`。

## Android 启动与检查

```bash
npm --prefix apps/mobile run android
npm --prefix apps/mobile run dependencies:check
npm --prefix apps/mobile run test:db
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile run export:android
```

`android` 需要本机已配置 Android Emulator 或通过 ADB 连接设备。`export:android` 只生成可清理的 `.expo-export/` 静态产物，不等同于签名 APK、AAB 或商店发布验证。

## 目录与状态分工

- `app/`：Expo Router 路由入口；认证页与四个底部标签页目前均为占位。
- `src/app/providers/`：Safe Area 与 TanStack Query 等应用级 Provider；`QueryClient` 在模块级创建，避免渲染时重建。
- `src/features/`：按认证、商城、购物车、结算、订单、反馈、个人中心拆分业务边界。
- `src/stores/`：Zustand 客户端状态；服务端缓存应留给 TanStack Query。
- `src/db/`：SQLite 打开函数与 `PRAGMA user_version` 迁移框架；数据库当前版本限定为 `0..2147483647` 整数，迁移版本限定为 `1..2147483647` 且不可重复，允许跳号但始终严格升序执行。数据库版本高于代码最高已知迁移时会拒绝降级运行；空迁移清单仅允许版本 `0`。迁移只能由初始化链单一入口串行触发，当前不创建业务表、不自动 hydration。
- `src/platform/`：安全存储和相机、图片选择、通知、Deep Link 的平台抽象。
- `src/components/`、`src/ui/`、`src/theme/`：共享组件、无业务语义 UI 与设计令牌。
- `src/sync/`：未来离线同步与冲突处理边界；当前不运行同步任务。

## Mock 与 API 接入

当前页面只展示静态占位文案，不提供伪造的网络层或假 `test` 命令。需要 mock 时，应把确定性的 fixture 放在对应 `features/*` 内，并与生产数据入口隔离。

未来接入 `api-client` 与 `shared-types` 时，应通过正式发布或明确的独立包安装方式消费版本，不得用跨目录相对路径直接引用根 `packages/*`。网络调用统一进入该客户端层，页面和 Store 不直接发起请求。

## 平台能力状态

相机、图片选择、通知与 Deep Link 目前只有平台无关接口；调用会抛出 `PlatformCapabilityNotConfiguredError`。本阶段未安装 camera、image-picker 或 notifications 原生依赖，未声明相关权限，也未实现业务 hooks。

`expo-secure-store` 适配器只负责字符串读写，不负责 token 生命周期。禁止存储密码、验证码或可直接使用的明文 Bearer token；只允许保存经安全设计评审的最小化、可撤销会话引用。SQLite 也不得成为敏感凭据仓库。

## iOS 扩展

当前没有 `ios.bundleIdentifier`、Apple 凭据或 EAS projectId。开始 iOS 真机与发布工作前，需要确认 bundle identifier、签名团队、Keychain 行为、权限文案和商店合规，再补充对应配置与设备验证。

## Antigravity 修改边界

在单独任务明确授权时，Antigravity 可修改：`app/**`、`src/features/**`、`src/components/**`、`src/stores/**`、`src/sync/**`、`src/theme/**`、`src/ui/**`。

未经移动端平台负责人明确授权，Antigravity 禁止修改：`src/platform/**`、`src/db/**`、`src/app/providers/**`、`app.config.ts`、`eas.json`、`package.json`、`package-lock.json`，以及 `apps/mobile` 以外的任何目录。
