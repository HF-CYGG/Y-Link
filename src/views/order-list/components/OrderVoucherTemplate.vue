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
</script>

<template>
  <article class="voucher-sheet">
    <header class="voucher-header">
      <div class="voucher-header__meta">
        <span>店铺：海右野辙文创店</span>
        <span>打印时间：{{ dayjs().format('YYYY-MM-DD HH:mm:ss') }}</span>
      </div>
      <h3 class="voucher-title">出库凭证</h3>
      <p class="voucher-subtitle">Y-Link 出库业务单据（留存联）</p>
    </header>

    <section class="voucher-info">
      <div class="voucher-info__row">
        <span class="voucher-label">业务单号</span>
        <span class="voucher-value">{{ props.order.showNo }}</span>
      </div>
      <div class="voucher-info__row">
        <span class="voucher-label">开单时间</span>
        <span class="voucher-value">{{ dayjs(props.order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</span>
      </div>
      <div class="voucher-info__row">
        <span class="voucher-label">订单类型</span>
        <span class="voucher-value">{{ getOrderTypeLabel(props.order.orderType) }}</span>
      </div>
      <div class="voucher-info__row">
        <span class="voucher-label">客户部门</span>
        <span class="voucher-value">{{ props.order.customerDepartmentName || '散客' }}</span>
      </div>
      <div class="voucher-info__row">
        <span class="voucher-label">领取人</span>
        <span class="voucher-value">{{ props.order.customerName || '-' }}</span>
      </div>
      <div class="voucher-info__row">
        <span class="voucher-label">出库人</span>
        <span class="voucher-value">{{ props.order.issuerName || '-' }}</span>
      </div>
      <div class="voucher-info__row">
        <span class="voucher-label">开单人</span>
        <span class="voucher-value">{{ props.order.creatorDisplayName || props.order.creatorUsername || '-' }}</span>
      </div>
      <div class="voucher-info__row voucher-info__row--wide">
        <span class="voucher-label">备注</span>
        <span class="voucher-value">{{ props.order.remark || '-' }}</span>
      </div>
    </section>

    <section class="voucher-items">
      <h4 class="voucher-items__title">出库明细</h4>
      <table class="voucher-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>产品编码</th>
            <th>产品名称</th>
            <th>数量</th>
            <th>单价</th>
            <th>小计</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in props.order.items" :key="item.id">
            <td>{{ index + 1 }}</td>
            <td>{{ item.productCode }}</td>
            <td>{{ item.productName }}</td>
            <td>{{ formatQty(item.qty) }}</td>
            <td>¥{{ formatAmount(item.unitPrice) }}</td>
            <td>¥{{ formatAmount(item.subTotal) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="voucher-summary">
      <div class="voucher-summary__item">
        <span class="voucher-label">合计数量</span>
        <strong class="voucher-summary__value">{{ formatQty(props.order.totalQty) }}</strong>
      </div>
      <div class="voucher-summary__item">
        <span class="voucher-label">合计金额</span>
        <strong class="voucher-summary__value">¥{{ formatAmount(props.order.totalAmount) }}</strong>
      </div>
    </section>

    <footer class="voucher-sign">
      <div class="voucher-sign__item">
        <span class="voucher-sign__label">制单人</span>
        <span class="voucher-sign__line"></span>
      </div>
      <div class="voucher-sign__item">
        <span class="voucher-sign__label">领取人</span>
        <span class="voucher-sign__line"></span>
      </div>
      <div class="voucher-sign__item">
        <span class="voucher-sign__label">审核人</span>
        <span class="voucher-sign__line"></span>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.voucher-sheet {
  border-radius: 10px;
  border: 1px solid #cbd5e1;
  background: #fff;
  padding: 16px;
  color: #0f172a;
}

.voucher-header {
  border-bottom: 1px solid #cbd5e1;
  padding-bottom: 10px;
}

.voucher-header__meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #64748b;
}

.voucher-title {
  margin: 0;
  text-align: center;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.voucher-subtitle {
  margin: 6px 0 0;
  text-align: center;
  font-size: 12px;
  color: #64748b;
}

.voucher-info {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid #cbd5e1;
  border-bottom: 0;
}

.voucher-info__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 10px;
  border-right: 1px solid #cbd5e1;
  border-bottom: 1px solid #cbd5e1;
}

.voucher-info__row:nth-child(4n) {
  border-right: 0;
}

.voucher-info__row--wide {
  grid-column: 1 / -1;
  border-right: 0;
}

.voucher-label {
  flex-shrink: 0;
  font-size: 11px;
  color: #64748b;
}

.voucher-value {
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: #0f172a;
  word-break: break-all;
}

.voucher-items {
  margin-top: 12px;
}

.voucher-items__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.voucher-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 11px;
}

.voucher-table th,
.voucher-table td {
  border: 1px solid #cbd5e1;
  padding: 6px 8px;
  text-align: left;
}

.voucher-table thead th {
  background: #f8fafc;
  font-weight: 600;
}

.voucher-table td:nth-child(1),
.voucher-table td:nth-child(4),
.voucher-table td:nth-child(5),
.voucher-table td:nth-child(6) {
  white-space: nowrap;
  text-align: right;
}

.voucher-summary {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
  gap: 16px;
}

.voucher-summary__item {
  min-width: 140px;
  border: 1px solid #cbd5e1;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.voucher-summary__value {
  font-size: 13px;
  color: #0f172a;
}

.voucher-sign {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  border-top: 1px dashed #94a3b8;
  padding-top: 12px;
}

.voucher-sign__item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.voucher-sign__label {
  font-size: 12px;
  color: #475569;
  white-space: nowrap;
}

.voucher-sign__line {
  flex: 1;
  border-bottom: 1px solid #94a3b8;
  min-height: 20px;
}

@media (max-width: 768px) {
  .voucher-sheet {
    padding: 14px;
  }

  .voucher-header__meta {
    flex-direction: column;
    gap: 4px;
  }

  .voucher-info {
    grid-template-columns: minmax(0, 1fr);
  }

  .voucher-info__row {
    border-right: 0;
  }

  .voucher-summary {
    justify-content: stretch;
    flex-direction: column;
    gap: 8px;
  }

  .voucher-summary__item {
    min-width: 0;
  }

  .voucher-sign {
    flex-direction: column;
    gap: 8px;
  }
}

@media print {
  .voucher-sheet {
    border: 1px solid #334155;
    border-radius: 0;
    box-shadow: none;
    page-break-inside: avoid;
    break-inside: avoid;
    color: #000;
  }

  .voucher-table thead {
    display: table-header-group;
  }

  .voucher-table tr {
    page-break-inside: avoid;
    break-inside: avoid;
  }
}
</style>
