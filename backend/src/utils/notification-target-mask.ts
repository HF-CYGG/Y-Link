/**
 * 文件说明：backend/src/utils/notification-target-mask.ts
 * 文件职责：统一处理通知外发目标（邮箱、飞书 Webhook）与失败原因的脱敏展示，供外发写库与通知事件查询共用。
 * 实现逻辑：
 * - 飞书 Webhook 只保留官方前缀与 hook ID 末 6 位，避免完整密钥路径出现在库表、审计或页面中；
 * - 邮箱保留首尾少量字符与域名，便于运维辨认收件人又不暴露完整地址；
 * - 失败原因中夹带的 URL、邮箱统一替换为脱敏形式，防止第三方返回的错误信息泄露敏感值。
 * 维护说明：
 * - 新增外发渠道时需补充对应的目标脱敏规则，并在通知事件详情接口中复用；
 * - 历史数据可能存有未脱敏目标，展示层必须再次调用本文件函数，而不能直接透出库值。
 */

export function maskFeishuWebhookTarget(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl.trim())
    const segments = url.pathname.split('/').filter(Boolean)
    const hookIndex = segments.findIndex((segment) => segment === 'hook')
    const hookId = hookIndex >= 0 ? segments[hookIndex + 1] : ''
    const suffix = hookId ? hookId.slice(-6) : ''
    return suffix ? `${url.origin}/open-apis/bot/v2/hook/***${suffix}` : `${url.origin}/open-apis/bot/v2/hook/***`
  } catch {
    return '[已隐藏飞书 Webhook]'
  }
}

/** 邮箱脱敏：本地部分保留首 2 个字符，域名保留原文；非邮箱账号只保留首字符。 */
export function maskEmailTarget(target: string): string {
  const text = target.trim()
  if (!text) {
    return ''
  }
  const atIndex = text.lastIndexOf('@')
  if (atIndex <= 0) {
    return `${Array.from(text)[0] ?? ''}***`
  }
  const localPart = Array.from(text.slice(0, atIndex))
  const domain = text.slice(atIndex + 1)
  return `${localPart.slice(0, Math.min(2, localPart.length)).join('')}***@${domain}`
}

/**
 * 外发目标展示脱敏：
 * - 飞书目标若已是脱敏格式（含 ***）直接返回，历史未脱敏的完整地址再做一次脱敏；
 * - 邮件目标统一按邮箱规则脱敏。
 */
export function maskDispatchTarget(channel: string, target: string | null | undefined): string {
  const text = String(target ?? '').trim()
  if (!text) {
    return ''
  }
  if (channel === 'feishu') {
    return text.includes('***') ? text : maskFeishuWebhookTarget(text)
  }
  return maskEmailTarget(text)
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** 失败原因脱敏：替换其中出现的 URL 与邮箱，保留其余可读的错误描述。 */
export function sanitizeNotificationErrorMessage(message: string | null | undefined): string | null {
  if (message === null || message === undefined) {
    return null
  }
  return String(message)
    .replaceAll(URL_PATTERN, (url) => {
      try {
        return `${new URL(url).origin}/***`
      } catch {
        return '[已隐藏地址]'
      }
    })
    .replaceAll(EMAIL_PATTERN, (email) => maskEmailTarget(email))
}
