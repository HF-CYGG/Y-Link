<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/components/OrderDetailDrawerContent.vue`
 * 文件职责：负责渲染出库单详情抽屉中的主单信息、明细列表与永久修订时间线。
 * 实现逻辑：
 * 1. 主单信息按订单类型做条件化展示，部门单保留部门流程字段，散客单直接显示“不适用”或隐藏冗余项；
 * 2. 明细仍由父层提供，组件按订单 ID/版本只读加载永久 revision 时间线；
 * 3. 金额、库存模式与订单类型在组件内统一格式化，确保表格端与移动端展示口径一致。
 * 维护说明：revision 请求使用订单 ID 与版本号抑制过期响应，不得用当前商品数据覆盖历史快照。
 */


import dayjs from 'dayjs'
import { ref, watch } from 'vue'
import { getOrderRevisions, type OrderDetailResult, type OrderRevisionRecord } from '@/api/modules/order'
import { showCriticalErrorDialog } from '@/utils/error-dialog'

/**
 * 单据详情展示组件：
 * - 仅负责渲染主单信息与明细列表；
 * - 页面层只需传入详情数据与当前设备信息；
 * - 保持桌面表格、移动端卡片的既有样式与展示逻辑不变。
 */
const props = defineProps<{
  order: OrderDetailResult
  isPhone: boolean
  isDesktop: boolean
  detailGridClass: string
}>()
const emit = defineEmits<{ navigate: [orderId: string] }>()

const revisions = ref<OrderRevisionRecord[]>([])
const revisionsLoading = ref(false)
let revisionRequestVersion = 0

watch(
  () => [props.order.id, props.order.editVersion] as const,
  async () => {
    revisionRequestVersion += 1
    const requestVersion = revisionRequestVersion
    revisionsLoading.value = true
    try {
      const result = await getOrderRevisions(props.order.id)
      if (requestVersion === revisionRequestVersion) revisions.value = result
    } catch (error) {
      if (requestVersion !== revisionRequestVersion) return
      revisions.value = []
      void showCriticalErrorDialog(error, {
        title: '修订记录加载失败',
        fallback: '订单详情已加载，但暂时无法读取修订时间线',
        operation: '加载订单修订记录',
      })
    } finally {
      if (requestVersion === revisionRequestVersion) revisionsLoading.value = false
    }
  },
  { immediate: true },
)

const formatInventoryMode = (order: OrderDetailResult) => {
  if (order.inventoryMode === 'manual_applied') return '手工单（联动库存）'
  if (order.inventoryMode === 'o2o_preapplied') return 'O2O 正式单（库存已预扣）'
  return '历史单（不追溯库存）'
}

/**
 * 金额格式化：
 * - 统一将字符串金额安全转为两位小数；
 * - 避免接口字段缺失或异常值时直接渲染出 NaN；
 * - 与详情抽屉既有“¥xx.xx”展示保持一致。
 */
const formatAmount = (value: string | number | null | undefined) => {
  const normalizedValue = Number(value ?? 0)
  return Number.isFinite(normalizedValue) ? normalizedValue.toFixed(2) : '0.00'
}

const formatOrderType = (value: OrderDetailResult['orderType']) => {
  return value === 'department' ? '部门单' : '散客单'
}

/**
 * 详情主显示名称：
 * - 部门单优先使用客户部门名称；
 * - 散客单回退客户名称；
 * - 兼容历史数据缺失时的兜底展示。
 */
const getOrderDisplayName = (order: OrderDetailResult) => {
  if (order.orderType === 'department') {
    return order.customerDepartmentName || order.customerName || '-'
  }
  return order.customerName || order.customerDepartmentName || '-'
}
const hasItemProvenance = () => props.order.items.some((item) => Boolean(item.sourceOrderId))

/**
 * 来源单据文案：
 * - 读取结构化来源快照，不解析备注或幂等键；
 * - 目前仅线上预订单核销生成的正式出库单有来源，其余返回 null 不展示。
 */
const formatSourceDoc = (order: { sourceDocType?: string | null; sourceDocNo?: string | null }) => {
  if (order.sourceDocType === 'o2o_preorder' && order.sourceDocNo) {
    return `线上预订单 ${order.sourceDocNo}`
  }
  return null
}
</script>

<template>
  <section class="mb-5 rounded-2xl border border-slate-100 bg-slate-50/70 p-3 sm:p-4 dark:border-white/10 dark:bg-white/5">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 class="flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
        <span class="inline-block h-2 w-2 rounded-full bg-brand" />
        主单信息
      </h3>
      <div class="rounded-full bg-white px-2.5 py-1 text-xs text-slate-500 dark:bg-white/10 dark:text-slate-400">
        {{ dayjs(order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}
      </div>
    </div>
    <el-descriptions :column="isPhone ? 1 : 2" border size="small">
      <el-descriptions-item label="业务单号">{{ order.businessNo }}</el-descriptions-item>
      <el-descriptions-item label="库存模式">{{ formatInventoryMode(order) }}</el-descriptions-item>
      <el-descriptions-item label="订单类型">{{ formatOrderType(order.orderType) }}</el-descriptions-item>
      <el-descriptions-item label="开单时间">{{ dayjs(order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</el-descriptions-item>
      <el-descriptions-item label="领用对象">{{ getOrderDisplayName(order) }}</el-descriptions-item>
      <el-descriptions-item label="客户部门">{{ order.orderType === 'department' ? order.customerDepartmentName || '-' : '不适用' }}</el-descriptions-item>
      <el-descriptions-item label="出库单状态">
        {{ order.orderType === 'department' ? (order.hasCustomerOrder ? '已带单' : '未带单') : '不适用' }}
      </el-descriptions-item>
      <el-descriptions-item label="系统申请">
        {{ order.orderType === 'department' ? (order.isSystemApplied ? '已申请' : '未申请') : '不适用' }}
      </el-descriptions-item>
      <el-descriptions-item v-if="order.customerName" label="客户名称">{{ order.customerName }}</el-descriptions-item>
      <el-descriptions-item label="出单人">{{ order.issuerName || '-' }}</el-descriptions-item>
      <el-descriptions-item label="开单人">{{ order.creatorDisplayName || order.creatorUsername || '-' }}</el-descriptions-item>
      <el-descriptions-item label="总数量">{{ order.totalQty }}</el-descriptions-item>
      <el-descriptions-item label="总金额">
        <span class="text-base font-bold text-red-500">¥{{ formatAmount(order.totalAmount) }}</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="formatSourceDoc(order)" label="来源单据" :span="isPhone ? 1 : 2">{{ formatSourceDoc(order) }}</el-descriptions-item>
      <el-descriptions-item label="单据备注" :span="isPhone ? 1 : 2">{{ order.remark || '-' }}</el-descriptions-item>
    </el-descriptions>
  </section>

  <section v-if="order.merge.role !== 'standalone'" class="mb-5 rounded-2xl border border-teal-100 bg-teal-50/60 p-3 sm:p-4">
    <h3 class="text-base font-semibold text-teal-900">合并关系</h3>
    <p v-if="order.merge.role === 'source'" class="mt-2 text-sm text-teal-800">
      当前为来源单，已合并至
      <el-button v-if="order.merge.parent" link type="primary" @click="emit('navigate', order.merge.parent.id)">
        {{ order.merge.parent.businessNo || order.merge.parent.showNo }}
      </el-button>
      <span v-else>父单</span>，仅支持查看。
    </p>
    <div v-else class="mt-2">
      <p class="text-sm text-teal-800">当前为父单，包含 {{ order.merge.children.length }} 张来源单。</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <el-button v-for="child in order.merge.children" :key="child.id" link type="primary" @click="emit('navigate', child.id)">
          {{ child.businessNo || child.showNo }}<span v-if="formatSourceDoc(child)">（{{ formatSourceDoc(child) }}）</span>
        </el-button>
      </div>
    </div>
  </section>

  <section class="mb-6 grid gap-2 sm:grid-cols-2">
    <div class="rounded-xl border border-slate-100 bg-white px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
      <div class="text-xs text-slate-500 dark:text-slate-400">明细行数</div>
      <div class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ order.items.length }} 行</div>
    </div>
    <div class="rounded-xl border border-slate-100 bg-white px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
      <div class="text-xs text-slate-500 dark:text-slate-400">合计金额</div>
      <div class="mt-1 text-sm font-semibold text-red-500">¥{{ formatAmount(order.totalAmount) }}</div>
    </div>
  </section>

  <section>
    <h3 class="mb-3 flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
      <span class="inline-block h-2 w-2 rounded-full bg-brand" />
      明细列表
    </h3>
    <el-table native-scrollbar v-if="isDesktop" :data="order.items" border stripe size="small" table-layout="auto">
      <el-table-column type="index" label="行号" width="68" align="center" />
      <el-table-column prop="productCode" label="产品编码" min-width="130" show-overflow-tooltip />
      <el-table-column prop="productName" label="产品名称" min-width="180" show-overflow-tooltip />
      <el-table-column prop="specText" label="规格" min-width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.specText || '-' }}</template>
      </el-table-column>
      <el-table-column prop="skuCode" label="SKU 编码" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.skuCode || '-' }}</template>
      </el-table-column>
      <el-table-column prop="qty" label="数量" width="92" align="right" />
      <el-table-column prop="unitPrice" label="单价" width="118" align="right">
        <template #default="{ row }">¥{{ formatAmount(row.unitPrice) }}</template>
      </el-table-column>
      <el-table-column prop="subTotal" label="小计" width="118" align="right">
        <template #default="{ row }">
          <span class="font-medium text-red-500">¥{{ formatAmount(row.subTotal) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip />
      <el-table-column v-if="hasItemProvenance()" label="来源单" min-width="150">
        <template #default="{ row }">
          <span v-if="row.sourceOrderId" class="text-xs text-slate-500">合并来源明细</span>
          <span v-else>-</span>
        </template>
      </el-table-column>
    </el-table>

    <div v-else :class="['grid gap-3', detailGridClass]">
      <div
        v-for="(item, index) in order.items"
        :key="item.id"
        class="rounded-xl border border-slate-100 bg-slate-50 p-3.5 dark:border-white/10 dark:bg-white/5"
      >
        <div class="mb-2 flex items-start justify-between gap-3">
          <span class="font-medium text-slate-800 dark:text-slate-100">
            <span class="mr-1 text-slate-400 dark:text-slate-500">{{ index + 1 }}.</span>
            {{ item.productName || '-' }}
          </span>
          <span class="font-semibold text-red-500">¥{{ formatAmount(item.subTotal) }}</span>
        </div>
        <div class="flex flex-wrap justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>编码：{{ item.productCode }}</span>
          <span>规格：{{ item.specText || '-' }}</span>
          <span>SKU：{{ item.skuCode || '-' }}</span>
          <span>{{ item.qty }} × ¥{{ formatAmount(item.unitPrice) }}</span>
        </div>
        <div v-if="item.remark" class="mt-2 rounded bg-slate-100 p-1.5 text-xs text-slate-500 dark:bg-white/5 dark:text-slate-400">
          备注：{{ item.remark }}
        </div>
        <div v-if="item.sourceOrderId" class="mt-2 text-xs text-slate-500">来源：已合并来源单明细</div>
      </div>
    </div>
  </section>

  <section class="mt-6 rounded-2xl border border-slate-100 bg-slate-50/70 p-3 sm:p-4 dark:border-white/10 dark:bg-white/5">
    <h3 class="mb-3 flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100">
      <span class="inline-block h-2 w-2 rounded-full bg-brand" />
      内容修订时间线
    </h3>
    <el-alert
      v-if="order.inventoryMode === 'legacy_none'"
      class="mb-3"
      title="历史订单编辑不会追溯扣减或回补库存"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="!order.contentEditable && order.contentEditBlockers.length"
      class="mb-3"
      :title="`内容已锁定：${order.contentEditBlockers.join('；')}`"
      type="info"
      :closable="false"
      show-icon
    />
    <div v-loading="revisionsLoading" class="min-h-12">
      <p v-if="!revisionsLoading && revisions.length === 0" class="py-4 text-center text-sm text-slate-400">暂无内容修订记录</p>
      <div v-else class="space-y-3 border-l-2 border-slate-200 pl-4 dark:border-white/10">
        <article
          v-for="revision in revisions"
          :key="revision.id"
          class="relative rounded-xl bg-white px-3 py-2 text-sm dark:bg-white/5"
        >
          <span class="absolute -left-[1.3rem] top-3 h-2 w-2 rounded-full bg-brand" />
          <div class="font-medium text-slate-800 dark:text-slate-100">版本 {{ revision.revisionNo }} · {{ revision.reason || '未填写原因' }}</div>
          <div class="mt-1 text-xs text-slate-500">
            {{ dayjs(revision.createdAt).format('YYYY-MM-DD HH:mm:ss') }} · {{ revision.actorDisplayName || revision.actorUsername }}
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
