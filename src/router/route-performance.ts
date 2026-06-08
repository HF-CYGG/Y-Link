/**
 * 模块说明：src/router/route-performance.ts
 * 文件职责：统一维护路由异步加载器、页面预热目标和登录后首跳预热策略，本次补齐客户端高频动态页预热映射，并为微信 / 弱性能移动浏览器增加保守预热分支。
 * 实现逻辑：
 * - 所有可预热页面继续复用同一份异步加载器，避免路由表与预热表出现两套入口；
 * - 客户端登录后按“当前目标页 + 高频相邻页”生成更轻量的预热清单，弱性能移动浏览器会自动收缩为仅保留首要目标；
 * - 空闲预热新增“已完成/已排队”双重门禁，并对弱性能移动浏览器延后调度，避免用户来回切页时重复塞入相同的空闲任务。
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
  | 'client-feedback'
  | 'client-feedback-create'
  | 'client-feedback-detail'
  | 'client-order-detail'
  | 'dashboard'
  | 'order-entry'
  | 'order-list'
  | 'reports'
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
  | 'system-customer-service'
  | 'system-audit-logs'
  | 'not-found'

export type RouteWarmupTarget = AppRouteName | 'appLayout'

type RouteViewLoader = () => Promise<unknown>
type WarmupNetworkConnection = {
  saveData?: boolean
  effectiveType?: string
}

type WarmupNavigator = Navigator & {
  connection?: WarmupNetworkConnection
  deviceMemory?: number
}

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
  'client-feedback': () => import('@/views/client/ClientFeedbackView.vue'),
  'client-feedback-create': () => import('@/views/client/ClientFeedbackCreateView.vue'),
  'client-feedback-detail': () => import('@/views/client/ClientFeedbackDetailView.vue'),
  'client-order-detail': () => import('@/views/client/ClientOrderDetailView.vue'),
  appLayout: () => import('@/layout/AppLayout.vue'),
  dashboard: () => import('@/views/dashboard/DashboardView.vue'),
  'order-entry': () => import('@/views/order-entry/OrderEntryView.vue'),
  'order-list': () => import('@/views/order-list/OrderListView.vue'),
  reports: () => import('@/views/reports/ReportCenterView.vue'),
  products: () => import('@/views/product-center/ProductCenterView.vue'),
  tags: () => import('@/views/base-data/TagManageView.vue'),

  // 送货单与扫码入库模块：
  // - 供货方“录入”和“历史”两个旧入口都必须回到同一个共享工作台壳层；
  // - 否则在外层路由 KeepAlive 复用相同 viewKey 时，会出现“同 key 但不同组件类型”切换，
  //   进而打断 Vue 的反激活链路，触发 deactivate 相关运行时异常。
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
  'system-customer-service': () => import('@/views/system/CustomerServiceWorkbenchView.vue'),
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
  'client-feedback': routeViewLoaders['client-feedback'],
  'client-feedback-create': routeViewLoaders['client-feedback-create'],
  'client-feedback-detail': routeViewLoaders['client-feedback-detail'],
  'client-order-detail': routeViewLoaders['client-order-detail'],
  dashboard: routeViewLoaders.dashboard,
  'order-entry': routeViewLoaders['order-entry'],
  'order-list': routeViewLoaders['order-list'],
  reports: routeViewLoaders.reports,
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
  'system-customer-service': routeViewLoaders['system-customer-service'],
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
  if (redirectPath.startsWith('/client/feedback/create')) {
    return 'client-feedback-create'
  }
  if (/^\/client\/feedback\/[^/]+/i.test(redirectPath)) {
    return 'client-feedback-detail'
  }
  if (redirectPath.startsWith('/client/feedback')) {
    return 'client-feedback'
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
 * 已经排队等待空闲调度的预热任务：
 * - 与 warmedRoutePromises 分工不同，这里只负责“还没真正执行、但已经安排过”的任务；
 * - 可以阻止用户在短时间内多次切页时，把同一路由反复塞进 requestIdleCallback / setTimeout 队列。
 */
const scheduledWarmupRouteNames = new Set<RouteWarmupTarget>()

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

/**
 * 单路由预热包装：
 * - 统一复用批量预热的 Promise 缓存；
 * - 供空闲分片调度逐个拉起页面子包，避免一次回调里并发触发多个重模块。
 */
const preloadSingleRouteComponent = async (routeName: RouteWarmupTarget) => {
  await preloadRouteComponents([routeName])
}

/**
 * 客户端高频相邻页预热映射：
 * - 第一个元素始终是“当前落点最可能的下一跳”；
 * - 只保留真正高频的相邻页，避免客户端冷启动时把低频页面也一并拉起。
 */
const clientWarmupAdjacencyMap: Partial<Record<AppRouteName, AppRouteName[]>> = {
  'client-mall': ['client-cart', 'client-orders'],
  'client-orders': ['client-order-detail', 'client-mall'],
  'client-cart': ['client-checkout', 'client-mall'],
  'client-checkout': ['client-order-detail', 'client-orders'],
  'client-profile': ['client-feedback', 'client-orders'],
  'client-feedback': ['client-feedback-create', 'client-feedback-detail', 'client-profile'],
  'client-feedback-create': ['client-feedback-detail', 'client-feedback'],
  'client-feedback-detail': ['client-feedback', 'client-profile'],
  'client-order-detail': ['client-orders'],
}

/**
 * 当前目标是否属于客户端页面预热：
 * - 客户端页面统一使用 `client-` 前缀，便于在共享调度层做保守策略收口；
 * - 管理端与壳层预热不受这里的客户端设备策略影响。
 */
const isClientWarmupTarget = (routeName: RouteWarmupTarget): routeName is AppRouteName => {
  return routeName.startsWith('client-')
}

/**
 * 当前浏览器是否需要启用客户端保守预热：
 * - 微信 WebView 对首屏阶段的额外网络竞争更敏感，因此直接进入保守模式；
 * - 其余移动浏览器则结合 CPU / 内存 / 网络 / 空闲回调能力综合判断，尽量只保留最高频的下一跳。
 */
const shouldUseConservativeClientWarmup = () => {
  if (globalThis.window === undefined || globalThis.navigator === undefined) {
    return false
  }

  const navigator = globalThis.navigator as WarmupNavigator
  const userAgent = navigator.userAgent ?? ''
  const maxTouchPoints = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0
  const isWechatBrowser = /MicroMessenger/i.test(userAgent)
  const isMobileBrowser = /Android|webOS|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)

  if (isWechatBrowser) {
    return true
  }

  if (!isMobileBrowser) {
    return false
  }

  const weakCpuDevice = typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 4
  const weakMemoryDevice = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4
  const networkConnection = navigator.connection
  const constrainedMobileNetwork = networkConnection?.saveData === true
    || /(?:^|-)3g$/i.test(networkConnection?.effectiveType ?? '')
  const lacksIdleBudgetApi = typeof globalThis.window.requestIdleCallback !== 'function'

  return weakCpuDevice || weakMemoryDevice || constrainedMobileNetwork || lacksIdleBudgetApi
}

/**
 * 客户端相邻页保守裁剪：
 * - 正常设备保持原有“当前页后续高频链路”预热顺序；
 * - 微信或弱性能移动浏览器仅保留首个最高优先级目标，避免把低频相邻页顺手拉起。
 */
const trimClientWarmupAdjacencyTargets = (routeNames: AppRouteName[]) => {
  const uniqueRouteNames = [...new Set(routeNames)]
  if (!shouldUseConservativeClientWarmup()) {
    return uniqueRouteNames
  }

  return uniqueRouteNames.slice(0, 1)
}

/**
 * 路由级客户端预热保守裁剪：
 * - 仅收缩客户端业务页的预热队列；
 * - 允许非客户端壳层或管理端预热继续按原逻辑执行，避免共享层策略误伤其他模块。
 */
const trimScheduledClientWarmupTargets = (routeNames: RouteWarmupTarget[]) => {
  const uniqueRouteNames = [...new Set(routeNames)]
  if (!shouldUseConservativeClientWarmup()) {
    return uniqueRouteNames
  }

  const firstClientRouteName = uniqueRouteNames.find((routeName) => isClientWarmupTarget(routeName))
  if (!firstClientRouteName) {
    return uniqueRouteNames
  }

  return uniqueRouteNames.filter((routeName) => {
    return !isClientWarmupTarget(routeName) || routeName === firstClientRouteName
  })
}

const warmupTargetMatchers: Array<{
  target: RouteWarmupTarget
  prefixes: string[]
}> = [
  { target: 'dashboard', prefixes: ['/dashboard'] },
  { target: 'order-entry', prefixes: ['/order-entry'] },
  { target: 'order-list', prefixes: ['/order-list'] },
  { target: 'reports', prefixes: ['/reports'] },
  { target: 'tags', prefixes: ['/base-data/tags'] },
  { target: 'products', prefixes: ['/base-data/products', '/base-data'] },
  { target: 'supplier-delivery', prefixes: ['/supplier-delivery'] },
  { target: 'supplier-history', prefixes: ['/supplier-history'] },
  { target: 'o2o-console-products', prefixes: ['/o2o-console/products'] },
  { target: 'o2o-console-orders', prefixes: ['/o2o-console/orders'] },
  { target: 'o2o-console-verify', prefixes: ['/o2o-console/verify'] },
  { target: 'o2o-console-inbound', prefixes: ['/inbound-manage', '/o2o-console/inbound'] },
  { target: 'system-audit-logs', prefixes: ['/system/audit-logs'] },
  { target: 'system-db-migration', prefixes: ['/system/db-migration'] },
  { target: 'system-client-users', prefixes: ['/system/client-users'] },
  { target: 'system-customer-service', prefixes: ['/system/customer-service'] },
  { target: 'system-users', prefixes: ['/system/users', '/system'] },
]

const resolveWarmupTargetByPath = (redirectPath: string): RouteWarmupTarget | null => {
  // 这里按“登录成功后最常见落点”做路径归类，把任意 redirect 路径收口成可预热的核心页面。
  // 即便用户命中更深层子路径，也尽量先把上层高频页面的代码包拉下来，降低首跳等待感。
  for (const matcher of warmupTargetMatchers) {
    if (matcher.prefixes.some((prefix) => redirectPath.startsWith(prefix))) {
      return matcher.target
    }
  }

  return null
}

export const resolvePostLoginWarmupTargets = (redirectPath?: string): RouteWarmupTarget[] => {
  // 登录成功后不再默认把 Dashboard 整页提前拉起：
  // - 登录页随后的 replace 本身就会加载目标页面，若这里同步预热 Dashboard，
  //   会与真实导航重复争抢带宽，放大“登录后首跳变慢”的体感；
  // - 因此这里仅保留基础壳层，并按 redirect 精确补充下一跳业务页。
  const targets: RouteWarmupTarget[] = ['appLayout']
  const normalizedRedirectPath = typeof redirectPath === 'string' ? redirectPath.trim() : ''
  const matchedTarget = normalizedRedirectPath ? resolveWarmupTargetByPath(normalizedRedirectPath) : null

  if (matchedTarget && matchedTarget !== 'dashboard') {
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
  const normalizedRedirectPath = typeof redirectPath === 'string' ? redirectPath.trim() : ''
  const matchedTarget = normalizedRedirectPath ? resolveClientWarmupTargetByPath(normalizedRedirectPath) : null
  const entryTarget = matchedTarget ?? 'client-mall'
  const targets = trimClientWarmupAdjacencyTargets([
    entryTarget,
    ...(clientWarmupAdjacencyMap[entryTarget] ?? []),
  ])
  return targets
}

/**
 * 将预热任务推迟到空闲片段：
 * - 避免与当前页面首屏渲染争抢主线程与网络；
 * - 使用 requestIdleCallback 优先，缺失时回退到短延时 setTimeout。
 */
export const scheduleRouteComponentWarmup = (routeNames: RouteWarmupTarget[]) => {
  if (globalThis.window === undefined) {
    return
  }

  /**
   * 弱网与省流场景下收缩预热：
   * - `saveData` 打开或命中 2G/slow-2g 时，优先把带宽留给当前页面；
   * - 正常网络仍保持现有空闲预热策略，不影响高频路径体验。
   */
  const navigator = globalThis.navigator as WarmupNavigator
  const networkConnection = navigator.connection
  if (networkConnection?.saveData || /(?:^|-)2g$/i.test(networkConnection?.effectiveType ?? '')) {
    return
  }

  const uniqueRouteNames = trimScheduledClientWarmupTargets(routeNames)
  const routeNamesToSchedule = uniqueRouteNames.filter((routeName) => {
    return !warmedRoutePromises.has(routeName) && !scheduledWarmupRouteNames.has(routeName)
  })
  if (!routeNamesToSchedule.length) {
    return
  }

  routeNamesToSchedule.forEach((routeName) => {
    scheduledWarmupRouteNames.add(routeName)
  })

  /**
   * 弱性能移动浏览器延后调度：
   * - 即使仍保留一个最高优先级相邻页，也应把预热放到更靠后的空闲片段；
   * - 这样可以先让当前页面完成首屏绘制、交互绑定和关键接口请求，减少“像同步加载一样卡顿”的体感。
   */
  const useConservativeClientWarmup = shouldUseConservativeClientWarmup()
  const initialWarmupDelay = useConservativeClientWarmup ? 1600 : 900
  const trailingWarmupDelay = useConservativeClientWarmup ? 2200 : 1200

  const scheduleDeferredWarmup = (callback: () => void, timeout: number) => {
    if (typeof globalThis.window.requestIdleCallback === 'function') {
      globalThis.window.requestIdleCallback(callback, { timeout })
      return
    }

    globalThis.window.setTimeout(callback, useConservativeClientWarmup ? timeout : Math.min(timeout, 420))
  }

  /**
   * 单项预热执行器：
   * - 真正开始执行时，再把该路由从“已排队”集合里移除；
   * - 用逐个空闲片段串行拉起，减少单个 setTimeout 回调里的同步工作量。
   */
  const runWarmupItem = (routeName: RouteWarmupTarget) => {
    scheduledWarmupRouteNames.delete(routeName)
    void preloadSingleRouteComponent(routeName)
  }

  /**
   * 高频相邻页分两段预热：
   * - 第一优先级页面先起，优先照顾最可能的下一跳；
   * - 其余目标继续拆到后续空闲片段里逐个执行，避免一次性并发拉起过多子包。
   */
  const warmupTask = () => {
    const [firstRouteName, ...trailingRouteNames] = routeNamesToSchedule
    if (firstRouteName) {
      runWarmupItem(firstRouteName)
    }

    if (!trailingRouteNames.length) {
      return
    }

    const scheduleTrailingWarmupAt = (index: number) => {
      const nextRouteName = trailingRouteNames[index]
      if (!nextRouteName) {
        return
      }

      scheduleDeferredWarmup(() => {
        runWarmupItem(nextRouteName)
        scheduleTrailingWarmupAt(index + 1)
      }, trailingWarmupDelay)
    }

    scheduleTrailingWarmupAt(0)
  }

  scheduleDeferredWarmup(warmupTask, initialWarmupDelay)
}
