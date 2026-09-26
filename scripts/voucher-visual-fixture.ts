/** 文件职责：用脱敏固定数据对正式出库单进行横竖版浏览器打印与 PDF 视觉回归。 */
import { createApp, h, nextTick, ref } from 'vue'
import type { OrderDetailResult } from '../src/api/modules/order'
import type { VoucherRenderRow } from '../src/views/order-list/order-voucher-pagination'
import OrderVoucherTemplate from '../src/views/order-list/components/OrderVoucherTemplate.vue'
import { exportVoucherPdf } from '../src/utils/pdf/export-voucher-pdf'

const query = new URLSearchParams(location.search)
const orientation = query.get('orientation') === 'portrait' ? 'portrait' : 'landscape'
const long = query.get('long') === '1'
document.head.insertAdjacentHTML('beforeend', `<style>@page { size: A4 ${orientation}; margin: 8mm; } body { margin: 0; } .fixture-print { display: none; } @media print { .fixture-preview { display: none; } .fixture-print { display: block; } .voucher-sheet:not(.voucher-sheet--last) { break-after: page; } }</style>`)

const items = Array.from({ length: long ? 24 : 3 }, (_, index) => ({
  id: `fixture-${index + 1}`,
  productId: index < (long ? 18 : 2) ? 'fixture-product-one' : `fixture-product-${index}`,
  productCode: `TEST-${index + 1}`,
  productName: index < (long ? 18 : 2) ? `演示帆布包（规格 ${index + 1}）` : `演示笔记本 ${index + 1}`,
  skuId: `fixture-sku-${index + 1}`,
  skuCode: null,
  skuCodeSnapshot: null,
  specText: index < (long ? 18 : 2) ? `规格 ${index + 1}` : null,
  specTextSnapshot: null,
  qty: '2.00',
  unitPrice: '12.50',
  subTotal: '25.00',
  remark: index === 0 ? '请按规格分别核对并签收。'.repeat(long ? 8 : 2) : null,
  sourceOrderId: null,
  sourceOrderUuid: null,
  sourceOrderItemId: null,
}))
const order = {
  id: 'fixture-order',
  businessNo: 'TEST-VOUCHER-112',
  orderType: 'department',
  customerDepartmentName: '演示部门',
  createdAt: '2026-09-26T08:00:00+08:00',
  sourceDocType: 'o2o_preorder',
  sourceDocNo: 'TEST-PRE-113',
  sourcePreorderPickupContact: '演示领取人',
  sourcePreorderPickupAt: '2026-09-27T09:00:00+08:00',
  totalQty: String(items.length * 2),
  totalAmount: (items.length * 25).toFixed(2),
  remark: '脱敏纸面验证',
  items,
} as OrderDetailResult

declare global { interface Window { __voucherReady?: boolean; __voucherPages?: number } }
let exportStarted = false
const captureExport = async () => {
  if (query.get('export') !== '1' || exportStarted) return
  exportStarted = true
  await nextTick()
  const source = document.querySelector<HTMLElement>('.fixture-preview .voucher-print-document')
  if (!source) return
  const originalCreateObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (object) => {
    if (object instanceof Blob) {
      const reader = new FileReader()
      reader.onload = () => {
        const node = document.createElement('pre')
        node.id = 'voucher-export-data'
        node.textContent = String(reader.result ?? '')
        document.body.appendChild(node)
      }
      reader.readAsDataURL(object)
    }
    return originalCreateObjectURL(object)
  }
  try {
    await exportVoucherPdf({ sourceElement: source, filename: 'voucher-fixture.pdf', orientation, marginMm: 8, scale: 2 })
  } catch (error) {
    const node = document.createElement('pre')
    node.id = 'voucher-export-error'
    node.textContent = String(error)
    document.body.appendChild(node)
  }
}
const app = {
  setup() {
    const pages = ref<VoucherRenderRow[][]>([])
    const fillerCounts = ref<number[]>([])
    const onPages = (value: VoucherRenderRow[][], fillers: number[]) => {
      pages.value = value
      fillerCounts.value = fillers
      window.__voucherPages = value.length
      window.__voucherReady = true
      void captureExport()
    }
    return () => h('main', [
      h('div', { class: 'fixture-preview' }, [h(OrderVoucherTemplate, { order, orientation, onPagesChange: onPages })]),
      h('div', { class: 'fixture-print' }, [h(OrderVoucherTemplate, { order, orientation, pages: pages.value, pageFillerCounts: fillerCounts.value, measurePages: false })]),
    ])
  },
}
createApp(app).mount('#app')
