/** 数组长度先于元素解析校验，超限请求不访问任何元素或触发递归 schema。 */
import { z } from 'zod'

export function boundedArraySchema<T extends z.ZodType>(element: T, maximum: number) {
  return z.unknown().superRefine((value, context) => {
    if (Array.isArray(value) && value.length > maximum) {
      context.addIssue({ code: 'too_big', origin: 'array', maximum, inclusive: true })
    }
  }).pipe(z.array(element).max(maximum))
}
