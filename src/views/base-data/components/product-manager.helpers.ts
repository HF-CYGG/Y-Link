/**
 * 模块说明：src/views/base-data/components/product-manager.helpers.ts
 * 文件职责：沉淀产品管理页的批量录入、排序与选择值归一化等纯函数，降低页面脚本的职责密度。
 * 实现逻辑：
 * - 把批量新增行工厂、产品编码排序规则、批量表单校验等稳定规则移到独立模块；
 * - 让页面保留请求编排、权限动作和视图状态，纯函数负责结构化数据加工；
 * - 所有导出函数都不依赖 Vue 响应式对象，便于后续继续拆子组件或补单测。
 * 维护说明：
 * - 若批量新增字段继续扩展，请优先同步调整本文件的行模型与校验逻辑；
 * - 若产品编码排序规则变化，也请统一在这里修改，避免表格与卡片出现不一致。
 */
export interface BatchCreateProductFormRow {
  rowId: string
  productCode: string
  productName: string
  pinyinAbbr: string
  defaultPrice: number
  currentStock: number
  isActive: boolean
  tagIds: Array<string | number>
}

/**
 * 统一创建一行批量新增表单：
 * - rowId 由页面传入生成器，保证组件层可按自己的时间戳或计数器策略构造唯一键；
 * - 其它字段全部回到稳定默认值，避免新增行带入旧输入。
 */
export const createBatchCreateRow = (rowId: string): BatchCreateProductFormRow => ({
  rowId,
  productCode: '',
  productName: '',
  pinyinAbbr: '',
  defaultPrice: 0,
  currentStock: 0,
  isActive: true,
  tagIds: [],
})

/**
 * 编码排序比较器：
 * - 统一按字符串字母序比较，兼容 UUID/自动编码等场景；
 * - 通过 toUpperCase 规避大小写导致的排序抖动。
 */
export const compareProductCode = (left: string, right: string): number => {
  const normalizedLeft = String(left ?? '').trim().toUpperCase()
  const normalizedRight = String(right ?? '').trim().toUpperCase()
  return normalizedLeft.localeCompare(normalizedRight, 'en')
}

/**
 * 归一化 Select 选择值：
 * - Element Plus 多选允许 string / number 混用；
 * - 页面侧统一把空值收口为空字符串，便于后续去重与标签创建。
 */
export const normalizeSelectValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) {
    return ''
  }

  return String(value).trim()
}

/**
 * 校验批量新增行：
 * - 优先返回第一条业务错误，保持当前页面提示方式简洁明确；
 * - 产品编码仅校验“显式填写时不能重复”，留空仍允许后端统一自动生成。
 */
export const validateBatchCreateRows = (rows: BatchCreateProductFormRow[]): string | null => {
  if (!rows.length) {
    return '请至少添加一行产品'
  }

  const explicitProductCodeRowMap = new Map<string, number>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row.productName.trim()) {
      return `第 ${index + 1} 行产品名称不能为空`
    }

    if (!Number.isFinite(row.defaultPrice) || row.defaultPrice < 0) {
      return `第 ${index + 1} 行默认售价必须大于等于 0`
    }

    if (!Number.isFinite(row.currentStock) || row.currentStock < 0 || !Number.isInteger(row.currentStock)) {
      return `第 ${index + 1} 行当前库存必须是大于等于 0 的整数`
    }

    const normalizedProductCode = row.productCode.trim()
    if (!normalizedProductCode) {
      continue
    }

    const duplicatedRow = explicitProductCodeRowMap.get(normalizedProductCode)
    if (duplicatedRow !== undefined) {
      return `第 ${index + 1} 行产品编码与第 ${duplicatedRow + 1} 行重复`
    }
    explicitProductCodeRowMap.set(normalizedProductCode, index)
  }

  return null
}
