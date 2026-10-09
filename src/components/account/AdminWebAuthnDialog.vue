<script setup lang="ts">
/**
 * 模块说明：src/components/account/AdminWebAuthnDialog.vue
 * 文件职责：管理本人通行密钥与安全密钥，包含列表、添加、改名和删除。
 * 实现逻辑：凭据管理与功能开关分别加载；添加才依赖 WebAuthn 能力，删除成功立即清空本地会话。
 * 维护说明：密码、动态码、恢复码和挑战只保存在当前弹窗内存，关闭或切换阶段必须清空并取消浏览器仪式。
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
  verifyAdminWebAuthnRegistration,
  type AdminWebAuthnCredential,
  type AdminWebAuthnStepUp,
} from '@/api/modules/admin-webauthn'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { redirectToAdminLogin } from '@/utils/auth-navigation'
import { assessWebAuthnAvailability, createWebAuthnFlow, isWebAuthnCancellation, type AdminWebAuthnCapabilities } from '@/utils/admin-webauthn'
import { extractErrorMessage } from '@/utils/error'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type Stage = 'list' | 'add' | 'rename' | 'delete'
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const authStore = useAuthStore(pinia)
const stage = ref<Stage>('list')
const selected = ref<AdminWebAuthnCredential | null>(null)
const credentials = ref<AdminWebAuthnCredential[]>([])
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
  currentPassword: '',
  code: '',
  recoveryCode: '',
  useRecoveryCode: false,
})
let epoch = 0
let confirmationSerial = 0
let loadController: AbortController | null = null
let sdk: typeof import('@simplewebauthn/browser') | null = null
const ceremony = createWebAuthnFlow(() => sdk?.WebAuthnAbortService.cancelCeremony())
const title = computed(() => ({ list: '我的通行密钥', add: '添加密钥', rename: '修改密钥名称', delete: '删除密钥' })[stage.value])
const availability = computed(() => capabilities.value
  ? assessWebAuthnAvailability(capabilities.value, {
    origin: globalThis.window?.location.origin ?? '',
    secure: globalThis.window?.isSecureContext === true,
    supported: typeof globalThis.PublicKeyCredential !== 'undefined' && Boolean(globalThis.navigator?.credentials?.create),
  })
  : { available: false, message: capabilitiesPhase.value === 'loading' ? '正在检查添加密钥能力…' : '添加密钥能力暂不可确认。' })
const busy = computed(() => submitting.value || confirmationPending.value || ceremonyPhase.value !== 'idle')
const committed = computed(() => submitting.value || ceremonyPhase.value === 'verify')

const clearProof = () => {
  form.currentPassword = ''
  form.code = ''
  form.recoveryCode = ''
  form.useRecoveryCode = false
}
const clearSensitive = () => {
  if (confirmationPending.value) ElMessageBox.close()
  ceremony.cancel()
  loadController?.abort()
  loadController = null
  epoch += 1
  confirmationSerial += 1
  confirmationPending.value = false
  clearProof()
  form.name = ''
  form.kind = 'passkey'
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
  if (visible) loadInitial()
  else clearSensitive()
}, { immediate: true })
onBeforeUnmount(clearSensitive)
// 弹窗位于 AppLayout 顶栏：仅最终删除 HTTP 在途时阻止离开管理端布局。
onBeforeRouteLeave(() => {
  if (deletePending.value) return false
})

const goToList = (force = false) => {
  if (!force && committed.value) return
  if (confirmationPending.value) ElMessageBox.close()
  confirmationSerial += 1
  confirmationPending.value = false
  ceremony.cancel()
  ceremonyPhase.value = 'idle'
  submitting.value = false
  clearProof()
  form.name = ''
  selected.value = null
  stage.value = 'list'
}
const openAdd = () => {
  if (!availability.value.available || credentials.value.length >= 10) return
  goToList()
  stage.value = 'add'
}
const openRename = (credential: AdminWebAuthnCredential) => {
  goToList()
  selected.value = credential
  form.name = credential.name
  stage.value = 'rename'
}
const openDelete = (credential: AdminWebAuthnCredential) => {
  goToList()
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
  if (mfaStatus.value?.enabled) {
    if (form.useRecoveryCode) {
      if (!form.recoveryCode.trim()) { showAppWarning('请输入恢复码'); return null }
      payload.recoveryCode = form.recoveryCode.trim()
    } else {
      const code = form.code.replace(/\s/g, '')
      if (!/^\d{6}$/.test(code)) { showAppWarning('请输入 6 位数字动态码'); return null }
      payload.code = code
    }
  }
  return payload
}

const addCredential = async () => {
  if (busy.value || !availability.value.available || credentials.value.length >= 10) return
  const name = checkedName()
  const proof = checkedProof()
  if (!name || !proof) return
  const accountLabel = authStore.currentUser?.username || '原账号'
  const operation = ceremony.start()
  ceremonyPhase.value = 'options'
  let verificationSubmitted = false
  try {
    const challenge = await startAdminWebAuthnRegistration({ name, kind: form.kind, ...proof }, { signal: operation.signal })
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
    await verifyAdminWebAuthnRegistration({ challengeId: challenge.challengeId, response })
    // 已提交请求的结果独立反馈；卸载或新弹窗出现时，只反馈原账号结果，不写回新表单。
    showAppSuccess(`已为“${accountLabel}”添加密钥“${name}”`)
    if (!ceremony.isCurrent(operation.id) || !props.modelValue || stage.value !== 'add') return
    ceremony.finish(operation.id)
    ceremonyPhase.value = 'idle'
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
    await deleteAdminWebAuthnCredential(target.id, proof)
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
    <el-alert v-if="committed" type="info" :closable="false" title="正在完成密钥操作，请等待结果后再关闭。" class="mb-3" />
    <template v-if="stage === 'list'">
      <el-alert v-if="capabilitiesPhase === 'error'" type="warning" :closable="false" title="添加密钥能力暂不可确认；已有密钥仍可查看、改名或删除。" class="mb-3" />
      <el-alert v-else-if="!availability.available" type="info" :closable="false" :title="availability.message" class="mb-3" />
      <p class="mb-3 text-sm text-slate-500">最多可保存 10 把密钥。添加通行密钥或安全密钥后，可在登录页不输入账号密码直接登录。</p>
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
    <template v-else>
      <el-alert v-if="stage === 'add'" type="info" :closable="false" title="通行密钥可保存到设备或密码管理器；安全密钥可选 USB/NFC 实体设备。实体密钥须支持保存可发现的密钥，并能完成 PIN 或生物验证。原有密码及两步验证仍可使用。" class="mb-3" />
      <el-alert v-if="stage === 'delete'" type="warning" :closable="false" title="删除任何一把密钥后，当前账号所有登录会话都会失效；最后一把密钥也可删除。" class="mb-3" />
      <p v-if="selected" class="mb-3 text-sm text-slate-600">当前密钥：{{ selected.name }}</p>
      <el-form label-position="top" @submit.prevent="confirm">
        <el-form-item v-if="stage !== 'delete'" label="密钥名称">
          <el-input v-model="form.name" maxlength="64" show-word-limit placeholder="1 至 64 个字符" />
        </el-form-item>
        <el-form-item v-if="stage === 'add'" label="选择密钥类型">
          <el-radio-group v-model="form.kind">
            <el-radio value="passkey">通行密钥</el-radio>
            <el-radio value="security_key">安全密钥</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="stage === 'add' || stage === 'delete'">
          <el-alert v-if="mfaPhase === 'error'" type="warning" :closable="false" title="两步验证状态读取失败，请关闭后重试。" class="mb-3" />
          <el-form-item label="当前密码">
            <el-input v-model="form.currentPassword" type="password" show-password autocomplete="current-password" />
          </el-form-item>
          <template v-if="mfaStatus?.enabled">
            <el-form-item :label="form.useRecoveryCode ? '恢复码' : '6 位动态码'">
              <el-input v-if="form.useRecoveryCode" v-model="form.recoveryCode" autocomplete="off" maxlength="32" />
              <el-input v-else v-model="form.code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" />
            </el-form-item>
            <el-button link type="primary" @click="form.useRecoveryCode = !form.useRecoveryCode; form.code = ''; form.recoveryCode = ''">{{ form.useRecoveryCode ? '改用动态码' : '改用恢复码' }}</el-button>
          </template>
        </template>
      </el-form>
    </template>
    <template #footer>
      <div class="flex flex-wrap justify-end gap-2">
        <el-button :disabled="committed" @click="stage === 'list' ? close() : goToList()">{{ stage === 'list' ? '关闭' : '返回' }}</el-button>
        <el-button v-if="stage !== 'list'" :type="stage === 'delete' ? 'danger' : 'primary'" :loading="busy" @click="confirm">{{ stage === 'delete' ? '删除密钥' : stage === 'rename' ? '保存名称' : '添加密钥' }}</el-button>
      </div>
    </template>
  </BizCrudDialogShell>
</template>
