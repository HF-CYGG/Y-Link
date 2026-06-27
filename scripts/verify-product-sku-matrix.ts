import assert from 'node:assert/strict'

import {
  buildSkuMatrixRows,
  extractSkuDimensionValues,
} from '../src/views/base-data/components/product-sku-matrix.helpers'

const existingRows = [
  {
    id: 'sku-red-standard',
    specValues: { 颜色: '红色', 款式: '标准款' },
    specText: '红色 / 标准款',
    color: '红色',
    style: '标准款',
    defaultPrice: 18,
    discountRate: 9,
    currentStock: 12,
    isActive: false,
    thumbnail: '/uploads/sku-red-standard.png',
  },
]

const generatedRows = buildSkuMatrixRows({
  colors: ['红色', '蓝色'],
  styles: ['标准款', '礼盒款'],
  existingRows,
  defaults: {
    defaultPrice: 9,
    discountRate: 10,
    currentStock: 0,
  },
})

assert.equal(generatedRows.length, 4, '颜色和款式应生成笛卡尔积 SKU 行')
assert.deepEqual(
  generatedRows.map((row) => row.specText),
  ['红色 / 标准款', '红色 / 礼盒款', '蓝色 / 标准款', '蓝色 / 礼盒款'],
  'SKU 行应按颜色优先、款式其次保持稳定排序',
)
assert.deepEqual(
  generatedRows[0],
  {
    id: 'sku-red-standard',
    specValues: { 颜色: '红色', 款式: '标准款' },
    specText: '红色 / 标准款',
    color: '红色',
    style: '标准款',
    defaultPrice: 18,
    discountRate: 9,
    currentStock: 12,
    isActive: false,
    thumbnail: '/uploads/sku-red-standard.png',
  },
  '已存在的同规格 SKU 应保留价格、库存、启停、图片和 id',
)
assert.equal(generatedRows[1].defaultPrice, 9, '新增 SKU 应继承主商品默认售价')
assert.equal(generatedRows[1].discountRate, 10, '新增 SKU 应继承主商品默认折扣')
assert.equal(generatedRows[1].currentStock, 0, '新增 SKU 应使用默认库存')
assert.equal(generatedRows[1].isActive, true, '新增 SKU 默认启用')
assert.equal(generatedRows[1].thumbnail, null, '新增 SKU 默认不写入规格图，展示时回退主商品图')

const colorOnlyRows = buildSkuMatrixRows({
  colors: ['黑色', '白色'],
  styles: [],
  existingRows: [],
  defaults: {
    defaultPrice: 6,
    discountRate: 8,
    currentStock: 3,
  },
})

assert.deepEqual(
  colorOnlyRows.map((row) => row.specValues),
  [{ 颜色: '黑色' }, { 颜色: '白色' }],
  '仅配置颜色时也应生成可售 SKU',
)

const extractedDimensions = extractSkuDimensionValues([
  ...generatedRows,
  {
    specValues: { 规格: '默认规格' },
    color: '',
    style: '',
    defaultPrice: 1,
    discountRate: 10,
    currentStock: 1,
    isActive: true,
  },
])

assert.deepEqual(extractedDimensions.colors, ['红色', '蓝色'], '应从现有 SKU 提取去重后的颜色维度')
assert.deepEqual(extractedDimensions.styles, ['标准款', '礼盒款'], '应从现有 SKU 提取去重后的款式维度')

console.log('[verify:product-sku-matrix] SKU 规格矩阵验证通过')
