# Y-Link Mobile：Antigravity UI 协作边界

## 0. 优先级与当前阶段硬边界

1. 仓库根 `AGENTS.md` 与用户当前任务始终优先于本文。本文不能放宽权限、子 agent、Git、风险操作或验证边界，也不构成自动委派或修改授权。
2. 第一阶段只交付 Expo 路由占位、providers、SecureStore/SQLite 基础、平台能力接口、共享包骨架和 CI；不新增或修改后端 API、数据库、认证会话、购物车、订单、库存、退货等业务。
3. 相机、相册、通知、正式 Deep Link、完整 401 refresh、服务端购物车、EAS 发布、正式包名与签名均是后续路线；当前未配置、未实现。

## 1. 角色

Antigravity 负责 Y-Link Mobile 的 mock UI、页面、组件、视觉和交互。当前只能在现有 Expo 占位骨架上做 Feature Mock，不接真实 API，不处理会话、同步或业务 mutation。

当前 `packages/*` 尚未接入 Mobile 的依赖解析。即使仓库中存在 shared packages，Antigravity 也不得从 `apps/mobile` 跨目录导入它们；需要的 mock 类型应放在 feature 自己的 mock 边界并明确标记临时，不能冒充正式 DTO。

## 2. 允许修改的目录

只有在用户当前任务明确要求 UI 工作时，才允许修改：

```text
apps/mobile/app/
apps/mobile/src/ui/
apps/mobile/src/components/
apps/mobile/src/theme/
apps/mobile/assets/
apps/mobile/src/features/*/screens/
apps/mobile/src/features/*/components/
apps/mobile/src/features/*/mock/
```

若真实路由目录与文档示例不一致，以仓库代码为准。新增 feature 目录或扩大范围前必须取得任务授权。

## 3. 禁止修改的目录

```text
backend/**
src/**
packages/**
.github/**
apps/mobile/src/api/**
apps/mobile/src/db/**
apps/mobile/src/platform/**
apps/mobile/src/stores/**
apps/mobile/src/sync/**
apps/mobile/package.json
apps/mobile/package-lock.json
apps/mobile/app.config.ts
apps/mobile/eas.json
```

根配置、Docker/Compose、数据库文件、签名和凭据同样禁止修改。用户另行明确授权时，仍需服从根 `AGENTS.md` 的风险与验证规则。

## 4. UI 实现规则

- 页面只消费 Feature Mock 或已由后续正式任务提供的 hook；当前不得直接调用 `fetch`、Axios 或 request bridge；
- 不实现登录、refresh、下单、取消、退货、库存判断、同步冲突或上传确认；
- 不发明正式接口字段，不把 mock 数据写入 `packages/shared-types`；
- 通用视觉值优先经 `apps/mobile/src/theme/` 统一管理；共享 design tokens 尚未接入时不要跨目录导入；
- 页面至少覆盖正常、加载、空、错误四类 mock 状态；弱网提示仅可作为视觉占位；
- Android 优先适配安全区、键盘、滚动和小屏，但不要在页面散落平台判断；
- 相机、相册、通知和 Deep Link 只能显示“未配置”状态，不得自行安装依赖或申请权限。

## 5. 第一轮建议范围

先完善现有路由占位的视觉骨架，例如登录、商城、订单、反馈和个人中心；之后按单个 feature 拆任务。购物车、结算、订单详情、退货和附件 UI 即使只做 mock，也应先获得明确页面范围与字段说明。

## 6. 验收与回传

至少运行：

```bash
npm --prefix apps/mobile run typecheck
```

如任务涉及 Android bundle，再运行：

```bash
npm --prefix apps/mobile run export:android
```

不要要求或声称运行不存在的通用 Mobile `test`；已有的 `test:db` 只验证 SQLite migration 框架，不替代 UI 验收。回传必须列出修改文件、已覆盖状态、mock/TODO、实际验证、未验证的模拟器/真机能力和是否需要后续契约支持。

## 7. 停止条件

遇到缺失的正式字段、共享包接入、真实 API、平台权限、认证或业务规则时，停止扩展并向主任务报告。不得用临时 UI 代码绕过这些边界。
