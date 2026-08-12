# Y-Link Mobile 多端开发总方案

版本：v1.2
日期：2026-08-13
当前状态：Contract Foundation 已建立，Mobile 尚未接入共享包或真实 API

## 0. 优先级与当前阶段硬边界

1. 仓库根 `AGENTS.md` 与用户当前任务始终优先于本文。本文是路线说明，不能放宽其中的权限、子 agent、Git、风险操作或验证边界，也不构成任何执行授权。
2. 当前 Contract Foundation 只校准跨端纯 TypeScript DTO、传输无关 API modules 与 Web 渐进 re-export；不新增或修改后端 API、数据库、认证会话、服务端购物车、订单幂等、库存或退货状态机。
3. 相机、相册、通知、正式 Deep Link、完整 401 refresh、服务端购物车、EAS 发布、正式包名与签名均为后续路线；当前未配置、未实现，不得按已交付能力对外承诺。

## 1. 项目目标

Y-Link 保留现有 Vue Web 管理端、Web 客户端和 Express/TypeORM 后端，在旁路新增 Android 优先、兼容后续 iOS 的 React Native + Expo 用户端。移动端不是 WebView 套壳，也不要求把现有 `src/` 迁入 `apps/web/`。

长期边界如下：

- 后端是认证、库存、订单、退货、核销和权限的最终事实来源；
- Mobile 负责页面、交互、受控本地状态、缓存与请求适配；
- 跨端能力只有在契约稳定后才进入 `packages/*`；
- 第一阶段不改变现有 Web、后端、Docker/Compose 或数据库运行方式。

## 2. Bootstrap 与 Contract Foundation 交付状态

| 范围 | 当前口径 |
| --- | --- |
| `apps/mobile` | 独立 Expo package 与 lockfile；路由和页面仅为占位，不接真实业务 API |
| Providers | `SafeAreaProvider` 与稳定的 TanStack Query `QueryClient` 基础 |
| 本地能力 | SecureStore 字符串包装、SQLite 版本迁移框架，不创建业务表 |
| 平台能力 | 相机、相册、通知、Deep Link 仅定义未配置接口和统一错误 |
| `packages/shared-types` | Auth、Catalog、O2O Order/Return、Feedback 与 Common 客户端 Contract 真源 |
| `packages/api-client` | 传输无关接口、业务 modules、Web bridge 与 Native fetch adapter；401 只归一化错误并保留 TODO |
| 其他共享包 | `domain`、`validation`、`design-tokens` 的最小边界骨架 |
| CI | Mobile 与共享基础两个独立 job；只做依赖、类型、测试和 Android JS bundle export |

当前仍没有 Mobile 真实登录、商城、购物车、订单、反馈或同步闭环。页面能打开只代表导航与工程骨架成立，共享 Contract 存在也不代表 Mobile 已接入业务。

## 3. 当前与未来技术栈

### 3.1 当前已纳入基础

- React Native、Expo、Expo Router、TypeScript；
- TanStack Query、Zustand；
- `expo-secure-store`、`expo-sqlite`；
- `react-native-safe-area-context`、`react-native-screens`；
- Node.js `22.13.1` 与 npm 独立安装。

### 3.2 后续候选能力

以下只代表路线，不代表依赖、权限、凭据或发布配置已经存在：

- `expo-camera`、`expo-image-picker`、`expo-notifications`；
- 正式 App/Deep Link 与推送跳转；
- Native 会话刷新、登出清理和服务端多设备会话；
- 服务端购物车、弱网 outbox 与冲突合并；
- EAS Build、EAS Submit、EAS Update；
- Android `applicationId`、iOS `bundleIdentifier`、签名与商店凭据。

## 4. 仓库结构与依赖策略

```text
Y-Link/
├─ src/                         现有 Vue Web，保持原位
├─ backend/                     现有 Express / TypeORM 后端
├─ apps/mobile/                 独立 Expo package 与 package-lock.json
├─ packages/
│  ├─ api-client/               传输无关 HTTP 契约与 adapter
│  ├─ shared-types/             已核对的稳定客户端契约类型入口
│  ├─ domain/                   纯函数边界
│  ├─ validation/               校验模块边界
│  └─ design-tokens/            最小跨端 primitive tokens
└─ .github/workflows/mobile-check.yml
```

第一阶段不启用根 npm workspaces。`apps/mobile` 使用自己的 `package.json` 和 `package-lock.json`，不得跨目录源码导入 `packages/*`。根依赖只用于现有 Web 和共享包独立类型检查；任何正式共享包接入都必须另立任务并明确解析、发布或构建策略。

## 5. 架构边界

### 5.1 Mobile

- `apps/mobile/app/`：Expo Router 路由入口，不承载复杂业务判断；
- `src/app/providers/`：应用级 provider 组合；
- `src/features/`：按业务域保留页面、组件、mock 与后续 hook 边界；
- `src/platform/`：平台能力接口，未配置能力必须显式失败；
- `src/db/`：SQLite 打开与版本迁移基础，不保存明文 token、密码或验证码；
- `src/stores/`、`src/sync/`：第一阶段只保留职责边界。

### 5.2 共享包

- `shared-types` 只接受已由现行 route/service/entity 核对、稳定且跨端确有需要的契约；当前已迁移 Auth、Catalog、O2O Order/Return、Feedback 与 Common 低风险 DTO；
- `api-client` 不含 UI、SecureStore 生命周期或业务状态机；
- Native adapter 可注入 Bearer token、处理超时/取消与显式幂等键，但不实现 401 refresh/replay；
- `domain` 不依赖 UI、网络、存储或运行时全局对象；
- `validation` 当前只有模块骨架，不把占位 schema 当正式契约；
- `design-tokens` 仅提供 primitive tokens，不替代 Mobile 主题层。

## 6. 后续产品路线

### Contract Foundation（已完成）

以当前运行代码为事实来源建立 `shared-types` 和 `api-client` modules，现有 Web 通过 import/re-export 渐进消费共享类型，API URL、Cookie/CSRF 和页面返回结构保持不变。字段地图与 UI 计算边界见 `docs/project-context/61-Mobile-API-Contract.md`。

此阶段只让 Contract 在仓库内可用；`apps/mobile` 尚未解决独立 package 对共享包的版本化消费方式，也没有接入真实 API。

### 第二阶段：Feature Mock

在 Antigravity 允许目录内完善登录、商城、订单、反馈和个人中心的 mock UI。mock 必须在 feature 内闭环，不能跨目录导入尚未接入 Mobile 的共享包，也不能发明正式 API 字段。

### 第三阶段：真实接口接入

需先单独完成并审查 Native 认证契约、服务端 API 兼容性、401 refresh 策略和共享类型接入方式。任何后端、数据库或安全边界变化都需要用户明确授权，并运行对应后端验证。

### 第四阶段：业务闭环

服务端购物车、预订单、库存预占、退货、反馈附件、弱网同步等必须以服务端事务、幂等、权限和回归测试为前提，不能由 Mobile 自行决定最终业务结果。

### 第五阶段：原生能力与发布

逐项评审相机、相册、通知、Deep Link、正式包名、签名、EAS 与商店流程。凭据不得进入仓库；发布、推送、外部写入需遵守根规范并取得相应授权。

## 7. CI 与验收

第一阶段 Mobile CI 只验证本次独立工程与共享基础，不调用 Docker、数据库迁移、EAS，也不读取 secrets。

Mobile job：

```bash
npm --prefix apps/mobile ci
npm --prefix apps/mobile run dependencies:check
npm --prefix apps/mobile run test:db
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile run export:android
```

Foundations job：

```bash
npm ci
node ./node_modules/typescript/bin/tsc -p packages/tsconfig.json --noEmit
node --experimental-strip-types --test packages/api-client/test/*.test.ts
```

`apps/mobile/package.json` 当前不提供笼统或虚假的通用 `test`；它提供真实的 SQLite migration 专项 `test:db`。第一阶段 PR 验收必须运行该专项测试，但不得要求不存在的通用 Mobile 测试脚本。Android export 只证明 JS bundle 可导出，不等于模拟器、真机、签名 APK 或商店发布通过。

## 8. 协作与风险治理

- 任何 agent 的职责文档都不能自行授权子 agent、Git 写入、后端修改或高风险操作；
- UI 任务只能在明确允许的 Mobile 目录内使用 Feature Mock；
- 涉及认证、权限、订单、库存、退货、迁移、上传或并发的后续工作必须重新确认范围和风险；
- 文档与真实代码不一致时以代码为准，并在任务范围允许时同步修正文档；
- 每轮交付必须记录实际命令、结果、未验证项和残余风险。

## 9. 当前完成定义

Mobile Bootstrap 与 Contract Foundation 完成只表示：独立 Mobile 工程、基础 providers、本地/平台接口、已核对的共享客户端类型、传输无关 API modules 和限定 CI 已落库并通过相应静态验证。它不表示 Android 业务 App 已接入共享包/真实 API，也不表示后端移动会话、服务端购物车、原生能力、签名产物或发布链路已经完成。
