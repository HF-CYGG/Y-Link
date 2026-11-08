<script setup lang="ts">
import { formatOrderRecipient } from '../order-recipient-display'
/**
 * 模块说明：`src/views/order-list/components/OrderDetailDrawerContent.vue`
 * 文件职责：负责渲染出库单详情抽屉中的合规状态、主单信息、明细列表与永久修订时间线。
 * 实现逻辑：
 * 1. 主单信息按订单类型做条件化展示，部门单保留部门流程字段，散客单直接显示“不适用”或隐藏冗余项；
 * 2. 明细仍由父层提供，组件按订单 ID/版本只读加载永久 revision 时间线；
 * 3. 合规状态只使用父层权限、草稿和保存状态，编辑经事件回传，不在展示组件内请求或持久化；
 * 4. 金额、库存模式与订单类型在组件内统一格式化，确保表格端与移动端展示口径一致。
 * 维护说明：revision 请求使用订单 ID 与版本号抑制过期响应，不得用当前商品数据覆盖历史快照；合规草稿由父层拥有。
 */
import { formatOrderKingdeeStatus, KINGDEE_STATUS_LABELS } from '@/utils/kingdee-status'



import KingdeeRegistrationEditor from '@/components/common/KingdeeRegistrationEditor.vue'
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getOrderRevisions, type OrderDetailResult, type OrderRevisionRecord } from '@/api/modules/order'
import { revisionActor, revisionSummary, revisionTime } from '../order-revision.helpers'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'

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
  canEditStandaloneComplianceFlags: boolean
  complianceForm: { hasCustomerOrder: boolean; isSystemApplied: boolean }
  complianceSaving: boolean
  canEditSystemApplied: boolean
  complianceRefreshRequired: 'conflict' | 'partial' | 'saved' | null
  complianceFeedback: string
}>()
const emit = defineEmits<{
  navigate: [orderId: string]
  'update:hasCustomerOrder': [value: boolean]
  'update:isSystemApplied': [value: boolean]
  'save-compliance': []
  'refresh-compliance': []
}>()
const authStore = useAuthStore(pinia)
const canViewSystemNo = () => authStore.currentUser?.role === 'admin'
const isMultiSourceOrder = computed(() => (props.order.merge.role === 'parent' && props.order.merge.children.length > 0)
  || (props.order.sourcePreorderRegistrations?.length ?? 0) > 1)
const singleRegistration = computed(() => {
  const sources = props.order.sourcePreorderRegistrations ?? []
  return !isMultiSourceOrder.value && sources.length === 1 && sources[0]?.sourceOrderId === props.order.id ? sources[0] : null
})
const canEditRegistration = computed(() => Boolean(authStore.currentUser?.permissions.includes('orders:update')) && !props.complianceSaving)

const revisions = ref<OrderRevisionRecord[]>([])
const revisionsLoading = ref(false)
const revisionsError = ref(false)
const showAllRevisions = ref(false)
const expandedRevisions = ref<string[]>([])
const visibleRevisions = computed(() => showAllRevisions.value ? revisions.value : revisions.value.slice(0, 3))
let revisionRequestVersion = 0

const loadRevisions = async () => {
    revisionRequestVersion += 1
    const requestVersion = revisionRequestVersion
    const orderId = props.order.id
    revisionsLoading.value = true
    revisionsError.value = false
    try {
      const result = await getOrderRevisions(orderId)
      if (requestVersion === revisionRequestVersion) revisions.value = result
    } catch {
      if (requestVersion !== revisionRequestVersion) return
      revisions.value = []
      revisionsError.value = true
    } finally {
      if (requestVersion === revisionRequestVersion) revisionsLoading.value = false
    }
}

watch(
  () => [props.order.id, props.order.editVersion] as const,
  () => {
    revisions.value = []
    showAllRevisions.value = false
    expandedRevisions.value = []
    void loadRevisions()
  },
  { immediate: true, flush: 'sync' },
)
onBeforeUnmount(() => { revisionRequestVersion += 1 })

const toggleRevision = (id: string) => {
  expandedRevisions.value = expandedRevisions.value.includes(id)
    ? expandedRevisions.value.filter(item => item !== id)
    : [...expandedRevisions.value, id]
}

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

/** 详情优先使用真实来源领取记录，缺失时不推断姓名。 */
const getOrderDisplayName = formatOrderRecipient
const hasItemProvenance = () => props.order.items.some((item) => Boolean(item.sourceOrderId))
const mergedPickupRecords = computed(() => {
  if (props.order.merge.role !== 'parent' || props.order.inventoryMode !== 'o2o_preapplied') return []
  const pickupByOrderId = new Map((props.order.sourcePreorderPickups ?? []).map((item) => [item.sourceOrderId, item]))
  return [props.order, ...props.order.merge.children].map((sourceOrder) => {
    const pickup = pickupByOrderId.get(sourceOrder.id)
    return {
      sourceOrderId: sourceOrder.id,
      businessNo: sourceOrder.businessNo || sourceOrder.showNo,
      sourcePreorderNo: pickup?.sourcePreorderNo || sourceOrder.sourceDocNo || null,
      pickupContact: pickup?.pickupContact || null,
      pickupAt: pickup?.pickupAt || null,
    }
  })
})

/**
 * 来源单据文案：
 * - 读取结构化来源快照，不解析备注或幂等键；
 * - 目前仅线上预订单核销生成的正式出库单有来源，其余返回 null 不展示。
 */
const formatSourceDoc = (order: { sourceDocType?: string | null; sourcePreorderNo?: string | null }) => {
  if (order.sourceDocType === 'o2o_preorder' && order.sourcePreorderNo) {
    return `线上预订单 ${order.sourcePreorderNo}`
  }
  return null
}
</script>

<template>
  <div class="mb-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/5">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p class="text-sm font-semibold text-slate-900 dark:text-slate-100">合规状态确认</p>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">仅部门单可编辑“是否有出库单”和“系统申请”。</p>
      </div>
      <el-button v-if="canEditStandaloneComplianceFlags && complianceRefreshRequired" size="small" :loading="complianceSaving" @click="emit('refresh-compliance')">
        {{ complianceRefreshRequired === 'saved' ? '刷新已保存状态' : '刷新并确认最新状态（保留输入）' }}
      </el-button>
      <el-button
        v-if="canEditStandaloneComplianceFlags"
        size="small"
        type="primary"
        :loading="complianceSaving"
        :disabled="Boolean(complianceRefreshRequired)"
        @click="emit('save-compliance')"
      >
        保存状态
      </el-button>
    </div>
    <p v-if="complianceFeedback" role="status" class="mt-2 text-sm text-amber-700 dark:text-amber-300">{{ complianceFeedback }}</p>
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <div class="rounded-xl bg-white px-3 py-3 dark:bg-[#141415]">
        <p class="text-xs text-slate-500 dark:text-slate-400">是否有出库单</p>
        <div class="mt-2">
          <el-switch
            v-if="canEditStandaloneComplianceFlags"
            :model-value="complianceForm.hasCustomerOrder"
            :disabled="complianceSaving || complianceRefreshRequired === 'partial' || complianceRefreshRequired === 'saved'"
            inline-prompt
            active-text="是"
            inactive-text="否"
            @update:model-value="emit('update:hasCustomerOrder', $event)"
          />
          <span v-else class="text-sm font-medium text-slate-700 dark:text-slate-200">
            {{ order.orderType === 'department' ? (order.hasCustomerOrder ? '是' : '否') : '不适用' }}
          </span>
        </div>
      </div>
      <div class="rounded-xl bg-white px-3 py-3 dark:bg-[#141415]">
        <p class="text-xs text-slate-500 dark:text-slate-400">金蝶状态</p>
        <div class="mt-2">
          <el-switch
            v-if="canEditSystemApplied"
            :model-value="complianceForm.isSystemApplied"
            :disabled="complianceSaving || complianceRefreshRequired === 'saved'"
            inline-prompt
            active-text="已申请"
            inactive-text="未申请"
            @update:model-value="emit('update:isSystemApplied', $event)"
          />
          <span v-else class="text-sm font-medium text-slate-700 dark:text-slate-200">
            {{ formatOrderKingdeeStatus(order) }}
          </span>
          <p v-if="canEditStandaloneComplianceFlags && !canEditSystemApplied" class="mt-1 text-xs text-slate-500 dark:text-slate-400">来源预订单未唯一确认，系统申请仅供查看。</p>
        </div>
      </div>
    </div>
  </div>

  <section v-if="isMultiSourceOrder" class="mb-5 rounded-2xl border border-slate-100 bg-slate-50/70 p-3 sm:p-4 dark:border-white/10 dark:bg-white/5">
    <h3 class="mb-3 flex items-center gap-2 text-base font-semibold text-slate-800 dark:text-slate-100"><span class="inline-block h-2 w-2 rounded-full bg-brand" />各来源金蝶登记</h3>
    <div class="space-y-3">
      <p v-if="!order.sourcePreorderRegistrations?.length" class="text-sm text-slate-500 dark:text-slate-400">来源登记未记录，仅供查看。</p>
      <div v-for="source in order.sourcePreorderRegistrations" :key="source.sourceOrderId" class="rounded-xl bg-white p-3 dark:bg-[#141415]">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p class="min-w-0 break-all text-sm font-semibold">来源出库业务号：{{ source.businessNo }}</p>
          <el-tag size="small" effect="light">{{ source.kingdeeStatus === null ? '不适用' : KINGDEE_STATUS_LABELS[source.kingdeeStatus ?? 'unknown'] }}</el-tag>
        </div>
        <p class="mt-2 break-all text-xs text-slate-500 dark:text-slate-400">线上预订单号：{{ source.sourcePreorderNo || '未记录' }}</p>
        <div class="mt-3 border-t border-slate-100 pt-3 dark:border-white/10">
          <p class="mb-2 text-xs text-slate-500 dark:text-slate-400">金蝶单据编号</p>
          <KingdeeRegistrationEditor v-if="source.sourcePreorderId" :key="source.sourcePreorderId" :order-id="source.sourcePreorderId" :registration="source" admin number-only :can-edit="canEditRegistration" @saved="emit('navigate', order.id)" />
          <template v-else><p class="break-all text-sm">{{ source.kingdeeVoucherNo || '无' }}</p><p class="mt-1 text-xs text-slate-500 dark:text-slate-400">来源预订单未记录，仅供查看</p></template>
        </div>
      </div>
    </div>
  </section>
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
      <el-descriptions-item v-if="canViewSystemNo()" label="出库系统编号（仅技术追溯）">{{ order.systemNo }}</el-descriptions-item>
      <el-descriptions-item label="库存模式">{{ formatInventoryMode(order) }}</el-descriptions-item>
      <el-descriptions-item label="订单类型">{{ formatOrderType(order.orderType) }}</el-descriptions-item>
      <el-descriptions-item label="开单时间">{{ dayjs(order.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</el-descriptions-item>
      <el-descriptions-item label="领用对象"><span class="recipient-text" :title="getOrderDisplayName(order)">{{ getOrderDisplayName(order) }}</span></el-descriptions-item>
      <el-descriptions-item label="客户部门">{{ order.orderType === 'department' ? order.customerDepartmentName || '-' : '不适用' }}</el-descriptions-item>
      <el-descriptions-item label="出库单状态">
        {{ order.orderType === 'department' ? (order.hasCustomerOrder ? '已带单' : '未带单') : '不适用' }}
      </el-descriptions-item>
      <el-descriptions-item label="金蝶状态">
        {{ formatOrderKingdeeStatus(order) }}
      </el-descriptions-item>
      <el-descriptions-item v-if="!isMultiSourceOrder" label="金蝶单据编号" :span="isPhone ? 1 : 2">
        <template v-if="order.orderType === 'walkin' || singleRegistration?.kingdeeStatus === null">不适用</template>
        <KingdeeRegistrationEditor v-else-if="singleRegistration?.sourcePreorderId" :key="singleRegistration.sourcePreorderId" :order-id="singleRegistration.sourcePreorderId" :registration="singleRegistration" admin number-only :can-edit="canEditRegistration" @saved="emit('navigate', order.id)" />
        <template v-else>
          <span class="break-all">{{ singleRegistration?.kingdeeVoucherNo || '无' }}</span>
          <p v-if="order.inventoryMode === 'o2o_preapplied' || order.sourceDocType === 'o2o_preorder'" class="mt-1 text-xs text-slate-500 dark:text-slate-400">来源预订单未记录，仅供查看</p>
        </template>
      </el-descriptions-item>
      <el-descriptions-item v-if="order.customerName" :label="order.merge.role === 'parent' ? '父单客户名称' : '客户名称'">{{ order.customerName }}</el-descriptions-item>
      <el-descriptions-item label="出单人">{{ order.issuerName || '-' }}</el-descriptions-item>
      <el-descriptions-item label="开单人">{{ order.creatorDisplayName || order.creatorUsername || '-' }}</el-descriptions-item>
      <el-descriptions-item label="总数量">{{ order.totalQty }}</el-descriptions-item>
      <el-descriptions-item v-if="formatSourceDoc(order)" :label="order.merge.role === 'parent' ? '父单来源单据' : '来源单据'" :span="isPhone ? 1 : 2">{{ formatSourceDoc(order) }}</el-descriptions-item>
      <el-descriptions-item v-if="order.merge.role !== 'parent' && order.sourceDocType === 'o2o_preorder'" label="来源预订单领取人">
        {{ order.sourcePreorderPickupContact || '未记录' }}
      </el-descriptions-item>
      <el-descriptions-item v-if="order.merge.role !== 'parent' && order.sourceDocType === 'o2o_preorder'" label="来源预订单取货时间">
        {{ order.sourcePreorderPickupAt ? dayjs(order.sourcePreorderPickupAt).format('YYYY-MM-DD HH:mm') : '未记录' }}
      </el-descriptions-item>
      <el-descriptions-item label="单据备注" :span="isPhone ? 1 : 2">{{ order.remark || '-' }}</el-descriptions-item>
    </el-descriptions>
  </section>

  <section v-if="order.merge.role !== 'standalone'" class="mb-5 rounded-2xl border border-teal-100 bg-teal-50/60 p-3 sm:p-4 dark:border-teal-500/20 dark:bg-teal-500/10">
    <h3 class="text-base font-semibold text-teal-900 dark:text-teal-200">合并关系</h3>
    <p v-if="order.merge.role === 'source'" class="mt-2 text-sm text-teal-800 dark:text-teal-200">
      当前为来源单，已合并至
      <el-button v-if="order.merge.parent" link type="primary" @click="emit('navigate', order.merge.parent.id)">
        {{ order.merge.parent.businessNo }}
      </el-button>
      <span v-else>父单</span>，仅支持查看。
    </p>
    <div v-else class="mt-2">
      <p class="text-sm text-teal-800 dark:text-teal-200">当前为父单，包含 {{ order.merge.children.length }} 张来源单。</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <el-button v-for="child in order.merge.children" :key="child.id" link type="primary" @click="emit('navigate', child.id)">
          {{ child.businessNo }}<span v-if="formatSourceDoc(child)">（{{ formatSourceDoc(child) }}）</span>
        </el-button>
      </div>
      <div v-if="mergedPickupRecords.length" class="mt-3 space-y-2">
        <div class="text-sm font-medium text-teal-900 dark:text-teal-200">各来源领取记录</div>
        <div v-for="(pickup, index) in mergedPickupRecords" :key="pickup.sourceOrderId" class="rounded-lg border border-teal-100 bg-white/80 px-3 py-2 text-sm text-teal-950 dark:border-teal-500/20 dark:bg-white/5 dark:text-teal-200">
          <div class="font-medium">{{ index === 0 ? '父单' : '来源单' }} {{ pickup.businessNo }}</div>
          <div>线上预订单：{{ pickup.sourcePreorderNo || '未记录' }}</div>
          <div>领取人：{{ pickup.pickupContact || '未记录' }}</div>
          <div>到店取货时间：{{ pickup.pickupAt ? dayjs(pickup.pickupAt).format('YYYY-MM-DD HH:mm') : '未记录' }}</div>
        </div>
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
          <span v-if="row.sourceOrderId" class="text-xs text-slate-500 dark:text-slate-400">合并来源明细</span>
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
        <div v-if="item.sourceOrderId" class="mt-2 text-xs text-slate-500 dark:text-slate-400">来源：已合并来源单明细</div>
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
      <p v-if="revisionsLoading" class="py-4 text-center text-sm text-slate-500">正在加载修订记录…</p>
      <div v-else-if="revisionsError" role="alert" class="rounded-xl bg-white p-3 text-sm text-slate-700 dark:bg-white/5 dark:text-slate-200">
        <p>修订记录加载失败，请重试。</p>
        <el-button class="mt-2" size="small" @click="loadRevisions">重试</el-button>
      </div>
      <p v-else-if="revisions.length === 0" class="py-4 text-center text-sm text-slate-400">暂无内容修订记录</p>
      <div v-else class="space-y-3 border-l-2 border-slate-200 pl-4 dark:border-white/10">
        <article
          v-for="(revision, index) in visibleRevisions"
          :key="revision.id"
          class="relative rounded-xl bg-white px-3 py-2 text-sm dark:bg-white/5"
        >
          <span class="absolute -left-[1.3rem] top-3 h-2 w-2 rounded-full bg-brand" />
          <div class="flex flex-wrap items-center gap-2">
            <el-tag size="small">版本 V{{ revision.revisionNo }}</el-tag>
            <span v-if="index === 0" class="text-xs font-medium text-brand">最近修订</span>
          </div>
          <p class="mt-2 break-all text-xs text-slate-500 dark:text-slate-400">{{ revisionTime(revision.createdAt) }} · 操作者：{{ revisionActor(revision.actorDisplayName, revision.actorUsername) }}</p>
          <p class="mt-2 break-all text-slate-800 dark:text-slate-100">修订原因：{{ revision.reason?.trim() || '未填写原因' }}</p>
          <el-button link type="primary" class="mt-2" :aria-expanded="expandedRevisions.includes(revision.id)" @click="toggleRevision(revision.id)">{{ expandedRevisions.includes(revision.id) ? '收起变更' : '查看变更' }}</el-button>
          <ul v-if="expandedRevisions.includes(revision.id)" class="mt-2 space-y-1 rounded-lg bg-slate-50 p-3 text-slate-700 dark:bg-white/5 dark:text-slate-200">
            <li v-for="line in revisionSummary(revision.before, revision.after)" :key="line" class="break-all">{{ line }}</li>
          </ul>
        </article>
        <el-button v-if="revisions.length > 3" link type="primary" @click="showAllRevisions = !showAllRevisions">{{ showAllRevisions ? '收起' : '展开全部' }}</el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.recipient-text { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
