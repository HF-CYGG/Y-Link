/**
 * 客户端个人用户名共享规则：
 * - Web 与 Mobile 仅用于本地即时反馈和提交前拦截；
 * - 服务端仍保留独立权威实现，避免运行时依赖共享包；
 * - 调整规则时必须同步运行后端验收中的前后端一致性断言。
 */
const PERSONAL_CLIENT_USERNAME_PATTERN = /^[\p{Script=Han}A-Za-z]{2,20}$/u

export const CLIENT_PERSONAL_USERNAME_RULE_MESSAGE = '用户名仅支持 2-20 位中文或英文字母，不能包含空格、数字或特殊字符'

export function normalizePersonalClientUsername(value: string): { value: string; isValid: boolean } {
  const normalizedValue = value.normalize('NFKC')
  return {
    value: normalizedValue,
    isValid: PERSONAL_CLIENT_USERNAME_PATTERN.test(normalizedValue),
  }
}

export function getPersonalClientUsernameRuleHint(value: string): string {
  return normalizePersonalClientUsername(value).isValid ? '' : CLIENT_PERSONAL_USERNAME_RULE_MESSAGE
}
