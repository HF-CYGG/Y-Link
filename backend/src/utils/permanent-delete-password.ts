/**
 * 文件说明：永久删除密码校验工具。
 * 实现逻辑：永久删除属于不可恢复高风险动作，统一要求服务端环境变量密码二次门禁。
 * 维护重点：不要在日志、审计或响应中输出配置密码或用户输入密码。
 */

import { timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { BizError } from './errors.js'

export function assertPermanentDeletePassword(inputPassword: string | null | undefined): void {
  const configuredPassword = env.PERMANENT_DELETE_PASSWORD?.trim()
  if (!configuredPassword) {
    throw new BizError('服务器未配置永久删除密码，请先在容器环境变量 PERMANENT_DELETE_PASSWORD 中设置并重启服务', 403)
  }

  const normalizedInput = typeof inputPassword === 'string' ? inputPassword.trim() : ''
  if (!normalizedInput) {
    throw new BizError('请输入永久删除密码', 400)
  }

  const expected = Buffer.from(configuredPassword, 'utf8')
  const actual = Buffer.from(normalizedInput, 'utf8')
  const matched = expected.length === actual.length && timingSafeEqual(expected, actual)
  if (!matched) {
    throw new BizError('永久删除密码不正确', 403)
  }
}
