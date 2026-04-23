/**
 * 模块说明：src/utils/client-auth-navigation.ts
 * 文件职责：统一承接客户端登录页跳转，避免退出登录或会话失效后仍残留旧页面树。
 * 实现逻辑：
 * - 客户端退出登录后优先使用 `window.location.replace` 做硬跳转，强制重建页面运行时；
 * - 这样可以一次性卸载旧的布局、过渡动画和 keep-alive 视图，避免 SPA 软跳转偶发白屏；
 * - 若调用方需要保留回跳地址，可透传站内相对路径作为 redirect 参数。
 * 维护说明：
 * - redirect 只允许站内绝对路径，避免把 query 拼成外部跳转；
 * - 该工具仅负责导航，不负责清理 store，本地状态仍由业务方先行清空。
 */

const CLIENT_LOGIN_PATH = '/client/login'

const resolveSafeClientRedirect = (value?: string) => {
  if (typeof value !== 'string') {
    return ''
  }

  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.startsWith('//')) {
    return ''
  }

  return normalized
}

export const redirectToClientLogin = (options?: { redirect?: string }) => {
  const redirect = resolveSafeClientRedirect(options?.redirect)
  const targetPath = redirect
    ? `${CLIENT_LOGIN_PATH}?redirect=${encodeURIComponent(redirect)}`
    : CLIENT_LOGIN_PATH

  if (globalThis.window !== undefined) {
    globalThis.window.location.replace(targetPath)
  }

  return targetPath
}
