/**
 * 模块说明：src/views/system/category-importance.ts
 * 文件职责：统一审计日志“业务类别”与通知事件“业务分类”标签的重要程度配色与图例文案。
 * 实现逻辑：
 * - 重要程度由后端类别目录维护并随列表与筛选项下发，前端只负责把级别映射为标签类型与图例；
 * - 未知或缺失级别按“一般”兜底，避免后端新增级别时页面报错。
 * 维护说明：调整配色时同时核对两个页面的图例说明，保持红/橙/主色/灰四级语义一致。
 */

import type { CategoryImportanceLevel } from '@/api/modules/audit'

type CategoryTagType = 'danger' | 'warning' | 'primary' | 'info'

export const CATEGORY_IMPORTANCE_META: Readonly<Record<CategoryImportanceLevel, {
  label: string
  tagType: CategoryTagType
  dotClass: string
}>> = {
  critical: { label: '高风险', tagType: 'danger', dotClass: 'bg-red-500' },
  high: { label: '重要', tagType: 'warning', dotClass: 'bg-amber-500' },
  normal: { label: '常规业务', tagType: 'primary', dotClass: 'bg-brand' },
  low: { label: '一般', tagType: 'info', dotClass: 'bg-slate-400' },
}

/** 图例按重要程度从高到低展示。 */
export const CATEGORY_IMPORTANCE_ORDER: readonly CategoryImportanceLevel[] = ['critical', 'high', 'normal', 'low']

const resolveMeta = (level: CategoryImportanceLevel | null | undefined) =>
  (level && CATEGORY_IMPORTANCE_META[level]) || CATEGORY_IMPORTANCE_META.low

export const getCategoryTagType = (level: CategoryImportanceLevel | null | undefined): CategoryTagType => resolveMeta(level).tagType

export const getCategoryDotClass = (level: CategoryImportanceLevel | null | undefined): string => resolveMeta(level).dotClass
