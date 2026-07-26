import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { O2oMallSku } from '../src/api/modules/o2o'
import {
  buildClientSkuSelectionModel,
  resolveClientSkuSelection,
} from '../src/views/client/client-sku-selector.helpers'

const helperPath = path.resolve('src/views/client/client-sku-selector.helpers.ts')

assert.equal(
  existsSync(helperPath),
  true,
  '客户端商城应提供独立的 SKU 分组选择模型，避免页面继续直接纵向渲染完整 SKU 列表',
)

const createSku = ({
  id,
  specValues,
  availableStock = 1,
  o2oRecommended = false,
}: {
  id: string
  specValues: Record<string, string>
  availableStock?: number
  o2oRecommended?: boolean
}): O2oMallSku => ({
  id,
  productId: 'product-1',
  skuCode: id,
  specValues,
  specText: Object.values(specValues).join(' / '),
  defaultPrice: '45.00',
  originalPrice: '45.00',
  discountRate: '10',
  discountedPrice: '45.00',
  currentStock: availableStock,
  preOrderedStock: 0,
  availableStock,
  isActive: true,
  isCurrent: true,
  o2oRecommended,
  thumbnail: null,
  sortOrder: 0,
})

const redSmall = createSku({ id: 'red-small', specValues: { 颜色: '红色', 尺码: 'S' } })
const groupedModel = buildClientSkuSelectionModel([
  redSmall,
  createSku({ id: 'red-medium', specValues: { 颜色: '红色', 尺码: 'M' }, availableStock: 0 }),
  createSku({ id: 'blue-large', specValues: { 颜色: '蓝色', 尺码: 'L' } }),
  createSku({ id: 'black-small', specValues: { 颜色: '黑色', 尺码: 'S' }, availableStock: 0 }),
], redSmall)

assert.deepEqual(
  groupedModel.map((group) => group.name),
  ['颜色', '尺码'],
  '规格组应按 SKU 数据中的首次出现顺序稳定展示',
)
assert.deepEqual(
  groupedModel[0]?.options.map((option) => option.value),
  ['红色', '蓝色', '黑色'],
  '第一组应合并重复颜色，只展示唯一规格值',
)
assert.deepEqual(
  groupedModel[1]?.options.map((option) => option.value),
  ['S', 'M'],
  '下层规格组应只展示当前上层选择下真实配置的尺码',
)
assert.equal(
  groupedModel[0]?.options.find((option) => option.value === '黑色')?.disabled,
  true,
  '上层规格下所有真实组合均无库存时，该规格应置灰',
)
assert.equal(
  groupedModel[1]?.options.find((option) => option.value === 'M')?.disabled,
  true,
  '当前上层规格下已配置但无库存的下层值应保留并置灰',
)
assert.equal(
  groupedModel[1]?.options.some((option) => option.value === 'L'),
  false,
  '当前上层规格没有配置的下层组合不应显示',
)

const blueSmall = createSku({ id: 'blue-small', specValues: { 颜色: '蓝色', 尺码: 'S' } })
const blueLarge = createSku({ id: 'blue-large', specValues: { 颜色: '蓝色', 尺码: 'L' } })
const selectionSkus = [
  redSmall,
  createSku({ id: 'red-medium-selection', specValues: { 颜色: '红色', 尺码: 'M' } }),
  blueSmall,
  blueLarge,
]

assert.equal(
  resolveClientSkuSelection(selectionSkus, redSmall, '颜色', '蓝色')?.id,
  blueSmall.id,
  '切换上层规格后，原下层值仍兼容时应保留该选择',
)
assert.equal(
  resolveClientSkuSelection(selectionSkus, selectionSkus[1] ?? null, '颜色', '蓝色')?.id,
  blueSmall.id,
  '切换上层规格后，原下层值不存在时应回退到首个有库存组合',
)

const recommendedBlueLarge = createSku({
  id: 'recommended-blue-large',
  specValues: { 颜色: '蓝色', 尺码: 'L' },
  o2oRecommended: true,
})
assert.equal(
  resolveClientSkuSelection(
    [redSmall, selectionSkus[1] as O2oMallSku, blueSmall, recommendedBlueLarge],
    selectionSkus[1] ?? null,
    '颜色',
    '蓝色',
  )?.id,
  recommendedBlueLarge.id,
  '无法保留原下层值时，应在有库存候选中优先 SKU 级推荐组合',
)

const legacySku = {
  ...createSku({ id: 'legacy-xl', specValues: {} }),
  specText: '经典款 / XL',
}
const legacyModel = buildClientSkuSelectionModel([legacySku], legacySku)

assert.deepEqual(
  legacyModel.map((group) => ({
    name: group.name,
    values: group.options.map((option) => option.value),
  })),
  [{ name: '规格', values: ['经典款 / XL'] }],
  '旧 SKU 缺少 specValues 时应降级为单个规格组，并保留完整规格文案',
)

const blackCottonMedium = createSku({
  id: 'black-cotton-medium',
  specValues: { 颜色: '黑色', 材质: '棉', 尺码: 'M' },
})
const blackLinenSmall = createSku({
  id: 'black-linen-small',
  specValues: { 颜色: '黑色', 材质: '亚麻', 尺码: 'S' },
})
const multiDimensionSkus = [
  blackCottonMedium,
  createSku({ id: 'black-cotton-large', specValues: { 颜色: '黑色', 材质: '棉', 尺码: 'L' }, availableStock: 0 }),
  blackLinenSmall,
  createSku({ id: 'white-cotton-medium', specValues: { 颜色: '白色', 材质: '棉', 尺码: 'M' } }),
]
const multiDimensionModel = buildClientSkuSelectionModel(multiDimensionSkus, blackCottonMedium)

assert.deepEqual(
  multiDimensionModel.map((group) => group.name),
  ['颜色', '材质', '尺码'],
  '三维及以上规格应沿用相同的动态分组顺序',
)
assert.equal(
  resolveClientSkuSelection(multiDimensionSkus, blackCottonMedium, '材质', '亚麻')?.id,
  blackLinenSmall.id,
  '切换中间规格后应按已选上层前缀解析新的完整 SKU',
)

const clientMallSource = readFileSync('src/views/client/ClientMallView.vue', 'utf8')
assert.ok(
  clientMallSource.includes('buildClientSkuSelectionModel'),
  '客户端商城详情应接入独立的 SKU 分组选择模型',
)
assert.ok(
  clientMallSource.includes('client-detail-sku-group'),
  '客户端商城详情应按规格组渲染紧凑选择区域',
)
assert.ok(
  clientMallSource.includes('<ElButton'),
  '新增的规格值交互控件应使用 Element Plus 按钮',
)
assert.ok(
  !clientMallSource.includes('v-for="sku in resolveActiveSkus(detailProduct)"'),
  '客户端商城详情不应继续纵向渲染每个完整 SKU',
)

console.log('[verify:client-sku-selector] 客户端 SKU 分组选择器验证通过')
