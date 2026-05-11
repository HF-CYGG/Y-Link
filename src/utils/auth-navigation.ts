/**
 * 模块说明：src/utils/auth-navigation.ts
 * 文件职责：统一承接管理端登录页跳转，确保退出登录、改密重登与会话失效后能彻底重建页面运行时。
 * 实现逻辑：
 * - 管理端退出后优先使用 `window.location.replace` 硬跳转到登录页；
 * - 这样会直接替换当前历史项，并卸载旧的管理端布局、keep-alive 页面与轮询副作用；
 * - 若调用方需要保留回跳地址，可传入站内相对路径作为 redirect 参数。
 * 维护说明：
 * - redirect 仅允许站内绝对路径，避免拼接成外部跳转；
 * - 该工具只负责导航，不负责清理 store，本地状态需由业务方先清空。
 */

const ADMIN_LOGIN_PATH = '/login'

const resolveSafeAdminRedirect = (value?: string) => {
  if (typeof value !== 'string') {
    return ''
  }

  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return ''
  }

  return normalized
}

export const redirectToAdminLogin = (options?: { redirect?: string }) => {
  const redirect = resolveSafeAdminRedirect(options?.redirect)
  const targetPath = redirect
    ? `${ADMIN_LOGIN_PATH}?redirect=${encodeURIComponent(redirect)}`
    : ADMIN_LOGIN_PATH

  if (globalThis.window !== undefined) {
    globalThis.window.location.replace(targetPath)
  }

  return targetPath
}
