/**
 * 文件说明：backend/scripts/security-findings-remediation-verify.ts
 * 文件职责：对 Codex Security 扫描确认的 15 项安全边界执行快速、可重复的回归校验。
 * 实现逻辑：同时校验纯函数行为和关键装配契约，确保修复不会退化为仅修改界面文案。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string) => fs.readFileSync(path.resolve(backendRoot, relativePath), 'utf8')

function requirePattern(source: string, pattern: RegExp, message: string) {
  assert.match(source, pattern, message)
}

async function main() {
  const appSource = read('src/app.ts')
  const staffEntity = read('src/entities/client-staff-directory.entity.ts')
  const userEntity = read('src/entities/client-user.entity.ts')
  const authRoutes = read('src/routes/client-auth.routes.ts')
  const systemRoutes = read('src/routes/system-config.routes.ts')
  const verificationService = read('src/services/verification-code.service.ts')
  const notificationService = read('src/services/notification.service.ts')
  const feedbackRoutes = read('src/routes/client-feedback.routes.ts')
  const o2oService = read('src/services/o2o-preorder.service.ts')

  requirePattern(staffEntity, /invite_code_digest/, '教职工目录必须保存不可逆邀请码摘要')
  requirePattern(staffEntity, /invite_locked_until/, '教职工目录必须持久化邀请码锁定状态')
  requirePattern(userEntity, /mobile_verified_at/, '客户端用户必须持久化手机验证状态')
  requirePattern(userEntity, /email_verified_at/, '客户端用户必须持久化邮箱验证状态')
  requirePattern(systemRoutes, /invite-code\/reset/, '必须提供管理员邀请码重置接口')
  requirePattern(systemRoutes, /invite-code[\s\S]{0,300}requireRole\('admin'\)/, '邀请码接口必须有管理员门禁')
  requirePattern(authRoutes, /profile\/verification-code\/send/, '必须提供鉴权后的资料改绑验证码接口')
  assert.doesNotMatch(authRoutes, /staff-directory\/lookup[\s\S]{0,500}realName/, '匿名工号查询不得返回实名信息')

  const { normalizeCsvCell } = await import('../src/utils/csv-security.js')
  assert.equal(normalizeCsvCell(' =2+2'), "' =2+2", 'CSV 公式必须在保留原内容的前提下中和')
  assert.equal(normalizeCsvCell('中文内容'), '中文内容', '普通中文 CSV 内容必须保持不变')

  const { assertSafeOutboundUrl, isPublicNetworkAddress } = await import('../src/utils/safe-http-request.js')
  assert.throws(() => assertSafeOutboundUrl('http://user:pass@example.com'), /userinfo|用户信息/i)
  assert.equal(isPublicNetworkAddress('127.0.0.1'), false)
  assert.equal(isPublicNetworkAddress('::ffff:127.0.0.1'), false)
  assert.equal(isPublicNetworkAddress('8.8.8.8'), true)

  requirePattern(verificationService, /safeHttpRequest/, '短信和邮件验证码必须使用安全出站 HTTP 客户端')
  requirePattern(notificationService, /safeHttpRequest/, '通知外发必须使用安全出站 HTTP 客户端')
  assert.doesNotMatch(notificationService, /feishuWebhookUrl:\s*row\.feishuWebhookUrl/, '通知规则读取不得返回完整 Webhook')
  requirePattern(feedbackRoutes, /attachments\/:id/, '反馈附件必须通过鉴权接口读取')
  requirePattern(o2oService, /SUM\([^)]*item[^)]*qty|SUM\([^)]*qty/i, 'O2O 限购必须累计待处理订单数量')
  requirePattern(appSource, /res\.json\(\{\s*status:\s*['"]UP['"]\s*\}\)/, '公开健康检查必须只返回 UP')
  assert.doesNotMatch(appSource, /express\.json\(\{\s*limit:\s*API_JSON_BODY_LIMIT/, '不得保留认证前全局 64 MiB JSON parser')
  assert.doesNotMatch(appSource, /express\.static\(uploadsDir/, '不得公开整个 uploads 根目录')
  const migration = read('sql/032_security_findings_remediation.sql')
  requirePattern(migration, /client_feedback_attachment/, '迁移必须创建反馈附件归属表')
  requirePattern(migration, /mobile_verified_at/, '迁移必须包含联系方式验证字段')

  console.log('OK 15 项 Codex Security 修复契约均已关闭')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
