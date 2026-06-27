import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mallEditorSource = readFileSync('src/views/o2o/O2oProductMallManageView.vue', 'utf8')
const clientMallSource = readFileSync('src/views/client/ClientMallView.vue', 'utf8')
const cartStoreSource = readFileSync('src/store/modules/client-cart.ts', 'utf8')
const cartStorageSource = readFileSync('src/utils/client-cart-storage.ts', 'utf8')

const assertSourceIncludes = (source, needle, message) => {
  assert.ok(source.includes(needle), message)
}

assertSourceIncludes(mallEditorSource, 'selectedSkuId', '线上商品编辑表单应维护当前选中的 SKU')
assertSourceIncludes(mallEditorSource, 'selectedSkuForEdit', '线上商品编辑应有当前 SKU 编辑对象')
assertSourceIncludes(mallEditorSource, 'skuDiscountRateInput', '线上商品编辑折扣应绑定当前 SKU 折扣')
assertSourceIncludes(mallEditorSource, 'skuDiscountedPriceInput', '线上商品编辑折后价应能反算当前 SKU 折扣')
assertSourceIncludes(mallEditorSource, 'v-model="form.selectedSkuId"', '线上商品编辑应通过 Select 选择要调整的商品规格')
assertSourceIncludes(mallEditorSource, 'handleSkuThumbnailUpload', '线上商品编辑应支持上传当前规格预览图')
assertSourceIncludes(mallEditorSource, 'handleRemoveSkuThumbnail', '线上商品编辑应支持删除当前规格预览图')
assertSourceIncludes(mallEditorSource, 'skus: buildSkuSubmitPayload()', '线上商品保存 payload 应提交 SKU 配置')

assertSourceIncludes(clientMallSource, 'resolveDetailProductThumbnail', '客户端详情应按选中 SKU 解析展示图')
assertSourceIncludes(clientMallSource, 'openDetailImagePreview', '客户端详情大图预览应使用选中 SKU 图片')
assertSourceIncludes(clientMallSource, 'selectedDetailSku.value?.thumbnail', '客户端详情图片应优先使用选中 SKU 图片')

assertSourceIncludes(cartStoreSource, 'thumbnail: string | null', '购物车项应保存商品或 SKU 图片快照')
assertSourceIncludes(cartStoreSource, 'resolveCartItemThumbnail', '购物车应按 SKU 图片优先生成快照图')
assertSourceIncludes(cartStoreSource, 'thumbnail: resolveCartItemThumbnail(product, sku)', '加入购物车应优先写入 SKU 图片')
assertSourceIncludes(cartStorageSource, 'thumbnail: string | null', '购物车本地快照类型应保存图片字段')
assertSourceIncludes(cartStorageSource, 'thumbnail = typeof row.thumbnail', '购物车本地快照恢复应归一化图片字段')

console.log('[verify:o2o-sku-editor] O2O SKU 编辑与客户端图片联动验证通过')
