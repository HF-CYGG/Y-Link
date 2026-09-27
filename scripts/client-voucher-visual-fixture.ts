/** 文件职责：挂载真实客户端弹窗及隐藏打印模板，验证分页事件在浏览器打印与 PDF 中复用。 */
import { createApp, h, nextTick, ref, Teleport } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import type { OrderDetailResult } from '../src/api/modules/order'
import type { VoucherRenderRow } from '../src/views/order-list/order-voucher-pagination'
import ClientOrderVoucherDialog from '../src/views/client/components/ClientOrderVoucherDialog.vue'
import OrderVoucherTemplate from '../src/views/order-list/components/OrderVoucherTemplate.vue'
import { exportVoucherPdf } from '../src/utils/pdf/export-voucher-pdf'
import { createClientVoucherExportSnapshot } from '../src/views/client/client-order-voucher-export'

const query = new URLSearchParams(location.search)
const orientation = query.get('orientation') === 'portrait' ? 'portrait' : 'landscape'
const long = query.get('long') === '1'
document.head.insertAdjacentHTML('beforeend', `<style>@page { size: A4 ${orientation}; margin: 8mm; } body { margin: 0; }</style>`)

const items = Array.from({ length: long ? 24 : 3 }, (_, index) => ({
  id: `client-fixture-${index + 1}`,
  productId: index < (long ? 18 : 2) ? 'client-product-one' : `client-product-${index}`,
  productCode: `TEST-${index + 1}`,
  productName: index < (long ? 18 : 2) ? `演示帆布包（规格 ${index + 1}）` : `演示笔记本 ${index + 1}`,
  skuId: `client-sku-${index + 1}`,
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
  id: 'client-fixture-order',
  businessNo: 'TEST-CLIENT-VOUCHER-112',
  showNo: 'TEST-CLIENT-VOUCHER-112',
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
const editableFields = { departmentOperator: '', kingdeeVoucherNo: '', receiverSignature: '', completionDate: '' }

declare global { interface Window { __clientVoucherReady?: boolean; __clientVoucherPages?: number; __clientVoucherError?: string } }
let exportStarted = false
const exportLoading = ref(false)
const captureExport = async (sourceElement: HTMLElement | null) => {
  if (!(sourceElement instanceof HTMLElement)) { window.__clientVoucherError = '缺少可见预览节点'; return }
  const snapshot = createClientVoucherExportSnapshot(sourceElement)
  exportLoading.value = true
  await nextTick()
  const closeDisabled = document.querySelector<HTMLButtonElement>('.client-order-detail-dialog--voucher .el-dialog__footer button:first-child')?.disabled === true
  const inputDisabledCount = document.querySelectorAll('.client-order-detail-dialog--voucher .voucher-editor-form input:disabled').length
  const headerCloseHidden = !document.querySelector('.client-order-detail-dialog--voucher .el-dialog__headerbtn')
  sourceElement.querySelector<HTMLElement>('.voucher-title-row th')!.textContent = '异步导出后被修改的预览标题'
  const lockState = document.createElement('pre')
  lockState.id = 'client-voucher-export-lock-state'
  lockState.textContent = JSON.stringify({ closeDisabled, inputDisabledCount, headerCloseHidden, snapshotStable: snapshot.sourceElement.querySelector('.voucher-title-row th')?.textContent === '野辙文创出库单（一式两份）' })
  document.body.appendChild(lockState)
  const originalCreateObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (object) => {
    if (object instanceof Blob) {
      const reader = new FileReader()
      reader.onload = () => {
        const node = document.createElement('pre')
        node.id = 'client-voucher-export-data'
        node.textContent = String(reader.result ?? '')
        document.body.appendChild(node)
      }
      reader.readAsDataURL(object)
    }
    return originalCreateObjectURL(object)
  }
  try {
    await exportVoucherPdf({ sourceElement: snapshot.sourceElement, filename: 'client-voucher-fixture.pdf', orientation, marginMm: 8, scale: 2 })
  } catch (error) {
    window.__clientVoucherError = String(error)
  } finally {
    snapshot.dispose()
    exportLoading.value = false
  }
}

const app = {
  setup() {
    const visible = ref(true)
    const pages = ref<VoucherRenderRow[][]>([])
    const fillers = ref<number[]>([])
    const onPages = async (value: VoucherRenderRow[][], fillerCounts: number[], orderId: string, direction: string) => {
      if (orderId !== order.id || direction !== orientation || !visible.value) return
      pages.value = value
      fillers.value = fillerCounts
      await nextTick()
      window.__clientVoucherPages = value.length * 2
      window.__clientVoucherReady = true
      if (query.get('export') === '1' && !exportStarted) {
        exportStarted = true
        document.querySelector<HTMLButtonElement>('.client-order-detail-dialog--voucher .el-dialog__footer button:last-child')?.click()
      }
    }
    return () => h('main', [
      h(ClientOrderVoucherDialog, {
        visible: visible.value,
        voucherOrder: order,
        editableFields,
        orientation,
        orientationLabel: orientation === 'portrait' ? '竖版' : '横版',
        enableHtml2pdfExport: true,
        exportPdfLoading: exportLoading.value,
        pageCount: pages.value.length * 2,
        'onUpdate:visible': (value: boolean) => { visible.value = value },
        onPagesChange: onPages,
        onExportPdf: captureExport,
      }),
      h(Teleport, { to: 'body' }, h('div', { class: 'order-voucher-print-root', 'aria-hidden': 'true' }, [
        h('div', { class: `order-voucher-print-scope is-${orientation}` }, [
          h(OrderVoucherTemplate, { order, editableFields, orientation, pages: pages.value, pageFillerCounts: fillers.value, measurePages: false }),
        ]),
      ])),
    ])
  },
}
createApp(app).use(ElementPlus).mount('#app')
