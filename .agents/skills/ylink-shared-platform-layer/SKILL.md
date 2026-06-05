---
name: "ylink-shared-platform-layer"
description: "Maintains Y-Link shared frontend platform layers. Invoke when changing shared APIs, constants, router, store, composables, or common components used across modules."
---

# Y-Link Shared Platform Layer

## 目标
- 专门覆盖 `Y-Link` 前端中跨模块复用的“平台层”。
- 适合处理不是某个单页私有逻辑，而是多个模块共同依赖的基础层改动。

## 何时使用
- 用户需求涉及以下任一共享层：
  - API 模块
  - 路由与权限元信息
  - 共享常量
  - composable
  - `components/common`
  - 统一分页、统一错误处理、统一缓存工具

## 结构覆盖
### 1. API 层
- `src/api/http.ts`
- `src/api/index.ts`
- `src/api/modules/**`

### 2. 路由层
- `src/router/index.ts`
- `src/router/routes.ts`
- `src/router/route-performance.ts`

### 3. Store 层
- `src/store/index.ts`
- `src/store/modules/**`

### 4. 共享组件
- `src/components/common/**`
- `src/components/charts/**`

### 5. 共享 composable
- `src/composables/useCrudManager.ts`
- `src/composables/useStableRequest.ts`
- `src/composables/useDevice.ts`
- `src/composables/useRouteBoundWorkbenchTab.ts`
- `src/composables/useCameraQrScanner.ts`

### 6. 共享常量与工具
- `src/constants/**`
- `src/utils/**`
- `src/style.css`

## 工作方式
1. 先确认这是“共享层问题”还是“单页面问题”。
2. 若多个页面都依赖同一逻辑：
   - 优先改共享层，不复制修复到多个页面。
3. 若改 API 类型：
   - 同步检查调用页面与 store。
4. 若改路由元信息：
   - 同步检查菜单、权限、快捷入口和 keepAlive。
5. 若改共享组件：
   - 评估会影响哪些管理端 / 客户端页面。

## 必须遵守
- 共享层改动要特别注意影响面，不能只验证单页。
- 类型、常量和文案改动要保证上下游一致。
- 路由或权限改动时，前后端权限码必须保持同步。
- composable 改动时，要检查调用它的所有主要页面。

## 验证要求
- 至少执行：
  - `npm run build`
- 若影响后端接口或权限：
  - `cd backend && npm run build`
- 若影响 UI 共享组件：
  - 复查关键调用页 diagnostics

## 输出要求
- 先说明这是哪个共享层的问题。
- 明确说明影响范围：
  - 哪些页面
  - 哪些 store
  - 哪些 API 模块
  - 哪些共享组件 / composable

## 示例
- “订单返回结构新增字段，需要前后端和缓存同时适配”
- “工作台菜单和权限派生口径要统一”
- “统一扫码组件要从商业 SDK 切到开源方案”
- “公共分页/错误提示逻辑需要全局调整”
