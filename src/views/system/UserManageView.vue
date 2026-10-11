<script setup lang="ts">
/**
 * 模块说明：src/views/system/UserManageView.vue
 * 文件职责：提供管理端用户治理页，承接账号查询、创建编辑、启停控制、密码维护与角色配置等操作。
 * 实现逻辑：
 * - 页面统一收口管理端用户的筛选、表格展示和弹窗编辑流程，避免治理入口分散；
 * - 用户状态变更、密码处理和角色字段都在同一页闭环，便于系统管理员集中维护账号权限；
 * - 列表展示各账号两步验证状态，管理员可为丢失手机的他人重置两步验证（与重置密码同一权限，不能重置自己）。
 * 维护说明：
 * - 若后续新增治理字段，需要同步检查查询表单、弹窗表单、表格列和提交参数是否一致；
 * - 管理端用户与客户端用户的治理边界必须继续分开，避免字段和权限语义互相污染。
 */


import dayjs from 'dayjs'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { BizCrudDialogShell, BizResponsiveDataCollectionShell, PageContainer, PagePaginationBar, PageToolbarCard } from '@/components/common'
import AccountLifecycleDialog from '@/components/account/AccountLifecycleDialog.vue'
import type {
  AccountLifecycleAction,
  AccountLifecyclePreview,
  AccountLifecycleReasonPayload,
  AccountPermanentDeletePayload,
  AccountState,
} from '../../../packages/shared-types/src/index'
import {
  changePassword,
  ROLE_LABEL_MAP,
  type UserRole,
  type UserSafeProfile,
  type UserStatus,
} from '@/api/modules/auth'
import {
  createUser,
  deactivateUser,
  getUserList,
  getUserDeactivationPreview,
  permanentlyDeleteUser,
  resetUserMfa,
  resetUserPassword,
  resetUserWebAuthn,
  restoreUser,
  updateUser,
  updateUserStatus,
  type CreateUserPayload,
  type ResetUserPasswordPayload,
  type AdminUserSensitiveActionProof,
  type ResetUserWebAuthnPayload,
  type UpdateUserPayload,
  type UserListQuery,
} from '@/api/modules/user'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { redirectToAdminLogin } from '@/utils/auth-navigation'
import { extractErrorMessage } from '@/utils/error'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { guardRecoveryCodePaste } from '@/utils/admin-mfa-recovery-code'
import { validateAdminPasswordShape } from '@/utils/admin-password-policy'
import { getAdminMfaStatus, type AdminMfaStatus } from '@/api/modules/admin-mfa'
import { startAdminWebAuthnStepUp, verifyAdminWebAuthnStepUp, type AdminWebAuthnStepUpAction } from '@/api/modules/admin-webauthn'
import { createWebAuthnFlow, isWebAuthnCancellation } from '@/utils/admin-webauthn'
import {
  accountTypeDescriptions,
  getAccountTypeDescription,
  getGovernancePermissionLabels,
  getRoleTagType,
  getStatusTagType,
  roleOptions,
} from '@/views/system/user-governance.helpers'

/**
 * 用户管理搜索表单：
 * - keyword 支持账号/姓名模糊查询；
 * - role/status 适配企业后台最常见筛选维度。
 */
const searchForm = reactive({
  keyword: '',
  role: '' as '' | UserRole,
  accountState: '' as '' | AccountState,
})

/**
 * 列表状态：
 * - 复用统一分页工具，保持与订单列表页交互一致；
 * - records 将承载当前页用户数据。
 */
const listState = reactive(createPaginatedListState<UserSafeProfile>({
  loading: true,
  query: {
    pageSize: 10,
  },
}))

/**
 * 当前登录用户：
 * - 页面权限判断统一来自 Auth Store；
 * - 避免在页面内硬编码 admin/operator 角色分支。
 */
const authStore = useAuthStore(pinia)
const listRequest = useStableRequest()
const { hasPermission, ensurePermission } = usePermissionAction()

/**
 * 页面权限能力：
 * - 查看权限控制整页是否允许加载用户数据；
 * - 新增/编辑/启停/重置密码分别映射到对应按钮和提交动作。
 */
const canCreateUser = computed(() => hasPermission('users:create'))
const canEditUser = computed(() => hasPermission('users:update'))
const canToggleUser = computed(() => hasPermission('users:status'))
const canResetUserPassword = computed(() => hasPermission('users:reset_password'))
const canDeactivateUser = computed(() => hasPermission('users:deactivate'))
const canPermanentDeleteUser = computed(() => hasPermission('users:permanent_delete'))
const canOperateUsers = computed(() => canEditUser.value || canToggleUser.value || canResetUserPassword.value || canDeactivateUser.value || canPermanentDeleteUser.value)

/**
 * 弹窗状态：
 * - dialogMode 区分新增与编辑；
 * - submitting 控制确认按钮 loading，避免重复提交。
 */
const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const submitting = ref(false)
const formRef = ref<FormInstance>()
const resetPasswordVisible = ref(false)
const resetPasswordSubmitting = ref(false)
const resetPasswordFormRef = ref<FormInstance>()
const ownPasswordVisible = ref(false)
const ownPasswordSubmitting = ref(false)
const ownPasswordFormRef = ref<FormInstance>()
const lifecycleVisible = ref(false)
const lifecycleLoading = ref(false)
const lifecycleAction = ref<AccountLifecycleAction>('deactivate')
const lifecycleTarget = ref<UserSafeProfile | null>(null)
const lifecyclePreview = ref<AccountLifecyclePreview | null>(null)
const revokeWebAuthnVisible = ref(false)
const revokeWebAuthnSubmitting = ref(false)
const revokeWebAuthnConfirmationPending = ref(false)
const revokeWebAuthnTarget = ref<UserSafeProfile | null>(null)
const revokeWebAuthnMfaStatus = ref<AdminMfaStatus | null>(null)
const revokeWebAuthnMfaPhase = ref<'loading' | 'ready' | 'error'>('loading')
const revokeWebAuthnForm = reactive({ currentPassword: '', code: '', recoveryCode: '', useRecoveryCode: false, useWebAuthn: false, reason: '' })
const resetMfaVisible = ref(false)
const resetMfaTarget = ref<UserSafeProfile | null>(null)
const resetMfaStatus = ref<AdminMfaStatus | null>(null)
const resetMfaPhase = ref<'loading' | 'ready' | 'error'>('loading')
const resetMfaSubmitting = ref(false)
const resetMfaConfirmationPending = ref(false)
const resetMfaForm = reactive({ currentPassword: '', code: '', recoveryCode: '', mode: 'totp' as 'totp' | 'recovery_code' | 'webauthn' })
let resetMfaEpoch = 0
let resetMfaActive = true
let userStepUpSdk: typeof import('@simplewebauthn/browser') | null = null
const userStepUpFlow = createWebAuthnFlow(() => userStepUpSdk?.WebAuthnAbortService.cancelCeremony())
const obtainUserStepUp = async (action: AdminWebAuthnStepUpAction, targetId: string, currentPassword: string) => {
  const operation = userStepUpFlow.start()
  try {
    const challenge = await startAdminWebAuthnStepUp({ action, targetId, currentPassword }, { signal: operation.signal })
    if (!userStepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    const sdk = await import('@simplewebauthn/browser')
    if (!userStepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    userStepUpSdk = sdk
    const response = await sdk.startAuthentication({ optionsJSON: challenge.options })
    if (!userStepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    const result = await verifyAdminWebAuthnStepUp({ challengeId: challenge.challengeId, response }, { signal: operation.signal })
    if (!userStepUpFlow.isCurrent(operation.id)) throw new DOMException('已取消', 'AbortError')
    return result.stepUpProof
  } finally { userStepUpFlow.finish(operation.id) }
}
let revokeWebAuthnEpoch = 0
let revokeWebAuthnActive = true
let revokeWebAuthnMounted = true
let revokeWebAuthnRefreshOnActivate = false

/**
 * 用户编辑表单：
 * - 新增时 password 必填；
 * - 编辑时 password 不走该弹窗，密码调整统一走独立重置入口。
 */
const userForm = reactive({
  id: '',
  username: '',
  password: '',
  displayName: '',
  email: '',
  role: 'operator' as UserRole,
  status: 'enabled' as UserStatus,
})

/**
 * 重置密码表单：
 * - targetUser 用于在弹窗内明确当前要处理的账号；
 * - confirmPassword 在前端先做一致性校验，避免无效请求。
 */
const resetPasswordForm = reactive({
  targetUserId: '',
  targetDisplayName: '',
  targetUsername: '',
  newPassword: '',
  confirmPassword: '',
})

/**
 * 本人修改密码表单：
 * - 仅用于当前登录用户主动改密；
 * - 与管理员重置他人密码场景隔离，避免语义混淆。
 */
const ownPasswordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})

/**
 * 表单标题：
 * - 和弹窗模式保持同步；
 * - 让用户明确当前是在新建还是编辑账号。
 */
const dialogTitle = computed(() => (dialogMode.value === 'create' ? '新增用户' : '编辑用户'))

/**
 * 表单校验规则：
 * - 编辑时密码非必填，因此通过自定义校验区分两种模式；
 * - 其余字段保持直接、明确的企业后台录入规则。
 */
const rules: FormRules = {
  username: [{ required: true, message: '请输入登录账号', trigger: 'blur' }],
  password: [
    {
      validator: (_rule, value: string, callback) => {
        if (dialogMode.value === 'create' && !value) {
          callback(new Error('请输入登录密码'))
          return
        }
        validateAdminPasswordShape(value, callback)
      },
      trigger: 'blur',
    },
  ],
  displayName: [{ required: true, message: '请输入用户姓名', trigger: 'blur' }],
  email: [
    {
      validator: (_rule, value: string, callback) => {
        const text = value.trim()
        if (!text) {
          callback()
          return
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
          callback(new Error('请输入正确的邮箱地址'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  role: [{ required: true, message: '请选择用户角色', trigger: 'change' }],
  status: [{ required: true, message: '请选择用户状态', trigger: 'change' }],
}

/**
 * 重置密码校验规则：
 * - 与本人改密入口保持相近口径；
 * - 仅具备 users:reset_password 的账号可使用。
 */
const resetPasswordRules: FormRules = {
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { validator: (_rule, value: string, callback) => validateAdminPasswordShape(value, callback), trigger: 'blur' },
  ],
  confirmPassword: [
    {
      validator: (_rule, value: string, callback) => {
        if (!value) {
          callback(new Error('请再次输入新密码'))
          return
        }
        if (value !== resetPasswordForm.newPassword) {
          callback(new Error('两次输入的新密码不一致'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
}

/**
 * 本人修改密码校验规则：
 * - 先校验当前密码，再校验新密码长度与确认一致性；
 * - 与登录页/顶栏规则保持一致，降低理解成本。
 */
const ownPasswordRules: FormRules = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { validator: (_rule, value: string, callback) => validateAdminPasswordShape(value, callback), trigger: 'blur' },
  ],
  confirmPassword: [
    {
      validator: (_rule, value: string, callback) => {
        if (!value) {
          callback(new Error('请再次输入新密码'))
          return
        }
        if (value !== ownPasswordForm.newPassword) {
          callback(new Error('两次输入的新密码不一致'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
}

/**
 * 是否允许修改账号：
 * - 后端编辑接口不支持修改 username，因此编辑时禁用；
 * - 视觉上保留字段，帮助治理人员明确当前账号归属。
 */
const usernameDisabled = computed(() => dialogMode.value === 'edit')

/**
 * 当前表单账号类型提示：
 * - 当管理员切换角色时，右侧提示同步变化；
 * - 重点强调供货方账号的专属落点，降低创建后“为什么没进工作台”的疑惑。
 */
const currentRoleDescription = computed(() => {
  return accountTypeDescriptions.find((item) => item.role === userForm.role) ?? accountTypeDescriptions[1]
})

/**
 * 角色与状态文案辅助：
 * - 模板中通过函数访问映射，避免 SFC 模板类型被推断成 any；
 * - 同时保证文案字典仍集中维护。
 */
const getRoleLabel = (role: UserRole) => ROLE_LABEL_MAP[role]
const getAccountStateLabel = (state: AccountState) => ({ enabled: '启用', disabled: '停用', deactivated: '已注销' })[state]
const getAccountStateTagType = (state: AccountState) => state === 'deactivated' ? 'danger' : getStatusTagType(state)

/**
 * 将搜索条件转换为接口参数：
 * - 仅在有值时才注入 role/status，减少无意义查询字段；
 * - page/pageSize 统一来自分页状态。
 */
const buildQueryParams = (): UserListQuery => {
  const params: UserListQuery = {
    page: listState.query.page,
    pageSize: listState.query.pageSize,
  }

  if (searchForm.keyword.trim()) {
    params.keyword = searchForm.keyword.trim()
  }
  if (searchForm.role) {
    params.role = searchForm.role
  }
  if (searchForm.accountState) {
    params.accountState = searchForm.accountState
  }

  return params
}

/**
 * 拉取用户分页列表：
 * - 若当前账号无 users:view，则直接提示并保持空列表；
 * - 成功后统一回填到 listState。
 */
const loadData = async () => {
  if (!ensurePermission('users:view', '用户列表查看')) {
    listState.loading = false
    listState.records = []
    listState.total = 0
    return
  }

  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getUserList(buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取用户列表失败'))
    },
    onFinally: () => {
      listState.loading = false
    },
  })
}

/**
 * 打开新增弹窗：
 * - 每次都重建默认表单，避免残留上次编辑数据；
 * - 默认创建启用状态的普通操作员。
 */
const handleOpenCreate = () => {
  if (!ensurePermission('users:create', '新增用户')) {
    return
  }

  dialogMode.value = 'create'
  dialogVisible.value = true
  userForm.id = ''
  userForm.username = ''
  userForm.password = ''
  userForm.displayName = ''
  userForm.email = ''
  userForm.role = 'supplier'
  userForm.status = 'enabled'
  formRef.value?.clearValidate()
}

/**
 * 重置管理员重置密码表单：
 * - 打开前清空旧输入；
 * - 关闭后再次执行，确保 destroy-on-close 外仍能恢复干净状态。
 */
const resetAdminPasswordForm = () => {
  resetPasswordForm.targetUserId = ''
  resetPasswordForm.targetDisplayName = ''
  resetPasswordForm.targetUsername = ''
  resetPasswordForm.newPassword = ''
  resetPasswordForm.confirmPassword = ''
  resetPasswordFormRef.value?.clearValidate()
}

/**
 * 重置本人修改密码表单：
 * - 每次打开/关闭弹窗都清理输入与校验状态；
 * - 防止旧输入残留带来误提交。
 */
const resetOwnPasswordForm = () => {
  ownPasswordForm.currentPassword = ''
  ownPasswordForm.newPassword = ''
  ownPasswordForm.confirmPassword = ''
  ownPasswordFormRef.value?.clearValidate()
}

/**
 * 打开本人修改密码弹窗：
 * - 在用户管理页提供显式入口，减少“找不到入口”的使用成本；
 * - 与顶栏入口并存，二者调用同一后端接口。
 */
const handleOpenOwnPasswordDialog = () => {
  ownPasswordVisible.value = true
  resetOwnPasswordForm()
}

/**
 * 打开编辑弹窗：
 * - 账号只读回显；
 * - 密码不在这里修改，避免用户资料编辑与安全操作混在一起。
 */
const handleOpenEdit = (row: UserSafeProfile) => {
  if (!ensurePermission('users:update', '编辑用户')) {
    return
  }

  dialogMode.value = 'edit'
  dialogVisible.value = true
  userForm.id = row.id
  userForm.username = row.username
  userForm.password = ''
  userForm.displayName = row.displayName
  userForm.email = row.email ?? ''
  userForm.role = row.role
  userForm.status = row.status
  formRef.value?.clearValidate()
}

/**
 * 打开管理员重置密码弹窗：
 * - 仅针对“非本人”账号开放；
 * - 弹窗中明确展示目标账号，降低误操作概率。
 */
const handleOpenResetPassword = (row: UserSafeProfile) => {
  if (!ensurePermission('users:reset_password', '重置用户密码')) {
    return
  }

  resetPasswordVisible.value = true
  resetAdminPasswordForm()
  resetPasswordForm.targetUserId = row.id
  resetPasswordForm.targetDisplayName = row.displayName
  resetPasswordForm.targetUsername = row.username
}

/**
 * 保存用户：
 * - 新增与编辑共享同一入口；
 * - 提交前再次按权限点做兜底，防止通过异常交互绕过按钮显隐。
 */
const handleSubmit = async () => {
  const form = formRef.value
  if (!form) {
    return
  }

  const valid = await form.validate().catch(() => false)
  if (!valid) {
    return
  }

  if (dialogMode.value === 'create' && !ensurePermission('users:create', '新增用户')) {
    return
  }
  if (dialogMode.value === 'edit' && !ensurePermission('users:update', '编辑用户')) {
    return
  }

  submitting.value = true
  try {
    if (dialogMode.value === 'create') {
      const payload: CreateUserPayload = {
        username: userForm.username.trim(),
        password: userForm.password,
        displayName: userForm.displayName.trim(),
        email: userForm.email.trim(),
        role: userForm.role,
        status: userForm.status,
      }
      await createUser(payload)
      showAppSuccess(
        userForm.role === 'supplier'
          ? '供货方账号创建成功，该账号登录后将进入送货单录入页'
          : '用户创建成功',
      )
    } else {
      const originalStatus = listState.records.find((item) => item.id === userForm.id)?.status
      if (userForm.status !== originalStatus && !ensurePermission('users:status', '启停用户')) {
        return
      }

      const payload: UpdateUserPayload = {
        displayName: userForm.displayName.trim(),
        email: userForm.email.trim(),
        role: userForm.role,
      }

      await updateUser(userForm.id, payload)

      if (userForm.status !== originalStatus) {
        await updateUserStatus(userForm.id, userForm.status)
      }

      showAppSuccess('用户信息更新成功')
    }

    dialogVisible.value = false
    await loadData()
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '保存用户失败',
      fallback: '保存用户失败',
      operation: userForm.id ? '编辑管理端用户' : '新增管理端用户',
    })
  } finally {
    submitting.value = false
  }
}

/**
 * 管理员提交重置密码：
 * - 成功后仅提示结果，不展示明文密码；
 * - 目标用户已有会话会被服务端作废，确保新密码立即生效。
 */
const handleSubmitResetPassword = async () => {
  const valid = await resetPasswordFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }

  if (!ensurePermission('users:reset_password', '重置用户密码')) {
    return
  }

  resetPasswordSubmitting.value = true
  try {
    const targetDisplayName = resetPasswordForm.targetDisplayName
    const payload: ResetUserPasswordPayload = {
      newPassword: resetPasswordForm.newPassword,
    }
    await resetUserPassword(resetPasswordForm.targetUserId, payload)
    resetPasswordVisible.value = false
    resetAdminPasswordForm()
    showAppSuccess(`已重置“${targetDisplayName}”的登录密码`)
    await loadData()
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '重置密码失败',
      fallback: '重置密码失败',
      operation: '重置管理端用户密码',
    })
  } finally {
    resetPasswordSubmitting.value = false
  }
}

/**
 * 管理员重置他人两步验证：
 * - 对方丢失手机且恢复码用尽时使用，确认后对方下次登录只需账号密码；
 * - 不作废对方已有会话，提示管理员提醒对方尽快重新绑定。
 */
const handleResetMfa = async (row: UserSafeProfile) => {
  if (!ensurePermission('users:reset_password', '重置两步验证') || row.id === authStore.currentUser?.id) return
  resetMfaEpoch += 1
  const id = resetMfaEpoch
  resetMfaTarget.value = row
  resetMfaStatus.value = null
  resetMfaPhase.value = 'loading'
  resetMfaVisible.value = true
  resetMfaForm.currentPassword = ''
  resetMfaForm.code = ''
  resetMfaForm.recoveryCode = ''
  try {
    const status = await getAdminMfaStatus()
    if (id !== resetMfaEpoch || !resetMfaVisible.value) return
    resetMfaStatus.value = status
    resetMfaForm.mode = status.availableMethods.includes('totp') ? 'totp' : status.availableMethods.includes('webauthn') ? 'webauthn' : 'recovery_code'
    resetMfaPhase.value = 'ready'
  } catch { if (id === resetMfaEpoch) resetMfaPhase.value = 'error' }
}

const closeResetMfa = () => {
  if (resetMfaSubmitting.value) return
  userStepUpFlow.cancel()
  resetMfaEpoch += 1
  resetMfaConfirmationPending.value = false
  resetMfaVisible.value = false
  resetMfaTarget.value = null
  resetMfaStatus.value = null
  resetMfaForm.currentPassword = ''
  resetMfaForm.code = ''
  resetMfaForm.recoveryCode = ''
}

const handleSubmitResetMfa = async () => {
  const target = resetMfaTarget.value
  const status = resetMfaStatus.value
  if (!target || !status || resetMfaPhase.value !== 'ready' || resetMfaSubmitting.value || resetMfaConfirmationPending.value || !resetMfaActive || !resetMfaForm.currentPassword) return
  const proof: AdminUserSensitiveActionProof = { currentPassword: resetMfaForm.currentPassword }
  const mode = resetMfaForm.mode
  if (status.mfaRequired) {
    if (mode === 'totp') {
      const code = resetMfaForm.code.replace(/\s/g, '')
      if (!/^\d{6}$/.test(code)) { showAppError('请输入 6 位数字动态码'); return }
      proof.code = code
    } else if (mode === 'recovery_code') {
      if (!resetMfaForm.recoveryCode.trim()) { showAppError('请输入恢复码'); return }
      proof.recoveryCode = resetMfaForm.recoveryCode.trim()
    }
  }
  const id = resetMfaEpoch
  resetMfaConfirmationPending.value = true
  try {
    await ElMessageBox.confirm(`确认重置“${target.displayName}”的所有密码后验证方式吗？对方下次登录将只需账号密码。`, '重置两步验证', {
      type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消',
    })
  } catch { resetMfaConfirmationPending.value = false; return }
  resetMfaConfirmationPending.value = false
  if (id !== resetMfaEpoch || !resetMfaActive || !resetMfaVisible.value || resetMfaTarget.value?.id !== target.id) return
  resetMfaSubmitting.value = true
  try {
    if (status.mfaRequired && mode === 'webauthn') proof.stepUpProof = await obtainUserStepUp('user.mfa.reset', String(target.id), proof.currentPassword)
    if (id !== resetMfaEpoch || !resetMfaActive || !resetMfaVisible.value) return
    await resetUserMfa(target.id, proof)
    showAppSuccess(`已重置“${target.displayName}”的两步验证`)
    resetMfaSubmitting.value = false
    closeResetMfa()
    await loadData()
  } catch (error) {
    if (isWebAuthnCancellation(error)) showAppError('安全密钥复核已取消')
    else showAppError(extractErrorMessage(error, '重置两步验证失败'))
  } finally {
    resetMfaSubmitting.value = false
    resetMfaForm.currentPassword = ''
    resetMfaForm.code = ''
    resetMfaForm.recoveryCode = ''
  }
}

/** 清空撤销表单并使旧状态请求、确认框和提交结果失效。 */
const clearRevokeWebAuthn = () => {
  revokeWebAuthnEpoch += 1
  revokeWebAuthnSubmitting.value = false
  revokeWebAuthnConfirmationPending.value = false
  revokeWebAuthnTarget.value = null
  revokeWebAuthnMfaStatus.value = null
  revokeWebAuthnMfaPhase.value = 'loading'
  revokeWebAuthnForm.currentPassword = ''
  revokeWebAuthnForm.code = ''
  revokeWebAuthnForm.recoveryCode = ''
  revokeWebAuthnForm.useRecoveryCode = false
  revokeWebAuthnForm.useWebAuthn = false
  revokeWebAuthnForm.reason = ''
}
watch(revokeWebAuthnVisible, (visible) => { if (!visible) clearRevokeWebAuthn() })
const updateRevokeWebAuthnVisible = (visible: boolean) => {
  if (!visible && revokeWebAuthnSubmitting.value) return
  revokeWebAuthnVisible.value = visible
}
const deactivateRevokeWebAuthn = () => {
  revokeWebAuthnActive = false
  userStepUpFlow.cancel()
  if (revokeWebAuthnSubmitting.value) {
    // 请求参数已复制，离页时立即抹除缓存组件内的复核凭据，结果仍由在途请求反馈。
    revokeWebAuthnForm.currentPassword = ''
    revokeWebAuthnForm.code = ''
    revokeWebAuthnForm.recoveryCode = ''
    return
  }
  if (revokeWebAuthnConfirmationPending.value) ElMessageBox.close()
  revokeWebAuthnVisible.value = false
  clearRevokeWebAuthn()
}
onDeactivated(deactivateRevokeWebAuthn)
onDeactivated(() => { resetMfaActive = false; if (!resetMfaSubmitting.value) closeResetMfa(); else { userStepUpFlow.cancel(); resetMfaForm.currentPassword = ''; resetMfaForm.code = ''; resetMfaForm.recoveryCode = '' } })
onBeforeUnmount(() => {
  resetMfaActive = false
  revokeWebAuthnMounted = false
  deactivateRevokeWebAuthn()
  userStepUpFlow.cancel()
  resetMfaForm.currentPassword = ''
  resetMfaForm.code = ''
  resetMfaForm.recoveryCode = ''
})
onActivated(() => {
  resetMfaActive = true
  revokeWebAuthnActive = true
  if (revokeWebAuthnRefreshOnActivate) {
    revokeWebAuthnRefreshOnActivate = false
    void loadData()
  }
})

const handleOpenRevokeWebAuthn = async (row: UserSafeProfile) => {
  if (!revokeWebAuthnActive || !authStore.isAdmin || row.id === authStore.currentUser?.id || !ensurePermission('users:reset_password', '撤销用户密钥') || !row.webauthnCredentialsCount) return
  clearRevokeWebAuthn()
  const id = revokeWebAuthnEpoch
  revokeWebAuthnTarget.value = row
  revokeWebAuthnVisible.value = true
  try {
    const status = await getAdminMfaStatus()
    if (id !== revokeWebAuthnEpoch || !revokeWebAuthnVisible.value) return
    revokeWebAuthnMfaStatus.value = status
    revokeWebAuthnMfaPhase.value = 'ready'
    revokeWebAuthnForm.useWebAuthn = Boolean(status.mfaRequired && !status.availableMethods.includes('totp') && status.availableMethods.includes('webauthn'))
  } catch {
    if (id === revokeWebAuthnEpoch && revokeWebAuthnVisible.value) revokeWebAuthnMfaPhase.value = 'error'
  }
}

const getRevokeMfaNotice = (target: UserSafeProfile | null) => target?.mfaRequired
  ? '目标账号的两步验证仍会保留；若密钥是唯一可用方式且恢复码已用尽，须由管理员另行重置两步验证才能恢复密码登录。'
  : ''

const handleSubmitRevokeWebAuthn = async () => {
  const target = revokeWebAuthnTarget.value
  if (!target || revokeWebAuthnSubmitting.value || revokeWebAuthnConfirmationPending.value || !revokeWebAuthnVisible.value || !revokeWebAuthnActive) return
  if (!authStore.isAdmin || target.id === authStore.currentUser?.id || !ensurePermission('users:reset_password', '撤销用户密钥')) return
  if (revokeWebAuthnMfaPhase.value !== 'ready') { showAppError('尚未确认本人两步验证状态，请重试'); return }
  const reason = revokeWebAuthnForm.reason.trim()
  if (!reason || reason.length > 500) { showAppError('请输入 1 至 500 个字符的撤销原因'); return }
  if (!revokeWebAuthnForm.currentPassword) { showAppError('请输入当前密码'); return }
  const payload: ResetUserWebAuthnPayload = { currentPassword: revokeWebAuthnForm.currentPassword, reason }
  if (revokeWebAuthnMfaStatus.value?.mfaRequired) {
    if (revokeWebAuthnForm.useWebAuthn) {
      if (!revokeWebAuthnMfaStatus.value.availableMethods.includes('webauthn')) { showAppError('当前账号没有可用的安全密钥'); return }
    } else if (revokeWebAuthnForm.useRecoveryCode) {
      if (!revokeWebAuthnForm.recoveryCode.trim()) { showAppError('请输入恢复码'); return }
      payload.recoveryCode = revokeWebAuthnForm.recoveryCode.trim()
    } else {
      if (!revokeWebAuthnMfaStatus.value.availableMethods.includes('totp')) { showAppError('请选择可用复核方式'); return }
      const code = revokeWebAuthnForm.code.replace(/\s/g, '')
      if (!/^\d{6}$/.test(code)) { showAppError('请输入 6 位数字动态码'); return }
      payload.code = code
    }
  }
  const confirmationEpoch = revokeWebAuthnEpoch
  revokeWebAuthnConfirmationPending.value = true
  try {
    await ElMessageBox.confirm(`确认撤销“${target.displayName}”的全部 ${target.webauthnCredentialsCount ?? 0} 把密钥吗？目标账号所有登录会话会立即失效。${getRevokeMfaNotice(target)}`, '撤销全部密钥', {
      type: 'warning', confirmButtonText: '撤销全部密钥', cancelButtonText: '取消',
    })
  } catch {
    if (confirmationEpoch === revokeWebAuthnEpoch) revokeWebAuthnConfirmationPending.value = false
    return
  }
  if (confirmationEpoch !== revokeWebAuthnEpoch || !revokeWebAuthnActive || !revokeWebAuthnVisible.value || revokeWebAuthnTarget.value?.id !== target.id) return
  revokeWebAuthnConfirmationPending.value = false
  const id = revokeWebAuthnEpoch
  revokeWebAuthnSubmitting.value = true
  try {
    if (revokeWebAuthnMfaStatus.value?.mfaRequired && revokeWebAuthnForm.useWebAuthn) {
      payload.stepUpProof = await obtainUserStepUp('user.webauthn.reset', String(target.id), payload.currentPassword)
      if (id !== revokeWebAuthnEpoch || !revokeWebAuthnActive || !revokeWebAuthnVisible.value) return
    }
    const result = await resetUserWebAuthn(target.id, payload)
    showAppSuccess(`已撤销“${target.displayName}”的 ${result.revokedCount} 把密钥。${getRevokeMfaNotice(target)}`)
    if (!revokeWebAuthnMounted || !revokeWebAuthnActive) {
      revokeWebAuthnRefreshOnActivate = revokeWebAuthnMounted
      revokeWebAuthnVisible.value = false
      clearRevokeWebAuthn()
      return
    }
    if (id !== revokeWebAuthnEpoch || !revokeWebAuthnVisible.value) return
    revokeWebAuthnVisible.value = false
    clearRevokeWebAuthn()
    await loadData()
  } catch (error) {
    if (!revokeWebAuthnMounted || !revokeWebAuthnActive) {
      revokeWebAuthnVisible.value = false
      clearRevokeWebAuthn()
      showAppError(extractErrorMessage(error, '撤销用户密钥失败'))
      return
    }
    if (id === revokeWebAuthnEpoch) showAppError(extractErrorMessage(error, '撤销用户密钥失败'))
  } finally {
    if (id === revokeWebAuthnEpoch) revokeWebAuthnSubmitting.value = false
  }
}

/**
 * 提交本人修改密码：
 * - 成功后服务端会使当前账号已有会话失效；
 * - 前端主动退出并跳转登录页，要求用新密码重新登录。
 */
const handleSubmitOwnPassword = async () => {
  const valid = await ownPasswordFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }

  ownPasswordSubmitting.value = true
  try {
    await changePassword({
      currentPassword: ownPasswordForm.currentPassword,
      newPassword: ownPasswordForm.newPassword,
    })
    ownPasswordVisible.value = false
    resetOwnPasswordForm()
    await authStore.logout()
    // 本人改密后使用硬跳转返回登录页，避免旧管理端页面与权限上下文继续停留在当前标签页。
    redirectToAdminLogin()
    showAppSuccess('密码修改成功，请使用新密码重新登录')
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '修改密码失败',
      fallback: '修改密码失败',
      operation: '修改本人管理端密码',
    })
  } finally {
    ownPasswordSubmitting.value = false
  }
}

/**
 * 切换用户状态：
 * - 启停动作独立于编辑弹窗，提升列表页操作效率；
 * - 危险动作前增加确认提示，降低误操作风险。
 */
const handleToggleStatus = async (row: UserSafeProfile) => {
  if (!ensurePermission('users:status', '启停用户')) {
    return
  }

  const nextStatus: UserStatus = row.status === 'enabled' ? 'disabled' : 'enabled'
  const actionLabel = nextStatus === 'enabled' ? '启用' : '停用'

  try {
    await ElMessageBox.confirm(`确认${actionLabel}用户“${row.displayName}”吗？`, `${actionLabel}用户`, {
      type: nextStatus === 'enabled' ? 'info' : 'warning',
      confirmButtonText: actionLabel,
      cancelButtonText: '取消',
    })

    await updateUserStatus(row.id, nextStatus)
    showAppSuccess(`${actionLabel}成功`)
    await loadData()
  } catch (error) {
    if (error === 'cancel') {
      return
    }
    void showCriticalErrorDialog(error, {
      title: `${actionLabel}用户失败`,
      fallback: `${actionLabel}失败`,
      operation: `${actionLabel}管理端用户`,
    })
  }
}

const handleOpenLifecycle = async (row: UserSafeProfile, action: AccountLifecycleAction) => {
  const permission = action === 'permanent_delete' ? 'users:permanent_delete' : 'users:deactivate'
  if (!ensurePermission(permission, action === 'permanent_delete' ? '永久删除账号' : '账号注销与恢复')) return
  lifecycleLoading.value = true
  try {
    lifecyclePreview.value = await getUserDeactivationPreview(row.id)
    lifecycleTarget.value = row
    lifecycleAction.value = action
    lifecycleVisible.value = true
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '账号生命周期预检失败',
      fallback: '无法获取账号生命周期状态，请稍后重试',
      operation: '账号生命周期预检',
    })
  } finally {
    lifecycleLoading.value = false
  }
}

const handleLifecycleConfirm = async (payload: AccountLifecycleReasonPayload | AccountPermanentDeletePayload) => {
  const target = lifecycleTarget.value
  if (!target) return
  lifecycleLoading.value = true
  try {
    if (lifecycleAction.value === 'deactivate') {
      await deactivateUser(target.id, payload as AccountLifecycleReasonPayload)
    } else if (lifecycleAction.value === 'restore') {
      await restoreUser(target.id, payload as AccountLifecycleReasonPayload)
    } else {
      await permanentlyDeleteUser(target.id, payload as AccountPermanentDeletePayload)
    }
    lifecycleVisible.value = false
    const actionLabel = lifecycleAction.value === 'deactivate'
      ? '注销'
      : lifecycleAction.value === 'restore'
        ? '恢复'
        : '永久删除'
    showAppSuccess(`${actionLabel}系统账号成功`)
    await loadData()
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: `${lifecycleAction.value === 'permanent_delete' ? '永久删除' : lifecycleAction.value === 'restore' ? '恢复' : '注销'}账号失败`,
      fallback: '账号状态可能已并发变化，请刷新后重试',
      operation: '账号生命周期操作',
    })
  } finally {
    lifecycleLoading.value = false
  }
}

/**
 * 搜索与重置：
 * - 搜索前统一回到第一页；
 * - 重置后立即刷新，保持后台页标准体验。
 */
const handleSearch = () => {
  listState.query.page = 1
  void loadData()
}

const handleReset = () => {
  searchForm.keyword = ''
  searchForm.role = ''
  searchForm.accountState = ''
  handleSearch()
}

/**
 * 分页切换：
 * - 与通用分页条事件保持一致；
 * - pageSize 变化时强制回到第一页，避免页码越界。
 */
const handleCurrentChange = (page: number) => {
  listState.query.page = page
  void loadData()
}

const handlePageSizeChange = (pageSize: number) => {
  listState.query.pageSize = pageSize
  listState.query.page = 1
  void loadData()
}

/**
 * 是否允许操作当前行：
 * - 当前版本仍允许编辑自己姓名；
 * - 停用自己与重置自己密码由业务规则继续限制。
 */
const isSelfRow = (row: UserSafeProfile) => row.id === authStore.currentUser?.id

/**
 * 行级按钮显示条件：
 * - 与权限点保持一一对应，避免“看到但点不了”的误导；
 * - 仅在确实具备对应权限时才呈现按钮。
 */
const canShowEditAction = (row: UserSafeProfile) => canEditUser.value && row.accountState !== 'deactivated' && Boolean(row.id)
const canShowResetPasswordAction = (row: UserSafeProfile) => canResetUserPassword.value && row.accountState !== 'deactivated' && !isSelfRow(row)
// 重置他人两步验证与重置密码同一权限；本人应在账号菜单中用动态码或恢复码自行停用。
const canShowResetMfaAction = (row: UserSafeProfile) => canResetUserPassword.value && Boolean(row.mfaRequired) && row.accountState !== 'deactivated' && !isSelfRow(row)
const canShowRevokeWebAuthnAction = (row: UserSafeProfile) => authStore.isAdmin && canResetUserPassword.value && !isSelfRow(row) && (row.webauthnCredentialsCount ?? 0) > 0
const canShowToggleStatusAction = (row: UserSafeProfile) => canToggleUser.value && row.accountState !== 'deactivated' && !(isSelfRow(row) && row.status === 'enabled')

onMounted(() => {
  void loadData()
})
</script>

<template>
  <PageContainer title="管理端用户" description="管理系统后台账号、角色、状态与关键权限边界，所有变更均自动进入审计链路。">
    <div class="flex min-w-0 flex-col gap-4">
      <PageToolbarCard content-class="items-start">
        <template #default="{ isPhone, isTablet }">
          <div class="flex flex-1 flex-wrap items-start gap-2.5">
            <el-input
              v-model="searchForm.keyword"
              placeholder="搜索账号或姓名"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[240px]' : '!w-[280px]'"
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            />
            <el-select
              v-model="searchForm.role"
              placeholder="角色"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[160px]' : '!w-[168px]'"
              @change="handleSearch"
            >
              <el-option
                v-for="roleOption in roleOptions"
                :key="roleOption.value"
                :label="roleOption.label"
                :value="roleOption.value"
              />
            </el-select>
            <el-select
              v-model="searchForm.accountState"
              placeholder="账号状态"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[160px]' : '!w-[168px]'"
              @change="handleSearch"
            >
              <el-option label="启用" value="enabled" />
              <el-option label="停用" value="disabled" />
              <el-option label="已注销" value="deactivated" />
            </el-select>
            <el-button :class="isPhone ? 'w-full' : ''" type="primary" icon="Search" @click="handleSearch">搜索</el-button>
            <el-button :class="isPhone ? 'w-full' : ''" icon="Refresh" @click="handleReset">重置</el-button>
          </div>
        </template>

        <template #actions="{ isPhone }">
          <div :class="['flex flex-wrap gap-2', isPhone ? 'w-full' : 'justify-end']">
            <el-button :class="isPhone ? 'w-full' : ''" icon="Lock" @click="handleOpenOwnPasswordDialog">
              修改我的密码
            </el-button>
            <el-button v-if="canCreateUser" :class="isPhone ? 'w-full' : ''" type="primary" icon="Plus" @click="handleOpenCreate">
              新增用户
            </el-button>
          </div>
        </template>
      </PageToolbarCard>

      <div class="rounded-2xl border border-dashed border-brand/20 bg-brand/5 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-brand/20 dark:bg-brand/10 dark:text-slate-300">
        当前账号角色为“{{ authStore.currentUser?.role ? getRoleLabel(authStore.currentUser.role) : '-' }}”，治理能力包括：
        {{ authStore.currentUser ? getGovernancePermissionLabels(authStore.currentUser.permissions).join('、') || '仅查看基础业务页面' : '未登录' }}。
      </div>

      <div class="grid gap-3 xl:grid-cols-3">
        <div
          v-for="accountType in accountTypeDescriptions"
          :key="accountType.role"
          :class="['rounded-2xl border px-4 py-3', accountType.badgeClass]"
        >
          <div class="flex items-center gap-2">
            <span class="inline-flex h-2.5 w-2.5 rounded-full bg-current opacity-80" />
            <span class="text-sm font-semibold">{{ accountType.title }}</span>
          </div>
          <div class="mt-2 text-sm leading-6 opacity-90">
            {{ accountType.description }}
          </div>
        </div>
      </div>

      <div class="apple-card flex min-h-0 flex-1 flex-col p-3 sm:p-4 xl:p-5">
        <BizResponsiveDataCollectionShell
          :items="listState.records"
          :loading="listState.loading"
          empty-description="暂无用户数据"
          empty-min-height="260px"
          :skeleton-rows="6"
          wrapper-class="flex min-h-0 flex-1 flex-col"
          table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden px-0"
          card-container-class="pb-4"
        >
          <template #table>
            <el-table native-scrollbar :data="listState.records" stripe class="user-manage-table w-full flex-1" height="100%" table-layout="auto">
              <el-table-column prop="username" label="账号" min-width="150" show-overflow-tooltip />
              <el-table-column prop="displayName" label="姓名" min-width="132" show-overflow-tooltip />
              <el-table-column prop="email" label="邮箱" min-width="200" show-overflow-tooltip>
                <template #default="{ row }">{{ row.email || '-' }}</template>
              </el-table-column>
              <el-table-column label="角色" width="110">
                <template #default="{ row }">
                  <el-tag :type="getRoleTagType(row.role)" effect="light">{{ getRoleLabel(row.role) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="账号类型" min-width="240">
                <template #default="{ row }">
                  <div class="flex flex-col gap-1 py-1">
                    <div class="flex items-center gap-2">
                      <span
                        :class="[
                          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                          row.role === 'supplier'
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                            : row.role === 'admin'
                              ? 'bg-brand/10 text-brand dark:bg-brand/15 dark:text-teal-300'
                              : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300',
                        ]"
                      >
                        {{ row.role === 'supplier' ? '供货方专用入口' : row.role === 'admin' ? '治理账号' : '业务操作账号' }}
                      </span>
                    </div>
                    <span class="text-xs leading-5 text-slate-500 dark:text-slate-400">
                      {{ getAccountTypeDescription(row.role) }}
                    </span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="getAccountStateTagType(row.accountState)" effect="light">{{ getAccountStateLabel(row.accountState) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="两步验证" width="110">
                <template #default="{ row }">
                  <el-tag :type="row.mfaRequired ? 'success' : 'info'" effect="plain" size="small">{{ row.mfaRequired ? (row.mfaEnabled ? '动态码已开启' : '其他方式已开启') : '未开启' }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="密钥数量" width="110">
                <template #default="{ row }">{{ row.webauthnCredentialsCount ?? 0 }}</template>
              </el-table-column>
              <el-table-column label="生命周期" min-width="210" show-overflow-tooltip>
                <template #default="{ row }">
                  <span v-if="row.accountState === 'deactivated'">
                    {{ row.deactivatedAt ? dayjs(row.deactivatedAt).format('YYYY-MM-DD HH:mm') : '已注销' }} · {{ row.deactivationReason || '未提供原因' }}
                  </span>
                  <span v-else-if="row.restoredAt">最近恢复 {{ dayjs(row.restoredAt).format('YYYY-MM-DD HH:mm') }}</span>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <el-table-column label="关键权限边界" min-width="360" class-name="user-manage__permission-cell">
                <template #default="{ row }">
                  <div class="flex flex-wrap items-start gap-2 py-1">
                    <el-tag
                      v-for="label in getGovernancePermissionLabels(row.permissions)"
                      :key="`${row.id}-${label}`"
                      class="user-manage__permission-tag max-w-full"
                      size="small"
                      effect="plain"
                      type="info"
                    >
                      {{ label }}
                    </el-tag>
                    <span v-if="getGovernancePermissionLabels(row.permissions).length === 0" class="text-sm text-slate-400">无系统治理权限</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="最后登录" min-width="176">
                <template #default="{ row }">{{ row.lastLoginAt ? dayjs(row.lastLoginAt).format('YYYY-MM-DD HH:mm') : '-' }}</template>
              </el-table-column>
              <el-table-column label="创建时间" min-width="176">
                <template #default="{ row }">{{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}</template>
              </el-table-column>
              <el-table-column
                v-if="canOperateUsers"
                label="操作"
                fixed="right"
                width="390"
                align="right"
                class-name="user-manage__action-cell"
              >
                <template #default="{ row }">
                  <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 py-1">
                    <el-button v-if="canShowEditAction(row)" link type="primary" @click="handleOpenEdit(row)">编辑</el-button>
                    <el-button v-if="canShowResetPasswordAction(row)" link type="primary" @click="handleOpenResetPassword(row)">重置密码</el-button>
                    <el-button v-if="canShowResetMfaAction(row)" link type="warning" @click="handleResetMfa(row)">重置两步验证</el-button>
                    <el-button v-if="canShowRevokeWebAuthnAction(row)" link type="danger" @click="handleOpenRevokeWebAuthn(row)">撤销密钥</el-button>
                    <el-button
                      v-if="canShowToggleStatusAction(row)"
                      link
                      :type="row.status === 'enabled' ? 'warning' : 'success'"
                      @click="handleToggleStatus(row)"
                    >
                      {{ row.status === 'enabled' ? '停用' : '启用' }}
                    </el-button>
                    <el-button v-if="canDeactivateUser && row.accountState !== 'deactivated'" link type="danger" @click="handleOpenLifecycle(row, 'deactivate')">注销</el-button>
                    <el-button v-if="canDeactivateUser && row.accountState === 'deactivated'" link type="primary" @click="handleOpenLifecycle(row, 'restore')">恢复</el-button>
                    <el-button v-if="canPermanentDeleteUser && row.accountState === 'deactivated'" link type="danger" @click="handleOpenLifecycle(row, 'permanent_delete')">永久删除</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <template #card="{ item }">
            <div class="apple-card flex min-w-0 flex-col gap-3 p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">{{ item.displayName }}</div>
                  <div class="truncate text-sm text-slate-500 dark:text-slate-400">{{ item.username }}</div>
                  <div class="truncate text-xs text-slate-400 dark:text-slate-500">{{ item.email || '未配置邮箱' }}</div>
                </div>
                <el-tag :type="getAccountStateTagType(item.accountState)" effect="light">{{ getAccountStateLabel(item.accountState) }}</el-tag>
              </div>

              <div class="grid gap-2 rounded-2xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">角色</span>
                  <el-tag size="small" :type="getRoleTagType(item.role)" effect="light">{{ getRoleLabel(item.role) }}</el-tag>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <span class="text-slate-400">账号类型</span>
                  <div class="max-w-[70%] text-right text-xs leading-5 text-slate-500 dark:text-slate-400">
                    {{ getAccountTypeDescription(item.role) }}
                  </div>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <span class="text-slate-400">治理权限</span>
                  <div class="flex max-w-[70%] flex-wrap justify-end gap-1.5">
                    <el-tag
                      v-for="label in getGovernancePermissionLabels(item.permissions)"
                      :key="`${item.id}-${label}`"
                      size="small"
                      effect="plain"
                      type="info"
                    >
                      {{ label }}
                    </el-tag>
                    <span v-if="getGovernancePermissionLabels(item.permissions).length === 0">无</span>
                  </div>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">两步验证</span>
                  <el-tag size="small" :type="item.mfaRequired ? 'success' : 'info'" effect="plain">{{ item.mfaRequired ? (item.mfaEnabled ? '动态码已开启' : '其他方式已开启') : '未开启' }}</el-tag>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">密钥数量</span>
                  <span>{{ item.webauthnCredentialsCount ?? 0 }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">最后登录</span>
                  <span>{{ item.lastLoginAt ? dayjs(item.lastLoginAt).format('YYYY-MM-DD HH:mm') : '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">创建时间</span>
                  <span>{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
                </div>
                <div v-if="item.deactivatedAt" class="flex items-start justify-between gap-3">
                  <span class="text-slate-400">最近注销</span>
                  <span class="max-w-[70%] text-right">{{ dayjs(item.deactivatedAt).format('YYYY-MM-DD HH:mm') }} · {{ item.deactivationReason || '-' }}</span>
                </div>
              </div>

              <div v-if="canOperateUsers" class="flex items-center justify-end gap-3 border-t border-slate-100 pt-3 dark:border-white/10">
                <el-button v-if="canShowEditAction(item)" link type="primary" @click="handleOpenEdit(item)">编辑</el-button>
                <el-button v-if="canShowResetPasswordAction(item)" link type="primary" @click="handleOpenResetPassword(item)">重置密码</el-button>
                <el-button v-if="canShowResetMfaAction(item)" link type="warning" @click="handleResetMfa(item)">重置两步验证</el-button>
                <el-button v-if="canShowRevokeWebAuthnAction(item)" link type="danger" @click="handleOpenRevokeWebAuthn(item)">撤销密钥</el-button>
                <el-button
                  v-if="canShowToggleStatusAction(item)"
                  link
                  :type="item.status === 'enabled' ? 'warning' : 'success'"
                  @click="handleToggleStatus(item)"
                >
                  {{ item.status === 'enabled' ? '停用' : '启用' }}
                </el-button>
                <el-button v-if="canDeactivateUser && item.accountState !== 'deactivated'" link type="danger" @click="handleOpenLifecycle(item, 'deactivate')">注销</el-button>
                <el-button v-if="canDeactivateUser && item.accountState === 'deactivated'" link type="primary" @click="handleOpenLifecycle(item, 'restore')">恢复</el-button>
                <el-button v-if="canPermanentDeleteUser && item.accountState === 'deactivated'" link type="danger" @click="handleOpenLifecycle(item, 'permanent_delete')">永久删除</el-button>
              </div>
            </div>
          </template>
        </BizResponsiveDataCollectionShell>

        <PagePaginationBar
          v-if="listState.total > 0"
          v-model:current-page="listState.query.page"
          v-model:page-size="listState.query.pageSize"
          layout="total, sizes, prev, pager, next, jumper"
          :page-sizes="[10, 20, 50]"
          :total="listState.total"
          @current-change="handleCurrentChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </div>

    <BizCrudDialogShell
      v-model="dialogVisible"
      :title="dialogTitle"
      height-mode="auto"
      :confirm-loading="submitting"
      confirm-text="保存"
      @confirm="handleSubmit"
    >
      <el-form ref="formRef" :model="userForm" :rules="rules" label-position="top">
        <el-form-item label="登录账号" prop="username">
          <el-input v-model.trim="userForm.username" :disabled="usernameDisabled" placeholder="请输入登录账号" />
        </el-form-item>
        <el-form-item v-if="dialogMode === 'create'" label="登录密码" prop="password">
          <el-input
            v-model="userForm.password"
            type="password"
            show-password
            placeholder="请输入登录密码"
          />
        </el-form-item>
        <div
          v-else
          class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400"
        >
          编辑用户仅修改姓名、角色与状态；若需调整密码，请使用列表中的“重置密码”独立入口。
        </div>
        <el-form-item label="用户姓名" prop="displayName">
          <el-input v-model.trim="userForm.displayName" placeholder="请输入用户姓名" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model.trim="userForm.email" placeholder="可选，用于通知中心邮件提醒" />
        </el-form-item>
        <div class="grid gap-3 sm:grid-cols-2">
          <el-form-item label="角色" prop="role">
            <el-select v-model="userForm.role" class="w-full">
              <el-option
                v-for="roleOption in roleOptions"
                :key="roleOption.value"
                :label="roleOption.label"
                :value="roleOption.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="状态" prop="status">
            <el-select v-model="userForm.status" class="w-full" :disabled="dialogMode === 'edit' && !canToggleUser">
              <el-option label="启用" value="enabled" />
              <el-option label="停用" value="disabled" />
            </el-select>
          </el-form-item>
        </div>
        <div
          :class="[
            'rounded-2xl border px-4 py-3 text-sm leading-6',
            currentRoleDescription.role === 'supplier'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
              : currentRoleDescription.role === 'admin'
                ? 'border-brand/20 bg-brand/5 text-slate-600 dark:border-brand/20 dark:bg-brand/10 dark:text-slate-300'
                : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400',
          ]"
        >
          <div class="font-medium">
            {{ currentRoleDescription.title }}
          </div>
          <div class="mt-1">
            {{ currentRoleDescription.description }}
          </div>
          <div v-if="currentRoleDescription.role === 'supplier'" class="mt-2 text-xs opacity-90">
            创建成功后，系统会提示“该账号登录后将进入送货单录入页”。
          </div>
        </div>
      </el-form>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-model="resetPasswordVisible"
      title="重置密码"
      height-mode="auto"
      phone-width="94%"
      tablet-width="520px"
      desktop-width="440px"
      :confirm-loading="resetPasswordSubmitting"
      confirm-text="确认重置"
      @confirm="handleSubmitResetPassword"
      @closed="resetAdminPasswordForm"
    >
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        即将为“{{ resetPasswordForm.targetDisplayName || '-' }}（{{ resetPasswordForm.targetUsername || '-' }}）”重置密码。提交成功后，该用户已有登录会话会立即失效；已注册密钥仍保留。如怀疑凭据失陷，请另行撤销密钥。
      </div>
      <el-form ref="resetPasswordFormRef" :model="resetPasswordForm" :rules="resetPasswordRules" label-position="top">
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="resetPasswordForm.newPassword"
            type="password"
            show-password
            placeholder="请输入新的登录密码"
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="resetPasswordForm.confirmPassword"
            type="password"
            show-password
            placeholder="请再次输入新密码"
            autocomplete="new-password"
            @keyup.enter="handleSubmitResetPassword"
          />
        </el-form-item>
      </el-form>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-model="ownPasswordVisible"
      title="修改我的密码"
      height-mode="auto"
      phone-width="94%"
      tablet-width="520px"
      desktop-width="440px"
      :confirm-loading="ownPasswordSubmitting"
      confirm-text="确认修改"
      @confirm="handleSubmitOwnPassword"
      @closed="resetOwnPasswordForm"
    >
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        修改成功后，当前账号已有登录会话会立即失效，需要使用新密码重新登录系统。
      </div>
      <el-form ref="ownPasswordFormRef" :model="ownPasswordForm" :rules="ownPasswordRules" label-position="top">
        <el-form-item label="当前密码" prop="currentPassword">
          <el-input
            v-model="ownPasswordForm.currentPassword"
            type="password"
            show-password
            placeholder="请输入当前密码"
            autocomplete="current-password"
          />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="ownPasswordForm.newPassword"
            type="password"
            show-password
            placeholder="请输入新密码"
            autocomplete="new-password"
          />
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="ownPasswordForm.confirmPassword"
            type="password"
            show-password
            placeholder="请再次输入新密码"
            autocomplete="new-password"
            @keyup.enter="handleSubmitOwnPassword"
          />
        </el-form-item>
      </el-form>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      :model-value="resetMfaVisible"
      :title="`重置“${resetMfaTarget?.displayName || ''}”的两步验证`"
      height-mode="auto"
      phone-width="94%"
      tablet-width="520px"
      desktop-width="500px"
      @update:model-value="!$event && closeResetMfa()"
    >
      <el-alert type="warning" :closable="false" title="重置后目标账号的密码后验证方式和恢复码都将失效，对方下次仅凭密码即可登录。" />
      <el-alert v-if="resetMfaPhase === 'error'" class="mt-3" type="error" :closable="false" title="本人两步验证状态读取失败，请关闭后重试。" />
      <el-skeleton v-if="resetMfaPhase === 'loading'" class="mt-3" :rows="2" animated />
      <el-form v-else :model="resetMfaForm" :disabled="resetMfaSubmitting || resetMfaConfirmationPending" class="mt-3" label-position="top" @submit.prevent="handleSubmitResetMfa">
        <el-form-item label="当前密码">
          <el-input v-model="resetMfaForm.currentPassword" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <template v-if="resetMfaStatus?.mfaRequired">
          <el-form-item label="本人复核方式">
            <el-radio-group v-model="resetMfaForm.mode">
              <el-radio v-if="resetMfaStatus.availableMethods.includes('totp')" value="totp">动态码</el-radio>
              <el-radio v-if="resetMfaStatus.availableMethods.includes('recovery_code')" value="recovery_code">恢复码</el-radio>
              <el-radio v-if="resetMfaStatus.availableMethods.includes('webauthn')" value="webauthn">已绑定密钥</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="resetMfaForm.mode === 'totp'" label="6 位动态码">
            <el-input v-model="resetMfaForm.code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" />
          </el-form-item>
          <el-form-item v-else-if="resetMfaForm.mode === 'recovery_code'" label="恢复码">
            <el-input v-model="resetMfaForm.recoveryCode" placeholder="单个恢复码，例如ABCD-EFGH-JKLM" autocomplete="off" maxlength="32" @paste="guardRecoveryCodePaste($event, showAppWarning)" />
          </el-form-item>
          <el-alert v-else type="info" :closable="false" title="确认后浏览器会请求已绑定的强凭据完成安全复核。" />
        </template>
      </el-form>
      <template #footer>
        <el-button :disabled="resetMfaSubmitting || resetMfaConfirmationPending" @click="closeResetMfa">取消</el-button>
        <el-button type="danger" :loading="resetMfaSubmitting || resetMfaConfirmationPending" :disabled="resetMfaPhase !== 'ready'" @click="handleSubmitResetMfa">确认重置</el-button>
      </template>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      :model-value="revokeWebAuthnVisible"
      @update:model-value="updateRevokeWebAuthnVisible"
      title="撤销用户密钥"
      height-mode="auto"
      phone-width="94%"
      tablet-width="500px"
      desktop-width="480px"
      :confirm-loading="revokeWebAuthnSubmitting"
      confirm-text="撤销全部密钥"
      @confirm="handleSubmitRevokeWebAuthn"
    >
      <el-alert v-if="revokeWebAuthnSubmitting" class="mb-3" type="info" :closable="false" title="撤销请求已提交，请等待结果后再关闭。" />
      <el-alert
        class="mb-3"
        type="warning"
        :closable="false"
        :title="`将撤销“${revokeWebAuthnTarget?.displayName || '-'}”的全部 ${revokeWebAuthnTarget?.webauthnCredentialsCount ?? 0} 把密钥，目标账号所有会话立即失效。${getRevokeMfaNotice(revokeWebAuthnTarget)}`"
      />
      <el-alert v-if="revokeWebAuthnMfaPhase === 'error'" class="mb-3" type="error" :closable="false" title="本人两步验证状态读取失败，请关闭后重试。" />
      <el-form :model="revokeWebAuthnForm" :disabled="revokeWebAuthnSubmitting || revokeWebAuthnConfirmationPending" label-position="top" @submit.prevent="handleSubmitRevokeWebAuthn">
        <el-form-item label="撤销原因">
          <el-input v-model="revokeWebAuthnForm.reason" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="请说明密钥丢失或凭据失陷等原因" />
        </el-form-item>
        <el-form-item label="当前密码">
          <el-input v-model="revokeWebAuthnForm.currentPassword" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <template v-if="revokeWebAuthnMfaStatus?.mfaRequired">
          <el-form-item v-if="!revokeWebAuthnForm.useWebAuthn" :label="revokeWebAuthnForm.useRecoveryCode ? '恢复码' : '6 位动态码'">
            <el-input v-if="revokeWebAuthnForm.useRecoveryCode" v-model="revokeWebAuthnForm.recoveryCode" placeholder="单个恢复码，例如ABCD-EFGH-JKLM" autocomplete="off" maxlength="32" @paste="guardRecoveryCodePaste($event, showAppWarning)" />
            <el-input v-else v-model="revokeWebAuthnForm.code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" />
          </el-form-item>
          <el-alert v-else type="info" :closable="false" title="确认后请使用已绑定的强凭据完成安全复核。" />
          <div class="flex flex-wrap gap-1">
            <el-button v-if="revokeWebAuthnMfaStatus.availableMethods.includes('totp')" link type="primary" @click="revokeWebAuthnForm.useWebAuthn = false; revokeWebAuthnForm.useRecoveryCode = false">动态码</el-button>
            <el-button v-if="revokeWebAuthnMfaStatus.availableMethods.includes('recovery_code')" link type="primary" @click="revokeWebAuthnForm.useWebAuthn = false; revokeWebAuthnForm.useRecoveryCode = true">恢复码</el-button>
            <el-button v-if="revokeWebAuthnMfaStatus.availableMethods.includes('webauthn')" link type="primary" @click="revokeWebAuthnForm.useWebAuthn = true; revokeWebAuthnForm.useRecoveryCode = false">已绑定密钥</el-button>
          </div>
        </template>
      </el-form>
    </BizCrudDialogShell>

    <AccountLifecycleDialog
      v-model="lifecycleVisible"
      :action="lifecycleAction"
      :account-label="lifecycleTarget?.username || ''"
      :preview="lifecyclePreview"
      :lifecycle="lifecycleTarget"
      :loading="lifecycleLoading"
      @confirm="handleLifecycleConfirm"
    />
  </PageContainer>
</template>

<style scoped>
/* 用户管理表格：
 * - 让多枚权限标签在列宽不足时安全换行，避免标签内容把单元格撑坏；
 * - 操作列与权限列统一增加上下留白，弱化多行内容时的拥挤感。
 */
.user-manage-table :deep(.user-manage__permission-cell .cell),
.user-manage-table :deep(.user-manage__action-cell .cell) {
  padding-top: 4px;
  padding-bottom: 4px;
}

.user-manage-table :deep(.user-manage__permission-tag) {
  height: auto;
  white-space: normal;
  line-height: 1.25rem;
}

</style>
