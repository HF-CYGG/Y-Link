---
name: "ylink-admin-business-workbench"
description: "Handles Y-Link admin workbench modules by repo structure. Invoke when changing dashboard, order entry, order list, inbound, base data, or system management flows."
---

# Y-Link Admin Business Workbench

## 目标
- 覆盖 `Y-Link` 管理端主工作台结构，而不是只处理单个页面局部改动。
- 面向后台业务模块做结构化实现、修复与联调。

## 何时使用
- 用户需求属于管理端任一业务模块：
  - 工作台
  - 出库开单
  - 出库单列表
  - 扫码入库 / 入库管理
  - 产品中心 / 标签管理
  - 用户中心 / 系统配置 / 审计日志
- 或者涉及管理端：
  - 路由权限
  - 页面装配
  - 工作台快捷入口
  - 列表/抽屉/弹窗/表单联动

## 模块覆盖
### 1. 路由与权限入口
- `src/router/routes.ts`
- `src/router/index.ts`
- `src/api/modules/auth.ts`
- `src/store/modules/auth.ts`

### 2. 工作台与业务操作
- `src/views/dashboard/**`
- `src/views/order-entry/**`
- `src/views/order-list/**`
- `src/views/inbound/**`

### 3. 基础资料
- `src/views/base-data/**`
- `src/views/product-center/**`

### 4. 系统管理
- `src/views/system/**`
- `src/api/modules/system-config.ts`
- `src/api/modules/user.ts`
- `src/api/modules/audit.ts`

### 5. 共享业务 UI
- `src/components/common/business-composite/**`
- `src/components/common/page-container/**`
- `src/components/common/page-shared/**`
- `src/composables/useCrudManager.ts`
- `src/composables/useStableRequest.ts`

## 工作方式
1. 先定位该需求属于哪个后台模块。
2. 从路由与权限开始确认页面入口是否合法。
3. 再看页面装配：
   - 页面入口
   - composable
   - 子组件
   - API 模块
4. 若涉及列表/详情/抽屉联动：
   - 优先调整共享状态，而不是在多个子组件各自维护一套。
5. 若涉及权限：
   - 同步检查前端权限码、后端权限常量和路由守卫。

## 必须遵守
- 后台页面优先维持“工作台式”整合体验，不随意拆散模块入口。
- 高复用能力尽量沉淀到：
  - 共享组件
  - composable
  - 常量与 API 类型
- 涉及关键动作时，优先考虑是否需要审计日志。

## 验证要求
- 至少执行：
  - `npm run build`
- 若涉及后端接口或权限：
  - `cd backend && npm run build`

## 输出要求
- 明确说明影响的是哪个后台模块。
- 明确说明是否改了：
  - 路由
  - 权限
  - 页面结构
  - 共享组件
  - API / 后端接口

## 示例
- “工作台快捷入口要按权限动态收敛”
- “产品中心编辑状态要联动线上展示”
- “审计日志增加某类动作筛选”
- “出库开单页手机端录入体验异常”
