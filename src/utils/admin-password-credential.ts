/**
 * 模块说明：src/utils/admin-password-credential.ts
 * 文件职责：仅在密码已通过服务端第一步后，暂存浏览器 PasswordCredential 对象并于完整登录后交给浏览器。
 * 维护说明：不得把凭据或原始密码写入 Store、持久存储、日志；失败、切换账号与页面隐藏时立即丢弃引用。
 */

type PasswordCredentialLike = Credential
type PasswordCredentialConstructor = new (data: { id: string; password: string; name: string }) => PasswordCredentialLike

export interface PasswordCredentialBridge {
  PasswordCredential?: PasswordCredentialConstructor
  store?: (credential: PasswordCredentialLike) => Promise<unknown>
}

export const createPasswordCredentialHandoff = (bridge: PasswordCredentialBridge) => {
  let pending: PasswordCredentialLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const discard = () => {
    pending = null
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    capture: (username: string, password: string, expiresInSeconds: number) => {
      discard()
      if (!bridge.PasswordCredential || !bridge.store || !username || !password) return false
      try {
        pending = new bridge.PasswordCredential({ id: username, password, name: username })
        const lifetime = Math.min(300, Math.max(0, expiresInSeconds)) * 1000
        if (lifetime === 0) { discard(); return false }
        timer = setTimeout(discard, lifetime)
        return true
      } catch {
        discard()
        return false
      }
    },
    storeOnce: async () => {
      const credential = pending
      discard()
      if (!credential || !bridge.store) return
      try { await bridge.store(credential) } catch { /* 浏览器拒绝保存不影响已有登录会话。 */ }
    },
    discard,
  }
}
