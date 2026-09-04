<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigVerificationSection.vue
 * 文件职责：承载短信/邮箱验证码平台配置，并提供阿里云 PNVS 脱敏就绪状态与最近短信回执查询。
 * 实现逻辑：
 * - 父页面保留权限校验、测试发送和保存提交，本组件只编排配置字段与只读回执；
 * - 短信供应商按通用 HTTP / 阿里云 PNVS 分支展示，两套配置始终保留在同一表单中，切换时不会清空；
 * - 回执筛选和分页通过稳定请求只接收最后一次结果，列表只展示后端返回的脱敏字段。
 * 维护说明：密钥只允许由后端环境配置，本组件不得增加密钥输入框或展示第三方错误详情。
 */

import dayjs from 'dayjs'
import { computed, onActivated, onDeactivated, onMounted, reactive, ref } from 'vue'
import {
  getSmsVerificationReceipts,
  type SmsVerificationDeliveryStatus,
  type SmsVerificationReceiptQuery,
  type SmsVerificationReceiptRecord,
  type VerificationProviderMobileChannelConfig,
  type VerificationScene,
} from '@/api/modules/system-config'
import { useStableRequest } from '@/composables/useStableRequest'
import { showAppError } from '@/utils/app-alert'
import { extractErrorMessage } from '@/utils/error'

type StatusTagType = 'success' | 'warning' | 'info' | 'danger'

const props = defineProps<{
  verificationForm: {
    mobile: {
      enabled: boolean
      providerType: 'generic_http' | 'aliyun_dypns'
      httpMethod: 'POST' | 'GET'
      apiUrl: string
      headersTemplate: string
      bodyTemplate: string
      successMatch: string
      aliyunSignName: string
      aliyunSchemeName: string
      aliyunTemplates: {
        register: string
        forgotPassword: string
        profileUpdate: string
        test: string
      }
    }
    email: {
      enabled: boolean
      httpMethod: 'POST' | 'GET'
      apiUrl: string
      headersTemplate: string
      bodyTemplate: string
      successMatch: string
    }
  }
  mobileProviderStatus: VerificationProviderMobileChannelConfig | null
  canUpdateConfigs: boolean
  canTestVerificationProviders: boolean
  loading: boolean
  saving: boolean
  testSendingChannel: 'mobile' | 'email' | ''
  getVerificationUpdatedAtLabel: (channel: 'mobile' | 'email') => string
}>()

const emit = defineEmits<{
  (event: 'test-send', channel: 'mobile' | 'email'): void
}>()

const receiptRequest = useStableRequest()
const receiptLoading = ref(false)
let mountedInCurrentActivation = false
const receiptRows = ref<SmsVerificationReceiptRecord[]>([])
const receiptTotal = ref(0)
const receiptFilters = reactive<{
  page: number
  pageSize: number
  scene: VerificationScene | ''
  deliveryStatus: SmsVerificationDeliveryStatus | ''
  dateRange: Date[] | null
}>({
  page: 1,
  pageSize: 10,
  scene: '',
  deliveryStatus: '',
  dateRange: null,
})

const aliyunReadinessAlert = computed(() => {
  const status = props.mobileProviderStatus
  if (!status) {
    return {
      type: 'warning' as const,
      title: '阿里云 PNVS 状态尚未加载',
      description: '请等待配置加载完成后再启用或测试短信通道。',
    }
  }
  const draft = props.verificationForm.mobile
  const missingDraftFields = [
    draft.aliyunSignName,
    draft.aliyunTemplates.register,
    draft.aliyunTemplates.forgotPassword,
    draft.aliyunTemplates.profileUpdate,
    draft.aliyunTemplates.test,
  ].some((value) => !value.trim())
  const ready = draft.enabled
    && !missingDraftFields
    && status.credentialsConfigured
    && status.ticketHmacConfigured
  const reason = !draft.enabled
    ? '当前草稿尚未启用短信通道。'
    : missingDraftFields
      ? '当前草稿的短信签名或四类场景模板尚未填写完整。'
      : !status.credentialsConfigured
        ? '后端环境尚未配置阿里云访问凭据。'
        : !status.ticketHmacConfigured
          ? '后端环境尚未配置有效的核验 HMAC 密钥。'
          : '当前草稿的业务配置与后端运行时凭据均已就绪。'
  return {
    type: ready ? 'success' as const : 'warning' as const,
    title: ready ? '当前阿里云配置已就绪' : '当前阿里云配置尚未就绪',
    description: `${reason} 环境凭据状态来自后端，签名与模板状态按当前草稿计算。`,
  }
})

const buildReceiptQuery = (): SmsVerificationReceiptQuery => {
  const [startDate, endDate] = receiptFilters.dateRange ?? []
  return {
    page: receiptFilters.page,
    pageSize: receiptFilters.pageSize,
    ...(receiptFilters.scene ? { scene: receiptFilters.scene } : {}),
    ...(receiptFilters.deliveryStatus ? { deliveryStatus: receiptFilters.deliveryStatus } : {}),
    ...(startDate ? { startDate: startDate.toISOString() } : {}),
    ...(endDate ? { endDate: endDate.toISOString() } : {}),
  }
}

const loadSmsReceipts = async () => {
  receiptLoading.value = true
  await receiptRequest.runLatest({
    executor: (signal) => getSmsVerificationReceipts(buildReceiptQuery(), { signal }),
    onSuccess: (result) => {
      receiptRows.value = result.items
      receiptTotal.value = result.total
      receiptFilters.page = result.page
      receiptFilters.pageSize = result.pageSize
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '加载短信回执失败，请稍后重试'))
    },
    onFinally: () => {
      receiptLoading.value = false
    },
  })
}

const handleReceiptSearch = () => {
  receiptFilters.page = 1
  void loadSmsReceipts()
}

const handleReceiptReset = () => {
  receiptFilters.page = 1
  receiptFilters.scene = ''
  receiptFilters.deliveryStatus = ''
  receiptFilters.dateRange = null
  void loadSmsReceipts()
}

const handleReceiptPageChange = (page: number) => {
  receiptFilters.page = page
  void loadSmsReceipts()
}

const handleReceiptPageSizeChange = (pageSize: number) => {
  receiptFilters.page = 1
  receiptFilters.pageSize = pageSize
  void loadSmsReceipts()
}

const sceneLabelMap: Record<VerificationScene, string> = {
  register: '注册',
  forgot_password: '找回密码',
  profile_update: '资料修改',
  test: '测试发送',
}

const sendStatusMeta: Record<SmsVerificationReceiptRecord['sendStatus'], { label: string; type: StatusTagType }> = {
  pending: { label: '等待受理', type: 'info' },
  sent: { label: '已发送', type: 'success' },
  failed: { label: '发送失败', type: 'danger' },
}

const deliveryStatusMeta: Record<SmsVerificationReceiptRecord['deliveryStatus'], { label: string; type: StatusTagType }> = {
  pending: { label: '等待回执', type: 'info' },
  delivered: { label: '已送达', type: 'success' },
  failed: { label: '送达失败', type: 'danger' },
}

const verificationStatusMeta: Record<SmsVerificationReceiptRecord['verificationStatus'], { label: string; type: StatusTagType }> = {
  pending: { label: '未核验', type: 'info' },
  passed: { label: '已通过', type: 'success' },
  failed: { label: '未通过', type: 'danger' },
}

const getSceneLabel = (value: unknown) => sceneLabelMap[value as VerificationScene] ?? '未知场景'
const getSendStatusMeta = (value: unknown) => sendStatusMeta[value as SmsVerificationReceiptRecord['sendStatus']] ?? sendStatusMeta.pending
const getDeliveryStatusMeta = (value: unknown) => deliveryStatusMeta[value as SmsVerificationReceiptRecord['deliveryStatus']] ?? deliveryStatusMeta.pending
const getVerificationStatusMeta = (value: unknown) => verificationStatusMeta[value as SmsVerificationReceiptRecord['verificationStatus']] ?? verificationStatusMeta.pending
const formatReceiptTime = (value: string | null) => value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'

onMounted(() => {
  mountedInCurrentActivation = true
  void loadSmsReceipts()
})

onActivated(() => {
  receiptLoading.value = false
  if (mountedInCurrentActivation) {
    mountedInCurrentActivation = false
    return
  }
  void loadSmsReceipts()
})

onDeactivated(() => {
  mountedInCurrentActivation = false
  receiptRequest.cancel()
  receiptLoading.value = false
})
</script>

<template>
  <div class="config-stage__panel space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">验证码平台配置</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          管理客户端注册与找回密码所需的短信、邮箱验证码发送平台。通用 HTTP 支持模板变量：
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
      description="通用 HTTP 请求头模板需填写合法 JSON，请求体模板会原样发送；找回密码只需短信或邮箱任一可用通道。阿里云访问凭据与核验密钥只能在后端环境配置，页面不会显示密钥内容。"
    />

    <div class="grid gap-6 xl:grid-cols-2">
      <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5 dark:border-white/10 dark:bg-slate-900/30">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">短信验证码平台</h3>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">用于手机号注册、找回密码与资料修改。</p>
          </div>
          <div class="flex items-center gap-3">
            <el-button
              size="small"
              :loading="testSendingChannel === 'mobile'"
              :disabled="!canTestVerificationProviders || loading || saving"
              @click="emit('test-send', 'mobile')"
            >
              发送测试短信
            </el-button>
            <el-switch v-model="verificationForm.mobile.enabled" :disabled="!canUpdateConfigs || loading" />
          </div>
        </div>

        <div class="grid gap-4">
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">短信供应商</div>
            <el-select v-model="verificationForm.mobile.providerType" :disabled="!canUpdateConfigs || loading">
              <el-option label="通用 HTTP" value="generic_http" />
              <el-option label="阿里云 PNVS" value="aliyun_dypns" />
            </el-select>
          </div>

          <template v-if="verificationForm.mobile.providerType === 'generic_http'">
            <div class="grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">请求方法</div>
                <el-select v-model="verificationForm.mobile.httpMethod" :disabled="!canUpdateConfigs || loading">
                  <el-option label="POST" value="POST" />
                  <el-option label="GET" value="GET" />
                </el-select>
              </div>
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">API 地址</div>
                <el-input v-model="verificationForm.mobile.apiUrl" :disabled="!canUpdateConfigs || loading" placeholder="https://example.com/send-sms" clearable />
              </div>
            </div>

            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">请求头模板（JSON）</div>
              <el-input v-model="verificationForm.mobile.headersTemplate" type="textarea" :rows="4" :disabled="!canUpdateConfigs || loading" placeholder='{"Content-Type":"application/json","Authorization":"Bearer xxx"}' />
            </div>

            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">请求体模板</div>
              <el-input v-model="verificationForm.mobile.bodyTemplate" type="textarea" :rows="6" :disabled="!canUpdateConfigs || loading" placeholder='{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}' />
            </div>

            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">成功关键字（可选）</div>
              <el-input v-model="verificationForm.mobile.successMatch" :disabled="!canUpdateConfigs || loading" placeholder="如：success" clearable />
            </div>
          </template>

          <template v-else-if="verificationForm.mobile.providerType === 'aliyun_dypns'">
            <el-alert
              :title="aliyunReadinessAlert.title"
              :description="aliyunReadinessAlert.description"
              :type="aliyunReadinessAlert.type"
              :closable="false"
              show-icon
            />

            <div class="grid gap-2 rounded-xl border border-slate-200/80 bg-white/70 p-3 text-xs dark:border-white/10 dark:bg-slate-950/30 sm:grid-cols-3">
              <div class="flex items-center justify-between gap-2 sm:block">
                <span class="text-slate-500 dark:text-slate-400">访问凭据</span>
                <el-tag class="sm:mt-1" :type="mobileProviderStatus?.credentialsConfigured ? 'success' : 'danger'" size="small">
                  {{ mobileProviderStatus?.credentialsConfigured ? '已配置' : '未配置' }}
                </el-tag>
              </div>
              <div class="flex items-center justify-between gap-2 sm:block">
                <span class="text-slate-500 dark:text-slate-400">核验 HMAC</span>
                <el-tag class="sm:mt-1" :type="mobileProviderStatus?.ticketHmacConfigured ? 'success' : 'danger'" size="small">
                  {{ mobileProviderStatus?.ticketHmacConfigured ? '已配置' : '未配置' }}
                </el-tag>
              </div>
              <div class="flex items-center justify-between gap-2 sm:block">
                <span class="text-slate-500 dark:text-slate-400">MNS 回执</span>
                <el-tag class="sm:mt-1" :type="!mobileProviderStatus?.mnsEnabled ? 'info' : mobileProviderStatus?.mnsConfigured ? 'success' : 'danger'" size="small">
                  {{ !mobileProviderStatus?.mnsEnabled ? '未启用' : mobileProviderStatus?.mnsConfigured ? '已配置' : '未配置' }}
                </el-tag>
              </div>
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">短信签名</div>
                <el-input v-model="verificationForm.mobile.aliyunSignName" :disabled="!canUpdateConfigs || loading" placeholder="请输入已审核通过的短信签名" clearable />
              </div>
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">SchemeName（可选）</div>
                <el-input v-model="verificationForm.mobile.aliyunSchemeName" :disabled="!canUpdateConfigs || loading" placeholder="核验方案名称" clearable />
              </div>
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">注册模板码</div>
                <el-input v-model="verificationForm.mobile.aliyunTemplates.register" :disabled="!canUpdateConfigs || loading" placeholder="请输入注册场景模板码" clearable />
              </div>
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">找回密码模板码</div>
                <el-input v-model="verificationForm.mobile.aliyunTemplates.forgotPassword" :disabled="!canUpdateConfigs || loading" placeholder="请输入找回密码场景模板码" clearable />
              </div>
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">资料修改模板码</div>
                <el-input v-model="verificationForm.mobile.aliyunTemplates.profileUpdate" :disabled="!canUpdateConfigs || loading" placeholder="请输入资料修改场景模板码" clearable />
              </div>
              <div class="space-y-2">
                <div class="text-sm text-slate-600 dark:text-slate-300">测试模板码</div>
                <el-input v-model="verificationForm.mobile.aliyunTemplates.test" :disabled="!canUpdateConfigs || loading" placeholder="请输入测试发送场景模板码" clearable />
              </div>
            </div>
          </template>
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
              :disabled="!canTestVerificationProviders || loading || saving"
              @click="emit('test-send', 'email')"
            >
              发送测试邮件
            </el-button>
            <el-switch v-model="verificationForm.email.enabled" :disabled="!canUpdateConfigs || loading" />
          </div>
        </div>

        <div class="grid gap-4">
          <div class="grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">请求方法</div>
              <el-select v-model="verificationForm.email.httpMethod" :disabled="!canUpdateConfigs || loading">
                <el-option label="POST" value="POST" />
                <el-option label="GET" value="GET" />
              </el-select>
            </div>
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">API 地址</div>
              <el-input v-model="verificationForm.email.apiUrl" :disabled="!canUpdateConfigs || loading" placeholder="https://example.com/send-mail" clearable />
            </div>
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">请求头模板（JSON）</div>
            <el-input
              v-model="verificationForm.email.headersTemplate"
              type="textarea"
              :rows="4"
              :disabled="!canUpdateConfigs || loading"
              placeholder='{"Content-Type":"application/json","Authorization":"Bearer xxx"}'
            />
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">请求体模板</div>
            <el-input
              v-model="verificationForm.email.bodyTemplate"
              type="textarea"
              :rows="6"
              :disabled="!canUpdateConfigs || loading"
              placeholder='{"email":"{{target}}","subject":"Y-Link 验证码","content":"您的验证码为 {{code}}"}'
            />
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">成功关键字（可选）</div>
            <el-input
              v-model="verificationForm.email.successMatch"
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

    <section class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5 dark:border-white/10 dark:bg-slate-900/30">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">最近短信回执</h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">按场景、送达状态与时间范围查询，仅展示脱敏目标及发送、送达、核验状态。</p>
        </div>
        <el-button :loading="receiptLoading" @click="loadSmsReceipts">刷新</el-button>
      </div>

      <div class="mt-4 grid gap-3 lg:grid-cols-[160px_160px_minmax(280px,1fr)_auto]">
        <el-select v-model="receiptFilters.scene" placeholder="全部场景" clearable>
          <el-option label="注册" value="register" />
          <el-option label="找回密码" value="forgot_password" />
          <el-option label="资料修改" value="profile_update" />
          <el-option label="测试发送" value="test" />
        </el-select>
        <el-select v-model="receiptFilters.deliveryStatus" placeholder="全部送达状态" clearable>
          <el-option label="等待回执" value="pending" />
          <el-option label="已送达" value="delivered" />
          <el-option label="送达失败" value="failed" />
        </el-select>
        <el-date-picker
          v-model="receiptFilters.dateRange"
          type="datetimerange"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          range-separator="至"
          class="w-full"
        />
        <div class="flex gap-2">
          <el-button type="primary" :loading="receiptLoading" @click="handleReceiptSearch">查询</el-button>
          <el-button :disabled="receiptLoading" @click="handleReceiptReset">重置</el-button>
        </div>
      </div>

      <div class="mt-4 overflow-x-auto rounded-xl border border-slate-200/80 dark:border-white/10">
        <el-table v-loading="receiptLoading" :data="receiptRows" style="min-width: 1120px" empty-text="暂无短信回执">
          <el-table-column label="场景" width="100">
            <template #default="{ row }">{{ getSceneLabel(row.scene) }}</template>
          </el-table-column>
          <el-table-column prop="targetMasked" label="脱敏目标" width="130" />
          <el-table-column prop="outId" label="outId" min-width="190" show-overflow-tooltip />
          <el-table-column prop="bizId" label="bizId" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.bizId || '-' }}</template>
          </el-table-column>
          <el-table-column label="发送状态" width="105">
            <template #default="{ row }">
              <el-tag :type="getSendStatusMeta(row.sendStatus).type" size="small">{{ getSendStatusMeta(row.sendStatus).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="送达状态" width="105">
            <template #default="{ row }">
              <el-tag :type="getDeliveryStatusMeta(row.deliveryStatus).type" size="small">{{ getDeliveryStatusMeta(row.deliveryStatus).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="核验状态" width="105">
            <template #default="{ row }">
              <el-tag :type="getVerificationStatusMeta(row.verificationStatus).type" size="small">{{ getVerificationStatusMeta(row.verificationStatus).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="errorCode" label="错误码" width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.errorCode || '-' }}</template>
          </el-table-column>
          <el-table-column label="时间轨迹" min-width="220">
            <template #default="{ row }">
              <div class="space-y-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
                <div>创建：{{ formatReceiptTime(row.createdAt) }}</div>
                <div>发送：{{ formatReceiptTime(row.sentAt) }}</div>
                <div>回执：{{ formatReceiptTime(row.reportedAt) }}</div>
                <div>核验：{{ formatReceiptTime(row.verifiedAt) }}</div>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="mt-4 flex justify-end overflow-x-auto pb-1">
        <el-pagination
          :current-page="receiptFilters.page"
          :page-size="receiptFilters.pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="receiptTotal"
          layout="total, sizes, prev, pager, next"
          @current-change="handleReceiptPageChange"
          @size-change="handleReceiptPageSizeChange"
        />
      </div>
    </section>
  </div>
</template>
