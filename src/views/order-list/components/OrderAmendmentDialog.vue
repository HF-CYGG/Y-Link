<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/components/OrderAmendmentDialog.vue`
 * 文件职责：承载历史出库单单笔/批量分类修订与独立业务号重编的预览、阻断展示和原子提交。
 * 实现逻辑：
 * 1. 每张订单携带当前 editVersion，预览只展示服务端重算结果，不写入任何持久状态；
 * 2. 表单变化会立即作废上次预览，正式提交仍由服务端在事务内重新校验全部冲突；
 * 3. 类型切换时只展示目标类型领用字段，并按目标命名空间游标自动顺延编排业务号（避让同批草稿号，用户仍可手改），
 *    切回原类型时恢复原业务号；建议号不占号，过期响应按请求序号丢弃；
 *    客户部门与开单页一致，为可搜索、可选择、可手动录入的组合输入，选项来自系统部门配置的完整路径，
 *    加载失败或配置为空只做提示，不阻断手动填写，修订只保存部门快照文本、不回写系统配置；
 * 4. 业务号只和物理存在订单校验唯一性；永久删除后释放的号码可通过普通修订再次填写，自动建议不会主动回填低号；
 * 5. 批量提交共享一次确认动作，服务端任一阻断都会整体回滚，不在前端模拟部分成功。
 * 维护说明：该组件只允许修改订单治理字段，不得在此增加商品明细、库存扣减或库存流水能力。
 */

import { computed, ref, watch } from 'vue'
import {
  commitOrderAmendments,
  getOrderAmendmentBusinessNoSuggestions,
  getOrderDepartmentOptions,
  previewOrderAmendments,
  type OrderAmendmentInput,
  type OrderDepartmentOption,
  type OrderAmendmentResult,
  type OrderRecord,
} from '@/api/modules/order'
import { BizCrudDialogShell } from '@/components/common'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { showCriticalErrorDialog } from '@/utils/error-dialog'

interface Props {
  modelValue: boolean
  orders: OrderRecord[]
}

interface AmendmentDraft {
  orderId: string
  editVersion: number
  systemNo: string
  businessNo: string
  orderType: 'department' | 'walkin'
  customerDepartmentName: string
  customerName: string
  issuerName: string
  hasCustomerOrder: boolean
  isSystemApplied: boolean
  remark: string
  originalOrderType: 'department' | 'walkin'
  originalBusinessNo: string
  /** 最近一次自动编排写入的业务号；用户手改后不再展示自动编排提示。 */
  autoBusinessNo: string
  autoBusinessNoHint: string
  suggesting: boolean
  suggestionSeq: number
}

const props = defineProps<Props>()
const authStore = useAuthStore(pinia)
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
const departmentOptions = ref<OrderDepartmentOption[]>([])
const departmentOptionsLoading = ref(false)
const departmentOptionsLoadFailed = ref(false)
const isAdmin = computed(() => authStore.currentUser?.role === 'admin')

/** 按完整路径去重：路径即订单保存的部门快照，也是展示与搜索文本。 */
const departmentPathOptions = computed(() => {
  const seen = new Set<string>()
  return departmentOptions.value.filter((option) => {
    if (seen.has(option.path)) return false
    seen.add(option.path)
    return true
  })
})

/** 部门输入下方提示：加载失败 > 配置为空 > 未匹配配置，均不阻断手动填写。 */
const resolveDepartmentHint = (draft: AmendmentDraft) => {
  if (departmentOptionsLoading.value) return ''
  if (departmentOptionsLoadFailed.value) return '部门选项加载失败，可直接手动填写'
  if (!departmentOptions.value.length) return '系统暂无部门配置，可直接手动填写'
  const departmentName = draft.customerDepartmentName.trim()
  if (departmentName && !departmentPathOptions.value.some((option) => option.path === departmentName)) {
    return '未匹配系统部门，将按手动填写保存，不会写入系统配置'
  }
  return ''
}

/** 每次打开弹窗刷新部门选项；失败只记录状态，保证手动录入仍可修订。 */
const loadDepartmentOptions = async () => {
  departmentOptionsLoading.value = true
  try {
    departmentOptions.value = await getOrderDepartmentOptions()
    departmentOptionsLoadFailed.value = false
  } catch {
    departmentOptions.value = []
    departmentOptionsLoadFailed.value = true
  } finally {
    departmentOptionsLoading.value = false
  }
}

const suggestingBusinessNo = computed(() => drafts.value.some((draft) => draft.suggesting))
const canCommit = computed(() => Boolean(previewResult.value?.ready) && !previewing.value && !suggestingBusinessNo.value)

const initializeDrafts = () => {
  drafts.value = props.orders.map((order) => ({
    orderId: order.id,
    editVersion: order.editVersion,
    systemNo: order.systemNo,
    businessNo: order.businessNo,
    orderType: order.orderType,
    customerDepartmentName: order.customerDepartmentName || '',
    customerName: order.customerName || '',
    issuerName: order.issuerName || '',
    hasCustomerOrder: Boolean(order.hasCustomerOrder),
    isSystemApplied: Boolean(order.isSystemApplied),
    remark: order.remark || '',
    originalOrderType: order.orderType,
    originalBusinessNo: order.businessNo,
    autoBusinessNo: '',
    autoBusinessNoHint: '',
    suggesting: false,
    suggestionSeq: 0,
  }))
  reason.value = ''
  previewResult.value = null
}

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return
    initializeDrafts()
    void loadDepartmentOptions()
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

/**
 * 切换订单类型后自动编排业务号：
 * - 切回原类型直接恢复原业务号，不请求服务端；
 * - 切到新类型时按目标命名空间游标顺延，并避让同批其他草稿已填写的号；
 * - 快速来回切换时只采纳最后一次请求的结果，失败则保留当前值并提示手动填写。
 */
const handleOrderTypeChange = async (draft: AmendmentDraft) => {
  const seq = ++draft.suggestionSeq
  if (draft.orderType === draft.originalOrderType) {
    draft.businessNo = draft.originalBusinessNo
    draft.autoBusinessNo = ''
    draft.autoBusinessNoHint = ''
    draft.suggesting = false
    return
  }
  const targetType = draft.orderType
  const exclude = drafts.value
    .filter((item) => item.orderId !== draft.orderId)
    .map((item) => item.businessNo.trim().toLowerCase())
    .filter(Boolean)
  draft.suggesting = true
  try {
    const suggestion = await getOrderAmendmentBusinessNoSuggestions({ orderType: targetType, count: 1, exclude })
    if (seq !== draft.suggestionSeq) return
    const nextBusinessNo = suggestion.businessNos[0]
    if (!nextBusinessNo) {
      draft.autoBusinessNo = ''
      draft.autoBusinessNoHint = ''
      showAppWarning(`${suggestion.namespace} 命名空间已无可用业务号，请手动填写`)
      return
    }
    draft.businessNo = nextBusinessNo
    draft.autoBusinessNo = nextBusinessNo
    const skippedText = suggestion.skippedBusinessNos.length
      ? `，已跳过被占用的 ${suggestion.skippedBusinessNos.length} 个号`
      : ''
    draft.autoBusinessNoHint = `已按 ${suggestion.namespace} 当前游标 ${suggestion.cursor} 顺延自动编排${skippedText}，可手动修改`
  } catch (error) {
    if (seq !== draft.suggestionSeq) return
    draft.autoBusinessNo = ''
    draft.autoBusinessNoHint = ''
    void showCriticalErrorDialog(error, {
      title: '业务单号自动编排失败',
      fallback: '无法获取目标类型的下一个业务单号，请手动填写',
      operation: '自动编排业务单号',
    })
  } finally {
    if (seq === draft.suggestionSeq) draft.suggesting = false
  }
}

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
  if (props.orders.some((order) => order.isDeleted)) {
    showAppWarning('已删除订单不可修订，请关闭窗口后重新选择')
    return false
  }
  if (!reason.value.trim()) {
    showAppWarning('请填写修订原因')
    return false
  }
  for (const draft of drafts.value) {
    if (!draft.businessNo.trim()) {
      showAppWarning('订单业务单号不能为空')
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
    if (error === 'cancel' || error === 'close') return
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
        title="业务单号是对外展示编号；出库系统编号仅供技术追溯且不可修改。部门单使用 hyyzjd，散客单使用 hyyz。切换订单类型会自动编排目标类型的下一个业务单号，可手动修改；预览不会占号，提交时会重新校验。"
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
          <strong class="text-sm text-slate-800">
            第 {{ index + 1 }} 张 · 业务单号 {{ draft.businessNo }}
            <span v-if="isAdmin">· 出库系统编号（不可修改，仅用于系统追溯）{{ draft.systemNo }}</span>
          </strong>
          <el-tag effect="plain">版本 {{ draft.editVersion }}</el-tag>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <el-form-item label="业务单号" class="!mb-0">
            <div class="w-full">
              <el-input
                v-model="draft.businessNo"
                :disabled="draft.suggesting"
                :placeholder="draft.suggesting ? '正在自动编排…' : (draft.orderType === 'department' ? 'hyyzjd000001' : 'hyyz000001')"
              />
              <p
                v-if="draft.autoBusinessNoHint && draft.businessNo === draft.autoBusinessNo"
                class="mt-1 text-xs leading-5 text-emerald-700"
              >
                {{ draft.autoBusinessNoHint }}
              </p>
            </div>
          </el-form-item>
          <el-form-item label="订单类型" class="!mb-0">
            <el-radio-group v-model="draft.orderType" @change="handleOrderTypeChange(draft)">
              <el-radio-button value="department">部门单</el-radio-button>
              <el-radio-button value="walkin">散客单</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="draft.orderType === 'department'" label="客户部门" class="!mb-0">
            <div class="w-full">
              <el-select
                v-model="draft.customerDepartmentName"
                class="w-full"
                filterable
                allow-create
                default-first-option
                clearable
                :loading="departmentOptionsLoading"
                placeholder="搜索选择或直接输入客户部门"
                no-data-text="暂无部门配置，可直接输入"
              >
                <el-option
                  v-for="option in departmentPathOptions"
                  :key="option.path"
                  :label="option.path"
                  :value="option.path"
                />
              </el-select>
              <p v-if="resolveDepartmentHint(draft)" class="mt-1 text-xs leading-5 text-slate-500">
                {{ resolveDepartmentHint(draft) }}
              </p>
            </div>
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
          <el-table-column v-if="isAdmin" label="出库系统编号" min-width="150">
            <template #default="{ row }">{{ row.before.systemNo }}</template>
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
        <el-button type="primary" plain :loading="previewing" :disabled="committing || suggestingBusinessNo" @click="handlePreview">重新预览</el-button>
        <el-button type="primary" :loading="committing" :disabled="!canCommit" @click="handleCommit">
          原子提交
        </el-button>
      </div>
    </template>
  </BizCrudDialogShell>
</template>
