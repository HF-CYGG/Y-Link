# Y-Link Mobile：Codex 工程协作边界

## 0. 优先级与当前阶段硬边界

1. 仓库根 `AGENTS.md` 与用户当前任务始终优先于本文。本文不能放宽权限、子 agent、Git、风险操作或验证边界，也不能替代清晰的工程任务简报。
2. 当前 Contract Foundation 只交付已核对的跨端类型、传输无关 API modules 与 Web 渐进 re-export；不新增或修改后端 API、数据库、认证会话、服务端购物车、订单幂等、库存或退货状态机。
3. 相机、相册、通知、正式 Deep Link、完整 401 refresh、服务端购物车、EAS 发布、正式包名与签名均是后续路线；当前未配置、未实现。

## 1. 当前工程与 Contract 实现

- `apps/mobile` 是独立 npm package，拥有自己的 `package.json` 与 `package-lock.json`；
- 根 `package.json` 未启用 npm workspaces，现有 Web 安装与构建链路保持不变；
- Expo Router 当前只提供登录、商城、订单、反馈和个人中心等轻量占位路由；
- `AppProviders` 组合 Safe Area 与 TanStack Query 基础，未装配真实会话或 API；
- SecureStore 只有字符串存取包装，SQLite 只有打开与 `PRAGMA user_version` 迁移框架；
- 相机、相册、通知和 Deep Link 只有平台能力接口与未配置错误；
- `packages/shared-types` 已成为 Auth、Catalog、O2O Order/Return、Feedback 与 Common 客户端 Contract 真源；
- `packages/api-client` 已提供 `client-auth`、`catalog`、`orders`、`feedback` modules 和显式 `cart` placeholder；Web adapter 是 bridge 薄包装，Native adapter 的 401 只返回规范化错误并保留 `TODO(mobile-auth)`；
- Mobile 当前不得跨目录源码导入 `packages/*`，正式接入需要后续独立任务。

## 2. 目录边界

Mobile 与共享基础文件按独立任务拆分：

```text
apps/mobile/**                       Mobile 工程
packages/**                          共享基础
.github/workflows/mobile-check.yml   限定 CI
文档与 .gitignore                    仓库接入说明
```

任何后续任务仍必须以用户给出的允许路径为准，本文不会自动授权修改上述全部目录。尤其不能因为角色说明而修改 `backend/**`、现有 `src/**`、Docker/Compose、根 package/lock 或 Git 历史。

## 3. 共享基础规则

### `packages/shared-types`

只接收经过现行 route、service、entity 与 Web 消费链核对的稳定客户端类型。已迁移类型从这里导出，Web 原 API 文件只做 import/re-export；禁止为了消除类型错误复制 DTO、放宽服务端必返字段或发明字段。

### `packages/api-client`

- `HttpAdapter` 只定义传输契约；
- Native fetch adapter 支持超时、取消、query、JSON body、显式 headers、可注入 token 和显式 `Idempotency-Key`；
- adapter 不直接依赖 SecureStore、Zustand、React 或页面；
- 401 当前不刷新、不重放、不退出；完整 refresh mutex 和会话清理必须等后端移动会话契约获批后实现；
- Web adapter 不能反向依赖现有 Web 源码，只接受外部 bridge。
- API modules 只描述 method、path、query、body 和 response；附件上传、SSE、服务端购物车与最终 Native session 均不在当前范围。

### 其他共享包

- `domain` 仅允许无 UI、网络、存储副作用的纯函数；
- `validation` 的模块文件当前是占位，正式 Zod schema 需有真实契约；
- `design-tokens` 只提供原始 token，不承担组件或主题逻辑。

## 4. Mobile 基础规则

- QueryClient 不得随 render 重建；
- SecureStore 不得保存密码、验证码或未经业务授权的敏感数据；
- SQLite 第一阶段不创建业务表，也不自动执行复杂 hydration；
- 平台能力未配置时必须显式抛出统一错误，不能静默降级为伪成功；
- 不安装 camera/image-picker/notifications；不设置 `android.package`、`ios.bundleIdentifier`、EAS projectId、签名或 secrets；
- `eas.json` 只是无凭据路线骨架，不代表可发布。

## 5. 后续任务的风险门禁

以下内容必须另行获得用户明确授权并重新读取相关项目上下文：后端移动会话、token/refresh、权限、服务端购物车、订单、库存、退货、上传、数据库迁移、并发控制和发布。不得把本文中的未来路线当作实施请求，也不得自动要求或派发 Claude/其他子 agent。

## 6. 当前验证

```bash
npm --prefix apps/mobile ci
npm --prefix apps/mobile run dependencies:check
npm --prefix apps/mobile run test:db
npm --prefix apps/mobile run typecheck
npm --prefix apps/mobile run export:android
npm ci
node ./node_modules/typescript/bin/tsc -p packages/tsconfig.json --noEmit
node --experimental-strip-types --test packages/api-client/test/*.test.ts
```

Contract 字段与 Antigravity 使用边界见 `docs/project-context/61-Mobile-API-Contract.md`。Mobile 当前仍不得跨目录源码导入 `packages/*`。

Mobile 没有笼统或虚假的通用 `test`，但已有 SQLite migration 专项 `test:db`，CI 必须运行该真实专项测试。Android export 不是模拟器、真机、签名 APK 或 EAS 发布证据。

## 7. 交付要求

每次任务都要列出允许范围、修改文件、行为变化、实际命令与结果、未验证项和残余风险。禁止从本文推导 Git 写入、PR、推送、发布或高风险操作授权。
