# Y-Link Store、共享组件与请求编排

## 适用范围

- 适用于改动 Pinia Store、共享页面壳、弹窗/抽屉容器、稳定请求和权限动作时。
- 适用于定位“请求乱序、缓存串号、共享组件双滚动、弹层失控”等问题。

## 最后核对来源

- `src/store/modules/auth.ts`
- `src/store/modules/client-auth.ts`
- `src/store/modules/client-cart.ts`
- `src/store/modules/client-catalog.ts`
- `src/store/modules/client-order.ts`
- `src/composables/useStableRequest.ts`
- `src/composables/usePermissionAction.ts`
- `src/components/common/*`
- `docs/前端页面与共享层接入规范.md`

## 真实入口

- 管理端鉴权真源：`src/store/modules/auth.ts`
- 客户端鉴权真源：`src/store/modules/client-auth.ts`
- 客户端购物车真源：`src/store/modules/client-cart.ts`
- 请求稳定器：`src/composables/useStableRequest.ts`
- 权限动作收口：`src/composables/usePermissionAction.ts`

## 前端链路

- 管理端 `auth.ts` 只维护用户快照、权限集、初始化状态和登录过渡态，不保存真实 token。
- 客户端 `client-auth.ts` 负责登录、注册、找回密码、会话恢复，并在退出或账号切换时清理购物车、目录和订单缓存。
- `client-cart.ts` 以“现有库存 + 单人限购”为统一约束，并在目录刷新后尽量重映射商品和 SKU，而不是直接清空。
- `useStableRequest.ts` 通过“只保留最后一次请求结果 + 自动中止旧请求”解决高频筛选和详情切换的竞态问题。
- `usePermissionAction.ts` 统一处理显隐、点击前权限拦截和越权提示。
- 共享页面结构组件主要分三类：
  - 页面容器：`PageContainer`、`PageToolbarCard`、`PagePaginationBar`
  - 业务壳层：`BizResponsiveDataCollectionShell`、`BizResponsiveDrawerShell`、`BizCrudDialogShell`
  - 基础展示：`BaseRequestState`、`BaseRouteErrorState`、`BaseEmptyState`

## 后端链路

- Store 不应擅自重算后端业务状态，只能缓存快照和本地交互状态。
- 权限显隐如果与后端权限码不一致，会表现为“前端可点但接口 403”，因此 Store 与 `usePermissionAction` 只是前端兜底，不是最终授权源。

## 关键状态/字段/快照

- 管理端 `auth` 快照包含：当前用户、权限集、初始化态、登录过渡态。
- 客户端 `client-auth` 快照包含：当前用户、过期时间、初始化态。
- 购物车快照除了数量，还会持久化价格、库存、限购和选择态，保证刷新后仍能恢复局部视图。
- 稳定请求内部通过 `AbortController + latestRequestId` 只允许最后一次结果回写。

## 权限与安全边界

- 页面层禁止手写分散的 `showPermissionDenied()` 分支，统一走 `usePermissionAction`。
- 管理端和客户端本地缓存都不能成为真实授权依据，真实授权只能看服务端返回和后端路由权限。
- 账号切换时必须清理用户绑定缓存，避免把前一个账号的购物车或订单带到下一个账号。

## 常见异常与排查顺序

1. 高频筛选结果乱序：查页面是否接入 `useStableRequest.ts`。
2. 客户端换号后购物车串号：查 `client-auth.ts` 的 `clearClientScopedStores()` 和 `client-cart.ts` 初始化逻辑。
3. 弹层双滚动或高度异常：查页面是否绕过共享壳层自己再包一层主滚动容器。
4. 按钮显示/禁用异常：查 `usePermissionAction.ts`、Store 权限集和页面 computed。
5. 刷新后局部状态丢失：查对应 Store 是否做了持久化快照。

## 验证与回归关注点

- 改 Store 时至少回归：刷新恢复、账号切换、退出登录、并发请求、弱网下请求中止。
- 改共享组件时回归：桌面和移动端布局、弹窗滚动、抽屉滚动、列表分页、空态和错误态。
- 改权限动作时回归：按钮显隐、点击拦截、越权提示文本和后端实际权限结果。
