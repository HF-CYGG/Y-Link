/**
 * 模块说明：src/router/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import { ElMessage } from 'element-plus'
import { createRouter, createWebHistory } from 'vue-router'
import { scheduleRouteComponentWarmup, type AppRouteName } from '@/router/route-performance'
import { useAuthStore, useClientAuthStore } from '@/store'
import { canAccessRoute, routes } from '@/router/routes'
import type { UserSafeProfile } from '@/api/modules/auth'

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

/**
 * 全局前置守卫：
 * - 负责首次刷新后的登录态恢复；
 * - 负责未登录拦截、登录页回跳与权限点路由校验。
 */
router.beforeEach(async (to) => {
  const authStore = useAuthStore()
  const clientAuthStore = useClientAuthStore()

  if (!authStore.initialized) {
    await authStore.initializeAuth()
  }
  if (!clientAuthStore.initialized) {
    await clientAuthStore.initializeAuth()
  }

  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
  const isGuestOnly = to.matched.some((record) => record.meta.guestOnly)
  const requiresClientAuth = to.matched.some((record) => record.meta.requiresClientAuth)
  const isClientGuestOnly = to.matched.some((record) => record.meta.clientGuestOnly)

  if (requiresAuth && !authStore.isAuthenticated) {
    return {
      path: '/login',
      query: {
        redirect: to.fullPath,
      },
    }
  }

  if (isGuestOnly && authStore.isAuthenticated) {
    return resolveSafeRedirect(to.query.redirect, authStore.currentUser)
  }

  if (requiresClientAuth && !clientAuthStore.isAuthenticated) {
    return {
      path: '/client/login',
      query: {
        redirect: to.fullPath,
      },
    }
  }

  if (isClientGuestOnly && clientAuthStore.isAuthenticated) {
    return resolveSafeClientRedirect(to.query.redirect)
  }

  const deniedRecord = to.matched.find((record) => !canAccessRoute(record.meta, authStore.currentUser))
  if (requiresAuth && deniedRecord) {
    ElMessage.warning('当前账号无权访问该页面')
    return resolveDefaultManagementRedirect(authStore.currentUser)
  }

  return true
})

router.afterEach((to) => {
  const authStore = useAuthStore()
  const metaTitle = typeof to.meta.title === 'string' ? to.meta.title : ''
  const title = metaTitle ? `Y-Link · ${metaTitle}` : 'Y-Link'
  document.title = title

  if (!authStore.isAuthenticated) {
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

  scheduleRouteComponentWarmup(preloadTargets)
})

export { resolveSafeRedirect }
export default router
