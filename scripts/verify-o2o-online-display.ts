/** 线上展示页纯规则回归：选图、筛选、分页跨页选择、最小写入载荷和基础资料入口。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ProductRecord } from '../src/api/modules/product.js'
import { resolveProductPreviewImage, resolveProductPreviewSku } from '../src/utils/product-preview.js'
import { resolveO2oPriceView } from '../src/utils/o2o-price.js'
import {
  buildOnlineDisplayPatch,
  clampOnlineDisplayPage,
  filterOnlineDisplayProducts,
  mergeOnlineDisplayPageSelection,
  validateOnlineDisplayPatch,
  type OnlineDisplaySnapshot,
} from '../src/views/o2o/o2o-online-display.helpers.js'

const product = (id: string, changes: Partial<ProductRecord> = {}): ProductRecord => ({
  id,
  productCode: `P-${id}`,
  productName: `商品${id}`,
  isActive: true,
  o2oStatus: 'unlisted',
  o2oRecommended: false,
  thumbnail: null,
  skus: [],
  ...changes,
} as ProductRecord)

const preview = product('preview', {
  thumbnail: '/product.png',
  skus: [
    { id: 'retired', isCurrent: false, isActive: true, o2oRecommended: true, availableStock: 10, sortOrder: 0, thumbnail: '/retired.png' },
    { id: 'inactive', isCurrent: true, isActive: false, o2oRecommended: true, availableStock: 10, sortOrder: 0, thumbnail: '/inactive.png' },
    { id: 'recommended-empty', isCurrent: true, isActive: true, o2oRecommended: true, availableStock: 0, sortOrder: 1, thumbnail: '/empty.png' },
    { id: 'recommended-stock', isCurrent: true, isActive: true, o2oRecommended: true, availableStock: 2, sortOrder: 2, thumbnail: '/stock.png' },
    { id: 'ordinary-stock', isCurrent: true, isActive: true, o2oRecommended: false, availableStock: 5, sortOrder: 0, thumbnail: '/ordinary.png' },
  ],
})
assert.equal(resolveProductPreviewSku(preview)?.id, 'recommended-stock', '当前启用推荐规格中优先有货')
assert.equal(resolveProductPreviewImage(preview), '/stock.png')
const differentlyPriced = product('price', {
  defaultPrice: '10.00', discountRate: '10.0', discountedPrice: '10.00',
  skus: [
    { id: 'cheap', isCurrent: true, isActive: true, o2oRecommended: false, availableStock: 4, sortOrder: 0,
      defaultPrice: '10.00', discountRate: '10.0', discountedPrice: '10.00' },
    { id: 'recommended', isCurrent: true, isActive: true, o2oRecommended: true, availableStock: 2, sortOrder: 1,
      defaultPrice: '40.00', discountRate: '10.0', discountedPrice: '40.00' },
  ],
})
assert.equal(resolveO2oPriceView(resolveProductPreviewSku(differentlyPriced) ?? differentlyPriced).discountedPrice, '40.00', '展示价应跟随客户端预览规格')
assert.equal(resolveProductPreviewSku({ ...preview, o2oRecommended: true })?.id, 'ordinary-stock', '商品级全部推荐按有货和排序选图')
assert.equal(resolveProductPreviewImage({ ...preview, skus: [{ id: 'only', isActive: true, isCurrent: true, availableStock: 1 }] }), '/product.png', '规格无图时回退商品图')
assert.equal(resolveProductPreviewImage({ ...preview, thumbnail: ' ', skus: [] }), null, '占位图不算有效原图')

const items = [
  product('1', { o2oStatus: 'listed', thumbnail: '/one.png' }),
  product('2', { isActive: false, thumbnail: null }),
  product('3', { o2oStatus: 'listed', thumbnail: null }),
]
assert.deepEqual(filterOnlineDisplayProducts(items, { online: 'listed', base: 'all', image: 'missing' }).map((item) => item.id), ['3'])
assert.deepEqual(filterOnlineDisplayProducts(items, { online: 'all', base: 'inactive', image: 'all' }).map((item) => item.id), ['2'])
assert.equal(clampOnlineDisplayPage(4, 10, 23), 3)
assert.equal(clampOnlineDisplayPage(3, 10, 0), 1)
const pageOne = [product('1'), product('2')]
const pageTwo = [product('3'), product('4')]
let selected = mergeOnlineDisplayPageSelection([], pageOne, [pageOne[0]!])
selected = mergeOnlineDisplayPageSelection(selected, pageTwo, [pageTwo[1]!])
assert.deepEqual(selected, ['1', '4'], '跨页选择应保留前页 ID')
selected = mergeOnlineDisplayPageSelection(selected, pageOne, [])
assert.deepEqual(selected, ['4'], '取消本页选择不能清除其他页')

const original: OnlineDisplaySnapshot = {
  o2oStatus: 'unlisted', recommendationMode: 'none', selectedSkuIds: [], limitPerUser: 5, detailContent: '原详情',
}
assert.deepEqual(buildOnlineDisplayPatch(original, { ...original }, ['a', 'b']), {}, '无变化不得发 PATCH')
assert.deepEqual(buildOnlineDisplayPatch(original, { ...original, limitPerUser: 8 }, ['a', 'b']), { limitPerUser: 8 }, '仅改限购不能携带 SKU 基线或其他字段')
assert.deepEqual(buildOnlineDisplayPatch(original, { ...original, recommendationMode: 'selected', selectedSkuIds: ['a'] }, ['a', 'b']), {
  recommendation: { mode: 'selected', skuIds: ['a'], expectedSkuIds: ['a', 'b'] },
})
assert.deepEqual(buildOnlineDisplayPatch(original, { ...original, recommendationMode: 'all' }, ['a', 'b']), {
  recommendation: { mode: 'all', expectedSkuIds: ['a', 'b'] },
})
assert.deepEqual(buildOnlineDisplayPatch(original, { ...original, detailContent: '更新' }, ['a', 'b']), { detailContent: '更新' })
const legacy: OnlineDisplaySnapshot = {
  ...original, limitPerUser: 1000000, detailContent: '详'.repeat(20001),
}
const legacyStatusPatch = buildOnlineDisplayPatch(legacy, { ...legacy, o2oStatus: 'listed' }, ['a', 'b'])
assert.deepEqual(legacyStatusPatch, { o2oStatus: 'listed' }, '旧超限字段未编辑时不能进入最小 PATCH')
assert.equal(validateOnlineDisplayPatch(legacyStatusPatch), null, '只改上下架时不能因旧字段超限而拦截')
assert.equal(validateOnlineDisplayPatch(buildOnlineDisplayPatch(legacy, { ...legacy, limitPerUser: 1000001 }, ['a', 'b'])),
  '单人限购必须为 1 至 999999 的整数', '主动修改为超限数必须拒绝')
assert.equal(validateOnlineDisplayPatch(buildOnlineDisplayPatch(legacy, { ...legacy, detailContent: '详'.repeat(20002) }, ['a', 'b'])),
  '商品详情不能超过 20000 个字符', '主动修改为超长详情必须拒绝')

const view = readFileSync('src/views/o2o/O2oProductMallManageView.vue', 'utf8')
const api = readFileSync('src/api/modules/product.ts', 'utf8')
assert.ok(view.includes("path: '/base-data/products'") && view.includes('productAction: action'), '基础资料入口必须携带一次性动作')
assert.ok(view.includes("goToBasic('create')") && view.includes("goToBasic('batch-create')") && view.includes("goToBasic('sku-config', product.id)"))
assert.ok(api.includes("method: 'PATCH'") && api.includes('url: `/products/${id}/online-display`') && api.includes("url: '/products/online-display/batch'"))
assert.ok(!view.includes('updateProduct(') && !view.includes('batchUpdateProducts('), '线上页禁止走商品全量编辑')
assert.ok(view.includes('resolveO2oPriceView(resolveProductPreviewSku(product) ?? product)'), '管理页展示价应跟随预览 SKU')
assert.ok(view.includes(':max="Math.max(999999, editingProduct.limitPerUser)"'), '旧超限数加载时输入组件不能自动截断并改写表单')
const selectionRestoreStart = view.indexOf('async function restoreTableSelection()')
const selectionRestoreEnd = view.indexOf('async function clearSelection()', selectionRestoreStart)
const selectionRestoreSource = view.slice(selectionRestoreStart, selectionRestoreEnd)
assert.ok(selectionRestoreSource.indexOf('restoringSelection.value = true') < selectionRestoreSource.indexOf('await nextTick()'), '翻页选择守卫必须在 DOM 更新前打开')
assert.ok(view.includes('if (restoringSelection.value) return'), '表格翻页的空选择事件不能清掉已保存的跨页选择')
const editorStart = view.indexOf('async function openEditor(')
const editorEnd = view.indexOf('async function refreshAfterConflict(', editorStart)
const editorSource = view.slice(editorStart, editorEnd)
assert.ok(editorSource.includes('const sequence = ++editorRequestSequence'), '打开编辑弹窗时必须建立请求序号')
assert.ok(editorSource.indexOf('if (sequence !== editorRequestSequence) return') < editorSource.indexOf('editingProduct.value = latest'), '旧商品详情不得覆盖最新弹窗')
assert.ok(view.includes('if (!visible) editorRequestSequence += 1') && view.includes('onDeactivated(() => {\n  editorRequestSequence += 1'), '关闭弹窗和离开页面须使未完成详情请求失效')
assert.equal((view.match(/style="width:48px;height:48px;min-width:48px;max-width:48px;flex:0 0 48px;border-radius:10px"/g) ?? []).length, 3, '表格、卡片、弹窗的预览图根容器均应固定为 48px')
assert.ok(view.includes('content-class="mall-toolbar-stack"') && view.includes('<el-dropdown v-if="isPhone"'), '筛选与操作分行且手机批量操作收起')
assert.ok(!view.includes('prefers-color-scheme: dark'), '页面不应在浅色 App 内单独切换为深色卡片')
console.log('[verify:o2o-online-display] 选图、筛选、跨页选择、弹窗竞态、紧凑布局、最小载荷和路由契约通过')
