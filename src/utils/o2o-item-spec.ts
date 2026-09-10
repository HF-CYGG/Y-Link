/**
 * 模块说明：src/utils/o2o-item-spec.ts
 * 文件职责：统一 O2O 预订单、退货单明细行的“下单时款式/规格”展示口径。
 * 实现逻辑：
 * - 只读取订单行上的下单快照（specText / skuCode），绝不回查当前商品的 SKU 去补全，
 *   避免商品事后改名、改规格或下架后，把历史订单渲染成另一个款式；
 * - 真实规格正常展示；「默认规格」属于单规格商品，不再重复渲染无信息量的标签；
 * - 快照缺失的历史订单显式提示“未记录规格”，与“商品本来就没有规格”区分开，
 *   杜绝 undefined、空白占位以及用当前规格冒充历史规格。
 * 维护说明：
 * - 后端快照写入位于 backend/src/services/o2o-preorder.service.ts 的 buildPreorderSkuItemSnapshot()，
 *   新单的 specText 至少为「默认规格」，因此下方缺失分支只会命中 SKU 化改造前的历史数据；
 * - 正式出库单的商品名拼接口径由后端 createOutboundOrderFromPreorder() 决定，
 *   调整 buildO2oItemDisplayName() 时必须同步核对两端，保证预览与打印逐字一致。
 */

/** 后端对单规格商品写入的规格快照文本，见 buildPreorderSkuItemSnapshot()。 */
export const O2O_DEFAULT_SPEC_TEXT = '默认规格'

/** 快照缺失时的兜底文案，用于提示历史订单没有留下规格记录。 */
export const O2O_MISSING_SPEC_TEXT = '未记录规格'

export interface O2oItemSpecSource {
  skuId?: string | number | null
  skuCode?: string | null
  specText?: string | null
}

export interface O2oItemSpecView {
  /** 是否需要在明细行渲染规格文本；单规格商品为 false。 */
  visible: boolean
  /** 展示文案。 */
  text: string
  /**
   * 语义分类：
   * - spec：下单时选中的真实规格，或可溯源的 SKU 编码；
   * - default：单规格商品的默认规格，无需展示；
   * - missing：历史订单没有留下规格快照。
   */
  kind: 'spec' | 'default' | 'missing'
}

const normalizeSnapshotText = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined) {
    return ''
  }
  return String(value).trim()
}

/**
 * 按下单快照解析明细行的规格展示视图。
 * 判定顺序刻意从“信息最完整”走到“信息最缺失”，保证同一条数据在各查看入口得到一致结论。
 */
export const resolveO2oItemSpecView = (source: O2oItemSpecSource): O2oItemSpecView => {
  const specText = normalizeSnapshotText(source.specText)
  if (specText && specText !== O2O_DEFAULT_SPEC_TEXT) {
    return { visible: true, text: specText, kind: 'spec' }
  }
  if (specText === O2O_DEFAULT_SPEC_TEXT) {
    return { visible: false, text: O2O_DEFAULT_SPEC_TEXT, kind: 'default' }
  }
  // 规格文本缺失但仍绑定了 SKU 时，用下单时的 SKU 编码兜底，至少保留可追溯线索。
  const skuCode = normalizeSnapshotText(source.skuCode)
  if (skuCode) {
    return { visible: true, text: `规格编码 ${skuCode}`, kind: 'spec' }
  }
  return { visible: true, text: O2O_MISSING_SPEC_TEXT, kind: 'missing' }
}

/**
 * 拼接正式出库单模板使用的商品名。
 * 这里刻意与页面展示口径不同：只要下单快照存在规格文本就拼接（含「默认规格」），
 * 从而与后端核销时落库的 productNameSnapshot 逐字一致，避免核销前预览与核销后打印对不上。
 */
export const buildO2oItemDisplayName = (productName: string, source: O2oItemSpecSource): string => {
  const normalizedProductName = normalizeSnapshotText(productName)
  const specText = normalizeSnapshotText(source.specText)
  return specText ? `${normalizedProductName}（${specText}）` : normalizedProductName
}
