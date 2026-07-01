import assert from 'node:assert/strict'

import {
  buildSkuMatrixRows,
  extractSkuDimensionValues,
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

console.log('[verify:product-sku-matrix] SKU matrix verification passed')
