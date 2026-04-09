<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { PageContainer, PageToolbarCard } from '@/components/common'
import {
  getO2oRuleConfigs,
  getOrderSerialConfigs,
  updateO2oRuleConfigs,
  updateOrderSerialConfigs,
  type O2oRuleConfigRecord,
  type OrderSerialConfigRecord,
} from '@/api/modules/system-config'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

type SerialFormValue = {
  start: number
  current: number
  width: number
}

const authStore = useAuthStore()
const formRef = ref<FormInstance>()
const loading = ref(true)
const saving = ref(false)
const configMap = ref<Record<'department' | 'walkin', OrderSerialConfigRecord> | null>(null)
const o2oRuleConfig = ref<O2oRuleConfigRecord | null>(null)
const loadRequest = useStableRequest()

const serialForm = reactive<{
  department: SerialFormValue
  walkin: SerialFormValue
  o2o: {
    autoCancelEnabled: boolean
    autoCancelHours: number
    limitEnabled: boolean
    limitQty: number
  }
}>({
  department: {
    start: 1,
    current: 0,
    width: 6,
  },
  walkin: {
    start: 1,
    current: 0,
    width: 6,
  },
  o2o: {
    autoCancelEnabled: true,
    autoCancelHours: 24,
    limitEnabled: true,
    limitQty: 5,
  },
})

const initialSnapshot = ref('')
const canViewConfigs = computed(() => authStore.hasPermission('system_configs:view'))
const canUpdateConfigs = computed(() => authStore.isAdmin && authStore.hasPermission('system_configs:update'))

const formatSerialPreview = (prefix: string | undefined, current: number, width: number) => {
  const safePrefix = String(prefix ?? '').trim() || '-'
  const safeCurrent = Math.max(0, Number(current) || 0)
  const safeWidth = Math.max(1, Number(width) || 1)
  const nextSerial = String(safeCurrent + 1).padStart(safeWidth, '0')
  return `${safePrefix}${nextSerial}`
}

const departmentPreview = computed(() =>
  formatSerialPreview(configMap.value?.department.prefix, serialForm.department.current, serialForm.department.width),
)

const walkinPreview = computed(() =>
  formatSerialPreview(configMap.value?.walkin.prefix, serialForm.walkin.current, serialForm.walkin.width),
)

const snapshotForm = () =>
  JSON.stringify({
    department: {
      start: Number(serialForm.department.start),
      current: Number(serialForm.department.current),
      width: Number(serialForm.department.width),
    },
    walkin: {
      start: Number(serialForm.walkin.start),
      current: Number(serialForm.walkin.current),
      width: Number(serialForm.walkin.width),
    },
    o2o: {
      autoCancelEnabled: Boolean(serialForm.o2o.autoCancelEnabled),
      autoCancelHours: Number(serialForm.o2o.autoCancelHours),
      limitEnabled: Boolean(serialForm.o2o.limitEnabled),
      limitQty: Number(serialForm.o2o.limitQty),
    },
  })

const isDirty = computed(() => snapshotForm() !== initialSnapshot.value)

const rules: FormRules = {
  'department.start': [{ required: true, message: '请输入部门单起始号', trigger: 'blur' }],
  'department.width': [{ required: true, message: '请输入部门单位宽', trigger: 'blur' }],
  'walkin.start': [{ required: true, message: '请输入散客单起始号', trigger: 'blur' }],
  'walkin.width': [{ required: true, message: '请输入散客单位宽', trigger: 'blur' }],
  'o2o.autoCancelHours': [{ required: true, message: '请输入超时取消时长', trigger: 'blur' }],
  'o2o.limitQty': [{ required: true, message: '请输入限购数量', trigger: 'blur' }],
}

const applyList = (list: OrderSerialConfigRecord[]) => {
  const department = list.find((item) => item.orderType === 'department')
  const walkin = list.find((item) => item.orderType === 'walkin')

  if (!department || !walkin) {
    return
  }

  configMap.value = { department, walkin }
  serialForm.department.start = department.start
  serialForm.department.current = department.current
  serialForm.department.width = department.width
  serialForm.walkin.start = walkin.start
  serialForm.walkin.current = walkin.current
  serialForm.walkin.width = walkin.width
}

const applyO2oRules = (config: O2oRuleConfigRecord) => {
  o2oRuleConfig.value = config
  serialForm.o2o.autoCancelEnabled = config.autoCancelEnabled
  serialForm.o2o.autoCancelHours = config.autoCancelHours
  serialForm.o2o.limitEnabled = config.limitEnabled
  serialForm.o2o.limitQty = config.limitQty
}

const loadData = async () => {
  if (!canViewConfigs.value) {
    loading.value = false
    return
  }

  loading.value = true
  await loadRequest.runLatest({
    executor: async () => Promise.all([getOrderSerialConfigs(), getO2oRuleConfigs()]),
    onSuccess: (result) => {
      applyList(result[0].list)
      applyO2oRules(result[1])
      initialSnapshot.value = snapshotForm()
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error, '加载系统配置失败，请稍后重试'))
    },
    onFinally: () => {
      loading.value = false
    },
  })
}

const handleSubmit = async () => {
  if (!canUpdateConfigs.value) {
    ElMessage.warning('当前账号仅支持只读查看')
    return
  }

  const form = formRef.value
  if (!form) {
    return
  }

  const valid = await form.validate().catch(() => false)
  if (!valid) {
    return
  }

  saving.value = true
  try {
    const result = await updateOrderSerialConfigs({
      department: {
        start: Number(serialForm.department.start),
        current: Number(configMap.value?.department.current ?? serialForm.department.current),
        width: Number(serialForm.department.width),
      },
      walkin: {
        start: Number(serialForm.walkin.start),
        current: Number(configMap.value?.walkin.current ?? serialForm.walkin.current),
        width: Number(serialForm.walkin.width),
      },
    })
    const o2oResult = await updateO2oRuleConfigs({
      autoCancelEnabled: serialForm.o2o.autoCancelEnabled,
      autoCancelHours: Number(serialForm.o2o.autoCancelHours),
      limitEnabled: serialForm.o2o.limitEnabled,
      limitQty: Number(serialForm.o2o.limitQty),
    })

    applyList(result.list)
    applyO2oRules(o2oResult.config)
    initialSnapshot.value = snapshotForm()
    ElMessage.success(result.changed || o2oResult.changed ? '系统配置已保存' : '配置未变更')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '保存系统配置失败，请稍后重试'))
  } finally {
    saving.value = false
  }
}

const getUpdatedAtLabel = (orderType: 'department' | 'walkin') => {
  const value = configMap.value?.[orderType]?.updatedAt
  if (!value) {
    return '-'
  }
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

const o2oUpdatedAtLabel = computed(() => {
  const value = o2oRuleConfig.value?.updatedAt
  if (!value) {
    return '-'
  }
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
})

onMounted(() => {
  void loadData()
})
</script>

<template>
  <PageContainer title="系统配置" description="维护部门/散客双流水参数，所有变更会记录审计日志。">
    <div class="space-y-6">
      <PageToolbarCard class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="text-sm text-slate-600 dark:text-slate-300">
            {{ canUpdateConfigs ? '当前账号（管理员）可编辑参数并提交保存' : '当前账号仅支持只读查看（仅管理员可修改）' }}
          </div>
          <el-button v-if="canUpdateConfigs" type="primary" :loading="saving" :disabled="loading || !isDirty" @click="handleSubmit">
            保存配置
          </el-button>
        </div>
        <el-alert
          title="简要说明"
          type="info"
          :closable="false"
          show-icon
          description="这里用于维护订单编号规则：系统会按“前缀 + 流水号”自动生成下一张单据编号。建议仅在管理员确认后修改，以免影响对账连续性。"
        />
      </PageToolbarCard>

      <el-alert
        v-if="!canViewConfigs"
        title="当前账号暂无系统配置查看权限"
        type="warning"
        :closable="false"
        show-icon
      />

      <el-form v-else ref="formRef" :model="serialForm" :rules="rules" label-position="top" class="grid gap-6 lg:grid-cols-2">
      <div class="apple-card flex flex-col p-5 sm:p-6 xl:p-7">
        <div class="mb-5 flex items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-white/5">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">部门订单流水</h2>
          <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            前缀：{{ configMap?.department.prefix || 'hyyzjd' }}
          </span>
        </div>
        <div class="grid flex-1 gap-5">
          <div class="rounded-xl border border-teal-200/60 bg-teal-50/50 p-4 text-teal-800 dark:border-teal-900/40 dark:bg-teal-900/10 dark:text-teal-300">
            <div class="text-xs font-medium opacity-80">订单编号示例（下一单）</div>
            <div class="mt-1.5 text-lg font-bold tracking-wide">{{ departmentPreview }}</div>
          </div>
          <div class="space-y-4">
            <el-form-item prop="department.start" class="!mb-0">
              <template #label>
                <span class="field-label">起始号 <span class="field-label__help">首次生效编号起点</span></span>
              </template>
              <el-input-number v-model="serialForm.department.start" :min="1" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
            </el-form-item>
            <el-form-item prop="department.current" class="!mb-0">
              <template #label>
                <span class="field-label">当前号 <span class="field-label__help">系统自动维护，仅展示不可编辑</span></span>
              </template>
              <el-input :model-value="String(serialForm.department.current)" disabled class="!w-full" />
            </el-form-item>
            <el-form-item prop="department.width" class="!mb-0">
              <template #label>
                <span class="field-label">位宽 <span class="field-label__help">流水号补零位数（1-12）</span></span>
              </template>
              <el-input-number v-model="serialForm.department.width" :min="1" :max="12" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
            </el-form-item>
          </div>
        </div>
        <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
          最近更新时间：{{ getUpdatedAtLabel('department') }}
        </div>
      </div>

      <div class="apple-card flex flex-col p-5 sm:p-6 xl:p-7">
        <div class="mb-5 flex items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-white/5">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">散客订单流水</h2>
          <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            前缀：{{ configMap?.walkin.prefix || 'hyyz' }}
          </span>
        </div>
        <div class="grid flex-1 gap-5">
          <div class="rounded-xl border border-sky-200/60 bg-sky-50/50 p-4 text-sky-800 dark:border-sky-900/40 dark:bg-sky-900/10 dark:text-sky-300">
            <div class="text-xs font-medium opacity-80">订单编号示例（下一单）</div>
            <div class="mt-1.5 text-lg font-bold tracking-wide">{{ walkinPreview }}</div>
          </div>
          <div class="space-y-4">
            <el-form-item prop="walkin.start" class="!mb-0">
              <template #label>
                <span class="field-label">起始号 <span class="field-label__help">首次生效编号起点</span></span>
              </template>
              <el-input-number v-model="serialForm.walkin.start" :min="1" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
            </el-form-item>
            <el-form-item prop="walkin.current" class="!mb-0">
              <template #label>
                <span class="field-label">当前号 <span class="field-label__help">系统自动维护，仅展示不可编辑</span></span>
              </template>
              <el-input :model-value="String(serialForm.walkin.current)" disabled class="!w-full" />
            </el-form-item>
            <el-form-item prop="walkin.width" class="!mb-0">
              <template #label>
                <span class="field-label">位宽 <span class="field-label__help">流水号补零位数（1-12）</span></span>
              </template>
              <el-input-number v-model="serialForm.walkin.width" :min="1" :max="12" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
            </el-form-item>
          </div>
        </div>
        <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
          最近更新时间：{{ getUpdatedAtLabel('walkin') }}
        </div>
      </div>
      </el-form>

      <div v-if="canViewConfigs" class="apple-card flex flex-col p-5 sm:p-6 xl:p-7">
        <div class="mb-5 flex items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-white/5">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">线上预订规则</h2>
          <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            默认值：24小时 / 5件
          </span>
        </div>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">超时自动取消</div>
            <el-switch v-model="serialForm.o2o.autoCancelEnabled" :disabled="!canUpdateConfigs || loading" />
          </div>
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">超时取消时长（小时）</div>
            <el-input-number
              v-model="serialForm.o2o.autoCancelHours"
              :min="1"
              :max="168"
              :controls="false"
              :disabled="!canUpdateConfigs || loading"
              class="!w-full"
            />
          </div>
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">全局限购开关</div>
            <el-switch v-model="serialForm.o2o.limitEnabled" :disabled="!canUpdateConfigs || loading" />
          </div>
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">默认限购数量</div>
            <el-input-number
              v-model="serialForm.o2o.limitQty"
              :min="1"
              :max="999"
              :controls="false"
              :disabled="!canUpdateConfigs || loading"
              class="!w-full"
            />
          </div>
        </div>
        <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
          最近更新时间：{{ o2oUpdatedAtLabel }}
        </div>
      </div>
    </div>
  </PageContainer>
</template>

<style scoped>
.field-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.field-label__help {
  font-size: 12px;
  font-weight: 400;
  color: #64748b;
}
</style>
