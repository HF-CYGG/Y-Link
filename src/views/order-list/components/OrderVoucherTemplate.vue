<script setup lang="ts">
/**
 * 模块说明：src/views/order-list/components/OrderVoucherTemplate.vue
 * 文件职责：把正式出库单的商品组、来源领取信息和两联纸面渲染成预览、打印、PDF 共用的页面。
 * 实现逻辑：预览组件测量真实纸张及表格行高后分页；打印组件复用测量所得分片，每联独立起页。
 * 维护说明：不要用固定明细行数代替实测高度，长规格与备注会改变纸面行高。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import dayjs from 'dayjs'
import type { OrderDetailResult } from '@/api/modules/order'
import { aggregateOrderVoucherItems } from '../order-voucher-aggregation'
import { buildVoucherRows, paginateVoucherRows, type VoucherRenderRow } from '../order-voucher-pagination'

interface OrderVoucherEditableFields {
  departmentOperator: string
  kingdeeVoucherNo: string
  receiverSignature: string
  completionDate: string
}

type VoucherOrientation = 'portrait' | 'landscape'
const props = withDefaults(defineProps<{
  order: OrderDetailResult
  editableFields?: OrderVoucherEditableFields
  copyLabels?: string[]
  orientation?: VoucherOrientation
  pages?: VoucherRenderRow[][]
  pageFillerCounts?: number[]
  measurePages?: boolean
}>(), {
  editableFields: () => ({ departmentOperator: '', kingdeeVoucherNo: '', receiverSignature: '', completionDate: '' }),
  copyLabels: () => ['第一联（部门留存）', '第二联（书院留存）'],
  orientation: 'landscape',
  measurePages: true,
})
const emit = defineEmits<{ 'pages-change': [pages: VoucherRenderRow[][], fillerCounts: number[]] }>()
const resolvedEditableFields = computed(() => props.editableFields)
const groups = computed(() => aggregateOrderVoucherItems(props.order.items))
const rows = computed(() => buildVoucherRows(groups.value))
const ownPages = ref<VoucherRenderRow[][]>([[]])
const renderedPages = computed(() => props.pages ?? ownPages.value)
const fillerCounts = ref<number[]>([])
const displayedFillerCounts = computed(() => props.pageFillerCounts ?? fillerCounts.value)
const documentRef = ref<HTMLElement | null>(null)
const printTimestamp = dayjs().format('YYYY-MM-DD HH:mm:ss')
let measurementRevision = 0

const formatQuantity = (value: string | number | null | undefined) => {
  const text = String(value ?? '').trim()
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return '—'
  return text.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}
const formatAmount = (value: string | number | null | undefined) => {
  const text = String(value ?? '').trim()
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text)
  return match ? `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}` : '—'
}
const formatDateTime = (value: string | number | Date | null | undefined) => value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '未记录'
const showLineSource = computed(() => props.order.merge.role === 'parent' && props.order.inventoryMode === 'o2o_preapplied')
const sourcePickupMap = computed(() => new Map((props.order.sourcePreorderPickups ?? []).map((item) => [item.sourceOrderId, item])))
const sourcePickupForRow = (row: VoucherRenderRow) => sourcePickupMap.value.get(row.detail?.sourceOrderId || props.order.id)
const sourceDocText = computed(() => showLineSource.value ? '合并来源见各明细'
  : props.order.sourceDocType === 'o2o_preorder' && props.order.sourceDocNo
  ? `线上预订单 ${props.order.sourceDocNo}` : '未记录')
const sourcePickupContact = computed(() => props.order.sourcePreorderPickupContact?.trim() || '未记录')
const sourcePickupAt = computed(() => formatDateTime(props.order.sourcePreorderPickupAt))
const editableText = (value: string) => value.trim() || ' '
const productLabel = (row: VoucherRenderRow, rowIndex: number, pageIndex: number) => {
  if (row.firstInGroup) return row.productName
  if (rowIndex === 0 && pageIndex > 0 && renderedPages.value[pageIndex - 1]?.at(-1)?.groupKey === row.groupKey) {
    return `${row.productName}（续）`
  }
  return ''
}

/** 用预览中的实际行高计算容量；纸张高度由同一份 CSS 的 mm 尺寸提供。 */
const measureAndPaginate = async () => {
  if (!props.measurePages || props.pages) return
  const revision = ++measurementRevision
  ownPages.value = [rows.value]
  fillerCounts.value = []
  await nextTick()
  if (revision !== measurementRevision) return
  const firstSheet = documentRef.value?.querySelector<HTMLElement>('.voucher-sheet')
  if (!firstSheet) return
  const heightOf = (selector: string) => firstSheet.querySelector<HTMLElement>(selector)?.getBoundingClientRect().height ?? 0
  const paperHeight = firstSheet.getBoundingClientRect().height
  const headerHeight = heightOf('.voucher-sheet__meta')
    + heightOf('.voucher-title-row') + heightOf('.voucher-meta-row--primary')
    + heightOf('.voucher-meta-row--secondary') + heightOf('.voucher-meta-row--pickup')
    + heightOf('.voucher-detail-header-row')
  const footerHeight = heightOf('.voucher-total-row') + heightOf('.voucher-sign-label-row') + heightOf('.voucher-sign-value-row')
  const rowHeights: Record<string, number> = {}
  firstSheet.querySelectorAll<HTMLElement>('[data-voucher-row-key]').forEach((element) => {
    const key = element.dataset.voucherRowKey
    if (key) rowHeights[key] = element.getBoundingClientRect().height
  })
  if (paperHeight <= 0 || headerHeight <= 0 || footerHeight <= 0) return
  const pages = paginateVoucherRows(rows.value, { paperHeight, headerHeight, footerHeight, rowHeights })
  if (revision !== measurementRevision) return
  ownPages.value = pages
  const lastPage = pages.at(-1) ?? []
  const remaining = paperHeight - headerHeight - footerHeight - 8
    - lastPage.reduce((sum, row) => sum + (rowHeights[row.key] ?? 40), 0)
  fillerCounts.value = pages.map((_, index) => index === pages.length - 1 ? Math.max(0, Math.min(18, Math.floor(remaining / 22))) : 0)
  emit('pages-change', pages, fillerCounts.value)
}

watch(() => [props.order, props.orientation, props.editableFields], measureAndPaginate, { immediate: true, deep: true, flush: 'post' })
onBeforeUnmount(() => { measurementRevision += 1 })
</script>

<template>
  <section ref="documentRef" class="voucher-print-document" :class="`is-${props.orientation}`">
    <template v-for="(copyLabel, copyIndex) in props.copyLabels" :key="`${props.order.id}-${copyIndex}`">
      <article
        v-for="(pageRows, pageIndex) in renderedPages"
        :key="`${props.order.id}-${copyIndex}-${pageIndex}`"
        class="voucher-sheet"
        :class="[`voucher-sheet--${props.orientation}`, { 'voucher-sheet--last': copyIndex === props.copyLabels.length - 1 && pageIndex === renderedPages.length - 1 }]"
        :data-copy-index="copyIndex"
        :data-page-index="pageIndex"
      >
        <header class="voucher-sheet__meta">
          <strong>{{ copyLabel }}<span v-if="renderedPages.length > 1"> · 第 {{ pageIndex + 1 }}/{{ renderedPages.length }} 页</span></strong>
          <span>打印时间：{{ printTimestamp }}</span>
        </header>
        <table class="voucher-master-table">
          <colgroup><col class="col-label" /><col class="col-value-wide" /><col class="col-label" /><col class="col-value-wide" /><col class="col-label" /><col class="col-value-wide" /></colgroup>
          <tbody>
            <tr class="voucher-title-row"><th colspan="6" scope="colgroup">野辙文创出库单（一式两份）</th></tr>
            <tr class="voucher-meta-row voucher-meta-row--primary">
              <th scope="row">申请部门</th><td>{{ props.order.customerDepartmentName || '散客' }}</td>
              <th scope="row">部门经办人</th><td class="is-editable-cell"><span class="editable-line">{{ editableText(resolvedEditableFields.departmentOperator) }}</span></td>
              <th scope="row">金蝶单据编号</th><td class="is-editable-cell"><span class="editable-line">{{ editableText(resolvedEditableFields.kingdeeVoucherNo) }}</span></td>
            </tr>
            <tr class="voucher-meta-row voucher-meta-row--secondary">
              <th scope="row">业务单号</th><td>{{ props.order.businessNo }}</td>
              <th scope="row">来源单据</th><td>{{ sourceDocText }}</td>
              <th scope="row">开单时间</th><td>{{ formatDateTime(props.order.createdAt) }}</td>
            </tr>
            <tr v-if="showLineSource" class="voucher-meta-row voucher-meta-row--pickup">
              <th scope="row">来源领取信息</th><td colspan="5">各来源正式单的领取人及到店取货时间见对应明细</td>
            </tr>
            <tr v-else class="voucher-meta-row voucher-meta-row--pickup">
              <th scope="row">来源领取人</th><td colspan="2">{{ sourcePickupContact }}</td>
              <th scope="row">到店取货时间</th><td colspan="2">{{ sourcePickupAt }}</td>
            </tr>
            <tr class="voucher-detail-header-row"><th colspan="2" scope="colgroup">产品名称</th><th scope="col">单价</th><th scope="col">数量（规格 × 数量）</th><th scope="col">总价</th><th scope="col">备注</th></tr>
            <tr v-for="(row, rowIndex) in pageRows" :key="row.key" :data-voucher-row-key="row.key" :class="row.kind === 'detail' ? 'voucher-detail-row' : 'voucher-group-total-row'">
              <template v-if="row.kind === 'detail' && row.detail">
                <td colspan="2" class="product-cell">
                  {{ productLabel(row, rowIndex, pageIndex) || ' ' }}
                  <small v-if="showLineSource" class="voucher-source-line">
                    来源正式单：{{ sourcePickupForRow(row)?.businessNo || '未记录' }} · 线上预订单：{{ sourcePickupForRow(row)?.sourcePreorderNo || '未记录' }}<br>
                    领取人：{{ sourcePickupForRow(row)?.pickupContact || '未记录' }} · 到店取货时间：{{ formatDateTime(sourcePickupForRow(row)?.pickupAt) }}
                  </small>
                </td>
                <td>{{ row.detail.unitPrice }}</td>
                <td class="quantity-cell"><span>{{ row.detail.specText ? `${row.detail.specText} × ${row.detail.qty}` : row.detail.qty }}</span><small v-if="row.detail.showNameSnapshot">原名称：{{ row.detail.nameSnapshot }}</small></td>
                <td>{{ row.detail.subTotal }}</td>
                <td class="remark-cell">{{ row.detail.remark || '—' }}</td>
              </template>
              <template v-else>
                <th colspan="3" scope="row" class="product-cell">{{ productLabel(row, rowIndex, pageIndex) }} 商品小计</th>
                <td>合计 {{ row.groupQty }}</td><td>{{ row.groupAmount }}</td><td></td>
              </template>
            </tr>
            <tr v-for="fillIndex in displayedFillerCounts[pageIndex] ?? 0" :key="`fill-${copyIndex}-${pageIndex}-${fillIndex}`" class="voucher-filler-row"><td colspan="2">&nbsp;</td><td></td><td></td><td></td><td></td></tr>
            <template v-if="pageIndex === renderedPages.length - 1">
              <tr class="voucher-total-row"><th colspan="3" scope="rowgroup">总计</th><td>{{ formatQuantity(props.order.totalQty) }}</td><td>{{ formatAmount(props.order.totalAmount) }}</td><td>{{ props.order.remark || '' }}</td></tr>
              <tr class="voucher-sign-label-row"><th colspan="2" scope="colgroup">领取人签字</th><th colspan="2" scope="colgroup">文创工坊管理员签字</th><th>出库人签字</th><th>完成日期</th></tr>
              <tr class="voucher-sign-value-row">
                <td colspan="2" class="is-editable-cell"><span class="editable-line">{{ editableText(resolvedEditableFields.receiverSignature) }}</span></td>
                <td colspan="2" class="is-editable-cell"><span class="editable-line">&nbsp;</span></td>
                <td class="is-editable-cell"><span class="editable-line">&nbsp;</span></td>
                <td class="is-editable-cell"><span class="editable-line">{{ editableText(resolvedEditableFields.completionDate) }}</span></td>
              </tr>
            </template>
          </tbody>
        </table>
      </article>
    </template>
  </section>
</template>

<style scoped>
.voucher-print-document { width: fit-content; color: #111827; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.voucher-sheet { box-sizing: border-box; background: #fff; break-inside: avoid; page-break-inside: avoid; }
.voucher-sheet--landscape { width: 281mm; height: 193mm; }
.voucher-sheet--portrait { width: 194mm; height: 280mm; }
.voucher-sheet__meta { min-height: 22px; display: flex; justify-content: center; align-items: center; gap: 12px; font-size: 11px; color: #334155; }
.voucher-master-table { width: 100%; border-collapse: collapse; table-layout: fixed; border: 2px solid #303030; background: #f8f8f8; }
.voucher-master-table .col-label { width: 11%; }
.voucher-master-table .col-value-wide { width: 22.3333%; }
.voucher-master-table th, .voucher-master-table td { border: 1px solid #575757; padding: 4px 4px; font-size: 11px; line-height: 1.35; vertical-align: middle; text-align: center; overflow-wrap: anywhere; background: #fcfcfc; }
.voucher-master-table th { font-weight: 700; background: #d9d9d9; }
.voucher-title-row th { padding: 9px 6px; font-size: 20px; letter-spacing: .06em; background: #fff; border-bottom: 2px solid #303030; }
.voucher-meta-row th, .voucher-meta-row td { min-height: 26px; }
.voucher-meta-row--primary th { background: #d3d3d3; }
.voucher-meta-row--secondary th, .voucher-meta-row--pickup th { background: #e1e1e1; }
.voucher-detail-header-row th { background: #d0d0d0; border-top: 2px solid #3a3a3a; border-bottom: 2px solid #3a3a3a; }
.voucher-detail-row .product-cell, .voucher-group-total-row .product-cell { text-align: left; padding-left: 8px; }
.voucher-source-line { display: block; margin-top: 3px; font-size: 9px; font-weight: 400; color: #334155; }
.voucher-detail-row .quantity-cell { white-space: normal; }
.quantity-cell small { display: block; font-size: 9px; color: #475569; }
.remark-cell { white-space: normal; }
.voucher-group-total-row th, .voucher-group-total-row td { background: #ededed; font-weight: 700; }
.voucher-filler-row td { height: 18px; padding: 0; }
.voucher-total-row th, .voucher-total-row td { background: #f1f1f1; font-weight: 700; border-top: 2px solid #3b3b3b; }
.voucher-sign-label-row th { background: #d0d0d0; border-top: 2px solid #303030; }
.voucher-sign-value-row td { height: 30px; background: #fff; }
.is-editable-cell { background: #fff !important; }
.editable-line { display: inline-flex; min-height: 20px; width: 100%; align-items: center; justify-content: center; white-space: pre-wrap; }
@media print {
  .voucher-print-document { width: fit-content; }
  .voucher-sheet:not(.voucher-sheet--last) { break-after: page; page-break-after: always; }
  .voucher-master-table, .voucher-master-table th, .voucher-master-table td, .is-editable-cell { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
</style>
