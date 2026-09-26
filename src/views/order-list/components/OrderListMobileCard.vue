<!--
  模块说明：src/views/order-list/components/OrderListMobileCard.vue
  文件职责：按需承载出库单列表的移动端卡片、父单展开来源单和受权限约束的行级操作。
  实现逻辑：
  - 卡片只接收父页面已归一化的订单与权限状态，通过事件回传查看、选择、修订及删除操作；
  - 父单来源单折叠状态仍由列表页面统一持有，确保刷新、分页和详情跳转不会丢失当前交互；
  - 来源单不渲染选择、修订或删除入口，避免移动端绕过桌面树表的合并约束。
  维护说明：
  - 此组件保持异步加载，不能把管理端订单页的高频桌面路由重新拉回移动端专属展示代码。
-->
<script setup lang="ts">
import dayjs from 'dayjs'
import type { OrderRecord } from '@/api/modules/order'

const props = defineProps<{
  item: OrderRecord
  isTablet: boolean
  selected: boolean
  canSelect: boolean
  canAmend: boolean
  canDelete: boolean
  canPurge: boolean
  parentExpanded: boolean
  isNew: boolean
  isActive: boolean
}>()

const emit = defineEmits<{
  view: [order: OrderRecord]
  viewId: [orderId: string]
  select: [selected: boolean]
  amend: [order: OrderRecord]
  delete: [order: OrderRecord]
  restore: [order: OrderRecord]
  purge: [order: OrderRecord]
  toggleParent: [orderId: string]
}>()

const isSourceOrder = (order: Pick<OrderRecord, 'merge'>) => order.merge.role === 'source'
const isParentOrder = (order: Pick<OrderRecord, 'merge'>) => order.merge.role === 'parent'
const getOrderTypeLabel = (value: OrderRecord['orderType']) => value === 'department' ? '部门单' : '散客单'
const getOrderDisplayName = (order: Pick<OrderRecord, 'orderType' | 'customerDepartmentName' | 'customerName'>) => {
  return order.orderType === 'department'
    ? order.customerDepartmentName || order.customerName || '-'
    : order.customerName || order.customerDepartmentName || '-'
}
const getShipmentStatusMeta = (order: Pick<OrderRecord, 'orderType' | 'hasCustomerOrder'>) => {
  if (order.orderType !== 'department') return { label: '不适用', toneClass: 'is-neutral' }
  return order.hasCustomerOrder ? { label: '已带单', toneClass: 'is-positive' } : { label: '未带单', toneClass: 'is-warning' }
}
const getSystemApplyStatusMeta = (order: Pick<OrderRecord, 'orderType' | 'isSystemApplied'>) => {
  if (order.orderType !== 'department') return { label: '不适用', toneClass: 'is-neutral' }
  return order.isSystemApplied ? { label: '已申请', toneClass: 'is-warning' } : { label: '未申请', toneClass: 'is-neutral' }
}
</script>

<template>
  <div
    :data-order-list-item-id="item.id"
    class="apple-card mobile-order-card min-w-0 p-4 active:scale-[0.99]"
    :class="{ 'mobile-order-card--new': isNew, 'mobile-order-card--active': isActive }"
    @click="emit('view', item)"
  >
    <div v-if="canSelect" class="mb-2" @click.stop>
      <el-checkbox :model-value="selected" @change="emit('select', Boolean($event))">选择单据</el-checkbox>
    </div>
    <div class="mobile-order-card__head">
      <div class="min-w-0"><div class="mobile-order-card__business-no">{{ item.businessNo }}</div><div class="mobile-order-card__time">{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}</div></div>
      <div class="mobile-order-card__head-tags"><span class="mobile-order-card__chip is-brand">{{ item.isDeleted ? '已删除' : '正常' }}</span><span class="mobile-order-card__chip is-brand-soft">{{ getOrderTypeLabel(item.orderType) }}</span></div>
    </div>
    <div class="mobile-order-card__primary"><p class="mobile-order-card__primary-label">领用对象</p><p class="mobile-order-card__primary-value">{{ getOrderDisplayName(item) }}</p></div>
    <div class="mobile-order-card__metrics"><span class="mobile-order-card__metric-qty">数量：{{ Number(item.totalQty).toFixed(2) }}</span><span class="mobile-order-card__metric-amount">¥{{ Number(item.totalAmount).toFixed(2) }}</span></div>

    <div v-if="isParentOrder(item)" class="mobile-order-card__merge" @click.stop>
      <div class="mobile-order-card__merge-head"><span class="mobile-order-card__merge-title">已合并 {{ item.merge.children.length }} 张来源单</span><el-button link type="primary" :aria-expanded="parentExpanded" @click="emit('toggleParent', item.id)">{{ parentExpanded ? '收起来源单' : '展开来源单' }}</el-button></div>
      <div v-if="parentExpanded" class="mobile-order-card__merge-list">
        <div v-for="child in item.merge.children" :key="child.id" class="mobile-order-card__merge-child">
          <div class="mobile-order-card__merge-child-head"><span class="mobile-order-card__merge-child-title">{{ child.businessNo }}</span><el-button link type="primary" @click="emit('viewId', child.id)">查看</el-button></div>
          <p class="mobile-order-card__merge-child-meta">已合并至父单 · {{ child.totalQty }} 件 · ¥{{ Number(child.totalAmount).toFixed(2) }}</p>
        </div>
      </div>
    </div>
    <div v-else-if="isSourceOrder(item)" class="mobile-order-card__source-notice">已合并至父单，当前仅可查看详情。</div>

    <div class="mobile-order-card__meta" :class="isTablet ? 'is-tablet' : ''">
      <div class="mobile-order-card__meta-item"><span class="mobile-order-card__meta-label">出库单状态</span><span class="mobile-order-card__meta-value" :class="getShipmentStatusMeta(item).toneClass">{{ getShipmentStatusMeta(item).label }}</span></div>
      <div class="mobile-order-card__meta-item"><span class="mobile-order-card__meta-label">系统申请</span><span class="mobile-order-card__meta-value" :class="getSystemApplyStatusMeta(item).toneClass">{{ getSystemApplyStatusMeta(item).label }}</span></div>
      <div class="mobile-order-card__meta-item"><span class="mobile-order-card__meta-label">出单人</span><span class="mobile-order-card__meta-value">{{ item.issuerName || '-' }}</span></div>
      <div class="mobile-order-card__meta-item"><span class="mobile-order-card__meta-label">开单人</span><span class="mobile-order-card__meta-value">{{ item.creatorDisplayName || item.creatorUsername || '-' }}</span></div>
      <div v-if="item.orderType === 'department'" class="mobile-order-card__meta-item"><span class="mobile-order-card__meta-label">客户部门</span><span class="mobile-order-card__meta-value">{{ item.customerDepartmentName || '-' }}</span></div>
      <div v-if="item.customerName" class="mobile-order-card__meta-item"><span class="mobile-order-card__meta-label">客户名称</span><span class="mobile-order-card__meta-value">{{ item.customerName }}</span></div>
    </div>

    <div class="mobile-order-card__actions">
      <el-button link type="primary" @click.stop="emit('view', item)">详情</el-button>
      <el-button v-if="canAmend && !item.isDeleted && !isSourceOrder(item)" link type="warning" @click.stop="emit('amend', item)">修订</el-button>
      <template v-if="canDelete">
        <el-button v-if="!item.isDeleted && !isSourceOrder(item)" link type="danger" @click.stop="emit('delete', item)">删除</el-button>
        <el-button v-else-if="item.isDeleted && !isSourceOrder(item)" link type="warning" @click.stop="emit('restore', item)">恢复</el-button>
        <el-button v-if="canPurge && item.isDeleted && !isSourceOrder(item)" link type="danger" @click.stop="emit('purge', item)">永久删除</el-button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mobile-order-card {
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}

.mobile-order-card--active {
  box-shadow: 0 0 0 1px rgba(13, 148, 136, 0.28), 0 18px 40px rgba(15, 118, 110, 0.16);
}

.mobile-order-card--new {
  animation: order-card-fade-highlight 0.9s ease;
}

.mobile-order-card__head {
  margin-bottom: 10px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.mobile-order-card__business-no {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 20px;
  font-weight: 700;
  color: #0f172a;
}

.mobile-order-card__time {
  margin-top: 2px;
  font-size: 12px;
  color: #64748b;
}

.mobile-order-card__head-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.mobile-order-card__chip {
  border-radius: 9999px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.mobile-order-card__chip.is-brand {
  background: #ecfdf5;
  color: #0f766e;
}

.mobile-order-card__chip.is-brand-soft {
  background: #ccfbf1;
  color: #134e4a;
}

.mobile-order-card__primary {
  border-radius: 12px;
  background: #f8fafc;
  padding: 10px 12px;
}

.mobile-order-card__primary-label {
  margin: 0;
  font-size: 12px;
  color: #64748b;
}

.mobile-order-card__primary-value {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: #0f172a;
  line-height: 1.45;
  word-break: break-all;
}

.mobile-order-card__metrics {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mobile-order-card__metric-qty {
  color: #475569;
  font-size: 14px;
}

.mobile-order-card__metric-amount {
  font-size: 18px;
  font-weight: 700;
  color: #ef4444;
}

.mobile-order-card__merge {
  margin-top: 12px;
  border: 1px solid #ccfbf1;
  border-radius: 12px;
  background: rgba(240, 253, 250, 0.6);
  padding: 12px;
}

.mobile-order-card__merge-head,
.mobile-order-card__merge-child-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mobile-order-card__merge-title {
  color: #115e59;
  font-size: 14px;
  font-weight: 500;
}

.mobile-order-card__merge-list {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

.mobile-order-card__merge-child {
  border-radius: 8px;
  background: #fff;
  padding: 8px 12px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.mobile-order-card__merge-child-title {
  min-width: 0;
  color: #1e293b;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.mobile-order-card__merge-child-meta {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 12px;
}

.mobile-order-card__source-notice {
  margin-top: 12px;
  border-radius: 12px;
  background: #f1f5f9;
  padding: 8px 12px;
  color: #475569;
  font-size: 12px;
}

.mobile-order-card__meta {
  margin-top: 10px;
  display: grid;
  gap: 6px 12px;
}

.mobile-order-card__meta.is-tablet {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mobile-order-card__meta-item {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mobile-order-card__meta-label {
  color: #64748b;
  font-size: 13px;
  flex-shrink: 0;
}

.mobile-order-card__meta-value {
  color: #334155;
  font-size: 13px;
  font-weight: 500;
  text-align: right;
  word-break: break-all;
}

.mobile-order-card__meta-value.is-positive {
  color: #15803d;
}

.mobile-order-card__meta-value.is-warning {
  color: #b45309;
}

.mobile-order-card__meta-value.is-danger {
  color: #b91c1c;
}

.mobile-order-card__meta-value.is-neutral {
  color: #64748b;
}

.mobile-order-card__actions {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  gap: 14px;
}

.dark .mobile-order-card__business-no {
  color: #e2e8f0;
}

.dark .mobile-order-card__time,
.dark .mobile-order-card__primary-label,
.dark .mobile-order-card__meta-label,
.dark .mobile-order-card__merge-child-meta {
  color: #94a3b8;
}

.dark .mobile-order-card__primary,
.dark .mobile-order-card__merge-child {
  background: rgba(30, 41, 59, 0.65);
}

.dark .mobile-order-card__primary-value,
.dark .mobile-order-card__meta-value,
.dark .mobile-order-card__merge-child-title {
  color: #e2e8f0;
}

.dark .mobile-order-card__actions {
  border-top-color: rgba(148, 163, 184, 0.28);
}

@keyframes order-card-fade-highlight {
  0% {
    transform: translateY(14px) scale(0.985);
    box-shadow: 0 18px 34px rgba(245, 158, 11, 0.18);
    background-color: rgba(254, 243, 199, 0.88);
  }

  60% {
    transform: translateY(0) scale(1);
    box-shadow: 0 12px 24px rgba(245, 158, 11, 0.12);
    background-color: rgba(254, 252, 232, 0.76);
  }

  100% {
    transform: translateY(0) scale(1);
    box-shadow: inherit;
    background-color: transparent;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mobile-order-card--new {
    animation: none !important;
  }
}
</style>
