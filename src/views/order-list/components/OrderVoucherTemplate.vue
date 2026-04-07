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
      <h3 class="voucher-title">海右野辙文创店购物凭证</h3>
      <p class="voucher-subtitle">Y-Link 出库业务凭证</p>
    </header>

    <section class="voucher-grid">
      <div class="voucher-cell">
        <span class="voucher-label">凭证时间</span>
        <span class="voucher-value">{{ dayjs(props.order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</span>
      </div>
      <div class="voucher-cell">
        <span class="voucher-label">业务单号</span>
        <span class="voucher-value">{{ props.order.showNo }}</span>
      </div>
      <div class="voucher-cell">
        <span class="voucher-label">订单类型</span>
        <span class="voucher-value">{{ getOrderTypeLabel(props.order.orderType) }}</span>
      </div>
      <div class="voucher-cell">
        <span class="voucher-label">客户部门</span>
        <span class="voucher-value">{{ props.order.customerDepartmentName || '-' }}</span>
      </div>
      <div class="voucher-cell">
        <span class="voucher-label">领取人</span>
        <span class="voucher-value">{{ props.order.customerName || '-' }}</span>
      </div>
      <div class="voucher-cell">
        <span class="voucher-label">出库人</span>
        <span class="voucher-value">{{ props.order.issuerName || '-' }}</span>
      </div>
      <div class="voucher-cell">
        <span class="voucher-label">开单人</span>
        <span class="voucher-value">{{ props.order.creatorDisplayName || props.order.creatorUsername || '-' }}</span>
      </div>
      <div class="voucher-cell">
        <span class="voucher-label">总数量</span>
        <span class="voucher-value">{{ formatQty(props.order.totalQty) }}</span>
      </div>
      <div class="voucher-cell voucher-cell--wide">
        <span class="voucher-label">总金额</span>
        <span class="voucher-value voucher-value--accent">¥{{ formatAmount(props.order.totalAmount) }}</span>
      </div>
    </section>

    <section class="voucher-items">
      <h4 class="voucher-items__title">明细清单</h4>
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

    <footer class="voucher-footer">
      <span>系统：Y-Link 文创出库管理系统</span>
      <span>打印时间：{{ dayjs().format('YYYY-MM-DD HH:mm:ss') }}</span>
    </footer>
  </article>
</template>

<style scoped>
.voucher-sheet {
  border-radius: 20px;
  border: 1px solid #e2e8f0;
  background: #fff;
  padding: 18px;
  color: #0f172a;
}

.voucher-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-bottom: 1px dashed #cbd5e1;
  padding-bottom: 12px;
}

.voucher-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.voucher-subtitle {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}

.voucher-grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.voucher-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  padding: 10px 12px;
}

.voucher-cell--wide {
  grid-column: 1 / -1;
}

.voucher-label {
  font-size: 12px;
  color: #64748b;
}

.voucher-value {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
  word-break: break-all;
}

.voucher-value--accent {
  color: #dc2626;
}

.voucher-items {
  margin-top: 14px;
}

.voucher-items__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.voucher-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.voucher-table th,
.voucher-table td {
  border: 1px solid #e2e8f0;
  padding: 6px 8px;
  text-align: left;
}

.voucher-table thead th {
  background: #f1f5f9;
}

.voucher-table td:nth-child(1),
.voucher-table td:nth-child(4),
.voucher-table td:nth-child(5),
.voucher-table td:nth-child(6) {
  white-space: nowrap;
}

.voucher-footer {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px dashed #cbd5e1;
  padding-top: 10px;
  color: #64748b;
  font-size: 12px;
}

@media (max-width: 768px) {
  .voucher-sheet {
    border-radius: 16px;
    padding: 14px;
  }

  .voucher-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
