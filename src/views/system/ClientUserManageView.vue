<script setup lang="ts">
/**
 * 模块说明：src/views/system/ClientUserManageView.vue
 * 文件职责：管理端对客户端用户进行查询、单个治理、部门共享账号批量开户、启停与密码重置。
 * 维护说明：
 * - 客户端用户与管理端用户分开治理，避免字段语义和操作入口混淆；
 * - 手动新增入口仅服务管理端受权治理，不经过客户端自助注册风控。
 * - 批量部门账号的明文凭据只保留在当前弹窗内，关闭后必须清理并撤销下载链接。
 */

import dayjs from 'dayjs'
import { computed, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { BizCrudDialogShell, BizResponsiveDataCollectionShell, PageContainer, PagePaginationBar, PageToolbarCard } from '@/components/common'
import {
  createClientUser,
  createDepartmentAccountBatch,
  getClientUserList,
  previewDepartmentAccountBatch,
  resetClientUserPassword,
  updateClientUser,
  updateClientUserStatus,
  type CreateClientUserPayload,
  type ClientUserProfileKind,
  type ClientUserManageProfile,
  type ClientUserStatus,
  type CreateDepartmentAccountBatchResult,
  type DepartmentAccountBatchPreviewResult,
  type DepartmentAccountBatchSkippedDepartment,
  type ResetClientUserPasswordPayload,
  type ClientUserListQuery,
  type UpdateClientUserPayload,
} from '@/api/modules/client-user-manage'
import { getClientDepartmentConfigs, type ClientDepartmentTreeNode } from '@/api/modules/system-config'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage, normalizeRequestError } from '@/utils/error'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'

import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import {
  buildDepartmentAccountCsv,
  createDepartmentAccountCredentials,
  createDepartmentAccountCsvFilename,
  isDepartmentAccountBatchOperationCurrent,
  mergeDepartmentAccountBatchSkipped,
  reconcileDepartmentAccountBatch,
  reconcileDepartmentAccountBatchResult,
  type DepartmentAccountCredential,
  type DepartmentAccountBatchRecoveryResult,
  type DepartmentAccountBatchOperationSnapshot,
} from './client-user-department-batch'

type DepartmentTreeSelectOption = {
  value: string
  label: string
  fullPath: string
  children?: DepartmentTreeSelectOption[]
}

type DepartmentNodeMeta = {
  departmentNodeId: string
  departmentName: string
}

const listRequest = useStableRequest()
const { hasPermission, ensurePermission } = usePermissionAction()

const searchForm = reactive({
  keyword: '',
  status: '' as '' | ClientUserStatus,
  profileKind: '' as '' | ClientUserProfileKind,
  departmentName: '',
  staffNo: '',
})

const listState = reactive(
  createPaginatedListState<ClientUserManageProfile>({
    loading: true,
    query: {
      pageSize: 10,
    },
  }),
)

const canEditUser = computed(() => hasPermission('users:update'))
const canToggleUser = computed(() => hasPermission('users:status'))
const canResetUserPassword = computed(() => hasPermission('users:reset_password'))
const canCreateUser = computed(() => hasPermission('users:create'))
const canOperateUsers = computed(() => canEditUser.value || canToggleUser.value || canResetUserPassword.value)
const departmentOptions = ref<string[]>([])
const departmentTree = ref<ClientDepartmentTreeNode[]>([])
const departmentPathLookup = ref<Record<string, string>>({})
const departmentNodeLookup = ref<Record<string, DepartmentNodeMeta>>({})
const departmentOptionsLoading = ref(false)

const createVisible = ref(false)
const createSubmitting = ref(false)
const createFormRef = ref<FormInstance>()
const createForm = reactive({
  profileKind: 'personal' as ClientUserProfileKind,
  username: '',
  staffNo: '',
  mobile: '',
  email: '',
  departmentName: '',
  departmentNodeId: '',
  password: '',
  confirmPassword: '',
  status: 'enabled' as ClientUserStatus,
})

const isCreateTeacherProfile = computed(() => createForm.profileKind === 'teacher')
const isCreateDepartmentProfile = computed(() => createForm.profileKind === 'department')
const isCreatePersonalProfile = computed(() => createForm.profileKind === 'personal')
const createUsernameLabel = computed(() => (isCreateDepartmentProfile.value ? '账号名称' : '用户名'))
const createDepartmentRequired = computed(() => isCreateDepartmentProfile.value)
const createContactRequired = computed(() => isCreatePersonalProfile.value)

const createRules: FormRules = {
  profileKind: [{ required: true, message: '请选择创建类型', trigger: 'change' }],
  username: [
    {
      validator: (_rule, value: string, callback) => {
        if (!isCreateTeacherProfile.value && !value.trim()) {
          callback(new Error(isCreateDepartmentProfile.value ? '请输入账号名称' : '请输入用户名'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  staffNo: [
    {
      validator: (_rule, value: string, callback) => {
        if (!isCreateTeacherProfile.value) {
          callback()
          return
        }
        const normalized = value.trim()
        if (!normalized) {
          callback(new Error('请输入教职工号'))
          return
        }
        if (!/^[A-Za-z0-9-]{4,32}$/.test(normalized)) {
          callback(new Error('教职工号仅支持字母、数字和短横线（4-32位）'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  mobile: [
    {
      validator: (_rule, value: string, callback) => {
        if (value && !/^1\d{10}$/.test(value.trim())) {
          callback(new Error('手机号格式不正确'))
          return
        }
        if (createContactRequired.value && !value.trim() && !createForm.email.trim()) {
          callback(new Error('手机号和邮箱至少保留一项'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  email: [
    {
      validator: (_rule, value: string, callback) => {
        if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
          callback(new Error('邮箱格式不正确'))
          return
        }
        if (createContactRequired.value && !value.trim() && !createForm.mobile.trim()) {
          callback(new Error('手机号和邮箱至少保留一项'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  departmentNodeId: [
    {
      validator: (_rule, value: string, callback) => {
        if (createDepartmentRequired.value && !value.trim()) {
          callback(new Error('请选择部门共享账号所属部门'))
          return
        }
        callback()
      },
      trigger: 'change',
    },
  ],
  password: [
    { required: true, message: '请输入登录密码', trigger: 'blur' },
    { min: 8, message: '登录密码至少 8 位', trigger: 'blur' },
  ],
  confirmPassword: [
    {
      validator: (_rule, value: string, callback) => {
        if (!value) {
          callback(new Error('请再次输入登录密码'))
          return
        }
        if (value !== createForm.password) {
          callback(new Error('两次输入的登录密码不一致'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  status: [{ required: true, message: '请选择账号状态', trigger: 'change' }],
}

const editVisible = ref(false)
const editSubmitting = ref(false)
const editFormRef = ref<FormInstance>()
const editForm = reactive({
  id: '',
  profileKind: 'personal' as ClientUserProfileKind,
  username: '',
  mobile: '',
  email: '',
  departmentName: '',
  departmentNodeId: '',
  status: 'enabled' as ClientUserStatus,
})

const editRules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  mobile: [
    {
      validator: (_rule, value: string, callback) => {
        if (value && !/^1\d{10}$/.test(value.trim())) {
          callback(new Error('手机号格式不正确'))
          return
        }
        if (editForm.profileKind === 'personal' && !value.trim() && !editForm.email.trim()) {
          callback(new Error('手机号和邮箱至少保留一项'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  email: [
    {
      validator: (_rule, value: string, callback) => {
        if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
          callback(new Error('邮箱格式不正确'))
          return
        }
        if (editForm.profileKind === 'personal' && !value.trim() && !editForm.mobile.trim()) {
          callback(new Error('手机号和邮箱至少保留一项'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  status: [{ required: true, message: '请选择账号状态', trigger: 'change' }],
}

const resetPasswordVisible = ref(false)
const resetPasswordSubmitting = ref(false)
const resetPasswordFormRef = ref<FormInstance>()
const resetPasswordForm = reactive({
  targetUserId: '',
  targetUsername: '',
  targetDepartmentName: '',
  newPassword: '',
  confirmPassword: '',
})

const resetPasswordRules: FormRules = {
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '新密码长度至少为 6 位', trigger: 'blur' },
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

const getStatusTagType = (status: ClientUserStatus) => {
  return status === 'enabled' ? 'success' : 'warning'
}

const getStatusLabel = (status: ClientUserStatus) => {
  return status === 'enabled' ? '启用' : '停用'
}

const getProfileKindLabel = (profileKind: ClientUserProfileKind) => {
  if (profileKind === 'teacher') return '教师账号'
  if (profileKind === 'department') return '部门共享账号'
  return '个人账号'
}

const getProfileKindTagType = (profileKind: ClientUserProfileKind) => {
  if (profileKind === 'teacher') return 'success'
  if (profileKind === 'department') return 'warning'
  return 'info'
}

const getStaffNoLabel = (profileKind: ClientUserProfileKind) => {
  return profileKind === 'department' ? '账号编号' : '教职工号'
}

const resetCreateForm = () => {
  createForm.profileKind = 'personal'
  createForm.username = ''
  createForm.staffNo = ''
  createForm.mobile = ''
  createForm.email = ''
  createForm.departmentName = ''
  createForm.departmentNodeId = ''
  createForm.password = ''
  createForm.confirmPassword = ''
  createForm.status = 'enabled'
  createFormRef.value?.clearValidate()
}

const resetEditForm = () => {
  editForm.id = ''
  editForm.profileKind = 'personal'
  editForm.username = ''
  editForm.mobile = ''
  editForm.email = ''
  editForm.departmentName = ''
  editForm.departmentNodeId = ''
  editForm.status = 'enabled'
  editFormRef.value?.clearValidate()
}

const normalizeOptionalText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const buildDepartmentPathLookup = (tree: ClientDepartmentTreeNode[]) => {
  const pathMap: Record<string, string> = {}
  const labelPathMap = new Map<string, string[]>()
  const walk = (nodes: ClientDepartmentTreeNode[], parentPath = '') => {
    nodes.forEach((node) => {
      const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
      pathMap[currentPath] = currentPath
      const paths = labelPathMap.get(node.label) ?? []
      paths.push(currentPath)
      labelPathMap.set(node.label, paths)
      if (Array.isArray(node.children) && node.children.length > 0) {
        walk(node.children, currentPath)
      }
    })
  }
  walk(tree)
  labelPathMap.forEach((paths, label) => {
    if (paths.length === 1) {
      pathMap[label] = paths[0]
    }
  })
  return pathMap
}

const buildDepartmentNodeLookup = (tree: ClientDepartmentTreeNode[]) => {
  const lookup: Record<string, DepartmentNodeMeta> = {}
  const walk = (nodes: ClientDepartmentTreeNode[], parentPath = '') => {
    nodes.forEach((node) => {
      const label = String(node.label ?? '').trim()
      const nodeId = String(node.id ?? '').trim()
      if (!label || !nodeId) return
      const departmentName = parentPath ? `${parentPath}-${label}` : label
      lookup[nodeId] = { departmentNodeId: nodeId, departmentName }
      walk(Array.isArray(node.children) ? node.children : [], departmentName)
    })
  }
  walk(tree)
  return lookup
}

const resolveDepartmentPathDisplay = (value: unknown) => {
  const normalized = normalizeOptionalText(value)
  if (!normalized) {
    return ''
  }
  return departmentPathLookup.value[normalized] ?? normalized
}

const departmentTreeSelectOptions = computed(() => {
  const buildOptions = (nodes: ClientDepartmentTreeNode[], parentPath = ''): DepartmentTreeSelectOption[] => {
    return nodes
      .map((node) => {
        const label = String(node.label ?? '').trim()
        if (!label) {
          return null
        }
        const fullPath = parentPath ? `${parentPath}-${label}` : label
        const value = String(node.id ?? '').trim()
        if (!value) return null
        const children = buildOptions(Array.isArray(node.children) ? node.children : [], fullPath)
        return {
          value,
          label,
          fullPath,
          ...(children.length > 0 ? { children } : {}),
        }
      })
      .filter((item): item is DepartmentTreeSelectOption => Boolean(item))
  }

  return buildOptions(departmentTree.value)
})
const departmentTreeSelectProps = {
  value: 'value',
  label: 'label',
  children: 'children',
} as const

const departmentAccountBatchVisible = ref(false)
const departmentAccountBatchSubmitting = ref(false)
const departmentAccountBatchPreviewLoading = ref(false)
const departmentAccountBatchNodeIds = ref<string[]>([])
const departmentAccountBatchStatus = ref<ClientUserStatus>('enabled')
const departmentAccountBatchPreview = ref<DepartmentAccountBatchPreviewResult | null>(null)
const departmentAccountBatchCredentials = ref<DepartmentAccountCredential[]>([])
const departmentAccountBatchCreatedCredentials = ref<DepartmentAccountCredential[]>([])
const departmentAccountBatchUnconfirmedCredentials = ref<DepartmentAccountCredential[]>([])
const departmentAccountBatchSkipped = ref<DepartmentAccountBatchSkippedDepartment[]>([])
const departmentAccountBatchInitialSkipped = ref<DepartmentAccountBatchSkippedDepartment[]>([])
const departmentAccountBatchRecovery = ref<DepartmentAccountBatchRecoveryResult | null>(null)
let departmentAccountBatchCsvUrl: string | null = null
let departmentAccountBatchEpoch = 0
let departmentAccountBatchController: AbortController | null = null

const selectedDepartmentAccountBatchNodes = computed(() => {
  return departmentAccountBatchNodeIds.value
    .map((nodeId) => departmentNodeLookup.value[nodeId])
    .filter((item): item is DepartmentNodeMeta => Boolean(item))
})
const isDepartmentAccountBatchSelectionValid = computed(() => {
  return (
    departmentAccountBatchNodeIds.value.length >= 1 &&
    departmentAccountBatchNodeIds.value.length <= 100 &&
    selectedDepartmentAccountBatchNodes.value.length === departmentAccountBatchNodeIds.value.length
  )
})
const hasDepartmentAccountBatchResults = computed(() => departmentAccountBatchCreatedCredentials.value.length > 0)
const isEditingOrphanedDepartmentAccount = computed(() => {
  return editForm.profileKind === 'department' && (!editForm.departmentNodeId || !departmentNodeLookup.value[editForm.departmentNodeId])
})

const getDepartmentAccountBatchOperationSnapshot = (): DepartmentAccountBatchOperationSnapshot => ({
  epoch: departmentAccountBatchEpoch,
  visible: departmentAccountBatchVisible.value,
  departmentNodeIds: [...departmentAccountBatchNodeIds.value],
})

const isCurrentDepartmentAccountBatchOperation = (snapshot: DepartmentAccountBatchOperationSnapshot) => {
  return isDepartmentAccountBatchOperationCurrent(snapshot, getDepartmentAccountBatchOperationSnapshot())
}

const invalidateDepartmentAccountBatchOperation = () => {
  departmentAccountBatchEpoch += 1
  departmentAccountBatchController?.abort()
  departmentAccountBatchController = null
  return departmentAccountBatchEpoch
}

const revokeDepartmentAccountBatchCsvUrl = () => {
  if (departmentAccountBatchCsvUrl) {
    URL.revokeObjectURL(departmentAccountBatchCsvUrl)
    departmentAccountBatchCsvUrl = null
  }
}

const clearDepartmentAccountBatchSensitiveState = () => {
  invalidateDepartmentAccountBatchOperation()
  revokeDepartmentAccountBatchCsvUrl()
  departmentAccountBatchNodeIds.value = []
  departmentAccountBatchStatus.value = 'enabled'
  departmentAccountBatchPreview.value = null
  departmentAccountBatchCredentials.value = []
  departmentAccountBatchCreatedCredentials.value = []
  departmentAccountBatchUnconfirmedCredentials.value = []
  departmentAccountBatchSkipped.value = []
  departmentAccountBatchInitialSkipped.value = []
  departmentAccountBatchRecovery.value = null
  departmentAccountBatchPreviewLoading.value = false
  departmentAccountBatchSubmitting.value = false
}

const invalidateDepartmentAccountBatchPreview = () => {
  invalidateDepartmentAccountBatchOperation()
  departmentAccountBatchPreview.value = null
  departmentAccountBatchCredentials.value = []
  departmentAccountBatchCreatedCredentials.value = []
  departmentAccountBatchUnconfirmedCredentials.value = []
  departmentAccountBatchSkipped.value = []
  departmentAccountBatchInitialSkipped.value = []
  departmentAccountBatchRecovery.value = null
  departmentAccountBatchPreviewLoading.value = false
}

const downloadDepartmentAccountCsv = (snapshot?: DepartmentAccountBatchOperationSnapshot) => {
  if (snapshot && !isCurrentDepartmentAccountBatchOperation(snapshot)) {
    return
  }
  if (departmentAccountBatchCreatedCredentials.value.length === 0) {
    showAppWarning('当前没有可下载的新增账号凭据')
    return
  }
  revokeDepartmentAccountBatchCsvUrl()
  const csv = buildDepartmentAccountCsv(departmentAccountBatchCreatedCredentials.value)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  departmentAccountBatchCsvUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = departmentAccountBatchCsvUrl
  anchor.download = createDepartmentAccountCsvFilename()
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(revokeDepartmentAccountBatchCsvUrl, 0)
}

const handleOpenDepartmentAccountBatch = () => {
  if (!ensurePermission('users:create', '批量创建部门账号')) {
    return
  }
  clearDepartmentAccountBatchSensitiveState()
  departmentAccountBatchVisible.value = true
  departmentAccountBatchEpoch += 1
}

const handleDepartmentAccountBatchModelValueUpdate = (visible: boolean) => {
  if (!visible && departmentAccountBatchSubmitting.value) {
    showAppWarning('批量创建或恢复核对进行中，暂不能关闭弹窗，以免丢失本次凭据')
    return
  }
  departmentAccountBatchVisible.value = visible
}

const handleDepartmentAccountBatchSelectionChange = (nodeIds: string[]) => {
  if (nodeIds.length > 100) {
    departmentAccountBatchNodeIds.value = nodeIds.slice(0, 100)
    showAppWarning('一次最多选择 100 个部门，已保留前 100 个选择')
  }
  invalidateDepartmentAccountBatchPreview()
}

const handlePreviewDepartmentAccountBatch = async () => {
  if (!ensurePermission('users:create', '批量创建部门账号')) {
    return
  }
  if (!isDepartmentAccountBatchSelectionValid.value) {
    showAppWarning('请选择 1 至 100 个有效部门节点')
    return
  }
  if (departmentOptionsLoading.value || departmentTree.value.length === 0) {
    showAppWarning('暂无可用部门配置，请先在“部门配置”中维护部门')
    return
  }

  const operationEpoch = invalidateDepartmentAccountBatchOperation()
  const controller = new AbortController()
  departmentAccountBatchController = controller
  const snapshot: DepartmentAccountBatchOperationSnapshot = {
    epoch: operationEpoch,
    visible: departmentAccountBatchVisible.value,
    departmentNodeIds: [...departmentAccountBatchNodeIds.value],
  }
  departmentAccountBatchPreviewLoading.value = true
  try {
    const preview = await previewDepartmentAccountBatch({ departmentNodeIds: snapshot.departmentNodeIds }, { signal: controller.signal })
    if (!isCurrentDepartmentAccountBatchOperation(snapshot)) {
      return
    }
    departmentAccountBatchPreview.value = preview
    departmentAccountBatchCredentials.value = createDepartmentAccountCredentials(preview.creatable)
    departmentAccountBatchInitialSkipped.value = preview.skipped
    departmentAccountBatchSkipped.value = preview.skipped
    departmentAccountBatchRecovery.value = null
    if (preview.creatable.length === 0) {
      showAppWarning('所选部门均已存在共享账号，已跳过且不会修改原账号状态或密码')
    }
  } catch (error) {
    if (isCurrentDepartmentAccountBatchOperation(snapshot) && !controller.signal.aborted) {
      showAppError(extractErrorMessage(error, '部门账号预检失败'))
    }
  } finally {
    if (departmentAccountBatchController === controller) {
      departmentAccountBatchController = null
    }
    if (isCurrentDepartmentAccountBatchOperation(snapshot)) {
      departmentAccountBatchPreviewLoading.value = false
    }
  }
}

const applyDepartmentAccountBatchReconciliation = async (
  confirmedCredentials: DepartmentAccountCredential[],
  unconfirmedCredentials: DepartmentAccountCredential[],
  skipped: DepartmentAccountBatchSkippedDepartment[],
  snapshot: DepartmentAccountBatchOperationSnapshot,
) => {
  if (!isCurrentDepartmentAccountBatchOperation(snapshot)) {
    return false
  }
  departmentAccountBatchCreatedCredentials.value = confirmedCredentials
  departmentAccountBatchUnconfirmedCredentials.value = unconfirmedCredentials
  departmentAccountBatchCredentials.value = unconfirmedCredentials
  departmentAccountBatchSkipped.value = skipped
  if (confirmedCredentials.length > 0) {
    downloadDepartmentAccountCsv(snapshot)
  }
  void loadData()
  return isCurrentDepartmentAccountBatchOperation(snapshot)
}

const reconcileDepartmentAccountBatchAfterTransportFailure = async (submissionSnapshot: DepartmentAccountBatchOperationSnapshot) => {
  if (!isCurrentDepartmentAccountBatchOperation(submissionSnapshot)) {
    return
  }
  const generatedCredentials = [...departmentAccountBatchCredentials.value]
  const initialSkipped = [...departmentAccountBatchInitialSkipped.value]
  if (submissionSnapshot.departmentNodeIds.length === 0 || generatedCredentials.length === 0) return

  const operationEpoch = invalidateDepartmentAccountBatchOperation()
  const controller = new AbortController()
  departmentAccountBatchController = controller
  const snapshot: DepartmentAccountBatchOperationSnapshot = {
    epoch: operationEpoch,
    visible: departmentAccountBatchVisible.value,
    departmentNodeIds: [...submissionSnapshot.departmentNodeIds],
  }
  departmentAccountBatchPreviewLoading.value = true
  try {
    const refreshedPreview = await previewDepartmentAccountBatch({ departmentNodeIds: snapshot.departmentNodeIds }, { signal: controller.signal })
    if (!isCurrentDepartmentAccountBatchOperation(snapshot)) {
      return
    }
    const generatedNodeIds = new Set(generatedCredentials.map((item) => item.departmentNodeId))
    const scopedPreview = {
      creatable: refreshedPreview.creatable.filter((item) => generatedNodeIds.has(item.departmentNodeId)),
      skipped: refreshedPreview.skipped.filter((item) => generatedNodeIds.has(item.departmentNodeId)),
    }
    const recovery = reconcileDepartmentAccountBatch(scopedPreview, generatedCredentials)
    departmentAccountBatchPreview.value = refreshedPreview
    departmentAccountBatchSkipped.value = mergeDepartmentAccountBatchSkipped(initialSkipped, refreshedPreview.skipped)
    departmentAccountBatchRecovery.value = recovery
    if (recovery.state === 'completed') {
      const applied = await applyDepartmentAccountBatchReconciliation(
        recovery.completed,
        [],
        mergeDepartmentAccountBatchSkipped(initialSkipped, refreshedPreview.skipped),
        snapshot,
      )
      if (applied) {
        showAppSuccess(`已确认 ${recovery.completed.length} 个部门共享账号，凭据已自动下载`)
      }
      return
    }
    if (recovery.state === 'not_committed') {
      departmentAccountBatchCredentials.value = recovery.pending
      departmentAccountBatchUnconfirmedCredentials.value = []
      showAppWarning('已重新预检：本次请求未提交，可使用同一组凭据安全重试')
      return
    }
    const applied = await applyDepartmentAccountBatchReconciliation(
      recovery.completed,
      recovery.unconfirmed,
      mergeDepartmentAccountBatchSkipped(initialSkipped, refreshedPreview.skipped),
      snapshot,
    )
    if (applied) {
      showAppWarning('预检结果存在混合状态、账号不一致或路径无效：仅已确认凭据已下载，未确认项需人工核对')
    }
  } catch (error) {
    if (isCurrentDepartmentAccountBatchOperation(snapshot) && !controller.signal.aborted) {
      departmentAccountBatchRecovery.value = {
        state: 'conflict',
        completed: [],
        pending: [],
        unconfirmed: generatedCredentials,
        reason: '网络异常后恢复预检失败，无法确认本次凭据是否已生效，需人工核对',
      }
      departmentAccountBatchUnconfirmedCredentials.value = generatedCredentials
      departmentAccountBatchCredentials.value = generatedCredentials
      showAppWarning(`网络异常后无法完成恢复预检：${extractErrorMessage(error, '请人工核对')}`)
    }
  } finally {
    if (departmentAccountBatchController === controller) {
      departmentAccountBatchController = null
    }
    if (isCurrentDepartmentAccountBatchOperation(snapshot)) {
      departmentAccountBatchPreviewLoading.value = false
    }
  }
}

const handleSubmitDepartmentAccountBatch = async () => {
  if (!ensurePermission('users:create', '批量创建部门账号')) {
    return
  }
  if (!departmentAccountBatchPreview.value) {
    await handlePreviewDepartmentAccountBatch()
    return
  }
  if (departmentAccountBatchSubmitting.value) {
    return
  }
  if (departmentAccountBatchRecovery.value?.state === 'conflict') {
    showAppWarning('当前结果需要人工核对，不能自动重试；请关闭弹窗清除凭据后重新预检')
    return
  }
  if (departmentAccountBatchCredentials.value.length === 0) {
    showAppWarning('没有待创建账号；所选部门均已跳过')
    return
  }

  const pendingCredentials = [...departmentAccountBatchCredentials.value]
  const initialSkipped = [...departmentAccountBatchInitialSkipped.value]
  const operationEpoch = invalidateDepartmentAccountBatchOperation()
  const snapshot: DepartmentAccountBatchOperationSnapshot = {
    epoch: operationEpoch,
    visible: departmentAccountBatchVisible.value,
    departmentNodeIds: [...departmentAccountBatchNodeIds.value],
  }
  departmentAccountBatchSubmitting.value = true
  try {
    const result: CreateDepartmentAccountBatchResult = await createDepartmentAccountBatch({
      status: departmentAccountBatchStatus.value,
      items: pendingCredentials.map((item) => ({
        departmentNodeId: item.departmentNodeId,
        account: item.account,
        initialPassword: item.initialPassword,
      })),
    })
    if (!isCurrentDepartmentAccountBatchOperation(snapshot)) {
      return
    }
    const reconciliation = reconcileDepartmentAccountBatchResult(result, pendingCredentials)
    const mergedSkipped = mergeDepartmentAccountBatchSkipped(initialSkipped, result.skipped)
    departmentAccountBatchRecovery.value =
      reconciliation.state === 'conflict'
        ? {
            state: 'conflict',
            completed: reconciliation.confirmed,
            pending: [],
            unconfirmed: reconciliation.unconfirmed,
            reason: reconciliation.reason,
          }
        : null
    const applied = await applyDepartmentAccountBatchReconciliation(
      reconciliation.confirmed,
      reconciliation.unconfirmed,
      mergedSkipped,
      snapshot,
    )
    if (!applied) {
      return
    }
    if (reconciliation.state === 'confirmed') {
      showAppSuccess(`已确认 ${reconciliation.confirmed.length} 个部门共享账号，凭据已自动下载`)
      return
    }
    showAppWarning('服务端回包存在待核对项：仅已确认凭据已下载，未确认凭据不得自动重试')
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '批量创建部门账号失败')
    const isRecoverableTransportFailure =
      !normalizedError.status ||
      [408, 502, 503, 504].includes(normalizedError.status) ||
      (normalizedError.status >= 500 && /超时|timeout|gateway|网关/i.test(normalizedError.message))
    if (isRecoverableTransportFailure && isCurrentDepartmentAccountBatchOperation(snapshot)) {
      showAppWarning('批量请求网络异常或超时，正在按原部门和账号重新预检恢复结果')
      await reconcileDepartmentAccountBatchAfterTransportFailure(snapshot)
      if (departmentAccountBatchVisible.value) {
        departmentAccountBatchSubmitting.value = false
      }
      return
    }
    if (!isCurrentDepartmentAccountBatchOperation(snapshot)) {
      return
    }
    invalidateDepartmentAccountBatchPreview()
    departmentAccountBatchSubmitting.value = false
    void showCriticalErrorDialog(error, {
      title: '批量创建部门账号失败',
      fallback: '批量创建部门账号失败',
      operation: '批量创建部门账号',
    })
  } finally {
    departmentAccountBatchSubmitting.value = false
  }
}

const buildQueryParams = (): ClientUserListQuery => {
  const params: ClientUserListQuery = {
    page: listState.query.page,
    pageSize: listState.query.pageSize,
  }

  if (searchForm.keyword.trim()) {
    params.keyword = searchForm.keyword.trim()
  }
  if (searchForm.status) {
    params.status = searchForm.status
  }
  if (searchForm.profileKind) {
    params.profileKind = searchForm.profileKind
  }
  if (searchForm.departmentName.trim()) {
    params.departmentName = searchForm.departmentName.trim()
  }
  if (searchForm.staffNo.trim()) {
    params.staffNo = searchForm.staffNo.trim()
  }

  return params
}

const loadData = async () => {
  if (!ensurePermission('users:view', '客户端用户查看')) {
    listState.loading = false
    listState.records = []
    listState.total = 0
    return
  }

  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getClientUserList(buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取客户端用户列表失败'))
    },
    onFinally: () => {
      listState.loading = false
    },
  })
}

const loadDepartmentOptions = async () => {
  departmentOptionsLoading.value = true
  try {
    const result = await getClientDepartmentConfigs()
    departmentOptions.value = result.options
    departmentTree.value = result.tree
    departmentPathLookup.value = buildDepartmentPathLookup(result.tree)
    departmentNodeLookup.value = buildDepartmentNodeLookup(result.tree)
  } catch (error) {
    departmentOptions.value = []
    departmentTree.value = []
    departmentPathLookup.value = {}
    departmentNodeLookup.value = {}
    showAppError(extractErrorMessage(error, '加载部门配置失败'))
  } finally {
    departmentOptionsLoading.value = false
  }
}

const handleSearch = () => {
  listState.query.page = 1
  void loadData()
}

const handleOpenCreate = () => {
  if (!ensurePermission('users:create', '手动新增客户端用户')) {
    return
  }
  createVisible.value = true
  resetCreateForm()
}

const handleReset = () => {
  searchForm.keyword = ''
  searchForm.status = ''
  searchForm.profileKind = ''
  searchForm.departmentName = ''
  searchForm.staffNo = ''
  handleSearch()
}

const handleCurrentChange = (page: number) => {
  listState.query.page = page
  void loadData()
}

const handleOpenEdit = (row: ClientUserManageProfile) => {
  if (!ensurePermission('users:update', '编辑客户端用户')) {
    return
  }
  editVisible.value = true
  resetEditForm()
  editForm.id = row.id
  editForm.profileKind = row.profileKind
  editForm.username = row.username
  editForm.mobile = row.mobile || ''
  editForm.email = row.email || ''
  editForm.departmentName = resolveDepartmentPathDisplay(row.departmentName)
  editForm.departmentNodeId = row.departmentNodeId || ''
  editForm.status = row.status
}

const handleSubmitCreate = async () => {
  const valid = await createFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }
  if (!ensurePermission('users:create', '手动新增客户端用户')) {
    return
  }

  const normalizedProfileKind = createForm.profileKind
  const normalizedUsername = createForm.username.trim()
  if (normalizedProfileKind !== 'teacher' && !normalizedUsername) {
    showAppWarning(normalizedProfileKind === 'department' ? '请输入账号名称' : '请输入用户名')
    return
  }
  const normalizedStaffNo = createForm.staffNo.trim()
  if (normalizedProfileKind === 'teacher' && !normalizedStaffNo) {
    showAppWarning('请输入教职工号')
    return
  }
  const normalizedMobile = createForm.mobile.trim()
  const normalizedEmail = createForm.email.trim().toLowerCase()
  const normalizedDepartmentName = normalizeOptionalText(createForm.departmentName)
  const normalizedDepartmentNodeId = normalizeOptionalText(createForm.departmentNodeId)
  if (normalizedProfileKind === 'personal' && !normalizedMobile && !normalizedEmail) {
    showAppWarning('手机号和邮箱至少保留一项')
    return
  }
  if (normalizedProfileKind === 'department' && !normalizedDepartmentNodeId) {
    showAppWarning('请选择部门共享账号所属部门')
    return
  }
  if (normalizedProfileKind === 'department' && !departmentNodeLookup.value[normalizedDepartmentNodeId]) {
    showAppWarning('请选择当前部门树中的有效部门节点')
    return
  }
  if (normalizedProfileKind === 'personal' && normalizedDepartmentName && !departmentOptions.value.includes(normalizedDepartmentName)) {
    showAppWarning('请选择系统配置中的部门选项')
    return
  }

  createSubmitting.value = true
  try {
    const payload: CreateClientUserPayload = {
      profileKind: normalizedProfileKind,
      username: normalizedUsername || undefined,
      staffNo: normalizedStaffNo || undefined,
      mobile: normalizedMobile || undefined,
      email: normalizedEmail || undefined,
      departmentName: normalizedProfileKind === 'personal' ? normalizedDepartmentName || undefined : undefined,
      departmentNodeId: normalizedProfileKind === 'department' ? normalizedDepartmentNodeId : undefined,
      password: createForm.password,
      status: createForm.status,
    }
    await createClientUser(payload)
    createVisible.value = false
    resetCreateForm()
    showAppSuccess('客户端用户已手动新增')
    listState.query.page = 1
    await loadData()
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '新增客户端用户失败',
      fallback: '手动新增客户端用户失败',
      operation: '手动新增客户端用户',
    })
  } finally {
    createSubmitting.value = false
  }
}

const handleSubmitEdit = async () => {
  const valid = await editFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }
  if (!ensurePermission('users:update', '编辑客户端用户')) {
    return
  }

  const normalizedUsername = editForm.username.trim()
  if (!normalizedUsername) {
    showAppWarning('请输入用户名')
    return
  }
  const normalizedMobile = editForm.mobile.trim()
  const normalizedEmail = editForm.email.trim().toLowerCase()
  const normalizedDepartmentName = normalizeOptionalText(editForm.departmentName)
  const normalizedDepartmentNodeId = normalizeOptionalText(editForm.departmentNodeId)
  if (editForm.profileKind === 'department' && !departmentNodeLookup.value[normalizedDepartmentNodeId]) {
    showAppWarning('该部门共享账号的原绑定已失效，请选择当前部门树中的有效节点后再保存')
    return
  }
  if (editForm.profileKind !== 'department' && normalizedDepartmentName && !departmentOptions.value.includes(normalizedDepartmentName)) {
    showAppWarning('请选择系统配置中的部门选项')
    return
  }

  editSubmitting.value = true
  try {
    const payload: UpdateClientUserPayload = {
      username: normalizedUsername,
      mobile: normalizedMobile || undefined,
      email: normalizedEmail || undefined,
      departmentName: editForm.profileKind === 'department' ? undefined : normalizedDepartmentName || undefined,
      departmentNodeId: editForm.profileKind === 'department' ? normalizedDepartmentNodeId : undefined,
      status: editForm.status,
    }
    await updateClientUser(editForm.id, payload)
    editVisible.value = false
    resetEditForm()
    showAppSuccess('客户端用户资料已更新')
    await loadData()
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '更新客户端用户失败',
      fallback: '更新客户端用户资料失败',
      operation: '更新客户端用户资料',
    })
  } finally {
    editSubmitting.value = false
  }
}

const handlePageSizeChange = (pageSize: number) => {
  listState.query.pageSize = pageSize
  listState.query.page = 1
  void loadData()
}

const resetClientPasswordForm = () => {
  resetPasswordForm.targetUserId = ''
  resetPasswordForm.targetUsername = ''
  resetPasswordForm.targetDepartmentName = ''
  resetPasswordForm.newPassword = ''
  resetPasswordForm.confirmPassword = ''
  resetPasswordFormRef.value?.clearValidate()
}

const handleOpenResetPassword = (row: ClientUserManageProfile) => {
  if (!ensurePermission('users:reset_password', '重置客户端用户密码')) {
    return
  }
  resetPasswordVisible.value = true
  resetClientPasswordForm()
  resetPasswordForm.targetUserId = row.id
  resetPasswordForm.targetUsername = row.username
  resetPasswordForm.targetDepartmentName = resolveDepartmentPathDisplay(row.departmentName)
}

const handleSubmitResetPassword = async () => {
  const valid = await resetPasswordFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }
  if (!ensurePermission('users:reset_password', '重置客户端用户密码')) {
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认将客户端用户“${resetPasswordForm.targetUsername || '-'}”的密码修改为当前输入的新密码吗？此操作会让该用户已登录会话立即失效。`,
      '二次确认修改密码',
      {
        type: 'warning',
        confirmButtonText: '确认修改',
        cancelButtonText: '取消',
      },
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    showAppError(extractErrorMessage(error, '二次确认失败'))
    return
  }

  resetPasswordSubmitting.value = true
  try {
    const payload: ResetClientUserPasswordPayload = {
      newPassword: resetPasswordForm.newPassword,
    }
    await resetClientUserPassword(resetPasswordForm.targetUserId, payload)
    resetPasswordVisible.value = false
    resetClientPasswordForm()
    showAppSuccess('客户端用户密码已修改')
    await loadData()
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '修改客户端用户密码失败',
      fallback: '修改客户端用户密码失败',
      operation: '修改客户端用户密码',
    })
  } finally {
    resetPasswordSubmitting.value = false
  }
}

const handleToggleStatus = async (row: ClientUserManageProfile) => {
  if (!ensurePermission('users:status', '启停客户端用户')) {
    return
  }

  const nextStatus: ClientUserStatus = row.status === 'enabled' ? 'disabled' : 'enabled'
  const actionLabel = nextStatus === 'enabled' ? '启用' : '停用'

  try {
    await ElMessageBox.confirm(`确认${actionLabel}客户端用户“${row.username}”吗？`, `${actionLabel}客户端用户`, {
      type: nextStatus === 'enabled' ? 'info' : 'warning',
      confirmButtonText: actionLabel,
      cancelButtonText: '取消',
    })
    await updateClientUserStatus(row.id, nextStatus)
    showAppSuccess(`${actionLabel}成功`)
    await loadData()
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    void showCriticalErrorDialog(error, {
      title: `${actionLabel}客户端用户失败`,
      fallback: `${actionLabel}失败`,
      operation: `${actionLabel}客户端用户`,
    })
  }
}

onMounted(() => {
  void loadDepartmentOptions()
  void loadData()
})

watch(
  () => createForm.profileKind,
  (profileKind) => {
    if (profileKind === 'teacher') {
      createForm.username = ''
      createForm.departmentName = ''
      createForm.departmentNodeId = ''
    }
    if (profileKind === 'personal') {
      createForm.staffNo = ''
    }
    if (profileKind === 'department') {
      createForm.staffNo = ''
      createForm.departmentName = ''
    }
    createFormRef.value?.clearValidate()
  },
)

watch(
  () => departmentAccountBatchNodeIds.value,
  (nodeIds) => {
    if (nodeIds.length > 100) {
      departmentAccountBatchNodeIds.value = nodeIds.slice(0, 100)
      showAppWarning('一次最多选择 100 个部门，已保留前 100 个选择')
      return
    }
    invalidateDepartmentAccountBatchPreview()
  },
)

watch(departmentAccountBatchStatus, () => {
  invalidateDepartmentAccountBatchPreview()
})

watch(departmentAccountBatchVisible, (visible) => {
  if (!visible) {
    clearDepartmentAccountBatchSensitiveState()
  }
})

onBeforeRouteLeave(() => {
  if (departmentAccountBatchSubmitting.value) {
    showAppWarning('请等待创建/核对完成后再离开')
    return false
  }
  departmentAccountBatchVisible.value = false
  clearDepartmentAccountBatchSensitiveState()
  return true
})

onDeactivated(() => {
  departmentAccountBatchVisible.value = false
  clearDepartmentAccountBatchSensitiveState()
})

onBeforeUnmount(() => {
  departmentAccountBatchVisible.value = false
  clearDepartmentAccountBatchSensitiveState()
})
</script>

<template>
  <PageContainer title="客户端用户" description="单独治理客户端注册账号，便于检索、启停与二次确认修改密码。">
    <div class="flex min-w-0 flex-col gap-4">
      <PageToolbarCard content-class="items-start">
        <template #default="{ isPhone, isTablet }">
          <div class="flex flex-1 flex-wrap items-start gap-2.5">
            <el-input
              v-model="searchForm.keyword"
              placeholder="搜索用户名、手机号、邮箱或部门"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[280px]' : '!w-[320px]'"
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            />
            <el-select
              v-model="searchForm.status"
              placeholder="状态"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[160px]' : '!w-[168px]'"
              @change="handleSearch"
            >
              <el-option label="启用" value="enabled" />
              <el-option label="停用" value="disabled" />
            </el-select>
            <el-select
              v-model="searchForm.profileKind"
              placeholder="账号身份"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[180px]' : '!w-[188px]'"
              @change="handleSearch"
            >
              <el-option label="个人账号" value="personal" />
              <el-option label="教师账号" value="teacher" />
              <el-option label="部门共享账号" value="department" />
            </el-select>
            <el-select
              v-model="searchForm.departmentName"
              placeholder="所属部门"
              clearable
              filterable
              :loading="departmentOptionsLoading"
              :class="isPhone ? '!w-full' : isTablet ? '!w-[220px]' : '!w-[240px]'"
              @change="handleSearch"
            >
              <el-option v-for="department in departmentOptions" :key="department" :label="department" :value="department" />
            </el-select>
            <el-input
              v-model="searchForm.staffNo"
              placeholder="搜索工号"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[180px]' : '!w-[188px]'"
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            />
            <el-button :class="isPhone ? 'w-full' : ''" type="primary" icon="Search" @click="handleSearch">搜索</el-button>
            <el-button :class="isPhone ? 'w-full' : ''" icon="Refresh" @click="handleReset">重置</el-button>
            <el-button v-if="canCreateUser" :class="isPhone ? 'w-full' : ''" type="primary" icon="Plus" @click="handleOpenCreate">
              新增用户
            </el-button>
            <el-button v-if="canCreateUser" :class="isPhone ? 'w-full' : ''" icon="UserFilled" @click="handleOpenDepartmentAccountBatch">
              批量创建部门账号
            </el-button>
          </div>
        </template>
      </PageToolbarCard>

      <div class="rounded-2xl border border-dashed border-brand/20 bg-brand/5 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-brand/20 dark:bg-brand/10 dark:text-slate-300">
        这里管理的是个人账号、教师账号和部门共享账号，不包含系统后台账号。部门共享账号只能从管理端创建；密码修改采用二次确认，修改成功后目标用户当前登录会话会立即失效。
      </div>

      <div class="apple-card flex min-h-0 flex-1 flex-col p-3 sm:p-4 xl:p-5">
        <BizResponsiveDataCollectionShell
          :items="listState.records"
          :loading="listState.loading"
          empty-description="暂无客户端用户数据"
          empty-min-height="260px"
          :skeleton-rows="6"
          wrapper-class="flex min-h-0 flex-1 flex-col"
          table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden px-0"
          card-container-class="pb-4"
        >
          <template #table>
            <el-table native-scrollbar :data="listState.records" stripe class="w-full flex-1" height="100%" table-layout="auto">
              <el-table-column prop="username" label="用户名" min-width="180" show-overflow-tooltip />
              <el-table-column prop="mobile" label="手机号" min-width="140" show-overflow-tooltip />
              <el-table-column prop="email" label="邮箱" min-width="220" show-overflow-tooltip />
              <el-table-column label="账号身份" width="132">
                <template #default="{ row }">
                  <el-tag :type="getProfileKindTagType(row.profileKind)" effect="light">{{ getProfileKindLabel(row.profileKind) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="staffNo" label="工号/编号" min-width="140" show-overflow-tooltip>
                <template #default="{ row }">{{ row.staffNo || '-' }}</template>
              </el-table-column>
              <el-table-column prop="departmentName" label="部门" min-width="160" show-overflow-tooltip>
                <template #default="{ row }">{{ resolveDepartmentPathDisplay(row.departmentName) || '-' }}</template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="getStatusTagType(row.status)" effect="light">{{ getStatusLabel(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="最后登录" min-width="176">
                <template #default="{ row }">{{ row.lastLoginAt ? dayjs(row.lastLoginAt).format('YYYY-MM-DD HH:mm') : '-' }}</template>
              </el-table-column>
              <el-table-column label="创建时间" min-width="176">
                <template #default="{ row }">{{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}</template>
              </el-table-column>
              <el-table-column v-if="canOperateUsers" label="操作" fixed="right" width="220" align="right">
                <template #default="{ row }">
                  <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 py-1">
                    <el-button v-if="canEditUser" link type="primary" @click="handleOpenEdit(row)">编辑</el-button>
                    <el-button v-if="canResetUserPassword" link type="primary" @click="handleOpenResetPassword(row)">修改密码</el-button>
                    <el-button
                      v-if="canToggleUser"
                      link
                      :type="row.status === 'enabled' ? 'warning' : 'success'"
                      @click="handleToggleStatus(row)"
                    >
                      {{ row.status === 'enabled' ? '停用' : '启用' }}
                    </el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </template>

          <template #card="{ item }">
            <div class="apple-card flex min-w-0 flex-col gap-3 p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">{{ item.username }}</div>
                  <div class="truncate text-sm text-slate-500 dark:text-slate-400">
                    {{ resolveDepartmentPathDisplay(item.departmentName) || '未设置部门' }}
                  </div>
                </div>
                <el-tag :type="getStatusTagType(item.status)" effect="light">{{ getStatusLabel(item.status) }}</el-tag>
              </div>

              <div class="grid gap-2 rounded-2xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">账号身份</span>
                  <el-tag :type="getProfileKindTagType(item.profileKind)" effect="light">{{ getProfileKindLabel(item.profileKind) }}</el-tag>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">{{ getStaffNoLabel(item.profileKind) }}</span>
                  <span class="text-right break-all">{{ item.staffNo || '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">手机号</span>
                  <span class="text-right break-all">{{ item.mobile || '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">邮箱</span>
                  <span class="text-right break-all">{{ item.email || '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">最后登录</span>
                  <span>{{ item.lastLoginAt ? dayjs(item.lastLoginAt).format('YYYY-MM-DD HH:mm') : '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">创建时间</span>
                  <span>{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
                </div>
              </div>

              <div v-if="canOperateUsers" class="flex items-center justify-end gap-3 border-t border-slate-100 pt-3 dark:border-white/10">
                <el-button v-if="canEditUser" link type="primary" @click="handleOpenEdit(item)">编辑</el-button>
                <el-button v-if="canResetUserPassword" link type="primary" @click="handleOpenResetPassword(item)">修改密码</el-button>
                <el-button
                  v-if="canToggleUser"
                  link
                  :type="item.status === 'enabled' ? 'warning' : 'success'"
                  @click="handleToggleStatus(item)"
                >
                  {{ item.status === 'enabled' ? '停用' : '启用' }}
                </el-button>
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
      v-model="createVisible"
      title="新增客户端用户"
      height-mode="auto"
      phone-width="94%"
      tablet-width="560px"
      desktop-width="520px"
      :confirm-loading="createSubmitting"
      confirm-text="确认新增"
      @confirm="handleSubmitCreate"
      @closed="resetCreateForm"
    >
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        个人账号保持现有创建规则；教师账号按教职工目录回填姓名和部门；部门共享账号由管理端选择部门并设置账号编号。
      </div>
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-position="top">
        <el-form-item label="创建类型" prop="profileKind">
          <el-segmented
            v-model="createForm.profileKind"
            :options="[
              { label: '个人账号', value: 'personal' },
              { label: '教师账号', value: 'teacher' },
              { label: '部门共享账号', value: 'department' },
            ]"
            class="w-full"
          />
        </el-form-item>
        <el-form-item v-if="!isCreateTeacherProfile" :label="createUsernameLabel" prop="username">
          <el-input v-model.trim="createForm.username" :placeholder="isCreateDepartmentProfile ? '请输入部门共享账号名称' : '请输入用户名'" />
        </el-form-item>
        <el-form-item v-if="isCreateTeacherProfile" label="教职工号" prop="staffNo">
          <el-input
            v-model.trim="createForm.staffNo"
            placeholder="请输入教职工号"
          />
        </el-form-item>
        <div class="grid gap-4 md:grid-cols-2">
          <el-form-item label="手机号" prop="mobile">
            <el-input v-model.trim="createForm.mobile" :placeholder="createContactRequired ? '请输入手机号' : '可选，用于登录或找回密码'" />
          </el-form-item>
          <el-form-item label="邮箱" prop="email">
            <el-input v-model.trim="createForm.email" :placeholder="createContactRequired ? '请输入邮箱' : '可选，用于登录或找回密码'" />
          </el-form-item>
        </div>
        <el-form-item v-if="isCreateDepartmentProfile" label="所属部门" prop="departmentNodeId">
          <el-tree-select
            v-model="createForm.departmentNodeId"
            placeholder="请选择部门共享账号所属部门"
            class="w-full"
            clearable
            filterable
            check-strictly
            node-key="value"
            :data="departmentTreeSelectOptions"
            :props="departmentTreeSelectProps"
            :loading="departmentOptionsLoading"
            :disabled="departmentOptionsLoading || departmentOptions.length === 0"
          />
          <p v-if="departmentOptions.length === 0 && !departmentOptionsLoading" class="mt-2 text-xs text-amber-600">
            暂无可选部门，请先在“部门配置”中维护部门。
          </p>
        </el-form-item>
        <el-form-item v-else-if="!isCreateTeacherProfile" label="所属部门（选填）" prop="departmentName">
          <el-select
            v-model="createForm.departmentName"
            placeholder="请选择所属部门（选填）"
            class="w-full"
            clearable
            filterable
            :loading="departmentOptionsLoading"
          >
            <el-option v-for="department in departmentOptions" :key="department" :label="department" :value="department" />
          </el-select>
        </el-form-item>
        <div class="grid gap-4 md:grid-cols-2">
          <el-form-item label="登录密码" prop="password">
            <el-input
              v-model="createForm.password"
              type="password"
              show-password
              placeholder="请输入初始登录密码"
              autocomplete="new-password"
            />
          </el-form-item>
          <el-form-item label="确认密码" prop="confirmPassword">
            <el-input
              v-model="createForm.confirmPassword"
              type="password"
              show-password
              placeholder="请再次输入初始登录密码"
              autocomplete="new-password"
            />
          </el-form-item>
        </div>
        <el-form-item label="账号状态" prop="status">
          <el-select v-model="createForm.status" class="w-full">
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
          </el-select>
        </el-form-item>
      </el-form>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-model="editVisible"
      title="编辑客户端用户"
      height-mode="auto"
      phone-width="94%"
      tablet-width="560px"
      desktop-width="520px"
      :confirm-loading="editSubmitting"
      confirm-text="保存修改"
      @confirm="handleSubmitEdit"
      @closed="resetEditForm"
    >
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        用户名支持自定义，手机号、邮箱至少保留一项，三类标识在系统内均不可与其他客户端用户重复。
      </div>
      <el-form ref="editFormRef" :model="editForm" :rules="editRules" label-position="top">
        <el-form-item label="用户名" prop="username">
          <el-input v-model.trim="editForm.username" placeholder="请输入用户名" />
        </el-form-item>
        <div class="grid gap-4 md:grid-cols-2">
          <el-form-item label="手机号" prop="mobile">
            <el-input v-model.trim="editForm.mobile" placeholder="请输入手机号" />
          </el-form-item>
          <el-form-item label="邮箱" prop="email">
            <el-input v-model.trim="editForm.email" placeholder="请输入邮箱" />
          </el-form-item>
        </div>
        <el-alert
          v-if="isEditingOrphanedDepartmentAccount"
          class="mb-4"
          title="当前部门绑定已失效"
          type="warning"
          :closable="false"
          show-icon
          description="该共享账号不能沿用旧部门路径保存，请选择当前部门树中的有效节点。"
        />
        <el-form-item v-if="editForm.profileKind === 'department'" label="所属部门" prop="departmentNodeId">
          <el-tree-select
            v-model="editForm.departmentNodeId"
            placeholder="请选择当前有效部门"
            class="w-full"
            clearable
            filterable
            check-strictly
            node-key="value"
            :data="departmentTreeSelectOptions"
            :props="departmentTreeSelectProps"
            :loading="departmentOptionsLoading"
            :disabled="departmentOptionsLoading || departmentOptions.length === 0"
          />
        </el-form-item>
        <el-form-item v-else label="所属部门" prop="departmentName">
          <el-select
            v-model="editForm.departmentName"
            placeholder="请选择所属部门（选填）"
            class="w-full"
            clearable
            filterable
            :loading="departmentOptionsLoading"
          >
            <el-option v-for="department in departmentOptions" :key="department" :label="department" :value="department" />
          </el-select>
        </el-form-item>
        <el-form-item label="账号状态" prop="status">
          <el-select v-model="editForm.status" class="w-full">
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
          </el-select>
        </el-form-item>
      </el-form>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-model="resetPasswordVisible"
      title="修改客户端用户密码"
      height-mode="auto"
      phone-width="94%"
      tablet-width="520px"
      desktop-width="440px"
      :confirm-loading="resetPasswordSubmitting"
      confirm-text="确认修改"
      @confirm="handleSubmitResetPassword"
      @closed="resetClientPasswordForm"
    >
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        即将修改客户端用户“{{ resetPasswordForm.targetUsername || '-' }}”的密码。
        <span v-if="resetPasswordForm.targetDepartmentName">所属部门：{{ resetPasswordForm.targetDepartmentName }}。</span>
        提交后会再次进行二次确认。
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
      :model-value="departmentAccountBatchVisible"
      title="批量创建部门账号"
      height-mode="scroll"
      phone-width="96%"
      tablet-width="720px"
      desktop-width="820px"
      :confirm-loading="departmentAccountBatchSubmitting || departmentAccountBatchPreviewLoading"
      :confirm-text="departmentAccountBatchPreview ? '确认创建待创建账号' : '开始预检'"
      @update:model-value="handleDepartmentAccountBatchModelValueUpdate"
      @confirm="handleSubmitDepartmentAccountBatch"
      @closed="clearDepartmentAccountBatchSensitiveState"
    >
      <div class="space-y-4">
        <el-alert type="info" :closable="false" show-icon>
          <template #title>先预检，再创建</template>
          已存在的部门共享账号无论启用或停用都会跳过，不会重置密码或改变状态。创建成功后凭据仅在当前弹窗展示一次并自动下载。
        </el-alert>

        <template v-if="!departmentAccountBatchPreview">
          <el-form label-position="top">
            <el-form-item label="选择部门（1 至 100 个）">
              <el-tree-select
                v-model="departmentAccountBatchNodeIds"
                class="w-full"
                placeholder="请选择需要创建共享账号的精确部门节点"
                clearable
                filterable
                multiple
                show-checkbox
                check-strictly
                node-key="value"
                :data="departmentTreeSelectOptions"
                :props="departmentTreeSelectProps"
                :loading="departmentOptionsLoading"
                :disabled="departmentOptionsLoading || departmentTree.length === 0"
                @change="handleDepartmentAccountBatchSelectionChange"
              />
              <p v-if="departmentTree.length === 0 && !departmentOptionsLoading" class="mt-2 text-xs text-amber-600">
                暂无部门配置，请先在“部门配置”中维护部门树后再批量开户。
              </p>
            </el-form-item>
            <div class="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
              已选 {{ departmentAccountBatchNodeIds.length }} / 100 个部门；父节点不会自动包含下级。
              <ul v-if="selectedDepartmentAccountBatchNodes.length" class="mt-2 list-disc space-y-1 pl-5 break-all">
                <li v-for="department in selectedDepartmentAccountBatchNodes" :key="department.departmentNodeId">{{ department.departmentName }}</li>
              </ul>
            </div>
            <el-form-item class="mt-4" label="创建后的账号状态">
              <el-radio-group v-model="departmentAccountBatchStatus">
                <el-radio value="enabled">启用</el-radio>
                <el-radio value="disabled">停用</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-form>
        </template>

        <template v-else>
          <el-alert
            v-if="departmentAccountBatchRecovery"
            :type="departmentAccountBatchRecovery.state === 'completed' ? 'success' : departmentAccountBatchRecovery.state === 'not_committed' ? 'warning' : 'error'"
            :closable="false"
            show-icon
            :title="departmentAccountBatchRecovery.reason"
          />

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-100">
              <div class="font-semibold">待创建：{{ departmentAccountBatchPreview.creatable.length }}</div>
              <div class="mt-1">将生成独立账号和强密码，并在单次事务内创建。</div>
            </div>
            <div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100">
              <div class="font-semibold">已存在并跳过：{{ departmentAccountBatchSkipped.length }}</div>
              <div class="mt-1">跳过不影响已有账号的状态和密码。</div>
            </div>
          </div>

          <div v-if="departmentAccountBatchPreview.creatable.length" class="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div class="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">待创建部门</div>
            <ul class="space-y-1 text-sm text-slate-600 dark:text-slate-300">
              <li v-for="department in departmentAccountBatchPreview.creatable" :key="department.departmentNodeId" class="break-all">
                {{ department.departmentName }}
              </li>
            </ul>
          </div>

          <div v-if="departmentAccountBatchSkipped.length" class="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div class="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">已存在并跳过</div>
            <el-table :data="departmentAccountBatchSkipped" size="small" max-height="180" table-layout="auto">
              <el-table-column prop="departmentName" label="部门路径" min-width="220" show-overflow-tooltip />
              <el-table-column prop="account" label="现有账号" min-width="160" />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">{{ row.status === 'enabled' ? '启用' : '停用' }}</template>
              </el-table-column>
            </el-table>
          </div>

          <div v-if="hasDepartmentAccountBatchResults" class="rounded-xl border border-emerald-200 p-3 dark:border-emerald-400/30">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div class="text-sm font-semibold text-emerald-800 dark:text-emerald-100">已确认凭据（关闭弹窗后不可恢复）</div>
              <el-button size="small" type="primary" plain @click="downloadDepartmentAccountCsv">重新下载 CSV</el-button>
            </div>
            <div class="max-h-72 overflow-auto" aria-label="新增部门共享账号凭据列表">
              <el-table :data="departmentAccountBatchCreatedCredentials" size="small" table-layout="auto">
                <el-table-column prop="departmentName" label="部门路径" min-width="220" show-overflow-tooltip />
                <el-table-column prop="account" label="登录账号" min-width="160" />
                <el-table-column prop="initialPassword" label="初始密码（可手动复制）" min-width="220" show-overflow-tooltip />
              </el-table>
            </div>
          </div>

          <div v-if="departmentAccountBatchUnconfirmedCredentials.length" class="rounded-xl border border-rose-200 p-3 dark:border-rose-400/30">
            <div class="mb-2 text-sm font-semibold text-rose-800 dark:text-rose-100">待人工核对（密码未确认有效，不会下载）</div>
            <div class="max-h-56 overflow-auto" aria-label="待人工核对的部门共享账号凭据列表">
              <el-table :data="departmentAccountBatchUnconfirmedCredentials" size="small" table-layout="auto">
                <el-table-column prop="departmentName" label="部门路径" min-width="220" show-overflow-tooltip />
                <el-table-column prop="account" label="登录账号" min-width="160" />
                <el-table-column prop="initialPassword" label="待核对初始密码（可手动复制）" min-width="240" show-overflow-tooltip />
              </el-table>
            </div>
          </div>
        </template>
      </div>

      <template #footer="{ close }">
        <span class="flex flex-wrap justify-end gap-2">
          <el-button @click="close">关闭并清除凭据</el-button>
          <el-button v-if="hasDepartmentAccountBatchResults" type="primary" plain @click="downloadDepartmentAccountCsv">重新下载凭据 CSV</el-button>
          <el-button
            v-if="departmentAccountBatchPreview && departmentAccountBatchCredentials.length > 0 && !hasDepartmentAccountBatchResults && departmentAccountBatchRecovery?.state !== 'conflict'"
            type="primary"
            :loading="departmentAccountBatchSubmitting || departmentAccountBatchPreviewLoading"
            @click="handleSubmitDepartmentAccountBatch"
          >
            {{ departmentAccountBatchRecovery?.state === 'not_committed' ? '使用相同凭据重试' : '确认创建待创建账号' }}
          </el-button>
          <el-button
            v-else-if="!departmentAccountBatchPreview"
            type="primary"
            :loading="departmentAccountBatchPreviewLoading"
            :disabled="!isDepartmentAccountBatchSelectionValid"
            @click="handlePreviewDepartmentAccountBatch"
          >
            开始预检
          </el-button>
        </span>
      </template>
    </BizCrudDialogShell>
  </PageContainer>
</template>
