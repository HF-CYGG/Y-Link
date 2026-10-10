<script setup lang="ts">
/**
 * 模块说明：src/components/account/AdminMfaDialog.vue
 * 文件职责：管理端本人两步验证设置弹窗，承接 TOTP、密码后密钥与恢复码的状态和管理操作。
 * 实现逻辑：
 * - 弹窗按状态、绑定 TOTP、使用已有强密钥启用 MFA、保存恢复码、单关 TOTP、完全停用及重生成恢复码分阶段展示；
 * - 由顶栏首次点击时异步挂载，二维码库在进入扫码阶段才动态加载，两者都不进入首屏包；
 * - 敏感操作复核当前密码和已启用的 TOTP 或强密钥；恢复码不能换新恢复码；
 * - 完全停用后服务端吊销会话，前端清登录态并引导重新登录；单关 TOTP 仍刷新状态；
 * - 秘钥、恢复码与输入的密码只保存在组件内存，关闭时清空，不写入本地存储或日志。
 * 维护说明：
 * - 恢复码只在生成当次展示，关闭前必须明确提示用户保存；不要增加“再次查看恢复码”之类的能力；
 * - 二维码生成失败时必须保留手动输入秘钥的方式，不能让用户只看到空白占位。
 */

import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import dayjs from 'dayjs'
import { ElMessageBox } from 'element-plus'
import { BizCrudDialogShell } from '@/components/common'
import {
  confirmAdminMfaEnrollment,
  disableAdminMfa,
  disableAdminTotp,
  enableAdminWebAuthnMfa,
  getAdminMfaStatus,
  regenerateAdminMfaRecoveryCodes,
  startAdminMfaEnrollment,
  type AdminMfaStatus,
} from '@/api/modules/admin-mfa'
import { getAdminWebAuthnCredentials, startAdminWebAuthnStepUp, verifyAdminWebAuthnStepUp, type AdminWebAuthnStepUpAction } from '@/api/modules/admin-webauthn'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { redirectToAdminLogin } from '@/utils/auth-navigation'
import { createWebAuthnFlow, isWebAuthnCancellation } from '@/utils/admin-webauthn'
import { guardRecoveryCodePaste } from '@/utils/admin-mfa-recovery-code'
import { extractErrorMessage, normalizeRequestError } from '@/utils/error'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type QrCodeModule = typeof import('qrcode')
type QrCodeRenderer = Pick<QrCodeModule, 'toDataURL'>
type MfaDialogStage = 'status' | 'enroll-password' | 'enroll-scan' | 'recovery-codes' | 'disable' | 'disable-totp' | 'regenerate' | 'enable-key'

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
const disableAllPending = ref(false)
const recoveryFinalPending = ref(false)
const authStore = useAuthStore(pinia)
const status = ref<AdminMfaStatus | null>(null)
const strongCredentialCount = ref(0)
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
  useWebAuthn: false,
})
let webAuthnSdk: typeof import('@simplewebauthn/browser') | null = null
const stepUpFlow = createWebAuthnFlow(() => webAuthnSdk?.WebAuthnAbortService.cancelCeremony())

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
      return '完全停用两步验证'
    case 'disable-totp':
      return '关闭动态码验证'
    case 'enable-key':
      return '使用已有密钥开启两步验证'
    case 'regenerate':
      return '重新生成恢复码'
    default:
      return '两步验证'
  }
})

// 手动输入秘钥时按 4 位分组展示，降低抄错概率；复制时仍复制无空格原文。
const groupedSecret = computed(() => enrollment.secret.match(/.{1,4}/g)?.join(' ') ?? '')

const enabledAtText = computed(() => (status.value?.enabledAt ? dayjs(status.value.enabledAt).format('YYYY-MM-DD HH:mm') : '-'))

const recoveryCodesLow = computed(() => Boolean(status.value?.mfaRequired) && (status.value?.recoveryCodesRemaining ?? 0) <= RECOVERY_CODES_LOW_THRESHOLD)

const resetForm = () => {
  form.currentPassword = ''
  form.code = ''
  form.recoveryCode = ''
  form.useRecoveryCode = false
  form.useWebAuthn = false
}

const clearEnrollment = () => {
  enrollment.secret = ''
  enrollment.otpauthUri = ''
  enrollment.qrDataUrl = ''
  enrollment.qrLoading = false
  enrollment.qrFailed = false
}

const goToStage = (nextStage: MfaDialogStage, fromCompletedAction = false) => {
  if (!fromCompletedAction && (submitting.value || recoveryFinalPending.value || recoveryCodes.value.length > 0)) return
  stepUpFlow.cancel()
  resetForm()
  if (status.value?.mfaRequired && !status.value.availableMethods.includes('totp') && status.value.availableMethods.includes('webauthn')) form.useWebAuthn = true
  stage.value = nextStage
}

const loadStatus = async () => {
  loading.value = true
  try {
    status.value = await getAdminMfaStatus()
    strongCredentialCount.value = (await getAdminWebAuthnCredentials().catch(() => [])).filter((credential) => credential.usage === 'passwordless').length
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
    if (visible && !submitting.value && !recoveryFinalPending.value && recoveryCodes.value.length === 0) void loadStatus()
    else if (submitting.value || recoveryFinalPending.value || recoveryCodes.value.length > 0) emit('update:modelValue', true)
  },
  { immediate: true },
)

const closeDialog = () => {
  if (submitting.value || recoveryFinalPending.value || recoveryCodes.value.length > 0) return
  emit('update:modelValue', false)
}
onBeforeRouteLeave(() => { if (submitting.value || disableAllPending.value || recoveryFinalPending.value || recoveryCodes.value.length > 0) return false })

// 关闭动画结束后清空全部敏感状态，下次打开重新读取服务端状态。
const handleClosed = () => {
  if (recoveryFinalPending.value || recoveryCodes.value.length > 0) return
  stepUpFlow.cancel()
  resetForm()
  clearEnrollment()
  recoveryCodes.value = []
  status.value = null
  strongCredentialCount.value = 0
  stage.value = 'status'
}
onBeforeUnmount(() => { stepUpFlow.cancel(); resetForm(); recoveryCodes.value = [] })

const obtainWebAuthnProof = async (action: AdminWebAuthnStepUpAction, currentPassword: string) => {
  const operation = stepUpFlow.start()
  try {
    const challenge = await startAdminWebAuthnStepUp({ currentPassword, action }, { signal: operation.signal })
    if (!stepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    const sdk = await import('@simplewebauthn/browser')
    if (!stepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    webAuthnSdk = sdk
    const response = await sdk.startAuthentication({ optionsJSON: challenge.options })
    if (!stepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    const result = await verifyAdminWebAuthnStepUp({ challengeId: challenge.challengeId, response }, { signal: operation.signal })
    if (!stepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    return result.stepUpProof
  } finally { stepUpFlow.finish(operation.id) }
}

const checkedFactor = async (action: AdminWebAuthnStepUpAction, allowRecovery = true): Promise<{ code?: string; recoveryCode?: string; stepUpProof?: string } | null> => {
  if (!status.value?.mfaRequired) return {}
  if (form.useWebAuthn) return { stepUpProof: await obtainWebAuthnProof(action, form.currentPassword) }
  if (form.useRecoveryCode) {
    if (!allowRecovery) { showAppWarning('恢复码不能用于生成新的恢复码'); return null }
    if (!status.value.availableMethods.includes('recovery_code') || !form.recoveryCode.trim()) { showAppWarning('请输入可用恢复码'); return null }
    return { recoveryCode: form.recoveryCode.trim() }
  }
  const code = normalizeCodeInput(form.code)
  if (!status.value.availableMethods.includes('totp') || !/^\d{6}$/.test(code)) { showAppWarning('请输入 6 位数字动态码，或切换其他可用方式'); return null }
  return { code }
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
    const proof = await checkedFactor('mfa.totp.enroll')
    if (!proof) return
    const result = await startAdminMfaEnrollment(form.currentPassword, proof)
    goToStage('enroll-scan', true)
    enrollment.secret = result.secret
    enrollment.otpauthUri = result.otpauthUri
    void renderEnrollmentQrCode(result.otpauthUri)
  } catch (error) {
    form.currentPassword = ''
    if (isWebAuthnCancellation(error)) showAppWarning('安全密钥复核已取消')
    else showAppError(extractErrorMessage(error, '发起绑定失败，请稍后重试'))
  } finally {
    submitting.value = false
  }
}

const handleConfirmEnrollment = async () => {
  if (submitting.value || stage.value !== 'enroll-scan' || recoveryCodes.value.length > 0) return
  const code = normalizeCodeInput(form.code)
  if (!/^\d{6}$/.test(code)) {
    showAppWarning('请输入身份验证器中显示的 6 位动态码')
    return
  }
  submitting.value = true
  try {
    recoveryFinalPending.value = true
    const result = await confirmAdminMfaEnrollment(code)
    recoveryFinalPending.value = false
    clearEnrollment()
    if (result.recoveryCodes.length) {
      goToStage('recovery-codes', true)
      recoveryCodes.value = result.recoveryCodes
      showAppSuccess('两步验证已开启，请保存新恢复码')
    } else {
      await loadStatus()
      showAppSuccess('动态码已绑定，原恢复码仍有效')
    }
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
    recoveryFinalPending.value = false
    submitting.value = false
  }
}

const handleFinishRecoveryCodes = async () => {
  if (submitting.value || stage.value !== 'recovery-codes') return
  recoveryCodes.value = []
  await loadStatus()
}

const handleDisable = async () => {
  if (submitting.value) return
  if (!form.currentPassword) {
    showAppWarning('请输入当前登录密码')
    return
  }
  const disableTotpOnly = stage.value === 'disable-totp'
  submitting.value = true
  try {
    if (!disableTotpOnly) {
      await ElMessageBox.confirm('完全停用后，动态码、密码后密钥和恢复码都不再作为登录第二步；下次仅凭密码即可登录。确认继续吗？', '完全停用两步验证', {
        type: 'warning', confirmButtonText: '确认完全停用', cancelButtonText: '取消',
      })
    }
    const proof = await checkedFactor(disableTotpOnly ? 'mfa.totp.disable' : 'mfa.disable_all')
    if (!proof) return
    if (disableTotpOnly) {
      await disableAdminTotp({ currentPassword: form.currentPassword, ...proof })
      showAppSuccess('动态码验证已关闭')
      await loadStatus()
    } else {
      // 完全停用已由服务端吊销所有会话；不能再以旧会话读取状态。
      disableAllPending.value = true
      await disableAdminMfa({ currentPassword: form.currentPassword, ...proof })
      authStore.clearAuthState({ resetInitialized: true })
      emit('update:modelValue', false)
      showAppSuccess('两步验证已完全停用，请重新登录')
      disableAllPending.value = false
      redirectToAdminLogin()
    }
  } catch (error) {
    form.code = ''
    form.recoveryCode = ''
    if (error === 'cancel' || error === 'close') return
    if (isWebAuthnCancellation(error)) showAppWarning('安全密钥复核已取消')
    else showAppError(extractErrorMessage(error, '停用两步验证失败，请稍后重试'))
  } finally {
    disableAllPending.value = false
    submitting.value = false
    form.currentPassword = ''
  }
}

const handleRegenerate = async () => {
  if (submitting.value || stage.value !== 'regenerate' || recoveryCodes.value.length > 0) return
  if (!form.currentPassword) {
    showAppWarning('请输入当前登录密码')
    return
  }
  submitting.value = true
  try {
    const proof = await checkedFactor('mfa.recovery_codes', false)
    if (!proof) return
    recoveryFinalPending.value = true
    const result = await regenerateAdminMfaRecoveryCodes({ currentPassword: form.currentPassword, ...proof })
    recoveryFinalPending.value = false
    goToStage('recovery-codes', true)
    recoveryCodes.value = result.recoveryCodes
    showAppSuccess('已生成新的恢复码，旧恢复码全部失效')
  } catch (error) {
    form.code = ''
    if (isWebAuthnCancellation(error)) showAppWarning('安全密钥复核已取消')
    else showAppError(extractErrorMessage(error, '重新生成恢复码失败，请稍后重试'))
  } finally {
    recoveryFinalPending.value = false
    submitting.value = false
  }
}

const handleEnableKey = async () => {
  if (submitting.value || stage.value !== 'enable-key' || recoveryCodes.value.length > 0) return
  if (!form.currentPassword) { showAppWarning('请输入当前登录密码'); return }
  submitting.value = true
  try {
    const stepUpProof = await obtainWebAuthnProof('mfa.webauthn.enable', form.currentPassword)
    recoveryFinalPending.value = true
    const result = await enableAdminWebAuthnMfa({ currentPassword: form.currentPassword, stepUpProof })
    recoveryFinalPending.value = false
    goToStage('recovery-codes', true)
    recoveryCodes.value = result.recoveryCodes
    showAppSuccess('已使用现有密钥开启两步验证')
  } catch (error) {
    if (isWebAuthnCancellation(error)) showAppWarning('安全密钥复核已取消')
    else showAppError(extractErrorMessage(error, '开启密钥两步验证失败'))
  } finally {
    recoveryFinalPending.value = false
    form.currentPassword = ''
    submitting.value = false
  }
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
    @update:model-value="!$event && closeDialog()"
    @closed="handleClosed"
  >
    <el-skeleton v-if="loading" :rows="3" animated />

    <template v-else-if="stage === 'status' && status">
      <div class="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3 dark:bg-white/5">
        <div class="text-sm font-semibold text-slate-700 dark:text-slate-200">当前状态</div>
        <el-tag :type="status.mfaRequired ? 'success' : 'info'" effect="light">{{ status.mfaRequired ? '已开启' : '未开启' }}</el-tag>
      </div>
      <div v-if="status.mfaRequired" class="mt-3 grid gap-2 text-sm text-slate-600 dark:text-slate-300">
        <div class="flex items-center justify-between gap-3">
          <span class="text-slate-400">动态码</span>
          <span>{{ status.totpEnabled ? `已启用（${enabledAtText}）` : '未启用' }}</span>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-slate-400">密码后密钥</span>
          <span>{{ status.availableMethods.includes('webauthn') ? '可用' : '未启用' }}</span>
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
        <el-alert v-if="!status.totpEnabled && !status.availableMethods.includes('webauthn')" type="warning" :closable="false" title="目前仅剩恢复码可用，请尽快重新绑定动态码，或联系管理员重置。" />
      </div>
      <p v-else class="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
        可绑定身份验证器应用，或显式使用已有的直接登录强凭据（通行密钥或安全密钥）开启密码后验证。创建直接登录凭据不会自动开启两步验证。
      </p>
    </template>

    <template v-else-if="stage === 'enroll-password' || stage === 'disable' || stage === 'disable-totp' || stage === 'regenerate' || stage === 'enable-key'">
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        <template v-if="stage === 'enroll-password'">为确认是本人操作，请输入当前密码；已开启两步验证时还需选择一种可用复核方式。</template>
        <template v-else-if="stage === 'disable'">这会完全停用所有密码后验证方式。请输入当前密码和一种可用复核方式。</template>
        <template v-else-if="stage === 'disable-totp'">仅关闭动态码，已绑定的密码后密钥仍作为登录第二步。请输入当前密码和复核方式。</template>
        <template v-else-if="stage === 'enable-key'">使用已存在的直接登录强凭据（通行密钥或安全密钥）开启密码后验证；此操作不会注册新密钥。</template>
        <template v-else>重新生成后旧恢复码全部失效，恢复码本身不能用来换新码。</template>
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
        <el-form-item v-if="stage !== 'enable-key' && status?.mfaRequired && !form.useWebAuthn && !form.useRecoveryCode" label="动态码">
          <el-input
            v-model.trim="form.code"
            placeholder="身份验证器中的 6 位动态码"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="7"
          />
        </el-form-item>
        <el-form-item v-if="stage !== 'enable-key' && stage !== 'regenerate' && status?.mfaRequired && form.useRecoveryCode && !form.useWebAuthn" label="恢复码">
          <el-input
            v-model.trim="form.recoveryCode"
            placeholder="单个恢复码，例如ABCD-EFGH-JKLM"
            autocomplete="off"
            maxlength="32"
            @paste="guardRecoveryCodePaste($event, showAppWarning)"
          />
        </el-form-item>
      </el-form>
      <div v-if="stage !== 'enable-key' && status?.mfaRequired" class="flex flex-wrap gap-1">
        <el-button v-if="status.availableMethods.includes('totp')" link type="primary" @click="form.useWebAuthn = false; form.useRecoveryCode = false">动态码</el-button>
        <el-button v-if="stage !== 'regenerate' && status.availableMethods.includes('recovery_code')" link type="primary" @click="form.useWebAuthn = false; form.useRecoveryCode = true">恢复码</el-button>
        <el-button v-if="status.availableMethods.includes('webauthn')" link type="primary" @click="form.useWebAuthn = true; form.useRecoveryCode = false">已绑定密钥</el-button>
      </div>
      <el-alert v-if="form.useWebAuthn || stage === 'enable-key'" class="mt-2" type="info" :closable="false" title="继续后浏览器会请求已绑定的强凭据完成安全复核。" />
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
        description="每个恢复码只能使用一次，验证时每次仅输入其中一条。复制全部仅供保存，不能直接粘贴到验证框；确认保存后将无法再次查看。"
      />
      <div class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div
          v-for="code in recoveryCodes"
          :key="code"
          class="flex min-w-0 flex-wrap items-center justify-between gap-1 rounded-xl bg-slate-50 px-3 py-2 dark:bg-white/5"
        >
          <code class="break-all font-mono text-sm tracking-wider text-slate-700 dark:text-slate-200">{{ code }}</code>
          <el-button link type="primary" size="small" @click="copyText(code, '单条恢复码已复制')">复制此条</el-button>
        </div>
      </div>
    </template>

    <template #footer>
      <span class="flex flex-wrap justify-end gap-2">
        <template v-if="stage === 'status'">
          <el-button @click="closeDialog">关闭</el-button>
          <template v-if="status?.mfaRequired">
            <el-button v-if="status.availableMethods.includes('totp') || status.availableMethods.includes('webauthn')" :disabled="loading" @click="goToStage('regenerate')">重新生成恢复码</el-button>
            <el-button v-if="!status.totpEnabled" :disabled="loading" @click="goToStage('enroll-password')">绑定动态码</el-button>
            <el-button v-if="status.totpEnabled && status.availableMethods.includes('webauthn')" :disabled="loading" @click="goToStage('disable-totp')">关闭动态码</el-button>
            <el-button type="danger" plain :disabled="loading" @click="goToStage('disable')">完全停用两步验证</el-button>
          </template>
          <template v-else>
            <el-button type="primary" :disabled="loading || !status" @click="goToStage('enroll-password')">绑定动态码</el-button>
            <el-button v-if="strongCredentialCount > 0" :disabled="loading" @click="goToStage('enable-key')">使用已有强凭据开启</el-button>
          </template>
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
          <el-button @click="copyText(recoveryCodes.join('\n'), '全部恢复码已复制，请妥善保存')">复制全部用于保存</el-button>
          <el-button type="primary" @click="handleFinishRecoveryCodes">我已妥善保存</el-button>
        </template>
        <template v-else-if="stage === 'disable'">
          <el-button @click="goToStage('status')">返回</el-button>
          <el-button type="danger" :loading="submitting" @click="handleDisable">完全停用</el-button>
        </template>
        <template v-else-if="stage === 'disable-totp'">
          <el-button @click="goToStage('status')">返回</el-button>
          <el-button type="warning" :loading="submitting" @click="handleDisable">关闭动态码</el-button>
        </template>
        <template v-else-if="stage === 'regenerate'">
          <el-button @click="goToStage('status')">返回</el-button>
          <el-button type="primary" :loading="submitting" @click="handleRegenerate">重新生成</el-button>
        </template>
        <template v-else-if="stage === 'enable-key'">
          <el-button @click="goToStage('status')">返回</el-button>
          <el-button type="primary" :loading="submitting" @click="handleEnableKey">验证并开启</el-button>
        </template>
      </span>
    </template>
  </BizCrudDialogShell>
</template>
