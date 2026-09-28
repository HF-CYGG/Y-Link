/**
 * 模块说明：src/utils/admin-password-policy.ts
 * 文件职责：统一后台账号（管理员、操作员、供货方）新密码在前端的格式校验与提示文案。
 * 实现逻辑：
 * - 与后端 `assertAdminPasswordPolicy` 的基础口径一致：8-64 位，且同时包含字母和数字；
 * - 弱口令黑名单与“不得包含账号信息”只在后端判定，前端直接展示后端返回的原因，避免维护两份名单。
 * 维护说明：后端调整长度或组成规则时同步修改本文件；客户端账号口径见 `client-password-policy.ts`。
 */

export const ADMIN_PASSWORD_MIN_LENGTH = 8
export const ADMIN_PASSWORD_MAX_LENGTH = 64
export const ADMIN_PASSWORD_RULE_TEXT = `密码需 ${ADMIN_PASSWORD_MIN_LENGTH}-${ADMIN_PASSWORD_MAX_LENGTH} 位，且同时包含字母和数字`

export const isAdminPasswordShapeValid = (password: string) => {
  const normalizedPassword = password.trim()
  return normalizedPassword.length >= ADMIN_PASSWORD_MIN_LENGTH
    && normalizedPassword.length <= ADMIN_PASSWORD_MAX_LENGTH
    && /[A-Za-z]/.test(normalizedPassword)
    && /\d/.test(normalizedPassword)
}

type ValidatorCallback = (error?: Error) => void

/** Element Plus 校验器：空值由调用方决定是否必填，这里只校验已填写内容的格式。 */
export const validateAdminPasswordShape = (password: string, callback: ValidatorCallback) => {
  if (password && !isAdminPasswordShapeValid(password)) {
    callback(new Error(ADMIN_PASSWORD_RULE_TEXT))
    return
  }
  callback()
}
