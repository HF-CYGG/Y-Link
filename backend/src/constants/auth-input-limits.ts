/**
 * 文件说明：管理端与 Web 客户端认证类接口的入参长度上限。
 * 实现逻辑：在路由 schema 层尽早拒绝超长输入，避免超长字符串进入账号归一化、数据库查询、密码派生与审计截断；
 * 已有密码（登录、当前密码复核）上限 256，明显高于新密码上限 64，兼容历史上未限长时设置的较长口令。
 * 维护说明：移动端入口有独立契约（`mobile-auth.routes.ts`），调整前需单独评估；新密码上限见 `PASSWORD_POLICY_MAX_LENGTH`。
 */
import { z } from 'zod'

export const AUTH_ACCOUNT_INPUT_MAX_LENGTH = 128
export const EXISTING_PASSWORD_INPUT_MAX_LENGTH = 256
export const CAPTCHA_ID_INPUT_MAX_LENGTH = 64
export const CAPTCHA_CODE_INPUT_MAX_LENGTH = 16
export const RESET_TOKEN_INPUT_MAX_LENGTH = 256

/** 已存在的密码（登录、当前密码复核）：只限长，不套用新密码策略。 */
export const existingPasswordInput = (label = '密码') =>
  z.string()
    .min(1, `${label}不能为空`)
    .max(EXISTING_PASSWORD_INPUT_MAX_LENGTH, `${label}长度不能超过 ${EXISTING_PASSWORD_INPUT_MAX_LENGTH} 位`)

export const optionalCaptchaIdInput = () =>
  z.string().trim().min(1).max(CAPTCHA_ID_INPUT_MAX_LENGTH, '图形验证码已失效，请刷新后重试').optional()

export const optionalCaptchaCodeInput = () =>
  z.string().trim().min(1).max(CAPTCHA_CODE_INPUT_MAX_LENGTH, '图形验证码格式不正确').optional()
