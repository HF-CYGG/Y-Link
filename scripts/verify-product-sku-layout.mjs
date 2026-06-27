import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/views/base-data/components/ProductManager.vue', 'utf8')
const skuStart = source.indexOf('product-sku-config-card')
const skuEnd = source.indexOf('<el-form-item label="关联标签"', skuStart > -1 ? skuStart : 0)
const skuArea = skuStart > -1 && skuEnd > skuStart ? source.slice(skuStart, skuEnd) : ''

const assertSourceIncludes = (needle, message) => {
  assert.ok(source.includes(needle), message)
}

const sliceBetween = (startNeedle, endNeedle) => {
  const start = source.indexOf(startNeedle)
  const end = source.indexOf(endNeedle, start > -1 ? start : 0)
  return start > -1 && end > start ? source.slice(start, end) : ''
}

const operationColumn = sliceBetween('label="操作"', '</el-table-column>')
const mainDialog = sliceBetween('v-model="dialogVisible"', '</BizCrudDialogShell>')
const skuDialog = sliceBetween('v-if="isSkuDialog"', '<el-form v-else')
const mobileActions = sliceBetween('class="product-mobile-actions', '</div>')

assertSourceIncludes('handleOpenSkuConfig(row)', 'desktop operation column should expose SKU config action')
assertSourceIncludes('handleOpenSkuConfig(item)', 'mobile card actions should expose SKU config action')
assert.ok(operationColumn.includes('规格'), 'desktop SKU action should be visible in the operation column')
assert.ok(mobileActions.includes('规格'), 'mobile SKU action should be visible in card actions')

assert.ok(mainDialog.includes('v-if="isSkuDialog"'), 'product dialog should switch into SKU mode from operation action')
assertSourceIncludes(`:tablet-width="isSkuDialog ? '92%' : '720px'"`, 'SKU mode should use a wider tablet dialog to avoid content overflow')
assertSourceIncludes(`:desktop-width="isSkuDialog ? '920px' : '500px'"`, 'SKU mode should use a wider desktop dialog to avoid content overflow')
assert.ok(skuDialog.includes('sku-card'), 'SKU config should be rendered in its own standalone card')
assert.ok(skuDialog.includes('min-inline-size: 0'), 'SKU fieldset should reset default min-inline-size to avoid overflow')
assertSourceIncludes('@confirm="isSkuDialog ? handleSubmitSkuConfig() : handleSubmit()"', 'SKU mode should save through dedicated submit handler')
assert.ok(skuDialog.includes('sku-dims'), 'SKU dialog should keep color and style inputs together')
assert.ok((skuDialog.match(/<el-input-tag/g) ?? []).length >= 2, 'SKU color and style dimensions should use InputTag components')
assert.ok(skuDialog.includes('v-model="skuColorInput"'), 'SKU color InputTag should bind to array input state')
assert.ok(skuDialog.includes('v-model="skuStyleInput"'), 'SKU style InputTag should bind to array input state')
assert.ok(source.includes('el-tag__close'), 'SKU InputTag tags should keep a visible remove affordance')
assert.ok(source.includes('el-input__wrapper w-full'), 'SKU InputTag wrapper should stay full-width')
assert.ok((skuDialog.match(/<label>/g) ?? []).length >= 2, 'SKU dimension inputs should keep separated labeled rows')
assert.ok(skuDialog.includes('sku-scroll'), 'SKU detail matrix should keep an isolated horizontal scroll container')
assert.ok(skuDialog.includes('overflow-x: auto'), 'SKU detail matrix should scroll inside the card instead of overflowing the dialog')
assert.ok(skuDialog.includes('sku-table'), 'SKU detail matrix should use a stable table layout')
assert.ok(skuDialog.includes('label="预览图"'), 'SKU detail matrix should expose a preview image column')
assert.ok(skuDialog.includes('buildSkuThumbnailUploadRequest(row)'), 'SKU preview image column should upload images per SKU row')
assert.ok(skuDialog.includes('handleRemoveSkuThumbnail'), 'SKU preview image column should remove images per SKU row')
assert.ok(skuDialog.includes('label="折扣"'), 'SKU detail matrix should expose a discount column')
assert.ok(skuDialog.includes('v-model="row.discountRate"'), 'SKU discount column should bind each row discount independently')
assert.ok((skuDialog.match(/:controls="false"/g) ?? []).length >= 2, 'SKU price and stock inputs should hide +/- controls to keep values fully visible')
assert.ok(skuDialog.includes('width="132"'), 'SKU price and stock columns should keep stable widths')
assert.ok(skuDialog.includes('width="72"'), 'SKU status column should keep a stable width')
assert.ok(skuDialog.includes('width="60"'), 'SKU operation column should keep a stable width')
assert.ok(!skuDialog.includes('active-text="启用"'), 'SKU row switch should not render text that squeezes the row')
assert.ok(!skuDialog.includes('inactive-text="停用"'), 'SKU row switch should not render text that squeezes the row')
assert.ok(skuDialog.includes('aria-label="SKU 启停"'), 'SKU row switch should keep an accessible name')

assertSourceIncludes('sku-form', '规格配置应脱离普通左侧标签表单项')
assert.ok(skuDialog.includes('sku-form'), 'SKU standalone card should keep the SKU form layout hook')
assertSourceIncludes('sku-card', '规格配置应独立放入卡片容器')
assertSourceIncludes('sku-dims', '颜色与款式输入应在卡片内形成稳定输入区')
assertSourceIncludes('sku-scroll', 'SKU 明细矩阵应有独立横向滚动容器')
assertSourceIncludes('sku-table', 'SKU 明细应使用表格矩阵承载')
assertSourceIncludes('min-width: 860px', 'SKU 明细表格应有足够最小宽度承载图片、折扣和库存列')
assertSourceIncludes('sku-thumb-uploader', 'SKU 明细应提供单规格预览图上传入口')
assertSourceIncludes('sku-discount-select', 'SKU 明细应提供单规格折扣选择器')
assertSourceIncludes('width="132"', 'SKU 售价和库存列应有稳定宽度，避免数字输入被压缩')
assertSourceIncludes('width="72"', 'SKU 状态列应有稳定宽度，避免开关被压缩')
assertSourceIncludes('width="60"', 'SKU 操作列应有稳定宽度，避免移除按钮挤压状态区')
assert.ok(!skuArea.includes('active-text="启用"'), 'SKU 行开关不应使用会被窄宽度挤压的启用文字')
assert.ok(!skuArea.includes('inactive-text="停用"'), 'SKU 行开关不应使用会被窄宽度挤压的停用文字')
assertSourceIncludes('aria-label="SKU 启停"', 'SKU 行开关应保留可访问名称')

console.log('[verify:product-sku-layout] 商品规格配置布局验证通过')
