<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { PageContainer, PageToolbarCard } from '@/components/common'
import { getOrderSerialConfigs, updateOrderSerialConfigs, type OrderSerialConfigRecord } from '@/api/modules/system-config'
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
const loadRequest = useStableRequest()

const serialForm = reactive<{
  department: SerialFormValue
  walkin: SerialFormValue
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
})

const initialSnapshot = ref('')
const canViewConfigs = computed(() => authStore.hasPermission('system_configs:view'))
const canUpdateConfigs = computed(() => authStore.hasPermission('system_configs:update'))

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
  })

const isDirty = computed(() => snapshotForm() !== initialSnapshot.value)

const rules: FormRules = {
  'department.start': [{ required: true, message: '请输入部门单起始号', trigger: 'blur' }],
  'department.current': [{ required: true, message: '请输入部门单当前号', trigger: 'blur' }],
  'department.width': [{ required: true, message: '请输入部门单位宽', trigger: 'blur' }],
  'walkin.start': [{ required: true, message: '请输入散客单起始号', trigger: 'blur' }],
  'walkin.current': [{ required: true, message: '请输入散客单当前号', trigger: 'blur' }],
  'walkin.width': [{ required: true, message: '请输入散客单位宽', trigger: 'blur' }],
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
  initialSnapshot.value = snapshotForm()
}

const loadData = async () => {
  if (!canViewConfigs.value) {
    loading.value = false
    return
  }

  loading.value = true
  await loadRequest.runLatest({
    executor: async () => getOrderSerialConfigs(),
    onSuccess: (result) => {
      applyList(result.list)
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error))
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
        current: Number(serialForm.department.current),
        width: Number(serialForm.department.width),
      },
      walkin: {
        start: Number(serialForm.walkin.start),
        current: Number(serialForm.walkin.current),
        width: Number(serialForm.walkin.width),
      },
    })

    applyList(result.list)
    ElMessage.success(result.changed ? '系统配置已保存' : '配置未变更')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error))
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

onMounted(() => {
  void loadData()
})
</script>

<template>
  <PageContainer title="系统配置" description="维护部门/散客双流水参数，所有变更会记录审计日志。">
    <PageToolbarCard class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="text-sm text-slate-600 dark:text-slate-300">
          {{ canUpdateConfigs ? '当前账号可编辑参数并提交保存' : '当前账号仅支持只读查看' }}
        </div>
        <el-button v-if="canUpdateConfigs" type="primary" :loading="saving" :disabled="loading || !isDirty" @click="handleSubmit">
          保存配置
        </el-button>
      </div>
    </PageToolbarCard>

    <el-alert
      v-if="!canViewConfigs"
      title="当前账号暂无系统配置查看权限"
      type="warning"
      :closable="false"
      show-icon
    />

    <el-form v-else ref="formRef" :model="serialForm" :rules="rules" label-position="top" class="grid gap-4 lg:grid-cols-2">
      <el-card class="border border-slate-200/80 dark:border-white/10" shadow="never">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-semibold text-slate-800 dark:text-slate-100">部门订单流水</span>
            <span class="text-xs text-slate-500 dark:text-slate-400">前缀：{{ configMap?.department.prefix || 'hyyzjd' }}</span>
          </div>
        </template>
        <div class="grid gap-3">
          <el-form-item label="起始号" prop="department.start">
            <el-input-number v-model="serialForm.department.start" :min="1" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
          <el-form-item label="当前号" prop="department.current">
            <el-input-number v-model="serialForm.department.current" :min="0" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
          <el-form-item label="位宽" prop="department.width">
            <el-input-number v-model="serialForm.department.width" :min="1" :max="12" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
        </div>
        <div class="mt-2 text-xs text-slate-500 dark:text-slate-400">最近更新时间：{{ getUpdatedAtLabel('department') }}</div>
      </el-card>

      <el-card class="border border-slate-200/80 dark:border-white/10" shadow="never">
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-semibold text-slate-800 dark:text-slate-100">散客订单流水</span>
            <span class="text-xs text-slate-500 dark:text-slate-400">前缀：{{ configMap?.walkin.prefix || 'hyyz' }}</span>
          </div>
        </template>
        <div class="grid gap-3">
          <el-form-item label="起始号" prop="walkin.start">
            <el-input-number v-model="serialForm.walkin.start" :min="1" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
          <el-form-item label="当前号" prop="walkin.current">
            <el-input-number v-model="serialForm.walkin.current" :min="0" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
          <el-form-item label="位宽" prop="walkin.width">
            <el-input-number v-model="serialForm.walkin.width" :min="1" :max="12" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
        </div>
        <div class="mt-2 text-xs text-slate-500 dark:text-slate-400">最近更新时间：{{ getUpdatedAtLabel('walkin') }}</div>
      </el-card>
    </el-form>
  </PageContainer>
</template>
