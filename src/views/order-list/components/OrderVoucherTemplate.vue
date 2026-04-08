<script setup lang="ts">
import dayjs from 'dayjs'
import type { OrderDetailResult } from '@/api/modules/order'

const props = defineProps<{
  order: OrderDetailResult
}>()

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

const getOrderTypeLabel = (value: OrderDetailResult['orderType']) => {
  return value === 'department' ? '部门单' : '散客单'
}

const getVisualLength = (value: string | null | undefined) => {
  return Array.from(String(value ?? '')).reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 255 ? 2 : 1), 0)
}

const shouldWrapProductName = (value: string | null | undefined) => {
  return getVisualLength(value) > 20
}

const shouldWrapRemark = (value: string | null | undefined) => {
  return getVisualLength(value) > 24
}

const getItemRemark = (value: string | null | undefined) => {
  const normalizedValue = String(value ?? '').trim()
  return normalizedValue || '-'
}
</script>

<template>
  <article class="voucher-sheet">
    <header class="voucher-header">
      <div class="voucher-header__meta">
        <span>店铺：海右野辙文创店</span>
        <span>打印时间：{{ dayjs().format('YYYY-MM-DD HH:mm:ss') }}</span>
      </div>
      <h3 class="voucher-title">野辙文创出库单</h3>
      <p class="voucher-subtitle">信息核对留存联 · 一式两份</p>
    </header>

    <section class="voucher-body">
      <table class="voucher-table voucher-table--meta">
        <tbody>
          <tr>
            <th scope="row">业务单号</th>
            <td colspan="3" class="is-strong">{{ props.order.showNo }}</td>
            <th scope="row">订单类型</th>
            <td colspan="3">{{ getOrderTypeLabel(props.order.orderType) }}</td>
          </tr>
          <tr>
            <th scope="row">开单时间</th>
            <td colspan="3">{{ dayjs(props.order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</td>
            <th scope="row">客户部门</th>
            <td colspan="3">{{ props.order.customerDepartmentName || '散客' }}</td>
          </tr>
          <tr>
            <th scope="row">领取人</th>
            <td colspan="2">{{ props.order.customerName || '-' }}</td>
            <th scope="row">出库人</th>
            <td colspan="2">{{ props.order.issuerName || '-' }}</td>
            <th scope="row">开单人</th>
            <td>{{ props.order.creatorDisplayName || props.order.creatorUsername || '-' }}</td>
          </tr>
          <tr>
            <th scope="row">备注</th>
            <td colspan="7">{{ props.order.remark || '-' }}</td>
          </tr>
        </tbody>
      </table>

      <section class="voucher-items">
        <h4 class="voucher-items__title">出库明细</h4>
        <table class="voucher-table voucher-table--items">
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">产品编码</th>
              <th scope="col">产品名称</th>
              <th scope="col">单价</th>
              <th scope="col">数量</th>
              <th scope="col">小计</th>
              <th scope="col">备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in props.order.items" :key="item.id">
              <td>{{ index + 1 }}</td>
              <td>{{ item.productCode || '-' }}</td>
              <td :class="{ 'is-wrap': shouldWrapProductName(item.productName) }">{{ item.productName || '-' }}</td>
              <td>¥{{ formatAmount(item.unitPrice) }}</td>
              <td>{{ formatQty(item.qty) }}</td>
              <td>¥{{ formatAmount(item.subTotal) }}</td>
              <td :class="{ 'is-wrap': shouldWrapRemark(item.remark) }">{{ getItemRemark(item.remark) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="voucher-summary">
        <div class="voucher-summary__item">
          <span class="voucher-summary__label">商品行数</span>
          <span class="voucher-summary__value">{{ props.order.items.length }}</span>
        </div>
        <div class="voucher-summary__item">
          <span class="voucher-summary__label">总数量</span>
          <span class="voucher-summary__value">{{ formatQty(props.order.totalQty) }}</span>
        </div>
        <div class="voucher-summary__item voucher-summary__item--amount">
          <span class="voucher-summary__label">总金额</span>
          <span class="voucher-summary__value">¥{{ formatAmount(props.order.totalAmount) }}</span>
        </div>
      </section>

      <footer class="voucher-sign">
        <div class="voucher-sign__item">
          <span>制单人</span>
          <span class="voucher-sign__line"></span>
        </div>
        <div class="voucher-sign__item">
          <span>领取人</span>
          <span class="voucher-sign__line"></span>
        </div>
        <div class="voucher-sign__item">
          <span>审核人</span>
          <span class="voucher-sign__line"></span>
        </div>
      </footer>
    </section>
  </article>
</template>

<style scoped>
.voucher-sheet {
  border: 0;
  border-radius: 0;
  background: #fff;
  padding: 12px 10px;
  color: #0f172a;
  width: 100%;
  box-sizing: border-box;
}

.voucher-header {
  border-bottom: 1px solid #111;
  padding-bottom: 8px;
}

.voucher-header__meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #111;
}

.voucher-title {
  margin: 0;
  text-align: center;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.voucher-subtitle {
  margin: 4px 0 0;
  text-align: center;
  font-size: 12px;
  color: #111;
}

.voucher-body {
  margin-top: 10px;
}

.voucher-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
}

.voucher-table th,
.voucher-table td {
  border: 1px solid #111;
  padding: 8px 6px;
  font-size: 13px;
  vertical-align: middle;
  text-align: center;
  word-break: break-word;
}

.voucher-table th {
  font-weight: 700;
  color: #111;
}

.voucher-table--meta th {
  width: 12%;
  background: transparent;
}

.voucher-table--meta td {
  color: #111;
  font-weight: 500;
}

.voucher-table--meta .is-strong {
  font-weight: 700;
  letter-spacing: 0.02em;
}

.voucher-items {
  margin-top: 10px;
}

.voucher-items__title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 700;
}

.voucher-table--items th {
  background: transparent;
  text-align: center;
}

.voucher-table--items {
  table-layout: auto;
  width: 100%;
  max-width: 100%;
}

.voucher-table--items th,
.voucher-table--items td {
  box-sizing: border-box;
  padding-left: 10px;
  padding-right: 10px;
  text-align: center;
}

.voucher-table--items th:nth-child(1),
.voucher-table--items td:nth-child(1) {
  width: 1%;
  white-space: nowrap;
}

.voucher-table--items th:nth-child(2),
.voucher-table--items td:nth-child(2) {
  width: 1%;
  white-space: nowrap;
}

.voucher-table--items th:nth-child(3),
.voucher-table--items td:nth-child(3) {
  width: 1%;
  min-width: 12ch;
  white-space: nowrap;
}

.voucher-table--items th:nth-child(4),
.voucher-table--items td:nth-child(4),
.voucher-table--items th:nth-child(5),
.voucher-table--items td:nth-child(5),
.voucher-table--items th:nth-child(6),
.voucher-table--items td:nth-child(6) {
  width: 1%;
  white-space: nowrap;
}

.voucher-table--items th:nth-child(7),
.voucher-table--items td:nth-child(7) {
  width: auto;
  min-width: 18ch;
  white-space: nowrap;
}

.voucher-table--items td.is-wrap {
  white-space: normal !important;
  overflow-wrap: anywhere;
}

.voucher-summary {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.voucher-summary__item {
  min-width: 0;
  border: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1 1 0;
  white-space: nowrap;
}

.voucher-summary__label {
  font-size: 12px;
  color: #111;
}

.voucher-summary__value {
  font-size: 14px;
  font-weight: 700;
  color: #111;
}

.voucher-sign {
  margin-top: 10px;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  border-top: 1px dashed #111;
  padding-top: 10px;
}

.voucher-sign__item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.voucher-sign__line {
  flex: 1;
  min-height: 20px;
  border-bottom: 1px solid #111;
}

@media (max-width: 900px) {
  .voucher-sheet {
    padding: 10px 8px;
  }

  .voucher-header__meta {
    flex-direction: column;
    gap: 4px;
  }

  .voucher-title {
    font-size: 22px;
  }

  .voucher-items__title {
    font-size: 18px;
  }

  .voucher-summary {
    flex-direction: row;
    gap: 8px;
  }

  .voucher-table th,
  .voucher-table td {
    padding: 8px 6px;
    font-size: 13px;
  }

  .voucher-table--items th,
  .voucher-table--items td {
    padding-left: 8px;
    padding-right: 8px;
  }
}

@media print {
  @page {
    size: A4 portrait;
    margin: 8mm;
  }

  .voucher-sheet {
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding: 5mm 4mm;
    color: #000;
    page-break-inside: auto;
    break-inside: auto;
  }

  .voucher-header,
  .voucher-sign {
    border-color: #000;
  }

  .voucher-table th,
  .voucher-table td {
    border-color: #000;
    color: #000;
    font-size: 11px;
    padding: 5px 4px;
  }

  .voucher-table--items th,
  .voucher-table--items td {
    padding-left: 7px;
    padding-right: 7px;
  }

  .voucher-table--meta th,
  .voucher-table--items th {
    background: transparent;
  }

  .voucher-summary {
    justify-content: space-between;
    flex-direction: row;
    gap: 8px;
  }

  .voucher-summary__label,
  .voucher-summary__value {
    color: #000;
  }

  .voucher-table thead {
    display: table-header-group;
  }

  .voucher-table--items tbody tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }

  .voucher-summary,
  .voucher-sign {
    page-break-inside: avoid;
    break-inside: avoid;
  }
}
</style>
