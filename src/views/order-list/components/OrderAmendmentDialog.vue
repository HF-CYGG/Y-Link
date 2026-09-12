<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/components/OrderAmendmentDialog.vue`
 * 文件职责：承载历史出库单单笔/批量分类修订与独立业务号重编的预览、阻断展示和原子提交。
 * 实现逻辑：
 * 1. 每张订单携带当前 editVersion，预览只展示服务端重算结果，不写入任何持久状态；
 * 2. 表单变化会立即作废上次预览，正式提交仍由服务端在事务内重新校验全部冲突；
 * 3. 类型切换时只展示目标类型领用字段，并显式提示业务号命名空间，避免跨类型残留；
 * 4. 批量提交共享一次确认动作，服务端任一阻断都会整体回滚，不在前端模拟部分成功。
 * 维护说明：该组件只允许修改订单治理字段，不得在此增加商品明细、库存扣减或库存流水能力。
 */

import { computed, ref, watch } from 'vue'
import {
  commitOrderAmendments,
  previewOrderAmendments,
  type OrderAmendmentInput,
  type OrderAmendmentResult,
  type OrderRecord,
} from '@/api/modules/order'
import { BizCrudDialogShell } from '@/components/common'
import { showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { showCriticalErrorDialog } from '@/utils/error-dialog'

interface Props {
  modelValue: boolean
  orders: OrderRecord[]
}

interface AmendmentDraft {
  orderId: string
  editVersion: number
  showNo: string
  businessNo: string
  orderType: 'department' | 'walkin'
  customerDepartmentName: string
  customerName: string
  issuerName: string
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  remark: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  committed: [result: OrderAmendmentResult]
}>()

const drafts = ref<AmendmentDraft[]>([])
const reason = ref('')
const previewing = ref(false)
const committing = ref(false)
const previewResult = ref<OrderAmendmentResult | null>(null)
const dialogTitle = computed(() => drafts.value.length > 1 ? `批量修订单据（${drafts.value.length} 张）` : '修订单据')
const canCommit = computed(() => Boolean(previewResult.value?.ready) && !previewing.value)

const initializeDrafts = () => {
  drafts.value = props.orders.map((order) => ({
    orderId: order.id,
    editVersion: order.editVersion,
    showNo: order.showNo,
    businessNo: order.businessNo,
    orderType: order.orderType,
    customerDepartmentName: order.customerDepartmentName || '',
    customerName: order.customerName || '',
    issuerName: order.issuerName || '',
    hasCustomerOrder: Boolean(order.hasCustomerOrder),
    isSystemApplied: Boolean(order.isSystemApplied),
    remark: order.remark || '',
  }))
  reason.value = ''
  previewResult.value = null
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) initializeDrafts()
  },
)

watch(
  drafts,
  () => {
    previewResult.value = null
  },
  { deep: true },
)

watch(reason, () => {
  previewResult.value = null
})

const normalizeOptionalText = (value: string): string | null => value.trim() || null

const buildInputs = (): OrderAmendmentInput[] => drafts.value.map((draft) => ({
  orderId: draft.orderId,
  editVersion: draft.editVersion,
  businessNo: draft.businessNo.trim().toLowerCase(),
  orderType: draft.orderType,
  customerDepartmentName: draft.orderType === 'department'
    ? normalizeOptionalText(draft.customerDepartmentName)
    : null,
  customerName: draft.orderType === 'walkin' ? normalizeOptionalText(draft.customerName) : null,
  issuerName: normalizeOptionalText(draft.issuerName),
  hasCustomerOrder: draft.orderType === 'department' ? draft.hasCustomerOrder : false,
  isSystemApplied: draft.orderType === 'department' ? draft.isSystemApplied : false,
  remark: normalizeOptionalText(draft.remark),
  reason: reason.value.trim(),
}))

const validateDrafts = (): boolean => {
  if (!drafts.value.length) {
    showAppWarning('请选择至少一张待修订订单')
    return false
  }
  if (!reason.value.trim()) {
    showAppWarning('请填写修订原因')
    return false
  }
  for (const draft of drafts.value) {
    if (!draft.businessNo.trim()) {
      showAppWarning(`系统键 ${draft.showNo} 的业务单号不能为空`)
      return false
    }
    if (draft.orderType === 'department' && !draft.customerDepartmentName.trim()) {
      showAppWarning(`业务单号 ${draft.businessNo} 缺少客户部门`)
      return false
    }
    if (draft.orderType === 'walkin' && !draft.customerName.trim()) {
      showAppWarning(`业务单号 ${draft.businessNo} 缺少散客名称`)
      return false
    }
  }
  return true
}

const handlePreview = async () => {
  if (!validateDrafts()) return
  previewing.value = true
  try {
    previewResult.value = await previewOrderAmendments(buildInputs())
    if (previewResult.value.ready) {
      showAppSuccess('预览校验通过，可提交修订')
    } else {
      showAppWarning('预览发现阻断项，请按提示修改后重新预览')
    }
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '订单修订预览失败',
      fallback: '预览失败，请核对业务号、订单类型和当前版本',
      operation: '预览订单修订',
    })
  } finally {
    previewing.value = false
  }
}

const handleCommit = async () => {
  if (!canCommit.value || !validateDrafts()) return
  committing.value = true
  try {
    const result = await commitOrderAmendments(buildInputs())
    showAppSuccess(drafts.value.length > 1 ? '批量修订已原子提交' : '订单修订已提交')
    emit('committed', result)
    emit('update:modelValue', false)
  } catch (error) {
    previewResult.value = null
    void showCriticalErrorDialog(error, {
      title: '订单修订提交失败',
      fallback: '提交时数据已变化或业务号冲突，请重新预览',
      operation: '提交订单修订',
    })
  } finally {
    committing.value = false
  }
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="props.modelValue"
    :title="dialogTitle"
    height-mode="scroll"
    phone-width="96%"
    tablet-width="820px"
    desktop-width="960px"
    dialog-class="order-amendment-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="space-y-4">
      <el-alert
        title="showNo 是永久不可修改的系统键；部门单使用 hyyzjd，散客单使用 hyyz。预览不会占号，提交时会重新校验。"
        type="warning"
        :closable="false"
        show-icon
      />

      <section
        v-for="(draft, index) in drafts"
        :key="draft.orderId"
        class="rounded-2xl border border-slate-200 bg-slate-50 p-4"
      >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <strong class="text-sm text-slate-800">第 {{ index + 1 }} 张 · 系统键 {{ draft.showNo }}</strong>
          <el-tag effect="plain">版本 {{ draft.editVersion }}</el-tag>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <el-form-item label="业务单号" class="!mb-0">
            <el-input v-model="draft.businessNo" :placeholder="draft.orderType === 'department' ? 'hyyzjd000001' : 'hyyz000001'" />
          </el-form-item>
          <el-form-item label="订单类型" class="!mb-0">
            <el-radio-group v-model="draft.orderType">
              <el-radio-button value="department">部门单</el-radio-button>
              <el-radio-button value="walkin">散客单</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="draft.orderType === 'department'" label="客户部门" class="!mb-0">
            <el-input v-model="draft.customerDepartmentName" placeholder="请输入完整部门路径" />
          </el-form-item>
          <el-form-item v-else label="散客名称" class="!mb-0">
            <el-input v-model="draft.customerName" placeholder="请输入散客名称" />
          </el-form-item>
          <el-form-item label="出单人" class="!mb-0">
            <el-input v-model="draft.issuerName" clearable placeholder="可留空" />
          </el-form-item>
          <div v-if="draft.orderType === 'department'" class="flex flex-wrap items-center gap-5 md:col-span-2">
            <el-checkbox v-model="draft.hasCustomerOrder">已有客户出库单</el-checkbox>
            <el-checkbox v-model="draft.isSystemApplied">已完成系统申请</el-checkbox>
          </div>
          <el-form-item label="备注" class="!mb-0 md:col-span-2">
            <el-input v-model="draft.remark" type="textarea" :rows="2" maxlength="500" show-word-limit />
          </el-form-item>
        </div>
      </section>

      <el-form-item label="修订原因" required class="!mb-0">
        <el-input v-model="reason" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="请说明分类修订或重编业务号的原因" />
      </el-form-item>

      <section v-if="previewResult" class="rounded-2xl border border-slate-200 p-3">
        <el-alert
          :title="previewResult.ready ? '全部订单可提交' : '存在阻断项，不能提交'"
          :type="previewResult.ready ? 'success' : 'error'"
          :closable="false"
          show-icon
          class="mb-3"
        />
        <div v-if="previewResult.cursorPlans.length" class="mb-3 flex flex-wrap gap-2 text-xs text-slate-600">
          <el-tag v-for="plan in previewResult.cursorPlans" :key="plan.namespace" effect="plain">
            {{ plan.namespace }} 游标 {{ plan.beforeCursor }} → {{ plan.afterCursor }}；下一号 {{ plan.nextBusinessNo || '已达位宽上限' }}
          </el-tag>
        </div>
        <el-table :data="previewResult.items" border size="small" table-layout="auto">
          <el-table-column label="系统键" min-width="150">
            <template #default="{ row }">{{ row.before.showNo }}</template>
          </el-table-column>
          <el-table-column label="业务号变化" min-width="240">
            <template #default="{ row }">{{ row.before.businessNo }} → {{ row.after.businessNo }}</template>
          </el-table-column>
          <el-table-column label="类型变化" min-width="150">
            <template #default="{ row }">{{ row.before.orderType }} → {{ row.after.orderType }}</template>
          </el-table-column>
          <el-table-column label="校验结果" min-width="260">
            <template #default="{ row }">
              <span v-if="!row.blockingReasons.length" class="text-emerald-600">通过</span>
              <span v-else class="text-red-600">{{ row.blockingReasons.join('；') }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <template #footer="{ close }">
      <div class="flex flex-wrap justify-end gap-2">
        <el-button @click="close">取消</el-button>
        <el-button type="primary" plain :loading="previewing" :disabled="committing" @click="handlePreview">重新预览</el-button>
        <el-button type="primary" :loading="committing" :disabled="!canCommit" @click="handleCommit">原子提交</el-button>
      </div>
    </template>
  </BizCrudDialogShell>
</template>
