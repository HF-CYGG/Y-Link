<script setup lang="ts">
/**
 * 模块说明：src/views/system/SystemConfigView.vue
 * 文件职责：负责维护订单流水、线上预订规则、验证码平台与客户端部门树等系统级配置，并统一承接高风险配置的保存与测试操作。
 * 实现逻辑：
 * - 首屏优先并行加载“订单流水 + 线上预订规则”，保证核心配置尽快可见；
 * - 验证码配置与部门配置继续后台补齐，并按分区维护各自的加载态与错误态；
 * - 当前激活分区只受自身加载状态约束，避免某个低优先级分区未完成时把整页表单都锁成“看得见但点不动”；
 * - 保存时继续串行提交四类配置，避免 SQLite 单连接场景下并发事务冲突。
 * 维护说明：
 * - 若后续新增新的延迟加载分区，必须同步补充本页的分区可交互状态映射，而不是直接复用整页 loading；
 * - 高风险保存仍应保持串行提交，优先保证一致性与可回溯性。
 */


import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref, toRaw } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { useRouter } from 'vue-router'
import { PageContainer, PageToolbarCard } from '@/components/common'
import {
  getNotificationPresenceSnapshot,
  getNotificationRules,
  updateNotificationRules,
  type NotificationPresenceSnapshot,
  type NotificationRuleRecord,
} from '@/api/modules/notification'
import {
  getClientDepartmentConfigs,
  getO2oRuleConfigs,
  getOrderSerialConfigs,
  getVerificationProviderConfigs,
  testVerificationProviderSend,
  updateClientDepartmentConfigs,
  updateO2oRuleConfigs,
  updateOrderSerialConfigs,
  updateVerificationProviderConfigs,
  type ClientDepartmentConfigRecord,
  type ClientDepartmentTreeNode,
  type O2oRuleConfigRecord,
  type OrderSerialConfigRecord,
  type VerificationProviderConfigsResult,
} from '@/api/modules/system-config'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import SystemConfigDepartmentSection from '@/views/system/components/SystemConfigDepartmentSection.vue'
import SystemConfigO2oRulesSection from '@/views/system/components/SystemConfigO2oRulesSection.vue'
import SystemConfigNotificationSection from '@/views/system/components/SystemConfigNotificationSection.vue'
import SystemConfigSerialSection from '@/views/system/components/SystemConfigSerialSection.vue'
import SystemConfigVerificationSection from '@/views/system/components/SystemConfigVerificationSection.vue'
import {
  DATABASE_MIGRATION_ASSISTANT_NAME,
  DATABASE_MIGRATION_ENTRY_DESCRIPTION,
  DATABASE_MIGRATION_ENTRY_LABEL,
  DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT,
} from './database-migration-copy'

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

type ConfigSectionKey = 'order_serial' | 'o2o_rules' | 'verification' | 'department' | 'notification'
type DepartmentTreeNode = ClientDepartmentTreeNode

const { hasPermission, ensurePermission } = usePermissionAction()
const router = useRouter()
const formRef = ref<FormInstance>()
const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const testSendingChannel = ref<'mobile' | 'email' | ''>('')
const activeSection = ref<ConfigSectionKey>('order_serial')
const selectedDepartmentNodeId = ref('')
const configMap = ref<Record<'department' | 'walkin', OrderSerialConfigRecord> | null>(null)
const o2oRuleConfig = ref<O2oRuleConfigRecord | null>(null)
const verificationConfigMap = ref<VerificationProviderConfigsResult | null>(null)
const clientDepartmentConfig = ref<ClientDepartmentConfigRecord | null>(null)
const notificationRules = ref<NotificationRuleRecord[]>([])
const notificationPresence = ref<NotificationPresenceSnapshot | null>(null)
const notificationPresenceLoading = ref(false)
const loadRequest = useStableRequest()
const deferredSectionRequest = useStableRequest()
const sectionLoadingState = reactive<Record<ConfigSectionKey, boolean>>({
  order_serial: true,
  o2o_rules: true,
  verification: true,
  department: true,
  notification: true,
})
const sectionErrorState = reactive<Record<ConfigSectionKey, string>>({
  order_serial: '',
  o2o_rules: '',
  verification: '',
  department: '',
  notification: '',
})

const sectionOptions: Array<{ key: ConfigSectionKey; label: string }> = [
  { key: 'order_serial', label: '订单流水' },
  { key: 'o2o_rules', label: '线上预定' },
  { key: 'verification', label: '验证码配置' },
  { key: 'department', label: '部门配置' },
  { key: 'notification', label: '通知中心' },
]

const handleSectionChange = (value: string | number) => {
  activeSection.value = String(value) as ConfigSectionKey
}

const serialForm = reactive<{
  department: SerialFormValue
  walkin: SerialFormValue
  o2o: {
    autoCancelEnabled: boolean
    autoCancelHours: number
    limitEnabled: boolean
    limitQty: number
    clientPreorderUpdateLimit: number
  }
  verification: {
    mobile: VerificationFormValue
    email: VerificationFormValue
  }
  clientDepartmentTree: DepartmentTreeNode[]
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
    // 客户端改单次数上限默认值，与后端默认配置保持一致，避免页面首屏空值。
    clientPreorderUpdateLimit: 3,
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
  clientDepartmentTree: [],
})

const initialSnapshot = ref('')
const canViewConfigs = computed(() => hasPermission('system_configs:view'))
const canUpdateConfigs = computed(() => hasPermission('system_configs:update'))
const canTestVerificationProviders = computed(() => hasPermission('verification_providers:test'))
const canViewMigrationAssistant = computed(() => hasPermission('db_migration:view'))
const hasPendingDeferredSections = computed(() => sectionLoadingState.verification || sectionLoadingState.department || sectionLoadingState.notification)
const hasDeferredSectionFailure = computed(() => Boolean(sectionErrorState.verification || sectionErrorState.department || sectionErrorState.notification))
const formInteractionLoading = computed(() => loading.value || hasPendingDeferredSections.value)
const managementUsers = computed(() => notificationPresence.value?.users ?? [])
const deferredSectionStatusText = computed(() => {
  if (hasPendingDeferredSections.value) {
    return '系统配置主内容已就绪，验证码、部门与通知中心配置正在继续加载，加载完成前暂不可编辑或保存。'
  }

  const failedSections = sectionOptions
    .filter((section) => sectionErrorState[section.key])
    .map((section) => section.label)
  if (failedSections.length > 0) {
    return `${failedSections.join('、')}加载失败，请刷新后重试，避免未加载分区被默认值覆盖。`
  }

  return ''
})

/**
 * 当前分区是否仍在加载：
 * - 只锁定当前激活分区，避免“验证码/部门仍在补齐”时把订单流水和 O2O 规则也一起锁死；
 * - 页面顶部保存按钮仍会基于全局条件统一收口，防止未完整加载的数据被误保存。
 */
const activeSectionLoading = computed(() => {
  return sectionLoadingState[activeSection.value]
})

/**
 * 当前分区是否加载失败：
 * - 用于当前激活面板的只读与提示控制；
 * - 让用户明确知道“哪一块不可用”，而不是整个页面都像失去响应。
 */
const activeSectionLoadFailed = computed(() => {
  return Boolean(sectionErrorState[activeSection.value])
})

/**
 * 当前分区交互门禁：
 * - 核心配置首屏加载完成后即可立即编辑；
 * - 只有当前所在分区仍在加载或失败时，才限制该分区内部交互。
 */
const activeSectionInteractionLoading = computed(() => {
  return loading.value || activeSectionLoading.value
})

/**
 * 进入数据库迁移助手：
 * - 将数据库迁移高风险动作统一收口到专门页面；
 * - 让管理员在系统配置页就能一键直达，减少左侧菜单查找成本。
 */
const handleGoToDatabaseMigration = () => {
  router.push('/system/db-migration').catch(() => undefined)
}

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

const createDepartmentNodeId = (prefix: string) => {
  const normalizedPrefix = prefix.trim().replaceAll(/\s+/g, '-').slice(0, 16)
  return `dept_${normalizedPrefix || 'node'}_${Math.random().toString(36).slice(2, 8)}`
}

const flattenDepartmentTreeLabels = (tree: DepartmentTreeNode[]): string[] => {
  const labels: string[] = []
  const walk = (nodes: DepartmentTreeNode[], parentPath = '') => {
    nodes.forEach((node) => {
      const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
      labels.push(currentPath)
      if (node.children.length > 0) {
        walk(node.children, currentPath)
      }
    })
  }
  walk(tree)
  return labels
}

const getDepartmentPathLabel = (targetId: string) => {
  if (!targetId) {
    return ''
  }
  let matchedPath = ''
  const walk = (nodes: DepartmentTreeNode[], parentPath = '') => {
    nodes.forEach((node) => {
      if (matchedPath) {
        return
      }
      const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
      if (node.id === targetId) {
        matchedPath = currentPath
        return
      }
      if (node.children.length > 0) {
        walk(node.children, currentPath)
      }
    })
  }
  walk(serialForm.clientDepartmentTree)
  return matchedPath
}

const cloneDepartmentTree = (tree: DepartmentTreeNode[]): DepartmentTreeNode[] => {
  const rawTree = toRaw(tree)
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(rawTree)
    } catch {
      // 某些浏览器在 structuredClone 遇到代理对象/非可克隆值时会抛错，转入 JSON 兜底。
    }
  }
  // 兼容旧浏览器：structuredClone 不可用时，使用显式递归复制，避免 JSON 方案被静态规则判定为低质量深拷贝。
  const cloneNodes = (nodes: DepartmentTreeNode[]): DepartmentTreeNode[] => {
    return nodes.map((node) => ({
      id: node.id,
      label: node.label,
      children: cloneNodes(node.children),
    }))
  }
  return cloneNodes(rawTree)
}

const clientDepartmentPreviewOptions = computed(() => flattenDepartmentTreeLabels(serialForm.clientDepartmentTree))
const selectedDepartmentNode = computed(() => {
  const targetId = selectedDepartmentNodeId.value
  if (!targetId) {
    return null
  }
  const walk = (nodes: DepartmentTreeNode[]): DepartmentTreeNode | null => {
    for (const node of nodes) {
      if (node.id === targetId) {
        return node
      }
      const child = walk(node.children)
      if (child) {
        return child
      }
    }
    return null
  }
  return walk(serialForm.clientDepartmentTree)
})

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
      clientPreorderUpdateLimit: Number(serialForm.o2o.clientPreorderUpdateLimit),
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
    clientDepartmentTree: serialForm.clientDepartmentTree,
    notificationRules: notificationRules.value.map((rule) => ({
      id: rule.id,
      enabled: rule.enabled,
      recipientUserIds: [...rule.recipientUserIds].sort(),
      emailEnabled: rule.emailEnabled,
      feishuEnabled: rule.feishuEnabled,
      externalTriggerMode: rule.externalTriggerMode,
      watchedUserIds: [...rule.watchedUserIds].sort(),
      feishuWebhookUrl: rule.feishuWebhookUrl.trim(),
      emailSubjectPrefix: rule.emailSubjectPrefix.trim(),
    })),
  })

const isDirty = computed(() => snapshotForm() !== initialSnapshot.value)

const rules: FormRules = {
  'department.start': [{ required: true, message: '请输入部门单起始号', trigger: 'blur' }],
  'department.width': [{ required: true, message: '请输入部门单位宽', trigger: 'blur' }],
  'walkin.start': [{ required: true, message: '请输入散客单起始号', trigger: 'blur' }],
  'walkin.width': [{ required: true, message: '请输入散客单位宽', trigger: 'blur' }],
  'o2o.autoCancelHours': [{ required: true, message: '请输入超时取消时长', trigger: 'blur' }],
  'o2o.limitQty': [{ required: true, message: '请输入限购数量', trigger: 'blur' }],
  'o2o.clientPreorderUpdateLimit': [{ required: true, message: '请输入改单次数上限', trigger: 'blur' }],
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
  serialForm.o2o.clientPreorderUpdateLimit = config.clientPreorderUpdateLimit
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

const applyClientDepartmentConfigs = (config: ClientDepartmentConfigRecord) => {
  clientDepartmentConfig.value = config
  serialForm.clientDepartmentTree = cloneDepartmentTree(config.tree)
  selectedDepartmentNodeId.value = ''
}

const applyNotificationRules = (list: NotificationRuleRecord[]) => {
  notificationRules.value = list.map((rule) => ({
    ...rule,
    recipientUserIds: [...rule.recipientUserIds],
    watchedUserIds: [...rule.watchedUserIds],
  }))
}

const applyNotificationPresenceSnapshot = (snapshot: NotificationPresenceSnapshot) => {
  notificationPresence.value = snapshot
}

const refreshNotificationPresenceSnapshot = async () => {
  notificationPresenceLoading.value = true
  try {
    const snapshot = await getNotificationPresenceSnapshot()
    applyNotificationPresenceSnapshot(snapshot)
  } catch (error) {
    ElMessage.warning(extractErrorMessage(error, '刷新在线状态失败'))
  } finally {
    notificationPresenceLoading.value = false
  }
}

const validateNotificationRules = () => {
  for (const rule of notificationRules.value) {
    if (rule.externalTriggerMode === 'watched_accounts_offline' && rule.watchedUserIds.length === 0) {
      ElMessage.warning(`规则“${rule.ruleName}”在“指定账号离线”模式下必须选择监测账号`)
      return false
    }
  }
  return true
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

const normalizeDepartmentLabel = (label: string) => {
  const normalized = label.trim()
  if (!normalized) {
    throw new Error('部门名称不能为空')
  }
  if (normalized.length > 32) {
    throw new Error('部门名称长度不能超过 32 个字符')
  }
  return normalized
}

const normalizeDepartmentTreeForSubmit = (tree: DepartmentTreeNode[], depth = 1): DepartmentTreeNode[] => {
  if (depth > 8) {
    throw new Error('部门层级最多支持 8 级')
  }
  return tree.map((node, index) => {
    const label = normalizeDepartmentLabel(node.label)
    const id = String(node.id ?? '').trim() || createDepartmentNodeId(`${label}-${depth}-${index + 1}`)
    const children = Array.isArray(node.children) ? normalizeDepartmentTreeForSubmit(node.children, depth + 1) : []
    return {
      id,
      label,
      children,
    }
  })
}

const validateDepartmentTree = (tree: DepartmentTreeNode[]) => {
  const labels = flattenDepartmentTreeLabels(tree)
  if (labels.length > 50) {
    throw new Error('部门节点总数最多保留 50 个')
  }
  const uniqueSet = new Set<string>()
  labels.forEach((label) => {
    if (uniqueSet.has(label)) {
      throw new Error(`部门“${label}”重复，请去重后保存`)
    }
    uniqueSet.add(label)
  })
}

const createDepartmentNodeWithPrompt = async (title: string, placeholder: string) => {
  const promptResult = await ElMessageBox.prompt('请输入部门名称', title, {
    inputPlaceholder: placeholder,
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputValidator: (value: string) => {
      try {
        normalizeDepartmentLabel(value)
        return true
      } catch (error) {
        return extractErrorMessage(error, '部门名称不合法')
      }
    },
  })
  const label = normalizeDepartmentLabel(promptResult.value)
  return {
    id: createDepartmentNodeId(label),
    label,
    children: [] as DepartmentTreeNode[],
  }
}

const findDepartmentNodeById = (nodes: DepartmentTreeNode[], id: string): DepartmentTreeNode | null => {
  for (const node of nodes) {
    if (node.id === id) {
      return node
    }
    const childNode = findDepartmentNodeById(node.children, id)
    if (childNode) {
      return childNode
    }
  }
  return null
}

const removeDepartmentNodeById = (nodes: DepartmentTreeNode[], id: string): boolean => {
  const index = nodes.findIndex((node) => node.id === id)
  if (index >= 0) {
    nodes.splice(index, 1)
    return true
  }
  return nodes.some((node) => removeDepartmentNodeById(node.children, id))
}

const handleAddRootDepartment = async () => {
  try {
    const node = await createDepartmentNodeWithPrompt('新增一级部门', '例如：市场部')
    serialForm.clientDepartmentTree.push(node)
    selectedDepartmentNodeId.value = node.id
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.warning(extractErrorMessage(error, '新增一级部门失败'))
  }
}

const handleAddChildDepartment = async (parentNode?: DepartmentTreeNode) => {
  const targetParent = parentNode ?? selectedDepartmentNode.value
  if (!targetParent) {
    ElMessage.warning('请先选择父级部门，再新增子部门')
    return
  }
  try {
    const node = await createDepartmentNodeWithPrompt('新增子部门', '例如：华南组')
    targetParent.children.push(node)
    selectedDepartmentNodeId.value = node.id
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.warning(extractErrorMessage(error, '新增子部门失败'))
  }
}

const handleEditDepartment = async (node: DepartmentTreeNode) => {
  try {
    const promptResult = await ElMessageBox.prompt('请输入新的部门名称', '编辑部门', {
      inputValue: node.label,
      inputPlaceholder: '请输入部门名称',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValidator: (value: string) => {
        try {
          normalizeDepartmentLabel(value)
          return true
        } catch (error) {
          return extractErrorMessage(error, '部门名称不合法')
        }
      },
    })
    node.label = normalizeDepartmentLabel(promptResult.value)
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.warning(extractErrorMessage(error, '编辑部门失败'))
  }
}

const handleDeleteDepartment = async (node: DepartmentTreeNode) => {
  try {
    await ElMessageBox.confirm(`确认删除部门“${node.label}”及其下级部门吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    removeDepartmentNodeById(serialForm.clientDepartmentTree, node.id)
    if (selectedDepartmentNodeId.value === node.id) {
      selectedDepartmentNodeId.value = ''
    }
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.warning(extractErrorMessage(error, '删除部门失败'))
  }
}

const handleDepartmentNodeClick = (data: DepartmentTreeNode) => {
  selectedDepartmentNodeId.value = data.id
}

const handleAllowDepartmentDrop = (_draggingNode: unknown, _dropNode: unknown, type: 'prev' | 'inner' | 'next') => {
  return type === 'prev' || type === 'inner' || type === 'next'
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
  if (!ensurePermission('verification_providers:test', '测试验证码平台发送')) {
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
    sectionLoadingState.order_serial = false
    sectionLoadingState.o2o_rules = false
    sectionLoadingState.verification = false
    sectionLoadingState.department = false
    sectionLoadingState.notification = false
    return
  }

  loadError.value = ''
  loading.value = true
  sectionErrorState.order_serial = ''
  sectionErrorState.o2o_rules = ''
  sectionErrorState.verification = ''
  sectionErrorState.department = ''
  sectionErrorState.notification = ''
  sectionLoadingState.order_serial = true
  sectionLoadingState.o2o_rules = true
  sectionLoadingState.verification = true
  sectionLoadingState.department = true
  sectionLoadingState.notification = true
  await loadRequest.runLatest({
    executor: async () => {
      // 首屏分层加载策略：
      // - 订单流水与线上预定规则属于系统配置首页最先需要看到的核心信息；
      // - 验证码配置与部门配置继续在后台补齐，避免首次进入时同时叠加过多接口与重分区渲染。
      const [orderSerialResult, o2oRuleResult] = await Promise.allSettled([
        getOrderSerialConfigs(),
        getO2oRuleConfigs(),
      ])

      return {
        orderSerialResult,
        o2oRuleResult,
      }
    },
    onSuccess: (result) => {
      let successCount = 0

      if (result.orderSerialResult.status === 'fulfilled') {
        applyList(result.orderSerialResult.value.list)
        successCount += 1
      }
      if (result.o2oRuleResult.status === 'fulfilled') {
        applyO2oRules(result.o2oRuleResult.value)
        successCount += 1
      } else {
        sectionErrorState.o2o_rules = '线上预定规则加载失败'
      }
      if (result.orderSerialResult.status !== 'fulfilled') {
        sectionErrorState.order_serial = '订单流水配置加载失败'
      }

      if (successCount === 0) {
        loadError.value = '系统配置加载失败，请刷新重试或检查后端服务状态'
        sectionLoadingState.verification = false
        sectionLoadingState.department = false
        sectionLoadingState.notification = false
        return
      }
      if (successCount > 0 && successCount < 2) {
        ElMessage.warning('核心配置已部分加载，页面将继续展示可用内容')
      }

      deferredSectionRequest
        .runLatest({
        executor: async () => {
          const [verificationResult, clientDepartmentResult, notificationRulesResult, notificationPresenceResult] = await Promise.allSettled([
            getVerificationProviderConfigs(),
            getClientDepartmentConfigs(),
            getNotificationRules(),
            getNotificationPresenceSnapshot(),
          ])
          return {
            verificationResult,
            clientDepartmentResult,
            notificationRulesResult,
            notificationPresenceResult,
          }
        },
        onSuccess: (deferredResult) => {
          if (deferredResult.verificationResult.status === 'fulfilled') {
            applyVerificationConfigs(deferredResult.verificationResult.value)
          } else {
            sectionErrorState.verification = '验证码配置加载失败'
          }

          if (deferredResult.clientDepartmentResult.status === 'fulfilled') {
            applyClientDepartmentConfigs(deferredResult.clientDepartmentResult.value)
          } else {
            sectionErrorState.department = '部门配置加载失败'
          }

          if (deferredResult.notificationRulesResult.status === 'fulfilled') {
            applyNotificationRules(deferredResult.notificationRulesResult.value.list)
          } else {
            sectionErrorState.notification = '通知规则加载失败'
          }

          if (deferredResult.notificationPresenceResult.status === 'fulfilled') {
            applyNotificationPresenceSnapshot(deferredResult.notificationPresenceResult.value)
          } else {
            sectionErrorState.notification = sectionErrorState.notification || '在线状态快照加载失败'
          }

          if (sectionErrorState.verification || sectionErrorState.department || sectionErrorState.notification) {
            ElMessage.warning('部分次级配置仍在加载失败，已保留当前可用内容')
          }
        },
        onError: (error) => {
          const message = extractErrorMessage(error, '继续加载验证码、部门与通知配置失败')
          sectionErrorState.verification = sectionErrorState.verification || message
          sectionErrorState.department = sectionErrorState.department || message
          sectionErrorState.notification = sectionErrorState.notification || message
          ElMessage.warning(message)
        },
        onFinally: () => {
          sectionLoadingState.verification = false
          sectionLoadingState.department = false
          sectionLoadingState.notification = false
          initialSnapshot.value = snapshotForm()
        },
        })
        .catch(() => undefined)
    },
    onError: (error) => {
      loadError.value = extractErrorMessage(error, '加载系统配置失败，请稍后重试')
      ElMessage.error(loadError.value)
    },
    onFinally: () => {
      sectionLoadingState.order_serial = false
      sectionLoadingState.o2o_rules = false
      loading.value = false
    },
  })
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleSubmit = async () => {
  if (!ensurePermission('system_configs:update')) {
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
  if (!validateNotificationRules()) {
    return
  }
  let normalizedDepartmentTree: DepartmentTreeNode[] = []
  try {
    normalizedDepartmentTree = normalizeDepartmentTreeForSubmit(cloneDepartmentTree(serialForm.clientDepartmentTree))
    validateDepartmentTree(normalizedDepartmentTree)
  } catch (error) {
    ElMessage.warning(extractErrorMessage(error, '部门配置格式不正确'))
    return
  }

  saving.value = true
  try {
    // SQLite 单连接下并发写事务会互相冲突，这里改为串行提交，避免 “cannot start a transaction within a transaction”。
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
      clientPreorderUpdateLimit: Number(serialForm.o2o.clientPreorderUpdateLimit),
    })
    const verificationResult = await updateVerificationProviderConfigs({
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
    })
    const departmentResult = await updateClientDepartmentConfigs({
      tree: normalizedDepartmentTree,
    })
    const notificationResult = await updateNotificationRules({
      rules: notificationRules.value.map((rule) => ({
        id: rule.id,
        enabled: rule.enabled,
        recipientUserIds: [...rule.recipientUserIds],
        emailEnabled: rule.emailEnabled,
        feishuEnabled: rule.feishuEnabled,
        externalTriggerMode: rule.externalTriggerMode,
        watchedUserIds: [...rule.watchedUserIds],
        feishuWebhookUrl: rule.feishuWebhookUrl.trim(),
        emailSubjectPrefix: rule.emailSubjectPrefix.trim() || '[Y-Link]',
      })),
    })

    applyList(result.list)
    applyO2oRules(o2oResult.config)
    applyVerificationConfigs(verificationResult.config)
    applyClientDepartmentConfigs(departmentResult.config)
    applyNotificationRules(notificationResult.list)
    await refreshNotificationPresenceSnapshot()
    initialSnapshot.value = snapshotForm()
    ElMessage.success(
      result.changed || o2oResult.changed || verificationResult.changed || departmentResult.changed || notificationResult.changed ? '系统配置已保存' : '配置未变更',
    )
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
      <PageToolbarCard class="space-y-3" :stack-actions-on-tablet="true">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="text-sm text-slate-600 dark:text-slate-300">
            {{ canUpdateConfigs ? '当前账号具备系统配置维护权限，可编辑参数并提交保存' : '当前账号仅支持只读查看' }}
          </div>
          <el-button
            v-if="canUpdateConfigs"
            type="primary"
            :loading="saving"
            :disabled="formInteractionLoading || hasDeferredSectionFailure || !isDirty"
            @click="handleSubmit"
          >
            保存配置
          </el-button>
        </div>
        <el-alert
          title="简要说明"
          type="info"
          :closable="false"
          show-icon
          :description="`这里用于维护订单编号规则、线上预订规则，以及客户端注册/找回密码依赖的短信与邮箱验证码平台。建议仅在管理员确认后修改，以免影响业务连续性。若需要处理数据库迁移、切换或回退，请统一进入${DATABASE_MIGRATION_ASSISTANT_NAME}，并按“${DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT}”闭环执行。`"
        />
        <template #actions>
          <div class="system-config-toolbar-actions flex w-full flex-wrap items-start gap-3">
            <div
              v-if="canViewMigrationAssistant"
              class="system-config-toolbar-hint rounded-2xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500 dark:bg-slate-900/40 dark:text-slate-400"
            >
              {{ DATABASE_MIGRATION_ENTRY_DESCRIPTION }}
            </div>
            <el-button v-if="canViewMigrationAssistant" plain class="system-config-toolbar-button" @click="handleGoToDatabaseMigration">
              {{ DATABASE_MIGRATION_ENTRY_LABEL }}
            </el-button>
          </div>
        </template>
      </PageToolbarCard>

      <el-alert
        v-if="!canViewConfigs"
        title="当前账号暂无系统配置查看权限"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-alert v-else-if="loadError" :title="loadError" type="error" :closable="false" show-icon />

      <el-form v-else ref="formRef" :model="serialForm" :rules="rules" label-position="top">
        <div class="apple-card p-5 sm:p-6 xl:p-7">
          <el-alert
            v-if="deferredSectionStatusText"
            :title="deferredSectionStatusText"
            :type="hasDeferredSectionFailure ? 'warning' : 'info'"
            :closable="false"
            show-icon
            class="mb-4"
          />
          <el-alert
            v-if="activeSectionLoadFailed"
            :title="sectionErrorState[activeSection]"
            type="warning"
            :closable="false"
            show-icon
            class="mb-4"
          />
          <div class="mb-4">
            <el-tabs :model-value="activeSection" @tab-change="handleSectionChange">
              <el-tab-pane v-for="section in sectionOptions" :key="section.key" :label="section.label" :name="section.key" />
            </el-tabs>
          </div>

          <div class="config-stage">
            <transition name="workbench-horizontal-slide">
              <SystemConfigSerialSection
                v-if="activeSection === 'order_serial'"
                :config-map="configMap"
                :department-preview="departmentPreview"
                :walkin-preview="walkinPreview"
                :serial-form="serialForm"
                :can-update-configs="canUpdateConfigs"
                :loading="activeSectionInteractionLoading"
                :get-updated-at-label="getUpdatedAtLabel"
              />
            </transition>

            <transition name="workbench-horizontal-slide">
              <SystemConfigO2oRulesSection
                v-if="activeSection === 'o2o_rules'"
                :o2o-form="serialForm.o2o"
                :can-update-configs="canUpdateConfigs"
                :loading="activeSectionInteractionLoading"
                :o2o-updated-at-label="o2oUpdatedAtLabel"
              />
            </transition>

            <transition name="workbench-horizontal-slide">
              <SystemConfigVerificationSection
                v-if="activeSection === 'verification'"
                :verification-form="serialForm.verification"
                :can-update-configs="canUpdateConfigs"
                :can-test-verification-providers="canTestVerificationProviders"
                :loading="activeSectionInteractionLoading"
                :saving="saving"
                :test-sending-channel="testSendingChannel"
                :get-verification-updated-at-label="getVerificationUpdatedAtLabel"
                @test-send="handleTestVerificationSend"
              />
            </transition>

            <transition name="workbench-horizontal-slide">
              <SystemConfigDepartmentSection
                v-if="activeSection === 'department'"
                :serial-form="serialForm"
                :can-update-configs="canUpdateConfigs"
                :loading="activeSectionInteractionLoading"
                :saving="saving"
                :selected-department-node="selectedDepartmentNode"
                :client-department-preview-options="clientDepartmentPreviewOptions"
                :client-department-config="clientDepartmentConfig"
                :get-department-path-label="getDepartmentPathLabel"
                :handle-allow-department-drop="handleAllowDepartmentDrop"
                @add-root="handleAddRootDepartment"
                @add-child="handleAddChildDepartment"
                @edit="handleEditDepartment"
                @delete="handleDeleteDepartment"
                @node-click="handleDepartmentNodeClick"
              />
            </transition>

            <transition name="workbench-horizontal-slide">
              <SystemConfigNotificationSection
                v-if="activeSection === 'notification'"
                :rules="notificationRules"
                :presence-snapshot="notificationPresence"
                :management-users="managementUsers"
                :loading="activeSectionInteractionLoading"
                :saving="saving"
                :can-update-configs="canUpdateConfigs"
                :presence-loading="notificationPresenceLoading"
                @refresh-presence="refreshNotificationPresenceSnapshot"
              />
            </transition>
          </div>
        </div>
      </el-form>
    </div>
  </PageContainer>
</template>

<style scoped>
.config-stage {
  position: relative;
  min-height: 420px;
}

.config-stage__panel {
  position: relative;
}

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

.workbench-horizontal-slide-enter-active {
  transition:
    transform var(--ylink-motion-normal) var(--ylink-motion-ease),
    opacity var(--ylink-motion-normal) var(--ylink-motion-ease);
  will-change: transform, opacity;
  position: relative;
  z-index: 2;
}

.workbench-horizontal-slide-leave-active {
  transition:
    transform var(--motion-duration-fast) var(--ylink-motion-ease),
    opacity var(--motion-duration-fast) var(--ylink-motion-ease);
  will-change: transform, opacity;
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

.workbench-horizontal-slide-enter-from {
  opacity: 0;
  transform: translate3d(28px, 0, 0);
}

.workbench-horizontal-slide-leave-to {
  opacity: 0;
  transform: translate3d(-20px, 0, 0);
}

.system-config-toolbar-actions {
  justify-content: space-between;
  width: auto;
  max-width: 100%;
}

.system-config-toolbar-hint {
  flex: 1 1 420px;
  min-width: 0;
  max-width: 520px;
}

.system-config-toolbar-button {
  flex-shrink: 0;
}

@media (max-width: 1279px) {
  .system-config-toolbar-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .system-config-toolbar-hint {
    flex-basis: auto;
    width: 100%;
  }

  .system-config-toolbar-button {
    width: 100%;
  }
}
</style>
