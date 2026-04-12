<script setup lang="ts">
/**
 * 模块说明：src/views/system/SystemConfigView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { PageContainer, PageToolbarCard } from '@/components/common'
import {
  getO2oRuleConfigs,
  getOrderSerialConfigs,
  getVerificationProviderConfigs,
  testVerificationProviderSend,
  updateO2oRuleConfigs,
  updateOrderSerialConfigs,
  updateVerificationProviderConfigs,
  type O2oRuleConfigRecord,
  type OrderSerialConfigRecord,
  type VerificationProviderConfigsResult,
} from '@/api/modules/system-config'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

type SerialFormValue = {
  start: number
  current: number
  width: number
}

type VerificationFormValue = {
  enabled: boolean
  httpMethod: 'POST' | 'GET'
  apiUrl: string
  headersTemplate: string
  bodyTemplate: string
  successMatch: string
}

const authStore = useAuthStore()
const formRef = ref<FormInstance>()
const loading = ref(true)
const saving = ref(false)
const testSendingChannel = ref<'mobile' | 'email' | ''>('')
const configMap = ref<Record<'department' | 'walkin', OrderSerialConfigRecord> | null>(null)
const o2oRuleConfig = ref<O2oRuleConfigRecord | null>(null)
const verificationConfigMap = ref<VerificationProviderConfigsResult | null>(null)
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
  verification: {
    mobile: VerificationFormValue
    email: VerificationFormValue
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
  verification: {
    mobile: {
      enabled: false,
      httpMethod: 'POST',
      apiUrl: '',
      headersTemplate: '{"Content-Type":"application/json"}',
      bodyTemplate: '{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}',
      successMatch: '',
    },
    email: {
      enabled: false,
      httpMethod: 'POST',
      apiUrl: '',
      headersTemplate: '{"Content-Type":"application/json"}',
      bodyTemplate: '{"email":"{{target}}","subject":"Y-Link 验证码","content":"您的验证码为 {{code}}，场景：{{scene}}。5 分钟内有效。"}',
      successMatch: '',
    },
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
    verification: {
      mobile: {
        enabled: Boolean(serialForm.verification.mobile.enabled),
        httpMethod: serialForm.verification.mobile.httpMethod,
        apiUrl: serialForm.verification.mobile.apiUrl.trim(),
        headersTemplate: serialForm.verification.mobile.headersTemplate.trim(),
        bodyTemplate: serialForm.verification.mobile.bodyTemplate.trim(),
        successMatch: serialForm.verification.mobile.successMatch.trim(),
      },
      email: {
        enabled: Boolean(serialForm.verification.email.enabled),
        httpMethod: serialForm.verification.email.httpMethod,
        apiUrl: serialForm.verification.email.apiUrl.trim(),
        headersTemplate: serialForm.verification.email.headersTemplate.trim(),
        bodyTemplate: serialForm.verification.email.bodyTemplate.trim(),
        successMatch: serialForm.verification.email.successMatch.trim(),
      },
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

const applyVerificationConfigs = (config: VerificationProviderConfigsResult) => {
  verificationConfigMap.value = config
  serialForm.verification.mobile.enabled = config.mobile.enabled
  serialForm.verification.mobile.httpMethod = config.mobile.httpMethod
  serialForm.verification.mobile.apiUrl = config.mobile.apiUrl
  serialForm.verification.mobile.headersTemplate = config.mobile.headersTemplate
  serialForm.verification.mobile.bodyTemplate = config.mobile.bodyTemplate
  serialForm.verification.mobile.successMatch = config.mobile.successMatch

  serialForm.verification.email.enabled = config.email.enabled
  serialForm.verification.email.httpMethod = config.email.httpMethod
  serialForm.verification.email.apiUrl = config.email.apiUrl
  serialForm.verification.email.headersTemplate = config.email.headersTemplate
  serialForm.verification.email.bodyTemplate = config.email.bodyTemplate
  serialForm.verification.email.successMatch = config.email.successMatch
}

const getVerificationChannelLabel = (channel: 'mobile' | 'email') => {
  return channel === 'mobile' ? '短信验证码平台' : '邮箱验证码平台'
}

const validateVerificationConfigs = () => {
  const channels: Array<'mobile' | 'email'> = ['mobile', 'email']
  for (const channel of channels) {
    const label = getVerificationChannelLabel(channel)
    const config = serialForm.verification[channel]
    if (config.enabled && !config.apiUrl.trim()) {
      ElMessage.warning(`${label}已启用时必须填写 API 地址`)
      return false
    }
    try {
      JSON.parse(config.headersTemplate.trim() || '{}')
    } catch {
      ElMessage.warning(`${label}请求头模板必须是合法 JSON`)
      return false
    }
  }
  return true
}

const validateSingleVerificationConfig = (channel: 'mobile' | 'email') => {
  const label = getVerificationChannelLabel(channel)
  const config = serialForm.verification[channel]
  if (!config.enabled) {
    ElMessage.warning(`${label}未启用，无法发送测试消息`)
    return false
  }
  if (!config.apiUrl.trim()) {
    ElMessage.warning(`${label}未填写 API 地址，无法发送测试消息`)
    return false
  }
  try {
    JSON.parse(config.headersTemplate.trim() || '{}')
  } catch {
    ElMessage.warning(`${label}请求头模板必须是合法 JSON`)
    return false
  }
  return true
}

const buildVerificationChannelPayload = (channel: 'mobile' | 'email') => {
  return {
    enabled: serialForm.verification[channel].enabled,
    httpMethod: serialForm.verification[channel].httpMethod,
    apiUrl: serialForm.verification[channel].apiUrl.trim(),
    headersTemplate: serialForm.verification[channel].headersTemplate.trim(),
    bodyTemplate: serialForm.verification[channel].bodyTemplate.trim(),
    successMatch: serialForm.verification[channel].successMatch.trim(),
  }
}

const handleTestVerificationSend = async (channel: 'mobile' | 'email') => {
  if (!canUpdateConfigs.value) {
    ElMessage.warning('当前账号仅支持只读查看')
    return
  }
  if (!validateSingleVerificationConfig(channel)) {
    return
  }

  try {
    const promptResult = await ElMessageBox.prompt(
      channel === 'mobile' ? '请输入用于接收测试短信的手机号' : '请输入用于接收测试邮件的邮箱',
      channel === 'mobile' ? '发送测试短信' : '发送测试邮件',
      {
        inputPlaceholder: channel === 'mobile' ? '例如：13800138000' : '例如：demo@example.com',
        inputPattern: channel === 'mobile' ? /^1\d{10}$/ : /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        inputErrorMessage: channel === 'mobile' ? '请输入正确的手机号' : '请输入正确的邮箱地址',
        confirmButtonText: '立即发送',
        cancelButtonText: '取消',
      },
    )

    testSendingChannel.value = channel
    const result = await testVerificationProviderSend({
      channel,
      target: promptResult.value.trim(),
      config: buildVerificationChannelPayload(channel),
    })
    ElMessage.success(`${channel === 'mobile' ? '测试短信' : '测试邮件'}已发送至 ${result.target}`)
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error(extractErrorMessage(error, '测试发送失败，请检查平台配置后重试'))
  } finally {
    testSendingChannel.value = ''
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const loadData = async () => {
  if (!canViewConfigs.value) {
    loading.value = false
    return
  }

  loading.value = true
  await loadRequest.runLatest({
    executor: async () => Promise.all([getOrderSerialConfigs(), getO2oRuleConfigs(), getVerificationProviderConfigs()]),
    onSuccess: (result) => {
      applyList(result[0].list)
      applyO2oRules(result[1])
      applyVerificationConfigs(result[2])
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

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
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
  if (!validateVerificationConfigs()) {
    return
  }

  saving.value = true
  try {
    const [result, o2oResult, verificationResult] = await Promise.all([
      updateOrderSerialConfigs({
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
      }),
      updateO2oRuleConfigs({
        autoCancelEnabled: serialForm.o2o.autoCancelEnabled,
        autoCancelHours: Number(serialForm.o2o.autoCancelHours),
        limitEnabled: serialForm.o2o.limitEnabled,
        limitQty: Number(serialForm.o2o.limitQty),
      }),
      updateVerificationProviderConfigs({
        mobile: {
          enabled: serialForm.verification.mobile.enabled,
          httpMethod: serialForm.verification.mobile.httpMethod,
          apiUrl: serialForm.verification.mobile.apiUrl.trim(),
          headersTemplate: serialForm.verification.mobile.headersTemplate.trim(),
          bodyTemplate: serialForm.verification.mobile.bodyTemplate.trim(),
          successMatch: serialForm.verification.mobile.successMatch.trim(),
        },
        email: {
          enabled: serialForm.verification.email.enabled,
          httpMethod: serialForm.verification.email.httpMethod,
          apiUrl: serialForm.verification.email.apiUrl.trim(),
          headersTemplate: serialForm.verification.email.headersTemplate.trim(),
          bodyTemplate: serialForm.verification.email.bodyTemplate.trim(),
          successMatch: serialForm.verification.email.successMatch.trim(),
        },
      }),
    ])

    applyList(result.list)
    applyO2oRules(o2oResult.config)
    applyVerificationConfigs(verificationResult.config)
    initialSnapshot.value = snapshotForm()
    ElMessage.success(result.changed || o2oResult.changed || verificationResult.changed ? '系统配置已保存' : '配置未变更')
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

const getVerificationUpdatedAtLabel = (channel: 'mobile' | 'email') => {
  const value = verificationConfigMap.value?.[channel]?.updatedAt
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
  <PageContainer title="系统配置" description="维护流水号、线上预订规则与短信/邮箱验证码平台参数，所有变更会记录审计日志。">
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
          description="这里用于维护订单编号规则、线上预订规则，以及客户端注册/找回密码依赖的短信与邮箱验证码平台。建议仅在管理员确认后修改，以免影响业务连续性。"
        />
      </PageToolbarCard>

      <el-alert
        v-if="!canViewConfigs"
        title="当前账号暂无系统配置查看权限"
        type="warning"
        :closable="false"
        show-icon
      />

      <el-form v-else ref="formRef" :model="serialForm" :rules="rules" label-position="top" class="space-y-6">
        <div class="grid gap-6 lg:grid-cols-2">
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
        </div>

        <div class="apple-card flex flex-col p-5 sm:p-6 xl:p-7">
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

        <div class="apple-card flex flex-col gap-5 p-5 sm:p-6 xl:p-7">
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
            <div>
              <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">验证码平台配置</h2>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                管理客户端注册与找回密码所需的短信、邮箱验证码发送平台。支持模板变量：
                <span v-pre class="font-mono">{{target}}</span>、
                <span v-pre class="font-mono">{{code}}</span>、
                <span v-pre class="font-mono">{{scene}}</span>、
                <span v-pre class="font-mono">{{ip}}</span>。
              </p>
            </div>
            <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              保存后立即生效
            </span>
          </div>

          <el-alert
            title="模板填写说明"
            type="info"
            :closable="false"
            show-icon
            description="请求头模板需填写合法 JSON；请求体模板会原样发送给目标平台。若配置成功关键字，系统会在第三方返回文本中匹配该内容来判断发送成功。客户端找回密码仅在手机与邮箱验证码平台同时启用时开放。"
          />

          <div class="grid gap-6 xl:grid-cols-2">
            <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5 dark:border-white/10 dark:bg-slate-900/30">
              <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">短信验证码平台</h3>
                  <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">用于手机号注册、手机号找回密码。</p>
                </div>
                <div class="flex items-center gap-3">
                  <el-button
                    size="small"
                    :loading="testSendingChannel === 'mobile'"
                    :disabled="!canUpdateConfigs || loading || saving"
                    @click="handleTestVerificationSend('mobile')"
                  >
                    发送测试短信
                  </el-button>
                  <el-switch v-model="serialForm.verification.mobile.enabled" :disabled="!canUpdateConfigs || loading" />
                </div>
              </div>

              <div class="grid gap-4">
                <div class="grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
                  <div class="space-y-2">
                    <div class="text-sm text-slate-600 dark:text-slate-300">请求方法</div>
                    <el-select v-model="serialForm.verification.mobile.httpMethod" :disabled="!canUpdateConfigs || loading">
                      <el-option label="POST" value="POST" />
                      <el-option label="GET" value="GET" />
                    </el-select>
                  </div>
                  <div class="space-y-2">
                    <div class="text-sm text-slate-600 dark:text-slate-300">API 地址</div>
                    <el-input v-model="serialForm.verification.mobile.apiUrl" :disabled="!canUpdateConfigs || loading" placeholder="https://example.com/send-sms" clearable />
                  </div>
                </div>

                <div class="space-y-2">
                  <div class="text-sm text-slate-600 dark:text-slate-300">请求头模板（JSON）</div>
                  <el-input
                    v-model="serialForm.verification.mobile.headersTemplate"
                    type="textarea"
                    :rows="4"
                    :disabled="!canUpdateConfigs || loading"
                    placeholder='{"Content-Type":"application/json","Authorization":"Bearer xxx"}'
                  />
                </div>

                <div class="space-y-2">
                  <div class="text-sm text-slate-600 dark:text-slate-300">请求体模板</div>
                  <el-input
                    v-model="serialForm.verification.mobile.bodyTemplate"
                    type="textarea"
                    :rows="6"
                    :disabled="!canUpdateConfigs || loading"
                    placeholder='{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}'
                  />
                </div>

                <div class="space-y-2">
                  <div class="text-sm text-slate-600 dark:text-slate-300">成功关键字（可选）</div>
                  <el-input
                    v-model="serialForm.verification.mobile.successMatch"
                    :disabled="!canUpdateConfigs || loading"
                    placeholder="如：success"
                    clearable
                  />
                </div>
              </div>

              <div class="mt-5 border-t border-slate-200/80 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
                最近更新时间：{{ getVerificationUpdatedAtLabel('mobile') }}
              </div>
            </div>

            <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5 dark:border-white/10 dark:bg-slate-900/30">
              <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">邮箱验证码平台</h3>
                  <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">用于邮箱注册、邮箱找回密码。</p>
                </div>
                <div class="flex items-center gap-3">
                  <el-button
                    size="small"
                    :loading="testSendingChannel === 'email'"
                    :disabled="!canUpdateConfigs || loading || saving"
                    @click="handleTestVerificationSend('email')"
                  >
                    发送测试邮件
                  </el-button>
                  <el-switch v-model="serialForm.verification.email.enabled" :disabled="!canUpdateConfigs || loading" />
                </div>
              </div>

              <div class="grid gap-4">
                <div class="grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
                  <div class="space-y-2">
                    <div class="text-sm text-slate-600 dark:text-slate-300">请求方法</div>
                    <el-select v-model="serialForm.verification.email.httpMethod" :disabled="!canUpdateConfigs || loading">
                      <el-option label="POST" value="POST" />
                      <el-option label="GET" value="GET" />
                    </el-select>
                  </div>
                  <div class="space-y-2">
                    <div class="text-sm text-slate-600 dark:text-slate-300">API 地址</div>
                    <el-input v-model="serialForm.verification.email.apiUrl" :disabled="!canUpdateConfigs || loading" placeholder="https://example.com/send-mail" clearable />
                  </div>
                </div>

                <div class="space-y-2">
                  <div class="text-sm text-slate-600 dark:text-slate-300">请求头模板（JSON）</div>
                  <el-input
                    v-model="serialForm.verification.email.headersTemplate"
                    type="textarea"
                    :rows="4"
                    :disabled="!canUpdateConfigs || loading"
                    placeholder='{"Content-Type":"application/json","Authorization":"Bearer xxx"}'
                  />
                </div>

                <div class="space-y-2">
                  <div class="text-sm text-slate-600 dark:text-slate-300">请求体模板</div>
                  <el-input
                    v-model="serialForm.verification.email.bodyTemplate"
                    type="textarea"
                    :rows="6"
                    :disabled="!canUpdateConfigs || loading"
                    placeholder='{"email":"{{target}}","subject":"Y-Link 验证码","content":"您的验证码为 {{code}}"}'
                  />
                </div>

                <div class="space-y-2">
                  <div class="text-sm text-slate-600 dark:text-slate-300">成功关键字（可选）</div>
                  <el-input
                    v-model="serialForm.verification.email.successMatch"
                    :disabled="!canUpdateConfigs || loading"
                    placeholder="如：accepted"
                    clearable
                  />
                </div>
              </div>

              <div class="mt-5 border-t border-slate-200/80 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
                最近更新时间：{{ getVerificationUpdatedAtLabel('email') }}
              </div>
            </div>
          </div>
        </div>
      </el-form>
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
