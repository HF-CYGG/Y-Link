/**
 * 模块说明：src/router/route-performance.ts
 * 文件职责：统一维护路由异步加载器、页面预热目标和登录后首跳预热策略，本次补充产品中心共享壳层的子页预热映射。
 * 维护说明：
 * - 路由表与预热表必须保持同一命名口径，否则 preloadTargets 会静默失效；
 * - 新增业务页面时，除了补 routes，还要同步评估是否需要纳入这里的预热范围。
 */
import { preloadProductCenterTabs, resolveProductCenterWarmupTargets } from '@/views/product-center/product-center-performance'
import { preloadUserCenterTabs } from '@/views/system/user-center-performance'

/**
 * 前端命名路由集合：
 * - 统一沉淀到单独文件，便于路由配置、预热策略与验证脚本共用同一命名口径；
 * - 仅收录实际命名路由，避免预热时误传匿名节点。
 */
export type AppRouteName =
  | 'login'
  | 'client-login'
  | 'client-forgot-password'
  | 'client-mall'
  | 'client-orders'
  | 'client-cart'
  | 'client-checkout'
  | 'client-profile'
  | 'client-order-detail'
  | 'dashboard'
  | 'order-entry'
  | 'order-list'
  | 'base-data'
  | 'products'
  | 'tags'
  | 'supplier-delivery'
  | 'supplier-history'
  | 'inbound-scan'
  | 'o2o-console'
  | 'o2o-console-products'
  | 'o2o-console-orders'
  | 'o2o-console-verify'
  | 'o2o-console-inbound'
  | 'system'
  | 'system-configs'
  | 'system-db-migration'
  | 'system-users'
  | 'system-client-users'
  | 'system-audit-logs'
  | 'not-found'

export type RouteWarmupTarget = AppRouteName | 'appLayout'

type RouteViewLoader = () => Promise<unknown>

/**
 * 路由级异步组件加载器：
 * - 所有业务页面都从这里统一声明，避免“路由里写一份、预热逻辑再写一份”；
 * - 让按需加载、预热与构建验证围绕同一套入口展开。
 */
export const routeViewLoaders = {
  login: () => import('@/views/auth/LoginView.vue'),
  'client-login': () => import('@/views/client/ClientAuthView.vue'),
  'client-forgot-password': () => import('@/views/client/ClientForgotPasswordView.vue'),
  'client-layout': () => import('@/views/client/components/ClientMainLayout.vue'),
  'client-mall': () => import('@/views/client/ClientMallView.vue'),
  'client-orders': () => import('@/views/client/ClientOrdersView.vue'),
  'client-cart': () => import('@/views/client/ClientCartView.vue'),
  'client-checkout': () => import('@/views/client/ClientCheckoutView.vue'),
  'client-profile': () => import('@/views/client/ClientProfileView.vue'),
  'client-order-detail': () => import('@/views/client/ClientOrderDetailView.vue'),
  appLayout: () => import('@/layout/AppLayout.vue'),
  dashboard: () => import('@/views/dashboard/DashboardView.vue'),
  'order-entry': () => import('@/views/order-entry/OrderEntryView.vue'),
  'order-list': () => import('@/views/order-list/OrderListView.vue'),
  products: () => import('@/views/product-center/ProductCenterView.vue'),
  tags: () => import('@/views/base-data/TagManageView.vue'),

  // 送货单与扫码入库模块
  'supplier-delivery': () => import('@/views/inbound/SupplierWorkbenchView.vue'),
  'supplier-history': () => import('@/views/inbound/SupplierWorkbenchView.vue'),
  'inbound-scan': () => import('@/views/inbound/InboundScanView.vue'),

  'o2o-console-products': () => import('@/views/product-center/ProductCenterView.vue'),
  'o2o-console-orders': () => import('@/views/o2o/O2oOrderQueryView.vue'),
  'o2o-console-verify': () => import('@/views/o2o/O2oVerifyConsoleView.vue'),
  'o2o-console-inbound': () => import('@/views/o2o/O2oInboundManageView.vue'),
  'system-configs': () => import('@/views/system/SystemConfigViewLoader'),
  'system-db-migration': () => import('@/views/system/DatabaseMigrationView.vue'),
  'system-users': () => import('@/views/system/UserCenterView.vue'),
  'system-client-users': () => import('@/views/system/UserCenterView.vue'),
  'system-audit-logs': () => import('@/views/system/AuditLogView.vue'),
  'not-found': () => import('@/views/not-found/NotFoundView.vue'),
} satisfies Record<string, RouteViewLoader>

/**
 * 允许预热的高频页面组件：
 * - 仅选择“登录后高频跳转”的业务页，避免把低频页面也提前拉取，反而挤占首屏带宽；
 * - 父级 redirect 路由与登录页不参与预热。
 */
const warmableRouteLoaders: Partial<Record<RouteWarmupTarget, RouteViewLoader>> = {
  appLayout: routeViewLoaders.appLayout,
  'client-mall': routeViewLoaders['client-mall'],
  'client-orders': routeViewLoaders['client-orders'],
  'client-cart': routeViewLoaders['client-cart'],
  'client-checkout': routeViewLoaders['client-checkout'],
  'client-profile': routeViewLoaders['client-profile'],
  'client-order-detail': routeViewLoaders['client-order-detail'],
  dashboard: routeViewLoaders.dashboard,
  'order-entry': routeViewLoaders['order-entry'],
  'order-list': routeViewLoaders['order-list'],
  // 产品中心当前使用共享工作台壳层：
  // - 仅预热壳层会导致标签切换时仍然需要额外等待子页面分包；
  // - 因此这里在路由预热阶段一并补齐默认标签对应的业务子包。
  products: () =>
    Promise.all([
      routeViewLoaders.products(),
      preloadProductCenterTabs(resolveProductCenterWarmupTargets('products')),
    ]),
  tags: routeViewLoaders.tags,
  'supplier-delivery': routeViewLoaders['supplier-delivery'],
  'supplier-history': routeViewLoaders['supplier-history'],
  'o2o-console-products': () =>
    Promise.all([
      routeViewLoaders['o2o-console-products'](),
      preloadProductCenterTabs(resolveProductCenterWarmupTargets('o2o-console-products')),
    ]),
  'o2o-console-orders': routeViewLoaders['o2o-console-orders'],
  'o2o-console-verify': routeViewLoaders['o2o-console-verify'],
  'o2o-console-inbound': routeViewLoaders['o2o-console-inbound'],
  'system-configs': routeViewLoaders['system-configs'],
  'system-db-migration': routeViewLoaders['system-db-migration'],
  // 用户中心改为共享壳层 + 异步标签页后，预热阶段继续补齐默认标签，
  // 避免从系统菜单首跳进入时还要额外等待标签子包下载。
  'system-users': () =>
    Promise.all([
      routeViewLoaders['system-users'](),
      preloadUserCenterTabs(['management']),
    ]),
  'system-client-users': () =>
    Promise.all([
      routeViewLoaders['system-client-users'](),
      preloadUserCenterTabs(['client']),
    ]),
  'system-audit-logs': routeViewLoaders['system-audit-logs'],
}

const resolveClientWarmupTargetByPath = (redirectPath: string): AppRouteName | null => {
  if (redirectPath.startsWith('/client/orders/')) {
    return 'client-order-detail'
  }
  if (redirectPath.startsWith('/client/orders')) {
    return 'client-orders'
  }
  if (redirectPath.startsWith('/client/cart')) {
    return 'client-cart'
  }
  if (redirectPath.startsWith('/client/checkout')) {
    return 'client-checkout'
  }
  if (redirectPath.startsWith('/client/profile')) {
    return 'client-profile'
  }
  if (redirectPath.startsWith('/client/mall') || redirectPath.startsWith('/client')) {
    return 'client-mall'
  }
  return null
}

/**
 * 已经发起过的预热任务：
 * - 通过 Promise 级缓存避免同一路由被重复 import；
 * - 即使多个入口同时请求预热，也只会真正加载一次。
 */
const warmedRoutePromises = new Map<RouteWarmupTarget, Promise<unknown>>()

/**
 * 立即预热指定路由组件：
 * - 适用于登录后进入工作台、首次进入治理页等“高概率下一跳”场景；
 * - 若某个路由已预热，则直接复用既有 Promise。
 */
export const preloadRouteComponents = async (routeNames: RouteWarmupTarget[]) => {
  const uniqueRouteNames = [...new Set(routeNames)]

  await Promise.allSettled(
    uniqueRouteNames.map((routeName) => {
      const loader = warmableRouteLoaders[routeName]
      if (!loader) {
        return Promise.resolve()
      }

      const cachedPromise = warmedRoutePromises.get(routeName)
      if (cachedPromise !== undefined) {
        return cachedPromise
      }

      const warmupPromise = loader()
      warmedRoutePromises.set(routeName, warmupPromise)
      return warmupPromise
    }),
  )
}

const resolveWarmupTargetByPath = (redirectPath: string): RouteWarmupTarget | null => {
  // 这里按“登录成功后最常见落点”做路径归类，把任意 redirect 路径收口成可预热的核心页面。
  // 即便用户命中更深层子路径，也尽量先把上层高频页面的代码包拉下来，降低首跳等待感。
  if (redirectPath.startsWith('/dashboard')) {
    return 'dashboard'
  }

  if (redirectPath.startsWith('/order-entry')) {
    return 'order-entry'
  }

  if (redirectPath.startsWith('/order-list')) {
    return 'order-list'
  }

  if (redirectPath.startsWith('/base-data/tags')) {
    return 'tags'
  }

  if (redirectPath.startsWith('/base-data/products') || redirectPath.startsWith('/base-data')) {
    return 'products'
  }

  if (redirectPath.startsWith('/supplier-delivery')) {
    return 'supplier-delivery'
  }

  if (redirectPath.startsWith('/supplier-history')) {
    return 'supplier-history'
  }

  if (redirectPath.startsWith('/o2o-console/products')) {
    return 'o2o-console-products'
  }

  if (redirectPath.startsWith('/o2o-console/orders')) {
    return 'o2o-console-orders'
  }

  if (redirectPath.startsWith('/o2o-console/verify')) {
    return 'o2o-console-verify'
  }

  if (redirectPath.startsWith('/inbound-manage') || redirectPath.startsWith('/o2o-console/inbound')) {
    return 'o2o-console-inbound'
  }

  if (redirectPath.startsWith('/system/audit-logs')) {
    return 'system-audit-logs'
  }

  if (redirectPath.startsWith('/system/db-migration')) {
    return 'system-db-migration'
  }

  if (redirectPath.startsWith('/system/client-users')) {
    return 'system-client-users'
  }

  if (redirectPath.startsWith('/system/users') || redirectPath.startsWith('/system')) {
    return 'system-users'
  }

  return null
}

export const resolvePostLoginWarmupTargets = (redirectPath?: string): RouteWarmupTarget[] => {
  // 登录后至少保证 AppLayout 和工作台被预热；
  // 如果存在明确 redirect，再额外补充一次“下一跳页面”预热。
  const targets: RouteWarmupTarget[] = ['appLayout', 'dashboard']
  const normalizedRedirectPath = typeof redirectPath === 'string' ? redirectPath.trim() : ''
  const matchedTarget = normalizedRedirectPath ? resolveWarmupTargetByPath(normalizedRedirectPath) : null

  if (matchedTarget) {
    targets.push(matchedTarget)
  }

  return [...new Set(targets)]
}

/**
 * 客户端登录后预热目标：
 * - 默认预热商城 + 订单 + 购物车三个高频路径；
 * - 若 redirect 指向具体客户端页，则补充目标页面预热，减少登录后首跳等待。
 */
export const resolveClientPostLoginWarmupTargets = (redirectPath?: string): AppRouteName[] => {
  const targets: AppRouteName[] = ['client-mall', 'client-orders', 'client-cart']
  const normalizedRedirectPath = typeof redirectPath === 'string' ? redirectPath.trim() : ''
  const matchedTarget = normalizedRedirectPath ? resolveClientWarmupTargetByPath(normalizedRedirectPath) : null
  if (matchedTarget) {
    targets.push(matchedTarget)
  }
  return [...new Set(targets)]
}

/**
 * 将预热任务推迟到空闲片段：
 * - 避免与当前页面首屏渲染争抢主线程与网络；
 * - 使用 requestIdleCallback 优先，缺失时回退到短延时 setTimeout。
 */
export const scheduleRouteComponentWarmup = (routeNames: AppRouteName[]) => {
  if (globalThis.window === undefined) {
    return
  }

  const uniqueRouteNames = [...new Set(routeNames)]
  if (!uniqueRouteNames.length) {
    return
  }

  const warmupTask = () => {
    void preloadRouteComponents(uniqueRouteNames)
  }

  if (typeof globalThis.window.requestIdleCallback === 'function') {
    globalThis.window.requestIdleCallback(warmupTask, { timeout: 900 })
    return
  }

  globalThis.window.setTimeout(warmupTask, 260)
}
