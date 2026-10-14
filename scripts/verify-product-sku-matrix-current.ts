import assert from 'node:assert/strict'

import {
  buildSkuMatrixRows,
  extractSkuDimensionValues,
  resolveSkuSpecAxes,
  type ProductSkuMatrixRow,
} from '../src/views/base-data/components/product-sku-matrix.helpers'

const existingRows: ProductSkuMatrixRow[] = [
  {
    id: 'sku-red-standard',
    specValues: { Color: 'Red', Style: 'Standard' },
    specText: 'Red / Standard',
    color: 'Red',
    style: 'Standard',
    defaultPrice: 18,
    discountRate: 9,
    currentStock: 12,
    isActive: false,
    thumbnail: '/uploads/sku-red-standard.png',
    o2oRecommended: true,
    isCurrent: true,
  },
]

const generatedRows = buildSkuMatrixRows({
  colors: ['Red', 'Blue'],
  styles: ['Standard', 'Gift'],
  existingRows,
  defaults: {
    defaultPrice: 9,
    discountRate: 10,
    currentStock: 0,
  },
})

assert.equal(generatedRows.length, 4, 'color and style dimensions should produce a cartesian SKU matrix')
assert.deepEqual(
  generatedRows.map((row) => row.specText),
  ['Red / Standard', 'Red / Gift', 'Blue / Standard', 'Blue / Gift'],
  'SKU rows should keep stable color-first ordering',
)
assert.equal(generatedRows[0].id, 'sku-red-standard', 'matching current SKU rows should retain id')
assert.equal(generatedRows[0].defaultPrice, 18, 'matching current SKU rows should retain price')
assert.equal(generatedRows[0].discountRate, 9, 'matching current SKU rows should retain discount')
assert.equal(generatedRows[0].currentStock, 12, 'matching current SKU rows should retain stock')
assert.equal(generatedRows[0].isActive, false, 'matching current SKU rows should retain active status')
assert.equal(generatedRows[0].thumbnail, '/uploads/sku-red-standard.png', 'matching current SKU rows should retain thumbnail')
assert.equal(generatedRows[0].o2oRecommended, true, 'matching current SKU rows should retain recommendation')
assert.equal(generatedRows[0].isCurrent, true, 'matching current SKU rows should stay current')
assert.equal(generatedRows[1].defaultPrice, 9, 'new SKU rows should inherit product default price')
assert.equal(generatedRows[1].discountRate, 10, 'new SKU rows should inherit product default discount')
assert.equal(generatedRows[1].currentStock, 0, 'new SKU rows should use default stock')
assert.equal(generatedRows[1].isActive, true, 'new SKU rows should be active by default')
assert.equal(generatedRows[1].thumbnail, null, 'new SKU rows should not write a SKU image by default')
assert.equal(generatedRows[1].o2oRecommended, false, 'new SKU rows should not be recommended by default')
assert.equal(generatedRows[1].isCurrent, true, 'new SKU rows should be marked as current matrix rows')

const archivedRows = buildSkuMatrixRows({
  colors: ['Red'],
  styles: ['Standard'],
  existingRows: [
    {
      id: 'archived-red-standard',
      specValues: { Color: 'Red', Style: 'Standard' },
      specText: 'Red / Standard',
      color: 'Red',
      style: 'Standard',
      defaultPrice: 99,
      discountRate: 1,
      currentStock: 999,
      isActive: false,
      thumbnail: '/uploads/archived.png',
      o2oRecommended: true,
      isCurrent: false,
    },
  ],
  defaults: {
    defaultPrice: 9,
    discountRate: 10,
    currentStock: 0,
  },
})

assert.equal(archivedRows.length, 1, 'current matrix should still generate the requested combination')
assert.equal(archivedRows[0].id, undefined, 'archived SKU rows should not be reused as current rows')
assert.equal(archivedRows[0].defaultPrice, 9, 'archived SKU price should not pollute regenerated rows')
assert.equal(archivedRows[0].currentStock, 0, 'archived SKU stock should not pollute regenerated rows')

const colorOnlyRows = buildSkuMatrixRows({
  colors: ['Black', 'White'],
  styles: [],
  existingRows: [],
  defaults: {
    defaultPrice: 6,
    discountRate: 8,
    currentStock: 3,
  },
})

assert.deepEqual(
  colorOnlyRows.map((row) => ({ color: row.color, style: row.style })),
  [{ color: 'Black', style: '' }, { color: 'White', style: '' }],
  'color-only dimensions should still produce sellable SKU rows',
)

const extractedDimensions = extractSkuDimensionValues([
  ...generatedRows,
  {
    specValues: {},
    color: '',
    style: '',
    defaultPrice: 1,
    discountRate: 10,
    currentStock: 1,
    isActive: true,
    o2oRecommended: false,
    isCurrent: true,
  },
])

assert.deepEqual(extractedDimensions.colors, ['Red', 'Blue'], 'dimension extraction should dedupe current colors')
assert.deepEqual(extractedDimensions.styles, ['Standard', 'Gift'], 'dimension extraction should dedupe current styles')

// 规格归轴：旧「款式」单独出现且没有尺码编码位时归颜色/款式，与后端存量升级口径一致；
// 已分配尺码编码位（如已升级为 0A 的商品）仍按尺码展示；规格文案只在两轴都为空时兜底，不能同时出现在两行。
assert.deepEqual(resolveSkuSpecAxes({ 款式: '明心书院' }, '明心书院', null), { color: '明心书院', style: '' }, '存量商品的单独款式应归颜色/款式轴')
assert.deepEqual(resolveSkuSpecAxes({ 款式: '明心书院' }, '明心书院', 'A'), { color: '', style: '明心书院' }, '已分配尺码位的款式应保持尺码轴且不再兜底为颜色')
assert.deepEqual(resolveSkuSpecAxes({ 尺码: 'S' }, 'S', null), { color: '', style: 'S' }, '只有尺码时不能把规格文案兜底成颜色')
assert.deepEqual(resolveSkuSpecAxes({ 颜色: '红', 款式: 'S' }, '红 / S', null), { color: '红', style: 'S' }, '颜色与款式同时存在时款式仍是第二轴')
assert.deepEqual(resolveSkuSpecAxes({ 规格: '礼盒装' }, '礼盒装', null), { color: '礼盒装', style: '' }, '两轴都为空时才兜底为规格文案')
assert.deepEqual(resolveSkuSpecAxes({ 规格: '默认规格' }, '默认规格', null), { color: '', style: '' }, '默认规格不产生维度取值')

const legacyStyleRows: ProductSkuMatrixRow[] = ['明心书院', '校门'].map((value, index) => ({
  id: `legacy-style-${index}`,
  specValues: { 款式: value },
  specText: value,
  ...resolveSkuSpecAxes({ 款式: value }, value, null),
  isCurrent: true,
}))
const legacyStyleDimensions = extractSkuDimensionValues(legacyStyleRows)
assert.deepEqual(legacyStyleDimensions, { colors: ['明心书院', '校门'], styles: [] }, '单维度存量款式不能同时出现在颜色和尺码两行')
const legacyStyleMatrix = buildSkuMatrixRows({
  colors: [...legacyStyleDimensions.colors, '岳动馆'],
  styles: legacyStyleDimensions.styles,
  existingRows: legacyStyleRows,
  defaults: { defaultPrice: 23, discountRate: 10, currentStock: 0 },
})
assert.equal(legacyStyleMatrix.length, 3, '重新生成矩阵不应产生笛卡尔积重复规格')
assert.deepEqual(legacyStyleMatrix[0].specValues, { 款式: '明心书院' }, '已有规格重新生成矩阵时保留原 specValues，后端才能按 key 匹配原 SKU')
assert.equal(legacyStyleMatrix[0].id, 'legacy-style-0')
assert.deepEqual(legacyStyleMatrix[2].specValues, { '颜色/款式': '岳动馆' }, '新增规格使用新版 key')

console.log('[verify:product-sku-matrix] SKU matrix verification passed')
