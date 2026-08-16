# Y-Link Mobile

Y-Link 的 Expo 移动端工程。当前已建立可运行路由、Provider、Feature Mock、平台边界和共享 Contract package 消费基础，但未连接后端 API，也不代表最终视觉方案。

## 环境与安装

- Node.js：`22.13.1`
- 包管理器：npm workspace；本目录保留独立 `package.json`，唯一依赖真源为仓库根 `package-lock.json`
- 依赖源：仓库根 `.npmrc` 固定官方 npm registry；根 lockfile 保留 tarball `resolved` 与 `integrity` 供本地、CI 与 EAS 共用
- Expo SDK：`~57.0.0`
- React Native：`0.86.x`
- React：`19.2.3`

全新 clone 后必须从仓库根安装：

```bash
npm ci
npm run verify:mobile:workspace
```

不要在 `apps/mobile` 单独执行 `npm install` 或生成第二份 lockfile。共享包只能通过 `@ylink/*` package 名称导入，不得使用 `../..` 或其它相对路径直接引用根项目与 `packages/*`。

## Android 启动与检查

```bash
npm --workspace y-link-mobile run android
npm --workspace y-link-mobile run dependencies:check
npm --workspace y-link-mobile run test:db
npm --workspace y-link-mobile run typecheck
npm --workspace y-link-mobile run export:android
```

`android` 需要本机已配置 Android Emulator 或通过 ADB 连接设备。`export:android` 只生成可清理的 `.expo-export/` 静态产物，不等同于签名 APK、AAB 或商店发布验证。

## 目录与状态分工

- `app/`：Expo Router 路由入口；认证页与四个底部标签页目前均为占位。
- `src/app/providers/`：Safe Area 与 TanStack Query 等应用级 Provider；`QueryClient` 在模块级创建，避免渲染时重建。
- `src/contracts/`：Mobile 对正式共享 packages 的最小解析边界；不创建 adapter 或真实请求。
- `src/features/`：按认证、商城、购物车、结算、订单、反馈、个人中心拆分业务边界。
- `src/stores/`：Zustand 客户端状态；服务端缓存应留给 TanStack Query。
- `src/db/`：SQLite 打开函数与 `PRAGMA user_version` 迁移框架；数据库当前版本限定为 `0..2147483647` 整数，迁移版本限定为 `1..2147483647` 且不可重复，允许跳号但始终严格升序执行。数据库版本高于代码最高已知迁移时会拒绝降级运行；空迁移清单仅允许版本 `0`。迁移只能由初始化链单一入口串行触发，当前不创建业务表、不自动 hydration。
- `src/platform/`：安全存储和相机、图片选择、通知、Deep Link 的平台抽象。
- `src/components/`、`src/ui/`、`src/theme/`：共享组件、无业务语义 UI 与设计令牌。
- `src/sync/`：未来离线同步与冲突处理边界；当前不运行同步任务。

## Mock 与 API 接入

当前页面只展示静态占位文案，不提供伪造的网络层或假 `test` 命令。需要 mock 时，应把确定性的 fixture 放在对应 `features/*` 内，并与生产数据入口隔离。

Mobile 已通过根 npm workspace 正式依赖 `@ylink/shared-types` 与 `@ylink/api-client`。前者提供 Auth、Catalog、O2O Order/Return、Feedback 与 Common Contract，后者提供对应传输无关 modules 和 adapter；字段地图见 `docs/project-context/61-Mobile-API-Contract.md`。

当前 `src/contracts/shared-packages.ts` 只用于证明包身份、类型与标准错误可以被 Mobile 解析，不实例化 Native adapter、不发起网络请求。未来网络调用必须统一进入客户端层，页面、Store 和 mock 不直接发起请求；在 Native token/session 方案获批前不得接真实 Auth。

`@ylink/domain`、`@ylink/validation` 与 `@ylink/design-tokens` 已按同一规范纳入根 workspace，但 Mobile 尚未声明依赖或消费。后续接入时只需在本 manifest 添加明确的 workspace dependency，并同步验证/文档；本轮不迁移现有主题、schema 或 Web 业务逻辑。

## Expo / EAS 入口

Expo 本地命令可从仓库根通过 npm workspace 运行。EAS CLI 按官方 monorepo 约定从 App 根启动：

```bash
cd apps/mobile
eas build --platform android --profile preview
```

EAS 上传仓库后按根 workspace 与根 `package-lock.json` 安装，`eas.json` 将 Node 固定为 `22.13.1`。当前没有 EAS project ID、Android applicationId、签名或凭据，因此上述命令只是正式构建入口说明，本阶段不执行发布或远端构建。

## 平台能力状态

相机、图片选择、通知与 Deep Link 目前只有平台无关接口；调用会抛出 `PlatformCapabilityNotConfiguredError`。本阶段未安装 camera、image-picker 或 notifications 原生依赖，未声明相关权限，也未实现业务 hooks。

`expo-secure-store` 适配器只负责字符串读写，不负责 token 生命周期。禁止存储密码、验证码或可直接使用的明文 Bearer token；只允许保存经安全设计评审的最小化、可撤销会话引用。SQLite 也不得成为敏感凭据仓库。

## iOS 扩展

当前没有 `ios.bundleIdentifier`、Apple 凭据或 EAS projectId。开始 iOS 真机与发布工作前，需要确认 bundle identifier、签名团队、Keychain 行为、权限文案和商店合规，再补充对应配置与设备验证。

## Antigravity 修改边界

在单独任务明确授权时，Antigravity 可修改：`app/**`、`src/features/**`、`src/components/**`、`src/stores/**`、`src/sync/**`、`src/theme/**`、`src/ui/**`。可以参考 Contract Map 设计确定性的 Feature Mock，但不得自行计算最终金额、最终可下单/可退数量或库存预占结果。

未经移动端平台负责人明确授权，Antigravity 禁止修改：`src/platform/**`、`src/db/**`、`src/app/providers/**`、`app.config.ts`、`eas.json`、`package.json`、`package-lock.json`，以及 `apps/mobile` 以外的任何目录。
