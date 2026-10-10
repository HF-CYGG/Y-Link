<script setup lang="ts">
/**
 * 模块说明：src/components/account/AdminWebAuthnDialog.vue
 * 文件职责：管理本人直接登录凭据和密码后验证密钥，包含用途选择、列表、添加、改名和删除。
 * 实现逻辑：添加时先选登录用途、再选密钥类型；按用途展示名称、设备及使用时间；首次独立绑定密码后密钥时一次展示恢复码；已开启 MFA 的敏感操作可用强密钥复核。
 * 维护说明：密码、动态码、恢复码和挑战只保存在当前弹窗内存；最终注册或删除请求在途时需等待明确结果，删除成功立即清空本地会话。
 */
import dayjs from 'dayjs'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { BizCrudDialogShell } from '@/components/common'
import { getAdminMfaStatus, type AdminMfaStatus } from '@/api/modules/admin-mfa'
import {
  deleteAdminWebAuthnCredential,
  getAdminWebAuthnCapabilities,
  getAdminWebAuthnCredentials,
  renameAdminWebAuthnCredential,
  startAdminWebAuthnRegistration,
  startAdminWebAuthnStepUp,
  verifyAdminWebAuthnRegistration,
  verifyAdminWebAuthnStepUp,
  type AdminWebAuthnCredential,
  type AdminWebAuthnStepUp,
} from '@/api/modules/admin-webauthn'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { redirectToAdminLogin } from '@/utils/auth-navigation'
import { assessWebAuthnAvailability, createWebAuthnFlow, isWebAuthnCancellation, type AdminWebAuthnCapabilities } from '@/utils/admin-webauthn'
import { guardRecoveryCodePaste } from '@/utils/admin-mfa-recovery-code'
import { extractErrorMessage } from '@/utils/error'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type Stage = 'list' | 'add' | 'rename' | 'delete' | 'recovery'
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const authStore = useAuthStore(pinia)
const stage = ref<Stage>('list')
const selected = ref<AdminWebAuthnCredential | null>(null)
const credentials = ref<AdminWebAuthnCredential[]>([])
const recoveryCodes = ref<string[]>([])
const capabilities = ref<AdminWebAuthnCapabilities | null>(null)
const capabilitiesPhase = ref<'loading' | 'ready' | 'error'>('loading')
const mfaStatus = ref<AdminMfaStatus | null>(null)
const mfaPhase = ref<'loading' | 'ready' | 'error'>('loading')
const listLoading = ref(false)
const listError = ref('')
const submitting = ref(false)
const deletePending = ref(false)
const confirmationPending = ref(false)
const ceremonyPhase = ref<'idle' | 'options' | 'browser' | 'verify'>('idle')
const form = reactive({
  name: '',
  kind: 'passkey' as 'passkey' | 'security_key',
  usage: 'passwordless' as 'passwordless' | 'second_factor',
  currentPassword: '',
  code: '',
  recoveryCode: '',
  useRecoveryCode: false,
  useWebAuthn: false,
})
let epoch = 0
let confirmationSerial = 0
let loadController: AbortController | null = null
let sdk: typeof import('@simplewebauthn/browser') | null = null
const ceremony = createWebAuthnFlow(() => sdk?.WebAuthnAbortService.cancelCeremony())
const stepUpCeremony = createWebAuthnFlow(() => sdk?.WebAuthnAbortService.cancelCeremony())
const title = computed(() => ({ list: '我的通行密钥', add: '添加密钥', rename: '修改密钥名称', delete: '删除密钥', recovery: '保存恢复码' })[stage.value])
const availability = computed(() => capabilities.value
  ? assessWebAuthnAvailability(capabilities.value, {
    origin: globalThis.window?.location.origin ?? '',
    secure: globalThis.window?.isSecureContext === true,
    supported: typeof globalThis.PublicKeyCredential !== 'undefined' && Boolean(globalThis.navigator?.credentials?.create),
  })
  : { available: false, message: capabilitiesPhase.value === 'loading' ? '正在检查添加密钥能力…' : '添加密钥能力暂不可确认。' })
const busy = computed(() => submitting.value || confirmationPending.value || ceremonyPhase.value !== 'idle')
const committed = computed(() => submitting.value || ceremonyPhase.value === 'verify' || recoveryCodes.value.length > 0)

const clearProof = () => {
  form.currentPassword = ''
  form.code = ''
  form.recoveryCode = ''
  form.useRecoveryCode = false
  form.useWebAuthn = false
}
const clearSensitive = () => {
  if (confirmationPending.value) ElMessageBox.close()
  ceremony.cancel()
  stepUpCeremony.cancel()
  loadController?.abort()
  loadController = null
  epoch += 1
  confirmationSerial += 1
  confirmationPending.value = false
  clearProof()
  form.name = ''
  form.kind = 'passkey'
  form.usage = 'passwordless'
  recoveryCodes.value = []
  selected.value = null
  credentials.value = []
  capabilities.value = null
  mfaStatus.value = null
  listError.value = ''
  listLoading.value = false
  stage.value = 'list'
  ceremonyPhase.value = 'idle'
  submitting.value = false
}
const close = () => {
  if (committed.value) return
  clearSensitive()
  emit('update:modelValue', false)
}
const updateVisible = (visible: boolean) => {
  if (!visible && committed.value) return
  if (!visible) clearSensitive()
  emit('update:modelValue', visible)
}
const current = (id: number) => props.modelValue && id === epoch
const loadCredentials = async (id: number, signal?: AbortSignal) => {
  listLoading.value = true
  listError.value = ''
  try {
    const result = await getAdminWebAuthnCredentials({ signal })
    if (current(id)) credentials.value = result
  } catch (error) {
    if (current(id) && !signal?.aborted) listError.value = extractErrorMessage(error, '读取密钥列表失败')
  } finally {
    if (current(id)) listLoading.value = false
  }
}
const loadInitial = () => {
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const id = ++epoch
  capabilitiesPhase.value = 'loading'
  mfaPhase.value = 'loading'
  void loadCredentials(id, controller.signal)
  void getAdminWebAuthnCapabilities({ signal: controller.signal }).then((result) => {
    if (!current(id)) return
    capabilities.value = result
    capabilitiesPhase.value = 'ready'
  }).catch(() => {
    if (!current(id) || controller.signal.aborted) return
    capabilities.value = null
    capabilitiesPhase.value = 'error'
  })
  void getAdminMfaStatus().then((result) => {
    if (!current(id)) return
    mfaStatus.value = result
    mfaPhase.value = 'ready'
  }).catch(() => {
    if (current(id)) mfaPhase.value = 'error'
  })
}
watch(() => props.modelValue, (visible) => {
  if (visible && !committed.value) loadInitial()
  else if (committed.value) emit('update:modelValue', true)
  else clearSensitive()
}, { immediate: true })
onBeforeUnmount(clearSensitive)
// 最终注册、删除 HTTP 在途及一次性恢复码展示期间，不允许离开管理端布局。
onBeforeRouteLeave(() => {
  if (deletePending.value || ceremonyPhase.value === 'verify' || recoveryCodes.value.length > 0) return false
})

const goToList = (force = false) => {
  if (!force && committed.value) return
  if (confirmationPending.value) ElMessageBox.close()
  confirmationSerial += 1
  confirmationPending.value = false
  ceremony.cancel()
  stepUpCeremony.cancel()
  ceremonyPhase.value = 'idle'
  submitting.value = false
  clearProof()
  recoveryCodes.value = []
  form.name = ''
  selected.value = null
  stage.value = 'list'
}
const openAdd = () => {
  if (committed.value) return
  if (!availability.value.available || credentials.value.length >= 10) return
  goToList()
  form.useWebAuthn = Boolean(mfaStatus.value?.mfaRequired && !mfaStatus.value.availableMethods.includes('totp') && mfaStatus.value.availableMethods.includes('webauthn'))
  stage.value = 'add'
}
const openRename = (credential: AdminWebAuthnCredential) => {
  if (committed.value) return
  goToList()
  selected.value = credential
  form.name = credential.name
  stage.value = 'rename'
}
const openDelete = (credential: AdminWebAuthnCredential) => {
  if (committed.value) return
  goToList()
  form.useWebAuthn = Boolean(mfaStatus.value?.mfaRequired && !mfaStatus.value.availableMethods.includes('totp') && mfaStatus.value.availableMethods.includes('webauthn'))
  selected.value = credential
  stage.value = 'delete'
}
const checkedName = () => {
  const name = form.name.trim()
  if (name.length < 1 || name.length > 64) {
    showAppWarning('密钥名称须为 1 至 64 个字符')
    return null
  }
  return name
}
const checkedProof = (): AdminWebAuthnStepUp | null => {
  if (mfaPhase.value !== 'ready') {
    showAppWarning('尚未确认两步验证状态，请重试读取')
    return null
  }
  if (!form.currentPassword) {
    showAppWarning('请输入当前密码')
    return null
  }
  const payload: AdminWebAuthnStepUp = { currentPassword: form.currentPassword }
  if (mfaStatus.value?.mfaRequired) {
    if (form.useWebAuthn) {
      if (!mfaStatus.value.availableMethods.includes('webauthn')) { showAppWarning('当前账号没有可用于复核的安全密钥'); return null }
    } else if (form.useRecoveryCode) {
      if (!mfaStatus.value.availableMethods.includes('recovery_code')) { showAppWarning('当前账号没有可用恢复码'); return null }
      if (!form.recoveryCode.trim()) { showAppWarning('请输入恢复码'); return null }
      payload.recoveryCode = form.recoveryCode.trim()
    } else {
      if (!mfaStatus.value.availableMethods.includes('totp')) { showAppWarning('请选择可用的复核方式'); return null }
      const code = form.code.replace(/\s/g, '')
      if (!/^\d{6}$/.test(code)) { showAppWarning('请输入 6 位数字动态码'); return null }
      payload.code = code
    }
  }
  return payload
}

const resolveStepUpProof = async (proof: AdminWebAuthnStepUp, action: 'webauthn.register' | 'webauthn.delete', targetId?: string): Promise<AdminWebAuthnStepUp> => {
  if (!form.useWebAuthn) return proof
  const operation = stepUpCeremony.start()
  try {
    const challenge = await startAdminWebAuthnStepUp({ currentPassword: proof.currentPassword, action, ...(targetId ? { targetId } : {}) }, { signal: operation.signal })
    if (!stepUpCeremony.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    const browserSdk = await import('@simplewebauthn/browser')
    if (!stepUpCeremony.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    sdk = browserSdk
    const response = await browserSdk.startAuthentication({ optionsJSON: challenge.options })
    if (!stepUpCeremony.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    const result = await verifyAdminWebAuthnStepUp({ challengeId: challenge.challengeId, response }, { signal: operation.signal })
    if (!stepUpCeremony.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    return { currentPassword: proof.currentPassword, stepUpProof: result.stepUpProof }
  } finally {
    stepUpCeremony.finish(operation.id)
  }
}

const addCredential = async () => {
  if (busy.value || !availability.value.available || credentials.value.length >= 10) return
  const name = checkedName()
  const proof = checkedProof()
  if (!name || !proof) return
  if (form.usage === 'second_factor' && form.kind !== 'security_key') { showAppWarning('密码后验证请选择安全密钥类型'); return }
  const accountLabel = authStore.currentUser?.username || '原账号'
  const operation = ceremony.start()
  ceremonyPhase.value = 'options'
  let verificationSubmitted = false
  try {
    const verifiedProof = form.useWebAuthn ? await resolveStepUpProof(proof, 'webauthn.register') : proof
    if (!ceremony.isCurrent(operation.id) || !props.modelValue || stage.value !== 'add') return
    const challenge = await startAdminWebAuthnRegistration({ name, kind: form.kind, usage: form.usage, ...verifiedProof }, { signal: operation.signal })
    if (!ceremony.isCurrent(operation.id) || !props.modelValue || stage.value !== 'add') return
    clearProof()
    const browserSdk = await import('@simplewebauthn/browser')
    if (!ceremony.isCurrent(operation.id) || !props.modelValue || stage.value !== 'add') return
    sdk = browserSdk
    ceremonyPhase.value = 'browser'
    const response = await browserSdk.startRegistration({ optionsJSON: challenge.options })
    if (!ceremony.isCurrent(operation.id) || !props.modelValue || stage.value !== 'add') return
    ceremonyPhase.value = 'verify'
    verificationSubmitted = true
    // 最终验证可能已经在服务端落库；提交后保持弹窗打开直至有明确结果。
    const registration = await verifyAdminWebAuthnRegistration({ challengeId: challenge.challengeId, response })
    // 最终请求期间关闭和路由离开受阻；必须先接收并展示仅一次返回的恢复码。
    showAppSuccess(`已为“${accountLabel}”添加密钥“${name}”`)
    if (!ceremony.isCurrent(operation.id) || stage.value !== 'add') return
    if (!props.modelValue) emit('update:modelValue', true)
    ceremony.finish(operation.id)
    ceremonyPhase.value = 'idle'
    if (registration.recoveryCodes?.length) {
      recoveryCodes.value = registration.recoveryCodes
      stage.value = 'recovery'
      return
    }
    goToList(true)
    await loadCredentials(epoch, loadController?.signal)
  } catch (error) {
    if (verificationSubmitted && (!ceremony.isCurrent(operation.id) || !props.modelValue)) {
      showAppError(`“${accountLabel}”的密钥“${name}”注册结果尚未确认，请返回原账号检查密钥列表后再重试。`)
      return
    }
    if (!ceremony.isCurrent(operation.id) || !props.modelValue) return
    if (isWebAuthnCancellation(error)) showAppWarning('密钥操作已取消或超时，可重新尝试')
    else showAppError(extractErrorMessage(error, '添加密钥失败'))
  } finally {
    if (ceremony.isCurrent(operation.id) && props.modelValue && stage.value === 'add') {
      ceremony.finish(operation.id)
      ceremonyPhase.value = 'idle'
      clearProof()
    }
  }
}

const renameCredential = async () => {
  if (busy.value || !selected.value) return
  const name = checkedName()
  if (!name) return
  submitting.value = true
  const id = epoch
  try {
    await renameAdminWebAuthnCredential(selected.value.id, name, { signal: loadController?.signal })
    if (!current(id)) return
    showAppSuccess('密钥名称已更新')
    goToList(true)
    await loadCredentials(id, loadController?.signal)
  } catch (error) {
    if (current(id)) showAppError(extractErrorMessage(error, '修改名称失败'))
  } finally {
    if (current(id)) submitting.value = false
  }
}

const deleteCredential = async () => {
  if (busy.value || !selected.value) return
  const proof = checkedProof()
  if (!proof) return
  const target = selected.value
  const confirmationEpoch = epoch
  const confirmationId = confirmationSerial
  confirmationPending.value = true
  try {
    await ElMessageBox.confirm(`确认删除“${target.name}”吗？删除后当前账号的所有登录会话都会立即失效，需要重新登录。`, '删除密钥', {
      type: 'warning', confirmButtonText: '删除并重新登录', cancelButtonText: '取消',
    })
  } catch {
    if (confirmationEpoch === epoch && confirmationId === confirmationSerial) confirmationPending.value = false
    return
  }
  if (confirmationEpoch !== epoch || confirmationId !== confirmationSerial || !props.modelValue || selected.value?.id !== target.id || submitting.value) return
  confirmationPending.value = false
  submitting.value = true
  deletePending.value = true
  const id = epoch
  try {
    // 服务端删除任意密钥即撤销全部会话；结果到达后必须清本地状态，即使页面刚卸载。
    const verifiedProof = form.useWebAuthn ? await resolveStepUpProof(proof, 'webauthn.delete', String(target.id)) : proof
    if (!current(id)) return
    await deleteAdminWebAuthnCredential(target.id, verifiedProof)
    deletePending.value = false
    clearSensitive()
    authStore.clearAuthState({ resetInitialized: true })
    redirectToAdminLogin()
  } catch (error) {
    deletePending.value = false
    if (current(id)) showAppError(extractErrorMessage(error, '删除密钥失败'))
  } finally {
    deletePending.value = false
    if (current(id) && stage.value === 'delete') {
      clearProof()
      submitting.value = false
    }
  }
}
const confirm = () => {
  if (stage.value === 'add') void addCredential()
  else if (stage.value === 'rename') void renameCredential()
  else if (stage.value === 'delete') void deleteCredential()
}
const deviceLabel = (credential: AdminWebAuthnCredential) => credential.deviceType === 'multiDevice' ? '可同步密钥' : '单设备密钥'
watch(() => form.usage, (usage) => { if (usage === 'second_factor') form.kind = 'security_key' })
const copyRecoveryCodes = async () => {
  try {
    await navigator.clipboard.writeText(recoveryCodes.value.join('\n'))
    showAppSuccess('全部恢复码已复制，请妥善保存')
  } catch { showAppWarning('请手动保存恢复码') }
}
const copyRecoveryCode = async (code: string) => {
  try {
    await navigator.clipboard.writeText(code)
    showAppSuccess('单条恢复码已复制')
  } catch { showAppWarning('请手动复制此条恢复码') }
}
const acknowledgeRecoveryCodes = () => {
  recoveryCodes.value = []
  goToList(true)
  void loadCredentials(epoch, loadController?.signal)
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="modelValue"
    :title="title"
    height-mode="scroll"
    phone-width="94%"
    tablet-width="640px"
    desktop-width="600px"
    :confirm-loading="busy"
    @update:model-value="updateVisible"
  >
    <el-alert v-if="ceremonyPhase === 'verify' || deletePending" type="info" :closable="false" title="正在完成密钥操作，请等待结果后再关闭。" class="mb-3" />
    <template v-if="stage === 'list'">
      <el-alert v-if="capabilitiesPhase === 'error'" type="warning" :closable="false" title="添加密钥能力暂不可确认；已有密钥仍可查看、改名或删除。" class="mb-3" />
      <el-alert v-else-if="!availability.available" type="info" :closable="false" :title="availability.message" class="mb-3" />
      <p class="mb-3 text-sm text-slate-500">最多可保存 10 把密钥。直接登录凭据无需密码；密码后验证密钥用于已开启的两步验证。</p>
      <el-button :disabled="!availability.available || credentials.length >= 10 || listLoading" type="primary" @click="openAdd">添加密钥</el-button>
      <el-button v-if="capabilitiesPhase === 'error'" @click="loadInitial">重试能力检查</el-button>
      <el-alert v-if="listError" type="error" :closable="false" :title="listError" class="mt-3" />
      <el-button v-if="listError" class="mt-2" @click="loadInitial">重试列表</el-button>
      <div v-loading="listLoading" class="mt-4 min-h-20 space-y-3">
        <div v-if="!listLoading && !listError && credentials.length === 0" class="rounded-xl bg-slate-50 p-4 text-sm text-slate-500 dark:bg-white/5">尚未添加密钥。</div>
        <div v-for="credential in credentials" :key="credential.id" class="rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="break-all font-medium">{{ credential.name }}</div>
              <el-tag class="mt-1" size="small" :type="credential.usage === 'second_factor' ? 'warning' : 'success'" effect="plain">{{ credential.usage === 'second_factor' ? '密码后验证' : '直接登录' }}</el-tag>
              <div class="mt-1 text-xs text-slate-500">{{ deviceLabel(credential) }} · {{ credential.backedUp ? '已备份' : '未备份' }}</div>
              <div class="mt-1 text-xs text-slate-500">创建：{{ dayjs(credential.createdAt).format('YYYY-MM-DD HH:mm') }} · 最近使用：{{ credential.lastUsedAt ? dayjs(credential.lastUsedAt).format('YYYY-MM-DD HH:mm') : '暂无' }}</div>
            </div>
            <div class="flex gap-2">
              <el-button link type="primary" @click="openRename(credential)">改名</el-button>
              <el-button link type="danger" @click="openDelete(credential)">删除</el-button>
            </div>
          </div>
        </div>
      </div>
    </template>
    <template v-else-if="stage === 'recovery'">
      <el-alert type="warning" :closable="false" title="请立即保存这 10 个恢复码" description="这是首次启用密码后密钥验证时仅展示一次的恢复码。验证时每次仅输入其中一条；复制全部仅供保存，不能直接粘贴到验证框。确认保存后无法再次查看，每个只能使用一次。" />
      <div class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div v-for="code in recoveryCodes" :key="code" class="flex min-w-0 flex-wrap items-center justify-between gap-1 rounded-xl bg-slate-50 px-3 py-2 dark:bg-white/5">
          <code class="break-all font-mono text-sm">{{ code }}</code>
          <el-button link type="primary" size="small" @click="copyRecoveryCode(code)">复制此条</el-button>
        </div>
      </div>
    </template>
    <template v-else>
      <el-alert v-if="stage === 'add'" type="info" :closable="false" title="直接登录凭据可由浏览器保存到设备、Google 密码管理器、iCloud 钥匙串或安全密钥；密码后验证请求安全密钥类型。最终创建方式及 USB/NFC 是否可用，以浏览器和认证器提示为准。" class="mb-3" />
      <el-alert v-if="stage === 'delete'" type="warning" :closable="false" title="删除密钥会使当前账号所有登录会话失效。若已开启两步验证，不能移除最后一个可用的常规验证方式；请先绑定其他方式，或明确完全停用两步验证。" class="mb-3" />
      <p v-if="selected" class="mb-3 text-sm text-slate-600">当前密钥：{{ selected.name }}</p>
      <el-form label-position="top" @submit.prevent="confirm">
        <el-form-item v-if="stage !== 'delete'" label="密钥名称">
          <el-input v-model="form.name" maxlength="64" show-word-limit placeholder="1 至 64 个字符" />
        </el-form-item>
        <el-form-item v-if="stage === 'add'" label="登录用途">
          <el-radio-group v-model="form.usage" aria-label="登录用途" class="credential-choice-group">
            <el-radio value="passwordless">
              <span class="credential-choice-copy"><strong>直接登录</strong><small>使用密钥登录，无需输入账号密码</small></span>
            </el-radio>
            <el-radio value="second_factor">
              <span class="credential-choice-copy"><strong>密码后验证</strong><small>输入密码后作为第二步验证</small></span>
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="stage === 'add'" label="密钥类型">
          <el-radio-group v-model="form.kind" aria-label="密钥类型" class="credential-choice-group credential-choice-group--kind" :class="{ 'credential-choice-group--single': form.usage === 'second_factor' }">
            <el-radio v-if="form.usage === 'passwordless'" value="passkey">
              <span class="credential-choice-copy"><strong>通行密钥</strong><small>设备或密码管理器</small></span>
            </el-radio>
            <el-radio value="security_key">
              <span class="credential-choice-copy"><strong>安全密钥类型</strong><small>具体设备以浏览器提示为准</small></span>
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="stage === 'add' || stage === 'delete'">
          <el-alert v-if="mfaPhase === 'error'" type="warning" :closable="false" title="两步验证状态读取失败，请关闭后重试。" class="mb-3" />
          <el-form-item label="当前密码">
            <el-input v-model="form.currentPassword" type="password" show-password autocomplete="current-password" />
          </el-form-item>
          <template v-if="mfaStatus?.mfaRequired">
            <el-form-item v-if="!form.useWebAuthn" :label="form.useRecoveryCode ? '恢复码' : '6 位动态码'">
              <el-input v-if="form.useRecoveryCode" v-model="form.recoveryCode" placeholder="单个恢复码，例如ABCD-EFGH-JKLM" autocomplete="off" maxlength="32" @paste="guardRecoveryCodePaste($event, showAppWarning)" />
              <el-input v-else v-model="form.code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" />
            </el-form-item>
            <el-alert v-else type="info" :closable="false" title="继续后请使用已绑定的强凭据完成一次安全复核。" />
            <div class="flex flex-wrap gap-1">
              <el-button v-if="mfaStatus.availableMethods.includes('totp')" link type="primary" @click="form.useWebAuthn = false; form.useRecoveryCode = false">动态码</el-button>
              <el-button v-if="mfaStatus.availableMethods.includes('recovery_code')" link type="primary" @click="form.useWebAuthn = false; form.useRecoveryCode = true">恢复码</el-button>
              <el-button v-if="mfaStatus.availableMethods.includes('webauthn')" link type="primary" @click="form.useWebAuthn = true; form.useRecoveryCode = false">已绑定密钥</el-button>
            </div>
          </template>
        </template>
      </el-form>
    </template>
    <template #footer>
      <div class="flex flex-wrap justify-end gap-2">
        <template v-if="stage === 'recovery'">
          <el-button @click="copyRecoveryCodes">复制全部用于保存</el-button>
          <el-button type="primary" @click="acknowledgeRecoveryCodes">我已妥善保存</el-button>
        </template>
        <template v-else>
        <el-button :disabled="committed" @click="stage === 'list' ? close() : goToList()">{{ stage === 'list' ? '关闭' : '返回' }}</el-button>
        <el-button v-if="stage !== 'list'" :type="stage === 'delete' ? 'danger' : 'primary'" :loading="busy" @click="confirm">{{ stage === 'delete' ? '删除密钥' : stage === 'rename' ? '保存名称' : '添加密钥' }}</el-button>
        </template>
      </div>
    </template>
  </BizCrudDialogShell>
</template>

<style scoped>
.credential-choice-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
  min-width: 0;
}

.credential-choice-group--single {
  grid-template-columns: minmax(0, 1fr);
}

.credential-choice-group :deep(.el-radio) {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  width: 100%;
  min-width: 0;
  height: auto;
  min-height: 72px;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-blank);
  line-height: 1.4;
  white-space: normal;
}

.credential-choice-group--kind :deep(.el-radio) {
  min-height: 58px;
  padding: 9px 12px;
}

.credential-choice-group :deep(.el-radio.is-checked) {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.credential-choice-group :deep(.el-radio:focus-within) {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.credential-choice-group :deep(.el-radio__input) {
  margin-top: 2px;
}

.credential-choice-group :deep(.el-radio__label) {
  min-width: 0;
  padding-left: 8px;
  color: var(--el-text-color-primary);
  white-space: normal;
}

.credential-choice-copy,
.credential-choice-copy small {
  display: block;
}

.credential-choice-copy strong {
  font-weight: 600;
}

.credential-choice-copy small {
  margin-top: 3px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

@media (max-width: 520px) {
  .credential-choice-group {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
