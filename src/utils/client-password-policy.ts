/**
 * 模块说明：src/utils/client-password-policy.ts
 * 文件职责：统一客户端注册、找回密码、个人中心改密所使用的新密码规则文案、占位提示与前端校验函数。
 * 实现逻辑：
 * - 通过常量统一三类页面（注册/找回/个人中心）的输入占位与报错文案；
 * - 提供统一口径校验函数（至少 8 位且同时包含字母和数字）；
 * - 输出可直接接入 Element Plus rules 的校验器，避免页面层重复书写密码校验逻辑。
 * 维护说明：
 * - 仅收敛客户端用户可见的新密码规则，不处理后台用户口径；
 * - 若后续密码策略调整，优先修改本文件，避免多个页面提示不一致。
 */
export const CLIENT_NEW_PASSWORD_RULE_TEXT = '密码至少 8 位，且需同时包含字母和数字'
export const CLIENT_NEW_PASSWORD_RULE_HINT = `${CLIENT_NEW_PASSWORD_RULE_TEXT}。`

/**
 * 新密码输入提示文案：
 * - 统一三处页面的占位与校验错误提示；
 * - 避免注册、找回密码、个人中心各自维护不同话术。
 */
export const CLIENT_NEW_PASSWORD_PLACEHOLDER = '请输入新密码'
export const CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER = '请再次输入新密码'
export const CLIENT_NEW_PASSWORD_REQUIRED_MESSAGE = '请输入新密码'
export const CLIENT_CONFIRM_NEW_PASSWORD_REQUIRED_MESSAGE = '请再次输入新密码'
export const CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE = '两次输入内容不一致，请重新确认'

type ValidatorCallback = (error?: Error) => void

/**
 * 判断新密码是否满足客户端口径：
 * - 至少 8 位；
 * - 至少包含 1 个字母；
 * - 至少包含 1 个数字。
 */
export const isClientNewPasswordValid = (password: string) => {
  const normalizedPassword = password.trim()
  return normalizedPassword.length >= 8 && /[A-Za-z]/.test(normalizedPassword) && /\d/.test(normalizedPassword)
}

/**
 * Element Plus 可复用的新密码校验器：
 * - 先检查必填；
 * - 再校验统一口径；
 * - 通过 callback 返回错误，兼容页面内现有 rules 写法。
 */
export const validateClientNewPassword = (password: string, callback: ValidatorCallback) => {
  if (!password.trim()) {
    callback(new Error(CLIENT_NEW_PASSWORD_REQUIRED_MESSAGE))
    return
  }
  if (!isClientNewPasswordValid(password)) {
    callback(new Error(CLIENT_NEW_PASSWORD_RULE_TEXT))
    return
  }
  callback()
}

/**
 * Element Plus 可复用的确认新密码校验器：
 * - 先拦截空值，给出统一提示；
 * - 再与用户刚输入的新密码做一致性校验。
 */
export const validateClientConfirmNewPassword = (
  confirmPassword: string,
  newPassword: string,
  callback: ValidatorCallback,
) => {
  if (!confirmPassword.trim()) {
    callback(new Error(CLIENT_CONFIRM_NEW_PASSWORD_REQUIRED_MESSAGE))
    return
  }
  if (confirmPassword !== newPassword) {
    callback(new Error(CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE))
    return
  }
  callback()
}
