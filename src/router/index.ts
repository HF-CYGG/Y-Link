/**
 * 模块说明：src/router/index.ts
 * 文件职责：创建前端路由实例并统一收口管理端、客户端两套登录态守卫、默认跳转与路由预热调度。
 * 实现逻辑：
 * - 基于共享路由表创建 Router，并在守卫中按管理端/客户端分别校验当前会话与访问权限；
 * - 对未登录、会话可恢复、无权限等场景统一给出跳转策略，保证首屏进入和刷新恢复口径一致；
 * - 在路由解析完成后串联页面异步组件预热，减少高频相邻页切换时的白屏与等待。
 */

import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router'
import { scheduleRouteComponentWarmup, type AppRouteName } from '@/router/route-performance'
import { useAuthStore, useClientAuthStore } from '@/store'
import { canAccessRoute, resolveFirstAccessibleManagementPath, routes } from '@/router/routes'
import type { UserSafeProfile } from '@/api/modules/auth'
import { showPermissionDenied } from '@/utils/permission'
import { hasRecoverableAdminSessionHint } from '@/utils/auth-storage'
import { showAppWarning } from '@/utils/app-alert'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { classifyRuntimeError } from '@/utils/runtime-error-guard'
import pinia from '@/store/pinia'

export const resolveDefaultManagementRedirect = (user?: Pick<UserSafeProfile, 'role'> | null) => {
  return user?.role === 'supplier' ? '/supplier-delivery' : '/dashboard'
}

/**
 * 登录回跳路径安全处理：
 * - 仅允许站内绝对路径，以防 query 被篡改后跳转到外部地址；
 * - 非法值统一回退到工作台首页。
 */
const resolveSafeRedirect = (value: unknown, user?: Pick<UserSafeProfile, 'role'> | null) => {
  if (typeof value !== 'string') {
    return resolveDefaultManagementRedirect(user)
  }

  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return resolveDefaultManagementRedirect(user)
  }

  return normalized
}

/**
 * 客户端回跳路径安全处理：
 * - 默认回到商品大厅，而不是管理端工作台；
 * - 同样只允许站内绝对路径，避免被拼接成外部跳转。
 */
const resolveSafeClientRedirect = (value: unknown) => {
  if (typeof value !== 'string') {
    return '/client/mall'
  }

  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return '/client/mall'
  }

  return normalized
}

/**
 * 路由实例：
 * - 使用 HTML5 History 模式，满足 SaaS 后台常规 URL 语义；
 * - 统一在导航后更新文档标题，保证浏览器标签可读性。
 */
const router = createRouter({
  history: createWebHistory(),
  routes,
})

const coldStartPreloadVisitedRoutes = new Set<string>()
const isRouteTraceEnabled = import.meta.env.DEV && import.meta.env.VITE_ROUTE_TRACE_DEBUG === 'true'

const logRouteTrace = (event: string, payload: Record<string, unknown>) => {
  if (!isRouteTraceEnabled) {
    return
  }
  console.info(`[route-trace] ${event}`, payload)
}

type RouteGuardFlags = {
  touchesManagementAuth: boolean
  touchesClientAuth: boolean
  requiresAuth: boolean
  isGuestOnly: boolean
  requiresClientAuth: boolean
  isClientGuestOnly: boolean
}

/**
 * 提前收敛当前路由依赖的鉴权语义：
 * - 统一在一个地方计算管理端/客户端的守卫标记；
 * - 避免在前置守卫里多次重复遍历 `to.matched`，同时降低条件分支复杂度。
 */
const resolveRouteGuardFlags = (to: RouteLocationNormalized): RouteGuardFlags => {
  return {
    touchesManagementAuth: to.matched.some((record) => record.meta.requiresAuth || record.meta.guestOnly),
    touchesClientAuth: to.matched.some((record) => record.meta.requiresClientAuth || record.meta.clientGuestOnly),
    requiresAuth: to.matched.some((record) => record.meta.requiresAuth),
    isGuestOnly: to.matched.some((record) => record.meta.guestOnly),
    requiresClientAuth: to.matched.some((record) => record.meta.requiresClientAuth),
    isClientGuestOnly: to.matched.some((record) => record.meta.clientGuestOnly),
  }
}

/**
 * 首次进入相关路由时，只初始化当前链路真正需要的登录态。
 */
const initializeRouteAuthIfNeeded = async (
  flags: RouteGuardFlags,
  authStore: ReturnType<typeof useAuthStore>,
  clientAuthStore: ReturnType<typeof useClientAuthStore>,
) => {
  /**
   * 管理端登录页属于游客路由：
   * - 未登录用户访问时，不必无条件探测 `/auth/me`，否则浏览器会稳定出现 401 噪音；
   * - 仅当路由本身受保护，或本地存在用户快照 / 过期时间 / CSRF Cookie 等会话痕迹时，才值得请求服务端确认。
   */
  const shouldInitializeManagementAuth = !authStore.initialized
    && (flags.requiresAuth || (flags.isGuestOnly && hasRecoverableAdminSessionHint()))

  if (shouldInitializeManagementAuth) {
    await authStore.initializeAuth()
  }
  if (flags.touchesClientAuth && !clientAuthStore.initialized) {
    await clientAuthStore.initializeAuth()
  }
}

/**
 * 管理端登录态守卫：
 * - 未登录访问受保护页时跳登录；
 * - 已登录访问游客页时回跳到安全目标。
 */
const resolveManagementRouteRedirect = (
  to: RouteLocationNormalized,
  flags: RouteGuardFlags,
  authStore: ReturnType<typeof useAuthStore>,
) => {
  if (flags.requiresAuth && !authStore.isAuthenticated) {
    logRouteTrace('beforeEach:redirect-login', {
      to: to.fullPath,
    })
    return {
      path: '/login',
      query: {
        redirect: to.fullPath,
      },
    }
  }

  if (flags.isGuestOnly && authStore.isAuthenticated) {
    const redirectPath = resolveSafeRedirect(to.query.redirect, authStore.currentUser)
    logRouteTrace('beforeEach:guest-redirect', {
      to: to.fullPath,
      redirectPath,
    })
    return redirectPath
  }

  return null
}

/**
 * 客户端登录态守卫：
 * - 未登录访问客户端受保护页时跳客户端登录；
 * - 已登录访问客户端游客页时回到客户端大厅。
 */
const resolveClientRouteRedirect = (
  to: RouteLocationNormalized,
  flags: RouteGuardFlags,
  clientAuthStore: ReturnType<typeof useClientAuthStore>,
) => {
  if (flags.requiresClientAuth && !clientAuthStore.isAuthenticated) {
    logRouteTrace('beforeEach:redirect-client-login', {
      to: to.fullPath,
    })
    return {
      path: '/client/login',
      query: {
        redirect: to.fullPath,
      },
    }
  }

  if (flags.isClientGuestOnly && clientAuthStore.isAuthenticated) {
    const redirectPath = resolveSafeClientRedirect(to.query.redirect)
    logRouteTrace('beforeEach:client-guest-redirect', {
      to: to.fullPath,
      redirectPath,
    })
    return redirectPath
  }

  return null
}

/**
 * 管理端权限守卫：
 * - 当已登录但无菜单权限时，优先回退到首个可访问页面；
 * - 如果完全没有任何可访问页，则进入 404，避免死循环。
 */
const resolveManagementPermissionRedirect = (
  to: RouteLocationNormalized,
  flags: RouteGuardFlags,
  authStore: ReturnType<typeof useAuthStore>,
) => {
  const deniedRecord = to.matched.find((record) => !canAccessRoute(record.meta, authStore.currentUser))
  if (!flags.requiresAuth || !deniedRecord) {
    return null
  }

  const firstAccessiblePath = resolveFirstAccessibleManagementPath(authStore.currentUser)
  if (firstAccessiblePath && firstAccessiblePath !== to.fullPath) {
    showPermissionDenied('已为你切换到可访问页面')
    logRouteTrace('beforeEach:redirect-first-accessible', {
      to: to.fullPath,
      redirectPath: firstAccessiblePath,
    })
    return firstAccessiblePath
  }

  showPermissionDenied()
  logRouteTrace('beforeEach:redirect-404', {
    to: to.fullPath,
  })
  return '/404'
}

/**
 * 全局前置守卫：
 * - 负责首次刷新后的登录态恢复；
 * - 负责未登录拦截、登录页回跳与权限点路由校验。
 */
router.beforeEach(async (to) => {
  const authStore = useAuthStore(pinia)
  const clientAuthStore = useClientAuthStore(pinia)
  const flags = resolveRouteGuardFlags(to)

  logRouteTrace('beforeEach:start', {
    to: to.fullPath,
    from: router.currentRoute.value.fullPath,
    requiresAuth: flags.requiresAuth,
  })

  await initializeRouteAuthIfNeeded(flags, authStore, clientAuthStore)

  const managementRedirect = resolveManagementRouteRedirect(to, flags, authStore)
  if (managementRedirect) {
    return managementRedirect
  }

  const clientRedirect = resolveClientRouteRedirect(to, flags, clientAuthStore)
  if (clientRedirect) {
    return clientRedirect
  }

  const permissionRedirect = resolveManagementPermissionRedirect(to, flags, authStore)
  if (permissionRedirect) {
    return permissionRedirect
  }

  return true
})

router.afterEach((to) => {
  const authStore = useAuthStore(pinia)
  const clientAuthStore = useClientAuthStore(pinia)
  const metaTitle = typeof to.meta.title === 'string' ? to.meta.title : ''
  const title = metaTitle ? `Y-Link · ${metaTitle}` : 'Y-Link'
  document.title = title

  if (!authStore.isAuthenticated && !clientAuthStore.isAuthenticated) {
    return
  }

  /**
   * 路由预热策略：
   * - 仅在用户已登录时执行，避免登录页预先加载业务模块；
   * - 汇总当前命中的 matched 路由配置，把“下一跳高频页面”延迟到空闲时预热。
   */
  const preloadTargets = to.matched.flatMap((record) => {
    return Array.isArray(record.meta.preloadTargets) ? (record.meta.preloadTargets as AppRouteName[]) : []
  })
  const routeVisitKey = typeof to.name === 'string' ? to.name : to.path
  const shouldDeferCurrentPreload = to.matched.some((record) => record.meta.deferPreloadOnColdStart === true)
    && !coldStartPreloadVisitedRoutes.has(routeVisitKey)

  coldStartPreloadVisitedRoutes.add(routeVisitKey)

  if (shouldDeferCurrentPreload) {
    logRouteTrace('afterEach:skip-cold-start-preload', {
      to: to.fullPath,
      preloadTargets,
    })
    return
  }

  logRouteTrace('afterEach:complete', {
    to: to.fullPath,
    preloadTargets,
  })
  scheduleRouteComponentWarmup(preloadTargets)
})

router.onError((error, to) => {
  const classification = classifyRuntimeError(error)
  logRouteTrace('router:error', {
    to: to.fullPath,
    message: error instanceof Error ? error.message : String(error),
    category: classification.category,
    reason: classification.reason,
  })

  if (classification.category === 'ignore') {
    return
  }

  if (classification.category === 'chunk-stale') {
    showAppWarning('页面资源已更新，请刷新当前页面后继续操作')
    return
  }

  void showCriticalErrorDialog(classification.value, {
    title: '页面加载失败',
    fallback: '当前页面模块加载异常，请稍后重试或联系管理员',
    operation: `进入 ${to.fullPath}`,
  })
})

export { resolveSafeRedirect }
export default router
