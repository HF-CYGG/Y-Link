---
name: "ylink-o2o-order-flow"
description: "Implements Y-Link O2O preorder changes by module map. Invoke when editing mall, cart, checkout, orders, verify, status, or client-visible order progress."
---

# Y-Link O2O Order Flow

## 目标
- 覆盖 `Y-Link` 中完整的 O2O 业务结构，而不是只覆盖最近做过的状态改动。
- 处理线上预订链路时，保证管理端、客户端、后端、审计日志、缓存和文档口径一致。

## 何时使用
- 用户需求属于以下任一 O2O 模块：
  - 商城展示 / 上下架 / 限购
  - 客户端商品大厅、购物车、结算、下单
  - 我的订单、订单详情、取消、超时
  - 管理端订单查询、预订单核销
  - 订单状态、商家特殊状态、用户可见进度
  - 核销、库存扣减、审计日志

## O2O 结构覆盖
### 1. 客户端前台
- `src/views/client/ClientMallView.vue`
- `src/views/client/ClientCartView.vue`
- `src/views/client/ClientCheckoutView.vue`
- `src/views/client/ClientOrdersView.vue`
- `src/views/client/ClientOrderDetailView.vue`
- `src/store/modules/client-cart.ts`
- `src/store/modules/client-catalog.ts`
- `src/store/modules/client-order.ts`

### 2. 管理端 O2O 页面
- `src/views/o2o/O2oProductMallManageView.vue`
- `src/views/o2o/O2oOrderQueryView.vue`
- `src/views/o2o/O2oVerifyConsoleView.vue`
- `src/views/o2o/O2oInboundManageView.vue`

### 3. 前端共享层
- `src/api/modules/o2o.ts`
- `src/constants/o2o-order-status.ts`
- `src/utils/client-order-storage.ts`

### 4. 后端 O2O
- `backend/src/entities/o2o-preorder.entity.ts`
- `backend/src/entities/o2o-preorder-item.entity.ts`
- `backend/src/services/o2o-preorder.service.ts`
- `backend/src/routes/o2o.routes.ts`
- `backend/sql/006_o2o_preorder_schema.sql`
- `backend/sql/007_o2o_preorder_cancel_reason.sql`
- `backend/sql/008_o2o_preorder_business_status.sql`

### 5. 文档口径
- `docs/订单状态说明.md`

## 必须遵守的规则
- 核心订单主状态与商家补充状态分离：
  - 主状态：`pending / verified / cancelled`
  - 补充状态：只用于说明特殊业务进度
- 不能随意让客户端状态文案和后端真实状态脱钩。
- 若新增 O2O 字段，必须同步：
  - 实体
  - 服务
  - 路由
  - API 类型
  - 客户端缓存
  - 管理端展示
  - 客户端展示
  - 文档
- 涉及用户可见状态变更时，优先考虑审计日志。

## 推荐工作流
1. 先确认改动属于哪一层：
   - 商城商品
   - 订单主状态
   - 商家补充状态
   - 核销流
   - 客户端展示
2. 先改后端实体与服务。
3. 再改路由与权限。
4. 再改管理端页面。
5. 再改客户端列表 / 详情 / 缓存。
6. 最后同步 `docs/订单状态说明.md`。
7. 跑前后端构建。

## 审计要求
- 以下操作优先入审计：
  - 设置
  - 清除
  - 变更
  - 核销
  - 人工取消
- 审计内容至少包含：
  - 操作人
  - 订单号
  - 前后状态
  - 请求来源

## 输出要求
- 明确说明影响的 O2O 子模块。
- 明确说明是否改变了：
  - 主状态
  - 补充状态
  - 客户端文案
  - 库存逻辑
  - 审计逻辑

## 示例
- “订单查询页增加特殊状态选择”
- “核销失败状态需要让用户端及时看到”
- “商品停用后自动下架，但重新启用不自动上架”
- “客户端订单详情要显示售后中”
