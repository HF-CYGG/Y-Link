<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/components/OrderVoucherTemplate.vue`
 * 文件职责：渲染正式出库单打印模板，统一承接详情自动填充字段、前端临时补填字段、横竖版版芯以及分页输出。
 * 实现逻辑：
 * 1. 模板改为与用户参考图同类的“单主表格”结构，避免导出时多段布局被压缩变形；
 * 2. 所有联次共享一份数据模型，但每联强制独立分页，保证每页只放一份；
 * 3. 横版和竖版共用同一模板，通过方向 props 切换列宽、字体和空白补齐行数；
 * 4. 部门经办人、金蝶单据编号与底部签字字段继续由父层传入，仅在当前页面临时生效。
 */

import { computed } from 'vue'
import dayjs from 'dayjs'
import type { OrderDetailResult } from '@/api/modules/order'

interface OrderVoucherEditableFields {
  departmentOperator: string
  kingdeeVoucherNo: string
  receiverSignature: string
  issuerSignature: string
  completionSignature: string
}

type VoucherOrientation = 'portrait' | 'landscape'

const createEmptyEditableFields = (): OrderVoucherEditableFields => ({
  departmentOperator: '',
  kingdeeVoucherNo: '',
  receiverSignature: '',
  issuerSignature: '',
  completionSignature: '',
})

const props = withDefaults(
  defineProps<{
    order: OrderDetailResult
    editableFields?: OrderVoucherEditableFields
    copyLabels?: string[]
    orientation?: VoucherOrientation
  }>(),
  {
    editableFields: () => ({
      departmentOperator: '',
      kingdeeVoucherNo: '',
      receiverSignature: '',
      issuerSignature: '',
      completionSignature: '',
    }),
    copyLabels: () => ['第一联（部门留存）', '第二联（财务留存）'],
    orientation: 'landscape',
  },
)

/**
 * 统一归并补填字段：
 * - 先给出空白默认值，避免父组件漏传时模板渲染异常；
 * - 这样模板内部始终只消费结构稳定的对象，不需要到处判空。
 */
const resolvedEditableFields = computed<OrderVoucherEditableFields>(() => ({
  ...createEmptyEditableFields(),
  ...(props.editableFields ?? {}),
}))

/**
 * 复制联次配置：
 * - 正式出库单默认一式两份；
 * - 保留 props 能力，便于后续按业务场景调整联次文案。
 */
const voucherCopies = computed(() => {
  return props.copyLabels.map((label, index) => ({
    key: `${props.order.id}-${index}`,
    label,
  }))
})

const isLandscape = computed(() => props.orientation === 'landscape')

// 详细注释：图 2 版式的底部签字区要求位置稳定，因此在明细不足时需要补齐空白行，
// 否则导出 PDF 时会出现签字区上浮、两联高度不一致的问题。
const minimumRowCount = computed(() => {
  return isLandscape.value ? 12 : 16
})

const fillerRowCount = computed(() => {
  return Math.max(0, minimumRowCount.value - props.order.items.length)
})

const formatAmount = (value: string | number | null | undefined) => {
  const normalizedValue = Number(value ?? 0)
  return Number.isFinite(normalizedValue) ? normalizedValue.toFixed(2) : '0.00'
}

const formatQty = (value: string | number | null | undefined) => {
  const normalizedValue = Number(value ?? 0)
  if (!Number.isFinite(normalizedValue)) {
    return '0'
  }
  if (Number.isInteger(normalizedValue)) {
    return String(normalizedValue)
  }
  return normalizedValue.toFixed(2)
}

const getVisualLength = (value: string | null | undefined) => {
  return Array.from(String(value ?? '')).reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 255 ? 2 : 1), 0)
}

const shouldWrapProductName = (value: string | null | undefined) => {
  return getVisualLength(value) > (isLandscape.value ? 30 : 18)
}

const shouldWrapRemark = (value: string | null | undefined) => {
  return getVisualLength(value) > (isLandscape.value ? 18 : 12)
}

/**
 * 规范明细备注展示：
 * - 明细备注为空时统一展示短横线；
 * - 保持纸质单据中“有值展示、无值留痕”的可读性。
 */
const getItemRemark = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()
  return normalizedValue || '-'
}

const getEditableFieldDisplay = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()
  return normalizedValue || ' '
}

const formatDateTime = (value: string | number | Date | null | undefined) => {
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

const printTimestamp = formatDateTime(new Date())
</script>

<template>
  <section class="voucher-print-document" :class="[`is-${props.orientation}`]">
    <article
      v-for="copy in voucherCopies"
      :key="copy.key"
      class="voucher-sheet"
      :class="[`voucher-sheet--${props.orientation}`]"
    >
      <header class="voucher-sheet__meta">
        <span class="voucher-copy-label">{{ copy.label }}</span>
        <span>打印时间：{{ printTimestamp }}</span>
      </header>

      <table class="voucher-master-table" :class="[`voucher-master-table--${props.orientation}`]">
        <colgroup>
          <col class="col-label" />
          <col class="col-value-wide" />
          <col class="col-label" />
          <col class="col-value-wide" />
          <col class="col-label" />
          <col class="col-value-wide" />
        </colgroup>
        <tbody>
          <tr>
            <th colspan="6" class="voucher-title-cell">野辙文创出库单（一式两份）</th>
          </tr>
          <tr>
            <th>申请部门</th>
            <td>{{ props.order.customerDepartmentName || '散客' }}</td>
            <th>部门经办人</th>
            <td class="is-editable-cell">
              <span class="editable-line" :class="{ 'is-empty': !resolvedEditableFields.departmentOperator.trim() }">
                {{ getEditableFieldDisplay(resolvedEditableFields.departmentOperator) }}
              </span>
            </td>
            <th>金蝶单据编号</th>
            <td class="is-editable-cell">
              <span class="editable-line" :class="{ 'is-empty': !resolvedEditableFields.kingdeeVoucherNo.trim() }">
                {{ getEditableFieldDisplay(resolvedEditableFields.kingdeeVoucherNo) }}
              </span>
            </td>
          </tr>
          <tr>
            <th>业务单号</th>
            <td>{{ props.order.showNo }}</td>
            <th>出库人</th>
            <td>{{ props.order.issuerName || '-' }}</td>
            <th>开单时间</th>
            <td>{{ formatDateTime(props.order.createdAt) }}</td>
          </tr>
          <tr>
            <th colspan="2">产品名称</th>
            <th>单价</th>
            <th>数量</th>
            <th>总价</th>
            <th>备注</th>
          </tr>
          <tr v-for="item in props.order.items" :key="item.id">
            <td colspan="2" class="text-left" :class="{ 'is-wrap': shouldWrapProductName(item.productName) }">
              {{ item.productName || '-' }}
            </td>
            <td>{{ formatAmount(item.unitPrice) }}</td>
            <td>{{ formatQty(item.qty) }}</td>
            <td>{{ formatAmount(item.subTotal) }}</td>
            <td :class="{ 'is-wrap': shouldWrapRemark(item.remark) }">{{ getItemRemark(item.remark) }}</td>
          </tr>
          <tr v-for="index in fillerRowCount" :key="`filler-${copy.key}-${index}`" class="voucher-filler-row">
            <td colspan="2">&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
          </tr>
          <tr class="voucher-total-row">
            <th colspan="4">总计</th>
            <td>{{ formatAmount(props.order.totalAmount) }}</td>
            <td>{{ props.order.remark || '' }}</td>
          </tr>
          <tr class="voucher-sign-label-row">
            <th colspan="2">领取人签字</th>
            <th colspan="2">出库人签字</th>
            <th colspan="2">完成日期/签字</th>
          </tr>
          <tr class="voucher-sign-value-row">
            <td colspan="2" class="is-editable-cell">
              <span class="editable-line" :class="{ 'is-empty': !resolvedEditableFields.receiverSignature.trim() }">
                {{ getEditableFieldDisplay(resolvedEditableFields.receiverSignature) }}
              </span>
            </td>
            <td colspan="2" class="is-editable-cell">
              <span class="editable-line" :class="{ 'is-empty': !resolvedEditableFields.issuerSignature.trim() }">
                {{ getEditableFieldDisplay(resolvedEditableFields.issuerSignature) }}
              </span>
            </td>
            <td colspan="2" class="is-editable-cell">
              <span class="editable-line" :class="{ 'is-empty': !resolvedEditableFields.completionSignature.trim() }">
                {{ getEditableFieldDisplay(resolvedEditableFields.completionSignature) }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </article>
  </section>
</template>

<style scoped>
.voucher-print-document {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: fit-content;
  min-width: 100%;
}

.voucher-sheet {
  background: #fff;
  padding: 0;
  color: #0f172a;
  box-sizing: border-box;
  break-inside: avoid;
  page-break-inside: avoid;
}

.voucher-sheet--landscape {
  width: 281mm;
}

.voucher-sheet--portrait {
  width: 194mm;
}

.voucher-sheet__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 12px;
  color: #334155;
}

.voucher-copy-label {
  font-weight: 700;
  color: #111827;
}

.voucher-master-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.voucher-master-table th,
.voucher-master-table td {
  border: 1px solid #111;
  padding: 6px 4px;
  font-size: 13px;
  line-height: 1.45;
  vertical-align: middle;
  text-align: center;
  word-break: break-word;
}

.voucher-master-table th {
  font-weight: 700;
  background: #f3f4f6;
  color: #111;
}

.voucher-title-cell {
  background: #fff !important;
  font-size: 24px !important;
  letter-spacing: 0.06em;
  padding: 10px 8px !important;
}

.voucher-master-table .col-label {
  width: 11%;
}

.voucher-master-table .col-value-wide {
  width: 22.3333%;
}

.voucher-master-table td.text-left {
  text-align: left;
  padding-left: 8px;
  padding-right: 8px;
}

.voucher-master-table td.is-wrap {
  white-space: normal;
  overflow-wrap: anywhere;
}

.voucher-total-row th,
.voucher-total-row td,
.voucher-sign-label-row th {
  font-weight: 700;
}

.voucher-filler-row td {
  height: 28px;
}

.voucher-sheet--portrait .voucher-filler-row td {
  height: 24px;
}

.is-editable-cell {
  background: #fcfcfc;
}

.editable-line {
  min-height: 24px;
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 4px;
  box-sizing: border-box;
  white-space: pre-wrap;
}

.editable-line.is-empty {
  color: transparent;
}

@media (max-width: 1200px) {
  .voucher-sheet--landscape,
  .voucher-sheet--portrait {
    width: 100%;
  }
}

@media (max-width: 900px) {
  .voucher-sheet {
    width: 100%;
  }

  .voucher-sheet__meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .voucher-master-table th,
  .voucher-master-table td {
    font-size: 12px;
    padding: 5px 4px;
  }
}

@media print {
  .voucher-print-document {
    gap: 0;
    min-width: auto;
  }

  .voucher-sheet {
    color: #000;
  }

  .voucher-sheet:not(:last-child) {
    page-break-after: always;
    break-after: page;
  }

  .voucher-sheet__meta,
  .voucher-copy-label {
    color: #000;
  }

  .voucher-master-table th,
  .voucher-master-table td,
  .editable-line {
    border-color: #000;
    color: #000;
  }

  .voucher-master-table th,
  .voucher-master-table td {
    font-size: 11px;
    padding: 4px 3px;
  }

  .voucher-title-cell {
    font-size: 20px !important;
  }

  .voucher-sheet--landscape {
    width: 281mm;
  }

  .voucher-sheet--portrait {
    width: 194mm;
  }

  .voucher-filler-row td {
    height: 20px;
  }

  .voucher-sheet--portrait .voucher-filler-row td {
    height: 18px;
  }
}
</style>
