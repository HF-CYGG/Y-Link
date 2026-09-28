/**
 * 文件说明：第三方验证码/邮件网关请求模板渲染工具。
 * 实现逻辑：
 * - 占位符 `{{ name }}` 一次性扫描替换，替换结果不会再次参与匹配，避免值中夹带的占位符被二次展开；
 * - 按目标格式对替换值做上下文转义：JSON 模板按 JSON 字符串转义，表单模板按 URL 编码，纯文本剔除控制字符；
 * - 目标、验证码、客服消息摘要等值部分来自外部输入，未转义时可闭合 JSON 字符串注入额外字段或破坏请求体。
 * 维护说明：
 * - 请求头模板必须是 JSON，始终按 JSON 格式渲染；
 * - 新增占位符时只需在调用方 context 中补字段，无需改动本工具。
 */

export type ProviderTemplateFormat = 'json' | 'form' | 'text'

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g
// 纯文本模板中保留制表符，剔除其余控制字符（含 CR/LF），防止拼出额外的协议行或字段。
const TEXT_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F]/g

const escapeProviderTemplateValue = (value: string, format: ProviderTemplateFormat): string => {
  if (format === 'json') {
    return JSON.stringify(value).slice(1, -1)
  }
  if (format === 'form') {
    return encodeURIComponent(value)
  }
  return value.replace(TEXT_CONTROL_CHAR_PATTERN, ' ')
}

export function renderProviderTemplate(
  template: string,
  context: Record<string, string>,
  format: ProviderTemplateFormat,
): string {
  return template.replace(PLACEHOLDER_PATTERN, (placeholder, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      return placeholder
    }
    return escapeProviderTemplateValue(String(context[key] ?? ''), format)
  })
}

/**
 * 按请求头声明的 Content-Type 判断请求体格式；未声明时模板以 `{` 或 `[` 开头视为 JSON。
 */
export function resolveProviderBodyFormat(headers: Record<string, unknown>, bodyTemplate: string): ProviderTemplateFormat {
  const contentTypeEntry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')
  const contentType = typeof contentTypeEntry?.[1] === 'string' ? contentTypeEntry[1].toLowerCase() : ''
  if (contentType.includes('json')) {
    return 'json'
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return 'form'
  }
  if (!contentType && /^[[{]/.test(bodyTemplate.trim())) {
    return 'json'
  }
  return 'text'
}
