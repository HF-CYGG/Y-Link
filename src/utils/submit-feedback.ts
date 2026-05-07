/**
 * 模块说明：src/utils/submit-feedback.ts
 * 文件职责：沉淀共享提交前字段归一化工具，统一收口文本、可选文本与数字字段在发送请求前的整理规则。
 * 实现逻辑：
 * - 通过纯函数把输入组件常见的临时态值（空串、前后空白、字符串数字、NaN）归一化为稳定提交值；
 * - 让高频 CRUD 页面在新增、编辑、批量提交等入口复用同一套字段处理口径；
 * - 保持函数无副作用，便于页面直接组合使用，也便于后续补充单元测试。
 * 维护说明：
 * - 若后续新增布尔、日期、数组等统一提交规则，优先继续在本文件扩展；
 * - 若业务字段需要特殊归一化，请在页面侧组合本文件工具，而不是回退到散点 `trim/Number`。
 */

/**
 * 统一归一化必填文本：
 * - 所有输入先转成字符串再去掉前后空白；
 * - 空值最终收口为空字符串，便于表单校验和后续显式判断。
 */
export const normalizeSubmitText = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`.trim()
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().trim() : ''
  }

  // 对象/数组等复杂值不做默认字符串化，避免提交成 "[object Object]"。
  return ''
}

/**
 * 统一归一化可选文本：
 * - 复用必填文本的 trim 口径；
 * - 空串直接转成 `undefined`，便于接口层表达“未填写而不是空字符串”。
 */
export const normalizeOptionalSubmitText = (value: unknown): string | undefined => {
  const normalizedText = normalizeSubmitText(value)
  return normalizedText || undefined
}

interface NormalizeSubmitNumberOptions {
  fallback?: number
  min?: number
  max?: number
  integer?: boolean
}

/**
 * 统一归一化数字字段：
 * - 兼容 `number`、字符串数字与空值；
 * - 非法值回退到约定默认值，避免把 `NaN` 直接发给后端；
 * - 按需补齐整数化、最小值、最大值约束，供库存、价格等场景复用。
 */
export const normalizeSubmitNumber = (
  value: unknown,
  options: NormalizeSubmitNumberOptions = {},
): number => {
  const fallbackValue = Number.isFinite(options.fallback) ? Number(options.fallback) : 0
  const rawNumber = typeof value === 'number' ? value : Number(normalizeSubmitText(value))
  let normalizedNumber = Number.isFinite(rawNumber) ? rawNumber : fallbackValue

  if (options.integer) {
    normalizedNumber = Math.floor(normalizedNumber)
  }

  if (typeof options.min === 'number') {
    normalizedNumber = Math.max(options.min, normalizedNumber)
  }

  if (typeof options.max === 'number') {
    normalizedNumber = Math.min(options.max, normalizedNumber)
  }

  return normalizedNumber
}
