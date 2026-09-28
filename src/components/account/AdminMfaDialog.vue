<script setup lang="ts">
/**
 * 模块说明：src/components/account/AdminMfaDialog.vue
 * 文件职责：管理端本人两步验证（TOTP）设置弹窗，承接状态查看、绑定身份验证器、保存恢复码、重生成恢复码与停用。
 * 实现逻辑：
 * - 弹窗按“状态 → 复核密码 → 扫码确认 → 保存恢复码 / 停用 / 重生成”分阶段展示，同一时刻只渲染当前阶段的表单与按钮；
 * - 由顶栏首次点击时异步挂载，二维码库在进入扫码阶段才动态加载，两者都不进入首屏包；
 * - 秘钥、恢复码与输入的密码只保存在组件内存，弹窗关闭即清空，不写入本地存储或日志；
 * - 发起绑定、停用、重生成都先复核当前密码，失败次数与登录共用锁定，错误提示直接展示服务端返回的原因。
 * 维护说明：
 * - 恢复码只在生成当次展示，关闭前必须明确提示用户保存；不要增加“再次查看恢复码”之类的能力；
 * - 二维码生成失败时必须保留手动输入秘钥的方式，不能让用户只看到空白占位。
 */

import { computed, reactive, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { BizCrudDialogShell } from '@/components/common'
import {
  confirmAdminMfaEnrollment,
  disableAdminMfa,
  getAdminMfaStatus,
  regenerateAdminMfaRecoveryCodes,
  startAdminMfaEnrollment,
  type AdminMfaStatus,
} from '@/api/modules/admin-mfa'
import { extractErrorMessage, normalizeRequestError } from '@/utils/error'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type QrCodeModule = typeof import('qrcode')
type QrCodeRenderer = Pick<QrCodeModule, 'toDataURL'>
type MfaDialogStage = 'status' | 'enroll-password' | 'enroll-scan' | 'recovery-codes' | 'disable' | 'regenerate'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const RECOVERY_CODES_LOW_THRESHOLD = 3

const stage = ref<MfaDialogStage>('status')
const loading = ref(false)
const submitting = ref(false)
const status = ref<AdminMfaStatus | null>(null)
const recoveryCodes = ref<string[]>([])
const enrollment = reactive({
  secret: '',
  otpauthUri: '',
  qrDataUrl: '',
  qrLoading: false,
  qrFailed: false,
})
const form = reactive({
  currentPassword: '',
  code: '',
  recoveryCode: '',
  useRecoveryCode: false,
})

let qrCodeModulePromise: Promise<QrCodeModule> | null = null

const dialogTitle = computed(() => {
  switch (stage.value) {
    case 'enroll-password':
      return '开启两步验证'
    case 'enroll-scan':
      return '绑定身份验证器'
    case 'recovery-codes':
      return '保存恢复码'
    case 'disable':
      return '停用两步验证'
    case 'regenerate':
      return '重新生成恢复码'
    default:
      return '两步验证'
  }
})

// 手动输入秘钥时按 4 位分组展示，降低抄错概率；复制时仍复制无空格原文。
const groupedSecret = computed(() => enrollment.secret.match(/.{1,4}/g)?.join(' ') ?? '')

const enabledAtText = computed(() => (status.value?.enabledAt ? dayjs(status.value.enabledAt).format('YYYY-MM-DD HH:mm') : '-'))

const recoveryCodesLow = computed(() => Boolean(status.value?.enabled) && (status.value?.recoveryCodesRemaining ?? 0) <= RECOVERY_CODES_LOW_THRESHOLD)

const resetForm = () => {
  form.currentPassword = ''
  form.code = ''
  form.recoveryCode = ''
  form.useRecoveryCode = false
}

const clearEnrollment = () => {
  enrollment.secret = ''
  enrollment.otpauthUri = ''
  enrollment.qrDataUrl = ''
  enrollment.qrLoading = false
  enrollment.qrFailed = false
}

const goToStage = (nextStage: MfaDialogStage) => {
  resetForm()
  stage.value = nextStage
}

const loadStatus = async () => {
  loading.value = true
  try {
    status.value = await getAdminMfaStatus()
    stage.value = 'status'
  } catch (error) {
    showAppError(extractErrorMessage(error, '读取两步验证状态失败'))
  } finally {
    loading.value = false
  }
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      void loadStatus()
    }
  },
  { immediate: true },
)

const closeDialog = () => {
  emit('update:modelValue', false)
}

// 关闭动画结束后清空全部敏感状态，下次打开重新读取服务端状态。
const handleClosed = () => {
  resetForm()
  clearEnrollment()
  recoveryCodes.value = []
  status.value = null
  stage.value = 'status'
}

const resolveQrCodeRenderer = async (): Promise<QrCodeRenderer> => {
  if (!qrCodeModulePromise) {
    qrCodeModulePromise = import('qrcode').catch((error) => {
      qrCodeModulePromise = null
      throw error
    })
  }
  const module = await qrCodeModulePromise
  return (module as QrCodeModule & { default?: QrCodeRenderer }).default ?? module
}

const renderEnrollmentQrCode = async (uri: string) => {
  enrollment.qrLoading = true
  enrollment.qrFailed = false
  try {
    const qrCode = await resolveQrCodeRenderer()
    const dataUrl = await qrCode.toDataURL(uri, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    })
    // 生成期间用户可能已取消绑定，过期结果不能覆盖当前状态。
    if (enrollment.otpauthUri === uri) {
      enrollment.qrDataUrl = dataUrl
    }
  } catch {
    enrollment.qrFailed = true
  } finally {
    enrollment.qrLoading = false
  }
}

const copyText = async (text: string, successMessage: string) => {
  try {
    await navigator.clipboard.writeText(text)
    showAppSuccess(successMessage)
  } catch {
    showAppWarning('当前浏览器不允许自动复制，请手动选中后复制')
  }
}

const normalizeCodeInput = (value: string) => value.replace(/\s/g, '')

const handleStartEnrollment = async () => {
  if (!form.currentPassword) {
    showAppWarning('请输入当前登录密码')
    return
  }
  submitting.value = true
  try {
    const result = await startAdminMfaEnrollment(form.currentPassword)
    goToStage('enroll-scan')
    enrollment.secret = result.secret
    enrollment.otpauthUri = result.otpauthUri
    void renderEnrollmentQrCode(result.otpauthUri)
  } catch (error) {
    form.currentPassword = ''
    showAppError(extractErrorMessage(error, '发起绑定失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

const handleConfirmEnrollment = async () => {
  const code = normalizeCodeInput(form.code)
  if (!/^\d{6}$/.test(code)) {
    showAppWarning('请输入身份验证器中显示的 6 位动态码')
    return
  }
  submitting.value = true
  try {
    const result = await confirmAdminMfaEnrollment(code)
    clearEnrollment()
    recoveryCodes.value = result.recoveryCodes
    goToStage('recovery-codes')
    showAppSuccess('两步验证已开启')
  } catch (error) {
    form.code = ''
    const normalizedError = normalizeRequestError(error, '动态码校验失败，请稍后重试')
    showAppError(normalizedError.message)
    // 绑定已过期（10 分钟）或错误次数用尽：回到状态页重新发起。
    if (normalizedError.status === 409) {
      clearEnrollment()
      await loadStatus()
    }
  } finally {
    submitting.value = false
  }
}

const handleFinishRecoveryCodes = async () => {
  recoveryCodes.value = []
  await loadStatus()
}

const handleDisable = async () => {
  if (!form.currentPassword) {
    showAppWarning('请输入当前登录密码')
    return
  }
  const code = normalizeCodeInput(form.code)
  const recoveryCode = form.recoveryCode.trim()
  if (form.useRecoveryCode ? !recoveryCode : !/^\d{6}$/.test(code)) {
    showAppWarning(form.useRecoveryCode ? '请输入一个未使用过的恢复码' : '请输入身份验证器中显示的 6 位动态码')
    return
  }
  submitting.value = true
  try {
    await disableAdminMfa({
      currentPassword: form.currentPassword,
      ...(form.useRecoveryCode ? { recoveryCode } : { code }),
    })
    showAppSuccess('两步验证已停用')
    await loadStatus()
  } catch (error) {
    form.code = ''
    form.recoveryCode = ''
    showAppError(extractErrorMessage(error, '停用两步验证失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

const handleRegenerate = async () => {
  if (!form.currentPassword) {
    showAppWarning('请输入当前登录密码')
    return
  }
  const code = normalizeCodeInput(form.code)
  if (!/^\d{6}$/.test(code)) {
    showAppWarning('请输入身份验证器中显示的 6 位动态码')
    return
  }
  submitting.value = true
  try {
    const result = await regenerateAdminMfaRecoveryCodes({ currentPassword: form.currentPassword, code })
    recoveryCodes.value = result.recoveryCodes
    goToStage('recovery-codes')
    showAppSuccess('已生成新的恢复码，旧恢复码全部失效')
  } catch (error) {
    form.code = ''
    showAppError(extractErrorMessage(error, '重新生成恢复码失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

const toggleDisableFactor = () => {
  form.useRecoveryCode = !form.useRecoveryCode
  form.code = ''
  form.recoveryCode = ''
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="props.modelValue"
    :title="dialogTitle"
    height-mode="auto"
    phone-width="94%"
    tablet-width="480px"
    desktop-width="460px"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="handleClosed"
  >
    <el-skeleton v-if="loading" :rows="3" animated />

    <template v-else-if="stage === 'status' && status">
      <div class="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3 dark:bg-white/5">
        <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">当前状态</div>
        <el-tag :type="status.enabled ? 'success' : 'info'" effect="light">{{ status.enabled ? '已开启' : '未开启' }}</el-tag>
      </div>
      <div v-if="status.enabled" class="mt-3 grid gap-2 text-sm text-slate-600 dark:text-slate-300">
        <div class="flex items-center justify-between gap-3">
          <span class="text-slate-400">开启时间</span>
          <span>{{ enabledAtText }}</span>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-slate-400">剩余恢复码</span>
          <span>{{ status.recoveryCodesRemaining }} 个</span>
        </div>
        <el-alert
          v-if="recoveryCodesLow"
          class="mt-1"
          type="warning"
          :closable="false"
          show-icon
          title="恢复码即将用完，建议重新生成并妥善保存。"
        />
      </div>
      <p v-else class="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
        开启后，登录时除了密码，还需要输入手机上身份验证器应用（如 Microsoft Authenticator、Google Authenticator、腾讯身份验证器）生成的 6 位动态码。
        即使密码泄露，他人也无法直接登录后台。手机丢失时可用恢复码登录，或联系其他管理员重置。
      </p>
    </template>

    <template v-else-if="stage === 'enroll-password' || stage === 'disable' || stage === 'regenerate'">
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        <template v-if="stage === 'enroll-password'">为确认是本人操作，请先输入当前登录密码。</template>
        <template v-else-if="stage === 'disable'">停用后登录只需要密码。请输入当前密码，并提供动态码或恢复码完成确认。</template>
        <template v-else>重新生成后，旧恢复码全部失效。请输入当前密码和身份验证器中的动态码。</template>
      </div>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="当前密码">
          <el-input
            v-model="form.currentPassword"
            type="password"
            show-password
            placeholder="请输入当前登录密码"
            autocomplete="current-password"
            maxlength="256"
          />
        </el-form-item>
        <el-form-item v-if="stage !== 'enroll-password' && !form.useRecoveryCode" label="动态码">
          <el-input
            v-model.trim="form.code"
            placeholder="身份验证器中的 6 位动态码"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="7"
          />
        </el-form-item>
        <el-form-item v-if="stage === 'disable' && form.useRecoveryCode" label="恢复码">
          <el-input
            v-model.trim="form.recoveryCode"
            placeholder="例如 ABCD-EFGH-JKLM"
            autocomplete="off"
            maxlength="20"
          />
        </el-form-item>
      </el-form>
      <el-button v-if="stage === 'disable'" link type="primary" @click="toggleDisableFactor">
        {{ form.useRecoveryCode ? '改用动态码' : '手机不在身边？改用恢复码' }}
      </el-button>
    </template>

    <template v-else-if="stage === 'enroll-scan'">
      <ol class="mb-4 list-decimal space-y-1 pl-5 text-sm leading-6 text-slate-500 dark:text-slate-400">
        <li>用手机上的身份验证器应用扫描下方二维码；无法扫码时手动输入秘钥。</li>
        <li>输入应用中显示的 6 位动态码完成绑定（请在 10 分钟内完成）。</li>
      </ol>
      <div class="flex flex-col items-center gap-3">
        <div class="flex h-[200px] w-[200px] items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10">
          <img v-if="enrollment.qrDataUrl" :src="enrollment.qrDataUrl" alt="两步验证绑定二维码" class="h-full w-full" />
          <span v-else-if="enrollment.qrLoading" class="text-sm text-slate-400">二维码生成中…</span>
          <span v-else class="px-4 text-center text-sm text-slate-400">二维码生成失败，请使用下方秘钥手动添加</span>
        </div>
        <div class="w-full rounded-2xl bg-slate-50 px-4 py-3 dark:bg-white/5">
          <div class="text-xs text-slate-400">手动输入秘钥（基于时间，6 位，30 秒）</div>
          <div class="mt-1 flex items-center justify-between gap-3">
            <code class="break-all font-mono text-sm tracking-wider text-slate-700 dark:text-slate-200">{{ groupedSecret }}</code>
            <el-button link type="primary" @click="copyText(enrollment.secret, '秘钥已复制')">复制</el-button>
          </div>
        </div>
      </div>
      <el-form class="mt-4" label-position="top" @submit.prevent>
        <el-form-item label="动态码">
          <el-input
            v-model.trim="form.code"
            placeholder="应用中显示的 6 位动态码"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="7"
            @keyup.enter="handleConfirmEnrollment"
          />
        </el-form-item>
      </el-form>
    </template>

    <template v-else-if="stage === 'recovery-codes'">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="请立即抄写或保存到安全位置"
        description="每个恢复码只能使用一次，可在手机丢失时代替动态码登录。关闭本窗口后将无法再次查看。"
      />
      <div class="mt-4 grid grid-cols-2 gap-2">
        <code
          v-for="code in recoveryCodes"
          :key="code"
          class="rounded-xl bg-slate-50 px-3 py-2 text-center font-mono text-sm tracking-wider text-slate-700 dark:bg-white/5 dark:text-slate-200"
        >
          {{ code }}
        </code>
      </div>
    </template>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <template v-if="stage === 'status'">
          <el-button @click="closeDialog">关闭</el-button>
          <template v-if="status?.enabled">
            <el-button :disabled="loading" @click="goToStage('regenerate')">重新生成恢复码</el-button>
            <el-button type="danger" plain :disabled="loading" @click="goToStage('disable')">停用</el-button>
          </template>
          <el-button v-else type="primary" :disabled="loading || !status" @click="goToStage('enroll-password')">开启两步验证</el-button>
        </template>
        <template v-else-if="stage === 'enroll-password'">
          <el-button @click="goToStage('status')">返回</el-button>
          <el-button type="primary" :loading="submitting" @click="handleStartEnrollment">下一步</el-button>
        </template>
        <template v-else-if="stage === 'enroll-scan'">
          <el-button @click="clearEnrollment(); goToStage('status')">取消</el-button>
          <el-button type="primary" :loading="submitting" @click="handleConfirmEnrollment">验证并开启</el-button>
        </template>
        <template v-else-if="stage === 'recovery-codes'">
          <el-button @click="copyText(recoveryCodes.join('\n'), '恢复码已复制')">复制全部</el-button>
          <el-button type="primary" @click="handleFinishRecoveryCodes">我已妥善保存</el-button>
        </template>
        <template v-else-if="stage === 'disable'">
          <el-button @click="goToStage('status')">返回</el-button>
          <el-button type="danger" :loading="submitting" @click="handleDisable">确认停用</el-button>
        </template>
        <template v-else-if="stage === 'regenerate'">
          <el-button @click="goToStage('status')">返回</el-button>
          <el-button type="primary" :loading="submitting" @click="handleRegenerate">重新生成</el-button>
        </template>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
