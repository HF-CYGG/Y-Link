/**
 * 模块说明：src/utils/date-time.ts
 * 文件职责：提供前端统一的日期时间展示格式化能力，避免页面直接把服务端原始 ISO 字符串暴露给用户。
 * 实现逻辑：
 * - 优先把可解析时间格式化为 `YYYY-MM-DD HH:mm:ss`，保证客户端与管理端视觉口径一致；
 * - 对空值使用调用方传入的兜底文案，避免各页面重复编写相同空态判断；
 * - 对无效时间保留原始字符串，降低后端偶发脏数据时的信息丢失风险。
 * 维护说明：
 * - 若后续需要国际化或相对时间展示，可在此文件扩展更多格式化函数；
 * - 用户可见时间字段应优先复用本工具，不再直接渲染接口原始值。
 */

const padDateUnit = (value: number) => String(value).padStart(2, '0')

export const formatDateTime = (value?: string | null, fallback = '-') => {
  if (!value) {
    return fallback
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  const year = date.getFullYear()
  const month = padDateUnit(date.getMonth() + 1)
  const day = padDateUnit(date.getDate())
  const hour = padDateUnit(date.getHours())
  const minute = padDateUnit(date.getMinutes())
  const second = padDateUnit(date.getSeconds())

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}
