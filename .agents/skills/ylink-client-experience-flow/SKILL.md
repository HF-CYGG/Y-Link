---
name: "ylink-client-experience-flow"
description: "Handles Y-Link client-side user flows by repo structure. Invoke when changing client auth, mall, cart, checkout, orders, profile, or mobile interaction experience."
---

# Y-Link Client Experience Flow

## 目标
- 覆盖 `Y-Link` 客户端 H5 的完整用户链路，而不是只处理某个单页面需求。
- 适合处理“用户看到什么、怎么操作、状态如何缓存、移动端如何表现”这类问题。

## 何时使用
- 用户需求涉及客户端任一部分：
  - 登录 / 注册 / 忘记密码
  - 商品大厅
  - 购物车
  - 结算与下单
  - 我的订单 / 订单详情
  - 我的资料 / 修改密码
  - 移动端导航、切页、卡片布局、交互反馈

## 结构覆盖
### 1. 客户端页面
- `src/views/client/ClientAuthView.vue`
- `src/views/client/ClientForgotPasswordView.vue`
- `src/views/client/ClientMallView.vue`
- `src/views/client/ClientCartView.vue`
- `src/views/client/ClientCheckoutView.vue`
- `src/views/client/ClientOrdersView.vue`
- `src/views/client/ClientOrderDetailView.vue`
- `src/views/client/ClientProfileView.vue`

### 2. 客户端布局与外壳
- `src/views/client/components/ClientMainLayout.vue`
- `src/views/client/components/ClientShell.vue`

### 3. 客户端状态管理
- `src/store/modules/client-auth.ts`
- `src/store/modules/client-cart.ts`
- `src/store/modules/client-catalog.ts`
- `src/store/modules/client-order.ts`

### 4. 客户端本地缓存
- `src/utils/client-auth-storage.ts`
- `src/utils/client-cart-storage.ts`
- `src/utils/client-catalog-storage.ts`
- `src/utils/client-order-storage.ts`

### 5. 客户端接口
- `src/api/modules/client-auth.ts`
- `src/api/modules/o2o.ts`
- `src/api/modules/client-user-manage.ts`

## 工作方式
1. 先判断需求属于哪个客户端流程：
   - 认证
   - 浏览
   - 购买
   - 订单
   - 个人中心
2. 先查页面入口，再查 store、缓存和 API。
3. 若状态跨页面复用：
   - 优先收敛到 store 或 storage，而不是散落在多个页面本地状态。
4. 若涉及移动端交互异常：
   - 同时检查布局容器、底部导航、滚动区域和安全区。
5. 若涉及订单 / 商品展示：
   - 同步检查后端返回结构是否已支持。

## 必须遵守
- 客户端体验优先移动端可用性。
- 不让页面文案与真实业务状态脱钩。
- 若本地缓存结构变更：
  - 必须同步 storage 解析逻辑与容错。
- 若用户可见状态改变：
  - 优先确认订单列表、详情、商城卡片是否都要同步。

## 验证要求
- 至少执行：
  - `npm run build`
- 若影响后端返回结构：
  - `cd backend && npm run build`

## 输出要求
- 明确说明影响的是哪段客户端流程。
- 明确说明是否改了：
  - 页面
  - store
  - 本地缓存
  - API 类型
  - 移动端布局

## 示例
- “商城卡片要显示新的商品状态”
- “购物车和结算页库存口径不一致”
- “客户端订单详情要展示商家特殊状态”
- “我的页面切换时底部导航瞬间错位”
