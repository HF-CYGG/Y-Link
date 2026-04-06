import { ElMessage } from 'element-plus'
import { createRouter, createWebHistory } from 'vue-router'
import { scheduleRouteComponentWarmup, type AppRouteName } from '@/router/route-performance'
import { useAuthStore } from '@/store'
import { canAccessRoute, routes } from '@/router/routes'

/**
 * 登录回跳路径安全处理：
 * - 仅允许站内绝对路径，以防 query 被篡改后跳转到外部地址；
 * - 非法值统一回退到工作台首页。
 */
const resolveSafeRedirect = (value: unknown) => {
  if (typeof value !== 'string') {
    return '/dashboard'
  }

  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return '/dashboard'
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

  if (!authStore.initialized) {
    await authStore.initializeAuth()
  }

  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
  const isGuestOnly = to.matched.some((record) => record.meta.guestOnly)

  if (requiresAuth && !authStore.isAuthenticated) {
    return {
      path: '/login',
      query: {
        redirect: to.fullPath,
      },
    }
  }

  if (isGuestOnly && authStore.isAuthenticated) {
    return resolveSafeRedirect(to.query.redirect)
  }

  const deniedRecord = to.matched.find((record) => !canAccessRoute(record.meta, authStore.currentUser))
  if (deniedRecord) {
    ElMessage.warning('当前账号无权访问该页面')
    return '/dashboard'
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
