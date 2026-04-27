<!--
  文件说明：数据库迁移助手页面。
  文件职责：在管理端系统治理模块中提供 SQLite -> MySQL 迁移预检、任务创建、任务执行、运行时切换、SQLite 回退与状态展示能力。
  实现逻辑：
  1. 页面左侧收口目标 MySQL 连接信息与迁移选项，管理员可先做预检，再创建迁移任务。
  2. 页面中部展示当前应用运行时数据库状态与预检结果，帮助管理员确认风险、覆盖配置和是否可继续操作。
  3. 页面下方维护迁移任务列表与任务详情，支持执行任务、切换到目标库、回退到 SQLite、清空运行时覆盖。
-->
<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { PageContainer, PageToolbarCard } from '@/components/common'
import {
  applyDatabaseMigrationSwitch,
  clearDatabaseMigrationRuntimeOverride,
  createSQLiteToMySqlMigrationTask,
  getDatabaseMigrationRuntimeOverrideState,
  getSQLiteToMySqlMigrationTaskDetail,
  getSQLiteToMySqlMigrationTasks,
  precheckSQLiteToMySqlMigration,
  rollbackDatabaseMigrationSwitch,
  runSQLiteToMySqlMigrationTask,
  type CreateSQLiteToMySqlTaskPayload,
  type DatabaseMigrationIssue,
  type DatabaseMigrationTableStat,
  type DatabaseRuntimeOverrideFile,
  type DatabaseRuntimeOverrideStateResult,
  type MySqlMigrationTarget,
  type SQLiteToMySqlPrecheckResult,
  type SQLiteToMySqlTaskRecord,
} from '@/api/modules/data-maintenance'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

/**
 * 页面表单状态：
 * - target 维护目标 MySQL 连接信息；
 * - 其余字段对应迁移任务创建时的控制开关。
 */
type MigrationFormState = {
  target: MySqlMigrationTarget
  allowTargetWithData: boolean
  initializeSchema: boolean
  clearTargetBeforeImport: boolean
  switchAfterSuccess: boolean
  createSqliteBackup: boolean
  note: string
}

const authStore = useAuthStore()
const overviewRequest = useStableRequest()
const taskDetailRequest = useStableRequest()

/**
 * 表单默认值：
 * - 端口默认 3306，降低管理员录入成本；
 * - 默认开启建表与 SQLite 备份，优先保障迁移安全性。
 */
const migrationForm = reactive<MigrationFormState>({
  target: {
    host: '',
    port: 3306,
    user: '',
    password: '',
    database: '',
    dbSync: false,
  },
  allowTargetWithData: false,
  initializeSchema: true,
  clearTargetBeforeImport: false,
  switchAfterSuccess: false,
  createSqliteBackup: true,
  note: '',
})

/**
 * 页面核心状态：
 * - runtimeState 记录当前运行时数据库覆盖配置；
 * - precheckResult 记录最近一次预检结果；
 * - taskList 记录迁移任务列表；
 * - selectedTaskId 控制下方详情区展示目标。
 */
const pageLoading = ref(true)
const precheckLoading = ref(false)
const taskCreating = ref(false)
const taskRunningId = ref('')
const switchingTaskId = ref('')
const rollbackLoading = ref(false)
const clearOverrideLoading = ref(false)
const loadError = ref('')
const runtimeState = ref<DatabaseRuntimeOverrideStateResult | null>(null)
const precheckResult = ref<SQLiteToMySqlPrecheckResult | null>(null)
const taskList = ref<SQLiteToMySqlTaskRecord[]>([])
const selectedTaskId = ref('')

/**
 * 权限控制：
 * - 查看权限用于控制整页展示；
 * - 更新权限控制预检之外的高风险动作按钮。
 */
const canViewMigration = computed(() => authStore.hasPermission('system_configs:view'))
const canOperateMigration = computed(() => authStore.hasPermission('system_configs:update'))

/**
 * 当前选中的迁移任务：
 * - 始终以 selectedTaskId 为真源；
 * - 若列表刷新后任务仍存在，会继续保持选中态。
 */
const selectedTask = computed(() => {
  return taskList.value.find((item) => item.id === selectedTaskId.value) ?? null
})

/**
 * 当前运行时数据库模式：
 * - 未启用运行时覆盖时，代表应用仍使用默认环境变量；
 * - 已启用时优先展示覆盖配置中的 DB_TYPE。
 */
const activeRuntimeModeLabel = computed(() => {
  const override = runtimeState.value?.activeOverride
  if (!override?.config) {
    return '未启用运行时覆盖（使用默认环境配置）'
  }
  return override.config.DB_TYPE === 'mysql' ? '当前运行在 MySQL 覆盖配置' : '当前运行在 SQLite 覆盖配置'
})

/**
 * 任务执行进度百分比：
 * - 以已完成表数 / SQLite 源表数估算；
 * - 若后端尚未开始回填表结果，则显示 0。
 */
const selectedTaskProgressPercent = computed(() => {
  const task = selectedTask.value
  if (!task) {
    return 0
  }
  const totalTables = Math.max(task.precheck.source.tables.length, 1)
  const doneTables = Math.min(task.progress.tableResults.length, totalTables)
  return Math.min(100, Math.round((doneTables / totalTables) * 100))
})

/**
 * 当前预检是否存在阻断错误：
 * - 供按钮态与风险文案复用；
 * - 仍允许管理员查看详情，但不鼓励继续创建任务。
 */
const hasPrecheckBlockingError = computed(() => {
  return Boolean(precheckResult.value?.issues.some((item) => item.level === 'error'))
})

/**
 * 对输入目标库参数做基础清洗：
 * - 字符串项统一 trim；
 * - 端口与布尔值做类型归一化，避免页面层把空格写进后端任务文件。
 */
const buildNormalizedTarget = (): MySqlMigrationTarget => {
  return {
    host: migrationForm.target.host.trim(),
    port: Number(migrationForm.target.port) || 3306,
    user: migrationForm.target.user.trim(),
    password: migrationForm.target.password,
    database: migrationForm.target.database.trim(),
    dbSync: Boolean(migrationForm.target.dbSync),
  }
}

/**
 * 创建任务时的完整请求载荷：
 * - 直接复用页面表单状态；
 * - 后端会再次做 Zod 校验，这里主要负责避免明显脏值。
 */
const buildTaskPayload = (): CreateSQLiteToMySqlTaskPayload => {
  return {
    target: buildNormalizedTarget(),
    allowTargetWithData: migrationForm.allowTargetWithData,
    initializeSchema: migrationForm.initializeSchema,
    clearTargetBeforeImport: migrationForm.clearTargetBeforeImport,
    switchAfterSuccess: migrationForm.switchAfterSuccess,
    createSqliteBackup: migrationForm.createSqliteBackup,
    note: migrationForm.note.trim() || undefined,
  }
}

/**
 * 基础表单校验：
 * - 仅校验迁移必须的连接参数；
 * - 真正连通性、数据库存在性、目标表风险交给后端预检。
 */
const validateTargetForm = () => {
  const target = buildNormalizedTarget()
  if (!target.host) {
    ElMessage.warning('请输入目标 MySQL 主机地址')
    return false
  }
  if (!target.user) {
    ElMessage.warning('请输入目标 MySQL 用户名')
    return false
  }
  if (!target.database) {
    ElMessage.warning('请输入目标 MySQL 数据库名')
    return false
  }
  if (!Number.isInteger(target.port) || target.port <= 0) {
    ElMessage.warning('请输入正确的 MySQL 端口')
    return false
  }
  return true
}

/**
 * 将任务结果回写到列表：
 * - 新建任务时用于插入；
 * - 执行、切换后用于更新同一任务的最新状态。
 */
const upsertTaskRecord = (task: SQLiteToMySqlTaskRecord) => {
  const nextList = [...taskList.value]
  const targetIndex = nextList.findIndex((item) => item.id === task.id)
  if (targetIndex >= 0) {
    nextList.splice(targetIndex, 1, task)
  } else {
    nextList.unshift(task)
  }
  nextList.sort((prev, next) => next.updatedAt.localeCompare(prev.updatedAt))
  taskList.value = nextList
}

/**
 * 刷新任务详情：
 * - 列表接口已经带完整任务结构，但详情刷新可确保当前选中任务拿到最新状态；
 * - 仅在存在选中任务时才触发，避免多余请求。
 */
const refreshSelectedTaskDetail = async () => {
  if (!selectedTaskId.value) {
    return
  }
  await taskDetailRequest.runLatest({
    executor: (signal) => getSQLiteToMySqlMigrationTaskDetail(selectedTaskId.value, { signal }),
    onSuccess: (task) => {
      upsertTaskRecord(task)
    },
    onError: (error) => {
      ElMessage.warning(extractErrorMessage(error, '刷新任务详情失败'))
    },
  })
}

/**
 * 首屏与动作后的总刷新：
 * - 一次性刷新任务列表与运行时覆盖状态；
 * - 若当前已有选中任务，再补一次详情刷新，保证下方卡片信息完整。
 */
const loadOverview = async () => {
  if (!canViewMigration.value) {
    pageLoading.value = false
    return
  }

  loadError.value = ''
  pageLoading.value = true
  await overviewRequest.runLatest({
    executor: async (signal) => {
      const [tasks, runtime] = await Promise.all([
        getSQLiteToMySqlMigrationTasks({ signal }),
        getDatabaseMigrationRuntimeOverrideState({ signal }),
      ])
      return { tasks, runtime }
    },
    onSuccess: async (result) => {
      taskList.value = result.tasks
      runtimeState.value = result.runtime

      if (!selectedTaskId.value && result.tasks.length > 0) {
        selectedTaskId.value = result.tasks[0].id
      }
      if (selectedTaskId.value && !result.tasks.some((item) => item.id === selectedTaskId.value)) {
        selectedTaskId.value = result.tasks[0]?.id ?? ''
      }
      await refreshSelectedTaskDetail()
    },
    onError: (error) => {
      loadError.value = extractErrorMessage(error, '加载数据库迁移助手失败')
      ElMessage.error(loadError.value)
    },
    onFinally: () => {
      pageLoading.value = false
    },
  })
}

/**
 * 预检动作：
 * - 优先用当前表单做一次后端真实校验；
 * - 成功后把结果保存在页面中，供创建任务前复核。
 */
const handlePrecheck = async () => {
  if (!canViewMigration.value) {
    ElMessage.warning('当前账号暂无数据库迁移查看权限')
    return
  }
  if (!validateTargetForm()) {
    return
  }

  precheckLoading.value = true
  try {
    const result = await precheckSQLiteToMySqlMigration({
      target: buildNormalizedTarget(),
      allowTargetWithData: migrationForm.allowTargetWithData,
    })
    precheckResult.value = result
    if (runtimeState.value) {
      runtimeState.value = {
        ...runtimeState.value,
        activeOverride: result.activeRuntimeOverride,
      }
    }
    ElMessage.success(result.canProceed ? '预检通过，可继续创建迁移任务' : '预检已完成，请先处理阻断问题')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '迁移预检失败'))
  } finally {
    precheckLoading.value = false
  }
}

/**
 * 创建迁移任务：
 * - 若预检尚未执行，允许继续创建，因为后端会再次预检；
 * - 若预检已有阻断错误，则先拦截，避免把明显无法执行的任务落盘。
 */
const handleCreateTask = async () => {
  if (!canOperateMigration.value) {
    ElMessage.warning('当前账号暂无数据库迁移操作权限')
    return
  }
  if (!validateTargetForm()) {
    return
  }
  if (hasPrecheckBlockingError.value) {
    ElMessage.warning('当前预检存在阻断错误，请修复后再创建迁移任务')
    return
  }

  taskCreating.value = true
  try {
    const task = await createSQLiteToMySqlMigrationTask(buildTaskPayload())
    upsertTaskRecord(task)
    selectedTaskId.value = task.id
    ElMessage.success('迁移任务已创建，可在下方任务列表中执行')
    await loadOverview()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '创建迁移任务失败'))
  } finally {
    taskCreating.value = false
  }
}

/**
 * 执行迁移任务：
 * - 二次确认后调用后端执行；
 * - 成功后刷新任务列表与运行时覆盖状态。
 */
const handleRunTask = async (task: SQLiteToMySqlTaskRecord) => {
  if (!canOperateMigration.value) {
    ElMessage.warning('当前账号暂无数据库迁移操作权限')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确认执行迁移任务“${task.id}”吗？执行过程中将按任务配置连接目标 MySQL，并可能创建 SQLite 备份。`,
      '执行迁移任务',
      {
        type: 'warning',
        confirmButtonText: '立即执行',
        cancelButtonText: '取消',
      },
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
  }

  taskRunningId.value = task.id
  try {
    const latestTask = await runSQLiteToMySqlMigrationTask(task.id)
    upsertTaskRecord(latestTask)
    selectedTaskId.value = latestTask.id
    ElMessage.success(latestTask.status === 'succeeded' ? '迁移任务执行完成' : '迁移任务已执行，请查看结果')
    await loadOverview()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '执行迁移任务失败'))
  } finally {
    taskRunningId.value = ''
  }
}

/**
 * 切换应用到指定迁移任务：
 * - 使用任务 ID 建立切换来源，便于后续审计与回退；
 * - 返回后会提示“需重启后端服务”这一关键动作。
 */
const handleSwitchToTask = async (task: SQLiteToMySqlTaskRecord) => {
  if (!canOperateMigration.value) {
    ElMessage.warning('当前账号暂无数据库迁移操作权限')
    return
  }
  if (task.status !== 'succeeded') {
    ElMessage.warning('仅支持切换到已成功完成的迁移任务')
    return
  }

  try {
    const promptResult = await ElMessageBox.prompt(
      '请输入本次切换原因，便于审计日志追溯。可直接确认使用默认原因。',
      '切换到 MySQL',
      {
        inputValue: '数据库迁移助手手动切换到目标 MySQL',
        inputPlaceholder: '例如：验证通过，切换到生产 MySQL',
        confirmButtonText: '确认切换',
        cancelButtonText: '取消',
      },
    )
    switchingTaskId.value = task.id
    const result = await applyDatabaseMigrationSwitch({
      taskId: task.id,
      reason: promptResult.value.trim() || undefined,
    })
    if (runtimeState.value) {
      runtimeState.value = {
        ...runtimeState.value,
        activeOverride: result.activeOverride,
      }
    }
    ElMessage.success('已写入 MySQL 运行时覆盖配置，请按提示重启后端服务使切换生效')
    await loadOverview()
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error(extractErrorMessage(error, '切换到 MySQL 失败'))
  } finally {
    switchingTaskId.value = ''
  }
}

/**
 * 回退到 SQLite：
 * - 若存在选中任务，则把 taskId 一并传给后端，方便后端优先回退到该任务源 SQLite；
 * - 若无选中任务，后端会使用当前覆盖配置中的 rollbackConfig 或默认 SQLite 路径。
 */
const handleRollbackToSqlite = async () => {
  if (!canOperateMigration.value) {
    ElMessage.warning('当前账号暂无数据库迁移操作权限')
    return
  }

  try {
    const promptResult = await ElMessageBox.prompt(
      '请输入本次回退原因。若当前已经切到 MySQL，回退后仍需重启后端服务。',
      '回退到 SQLite',
      {
        inputValue: '数据库迁移助手回退到 SQLite',
        inputPlaceholder: '例如：目标库校验异常，回退到 SQLite',
        confirmButtonText: '确认回退',
        cancelButtonText: '取消',
      },
    )
    rollbackLoading.value = true
    const result = await rollbackDatabaseMigrationSwitch({
      taskId: selectedTask.value?.id,
      reason: promptResult.value.trim() || undefined,
    })
    if (runtimeState.value) {
      runtimeState.value = {
        ...runtimeState.value,
        activeOverride: result.activeOverride,
      }
    }
    ElMessage.success('已写入 SQLite 回退覆盖配置，请重启后端服务完成回退')
    await loadOverview()
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error(extractErrorMessage(error, '回退到 SQLite 失败'))
  } finally {
    rollbackLoading.value = false
  }
}

/**
 * 清空运行时覆盖：
 * - 用于撤销当前覆盖文件，让应用回到默认环境变量配置；
 * - 页面会同步提醒管理员，仍需重启后端服务。
 */
const handleClearRuntimeOverride = async () => {
  if (!canOperateMigration.value) {
    ElMessage.warning('当前账号暂无数据库迁移操作权限')
    return
  }

  try {
    await ElMessageBox.confirm(
      '确认清空当前数据库运行时覆盖配置吗？清空后应用会回到默认环境变量配置，通常仍需重启后端服务。',
      '清空运行时覆盖',
      {
        type: 'warning',
        confirmButtonText: '确认清空',
        cancelButtonText: '取消',
      },
    )
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
  }

  clearOverrideLoading.value = true
  try {
    await clearDatabaseMigrationRuntimeOverride()
    ElMessage.success('运行时覆盖文件已清空，请按需重启后端服务')
    await loadOverview()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '清空运行时覆盖失败'))
  } finally {
    clearOverrideLoading.value = false
  }
}

/**
 * 任务行点击：
 * - 统一由任务 ID 维护选中态；
 * - 点击后立即刷新该任务详情，避免列表数据滞后。
 */
const handleSelectTask = async (task: SQLiteToMySqlTaskRecord) => {
  selectedTaskId.value = task.id
  await refreshSelectedTaskDetail()
}

/**
 * 风险级别标签色：
 * - error 使用危险色；
 * - warning 使用警告色；
 * - info 使用信息色。
 */
const getIssueTagType = (level: DatabaseMigrationIssue['level']) => {
  if (level === 'error') {
    return 'danger'
  }
  if (level === 'warning') {
    return 'warning'
  }
  return 'info'
}

/**
 * 迁移任务状态标签：
 * - 与后端枚举一一对应；
 * - 保证列表与详情区域文案一致。
 */
const getTaskStatusLabel = (status: SQLiteToMySqlTaskRecord['status']) => {
  if (status === 'prechecked') {
    return '待执行'
  }
  if (status === 'running') {
    return '执行中'
  }
  if (status === 'succeeded') {
    return '已成功'
  }
  return '已失败'
}

const getTaskStatusTagType = (status: SQLiteToMySqlTaskRecord['status']) => {
  if (status === 'succeeded') {
    return 'success'
  }
  if (status === 'running') {
    return 'warning'
  }
  if (status === 'failed') {
    return 'danger'
  }
  return 'info'
}

/**
 * 运行时数据库模式标签：
 * - 覆盖文件不存在时显示“默认配置”；
 * - 覆盖到 MySQL / SQLite 时显示对应模式。
 */
const getRuntimeModeTagType = (override: DatabaseRuntimeOverrideFile | null) => {
  if (!override?.config) {
    return 'info'
  }
  return override.config.DB_TYPE === 'mysql' ? 'success' : 'warning'
}

/**
 * 时间格式化：
 * - 统一治理页内的时间显示口径；
 * - 对空值做短横线兜底。
 */
const formatDateTime = (value?: string | null) => {
  if (!value) {
    return '-'
  }
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

/**
 * 表数量摘要：
 * - 供预检区与任务详情区展示；
 * - 没有数据时返回“0 张表”。
 */
const formatTableSummary = (tables: DatabaseMigrationTableStat[]) => {
  return `${tables.length} 张表 / ${tables.reduce((total, item) => total + item.rowCount, 0)} 行`
}

onMounted(() => {
  void loadOverview()
})
</script>

<template>
  <PageContainer
    title="数据库迁移助手"
    description="推荐通过本向导完成 SQLite 到 MySQL 的预检、迁移、切换与回退闭环，避免手工改环境变量或跳过校验造成运行风险。"
  >
    <div class="flex min-w-0 flex-col gap-4">
      <PageToolbarCard content-class="items-start">
        <template #default>
          <div class="space-y-3">
            <div class="text-sm text-slate-600 dark:text-slate-300">
              {{ canOperateMigration ? '当前账号可执行预检、创建任务、切换和回退操作' : '当前账号仅支持查看迁移状态，只有具备更新权限的账号可执行高风险动作' }}
            </div>
            <el-alert
              title="风险提醒"
              type="warning"
              :closable="false"
              show-icon
              description="正式环境推荐全程使用数据库迁移向导，不建议绕过页面手工修改运行时配置。数据库迁移、切换和回退都会影响系统运行环境，执行前请先完成预检，确认目标 MySQL 可用、SQLite 备份已保留，并与业务方约定重启窗口。"
            />
          </div>
        </template>
        <template #actions>
          <div class="flex w-full flex-wrap items-center justify-end gap-2">
            <el-button :loading="pageLoading" @click="loadOverview">刷新状态</el-button>
            <el-button
              type="warning"
              :loading="rollbackLoading"
              :disabled="!canOperateMigration || pageLoading"
              @click="handleRollbackToSqlite"
            >
              回退到 SQLite
            </el-button>
            <el-button
              type="danger"
              plain
              :loading="clearOverrideLoading"
              :disabled="!canOperateMigration || pageLoading"
              @click="handleClearRuntimeOverride"
            >
              清空运行时覆盖
            </el-button>
          </div>
        </template>
      </PageToolbarCard>

      <el-alert
        v-if="!canViewMigration"
        title="当前账号暂无数据库迁移助手查看权限"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-alert v-else-if="loadError" :title="loadError" type="error" :closable="false" show-icon />

      <div v-if="canViewMigration" class="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <section class="apple-card space-y-5 p-5 sm:p-6">
          <div class="border-b border-slate-100 pb-4 dark:border-white/5">
            <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">目标 MySQL 配置</h2>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
              推荐先在本向导内完成预检，再创建迁移任务并执行切换。密码仅在本次提交中使用，页面不会回显运行时真实密码。
            </p>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2 sm:col-span-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">主机地址</div>
              <el-input v-model="migrationForm.target.host" placeholder="例如：127.0.0.1 或 mysql.internal" />
            </div>
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">端口</div>
              <el-input-number v-model="migrationForm.target.port" :min="1" :max="65535" :controls="false" class="!w-full" />
            </div>
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">用户名</div>
              <el-input v-model="migrationForm.target.user" placeholder="请输入 MySQL 用户名" />
            </div>
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">密码</div>
              <el-input v-model="migrationForm.target.password" type="password" show-password placeholder="请输入 MySQL 密码" />
            </div>
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">数据库名</div>
              <el-input v-model="migrationForm.target.database" placeholder="请输入目标库名称" />
            </div>
          </div>

          <div class="grid gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-slate-900/20">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">允许目标库已有业务数据</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">若目标 MySQL 中已有业务表数据，预检会转为高风险提示</div>
              </div>
              <el-switch v-model="migrationForm.allowTargetWithData" />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">初始化目标表结构</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">推荐开启，让后端按实体结构初始化目标 MySQL</div>
              </div>
              <el-switch v-model="migrationForm.initializeSchema" />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">导入前清空目标业务表</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">仅在确认目标库可覆盖时开启，避免残留旧数据</div>
              </div>
              <el-switch v-model="migrationForm.clearTargetBeforeImport" />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">执行前创建 SQLite 物理备份</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">该项为固定开启，用于与 JSON 快照组成双重备份，保障回退安全</div>
              </div>
              <el-switch v-model="migrationForm.createSqliteBackup" disabled />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">迁移成功后自动切换到 MySQL</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">该操作只写入运行时覆盖配置，仍需重启后端服务后生效</div>
              </div>
              <el-switch v-model="migrationForm.switchAfterSuccess" />
            </div>
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">目标库启用 Schema 同步</div>
                <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">仅在你明确知道该环境允许自动同步结构时再开启</div>
              </div>
              <el-switch v-model="migrationForm.target.dbSync" />
            </div>
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">迁移备注</div>
            <el-input
              v-model="migrationForm.note"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="例如：测试环境切换到 4 月份新建 MySQL，用于验证订单与商品数据"
            />
          </div>

          <div class="flex flex-wrap gap-2">
            <el-button type="primary" :loading="precheckLoading" :disabled="pageLoading" @click="handlePrecheck">
              执行预检
            </el-button>
            <el-button type="success" :loading="taskCreating" :disabled="!canOperateMigration || pageLoading" @click="handleCreateTask">
              创建迁移任务
            </el-button>
          </div>
        </section>

        <div class="grid gap-4">
          <section class="apple-card space-y-4 p-5 sm:p-6">
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
              <div>
                <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">当前运行状态</h2>
                <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  展示数据库运行时覆盖文件、当前模式与可回退目标，帮助管理员确认此刻应用实际使用的数据库来源，并避免在线下手工改配置后与页面状态不一致。
                </p>
              </div>
              <el-tag :type="getRuntimeModeTagType(runtimeState?.activeOverride ?? null)" effect="light">
                {{ activeRuntimeModeLabel }}
              </el-tag>
            </div>

            <el-descriptions :column="2" border>
              <el-descriptions-item label="覆盖文件路径">
                {{ runtimeState?.filePath || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="当前模式">
                {{ runtimeState?.activeOverride?.config?.DB_TYPE || '默认配置' }}
              </el-descriptions-item>
              <el-descriptions-item label="覆盖更新时间">
                {{ formatDateTime(runtimeState?.activeOverride?.updatedAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="来源任务">
                {{ runtimeState?.activeOverride?.sourceTaskId || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="切换原因">
                {{ runtimeState?.activeOverride?.reason || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="执行人">
                {{ runtimeState?.activeOverride?.updatedBy?.displayName || runtimeState?.activeOverride?.updatedBy?.username || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="当前目标库">
                <template v-if="runtimeState?.activeOverride?.config?.DB_TYPE === 'mysql'">
                  {{ runtimeState.activeOverride.config.DB_HOST }}:{{ runtimeState.activeOverride.config.DB_PORT }} /
                  {{ runtimeState.activeOverride.config.DB_NAME }}
                </template>
                <template v-else>
                  {{ runtimeState?.activeOverride?.config?.SQLITE_DB_PATH || '-' }}
                </template>
              </el-descriptions-item>
              <el-descriptions-item label="可回退 SQLite">
                {{ runtimeState?.activeOverride?.rollbackConfig?.SQLITE_DB_PATH || '-' }}
              </el-descriptions-item>
            </el-descriptions>

            <el-alert
              title="重启提示"
              type="info"
              :closable="false"
              show-icon
              description="无论是切换到 MySQL、回退到 SQLite，还是清空运行时覆盖，通常都需要重启后端服务后才会真正切换到新数据库。建议把“写入覆盖配置”和“服务重启”视为同一次变更动作完成闭环。"
            />
          </section>

          <section class="apple-card space-y-4 p-5 sm:p-6">
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
              <div>
                <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">最近一次预检</h2>
                <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  预检会校验 SQLite 源文件、目标 MySQL 连通性、目标业务表数据风险，以及当前运行时覆盖状态。正式迁移前不要跳过此步骤。
                </p>
              </div>
              <el-tag v-if="precheckResult" :type="precheckResult.canProceed ? 'success' : 'danger'" effect="light">
                {{ precheckResult.canProceed ? '允许继续' : '存在阻断' }}
              </el-tag>
            </div>

            <div v-if="precheckResult" class="space-y-4">
              <el-descriptions :column="2" border>
                <el-descriptions-item label="预检时间">
                  {{ formatDateTime(precheckResult.checkedAt) }}
                </el-descriptions-item>
                <el-descriptions-item label="SQLite 文件存在">
                  {{ precheckResult.source.sqliteFileExists ? '是' : '否' }}
                </el-descriptions-item>
                <el-descriptions-item label="SQLite 路径">
                  {{ precheckResult.source.sqlitePath }}
                </el-descriptions-item>
                <el-descriptions-item label="SQLite 文件大小">
                  {{ precheckResult.source.sqliteFileSizeBytes }} Bytes
                </el-descriptions-item>
                <el-descriptions-item label="SQLite 数据量">
                  {{ formatTableSummary(precheckResult.source.tables) }}
                </el-descriptions-item>
                <el-descriptions-item label="MySQL 连通性">
                  {{ precheckResult.target.reachable ? '可连接' : '不可连接' }}
                </el-descriptions-item>
                <el-descriptions-item label="MySQL 版本">
                  {{ precheckResult.target.version || '-' }}
                </el-descriptions-item>
                <el-descriptions-item label="目标库">
                  {{ precheckResult.target.host }}:{{ precheckResult.target.port }} / {{ precheckResult.target.database }}
                </el-descriptions-item>
                <el-descriptions-item label="数据库已存在">
                  {{ precheckResult.target.databaseExists ? '是' : '否' }}
                </el-descriptions-item>
                <el-descriptions-item label="目标表结构状态">
                  {{
                    precheckResult.target.schemaReady
                      ? '已齐全'
                      : precheckResult.target.needsSchemaInitialization
                        ? '缺表，可由迁移任务初始化'
                        : '待确认'
                  }}
                </el-descriptions-item>
                <el-descriptions-item label="目标业务表">
                  {{ formatTableSummary(precheckResult.target.existingAppTables) }}
                </el-descriptions-item>
              </el-descriptions>

              <div class="space-y-2">
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">预检问题</div>
                <div class="flex flex-wrap gap-2">
                  <el-tag
                    v-for="issue in precheckResult.issues"
                    :key="`${issue.level}-${issue.code}-${issue.message}`"
                    :type="getIssueTagType(issue.level)"
                    effect="light"
                  >
                    {{ issue.code }}
                  </el-tag>
                  <span v-if="precheckResult.issues.length === 0" class="text-sm text-slate-500 dark:text-slate-400">
                    未发现额外风险项
                  </span>
                </div>
                <div
                  v-if="precheckResult.source.missingTables.length || precheckResult.target.missingAppTables.length"
                  class="grid gap-3 md:grid-cols-2"
                >
                  <el-alert
                    v-if="precheckResult.source.missingTables.length"
                    :title="`SQLite 缺少业务表：${precheckResult.source.missingTables.join('、')}`"
                    type="error"
                    :closable="false"
                    show-icon
                  />
                  <el-alert
                    v-if="precheckResult.target.missingAppTables.length"
                    :title="`目标 MySQL 缺少业务表：${precheckResult.target.missingAppTables.join('、')}`"
                    :type="precheckResult.target.schemaReady ? 'success' : 'info'"
                    :closable="false"
                    show-icon
                  />
                </div>
                <div class="space-y-2">
                  <el-alert
                    v-for="issue in precheckResult.issues"
                    :key="`${issue.code}-${issue.message}`"
                    :title="issue.message"
                    :type="issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warning' : 'info'"
                    :closable="false"
                    show-icon
                  />
                </div>
              </div>
            </div>
            <el-empty v-else description="尚未执行预检，请先填写目标 MySQL 信息并点击“执行预检”" />
          </section>
        </div>
      </div>

      <section v-if="canViewMigration" class="apple-card space-y-5 p-5 sm:p-6">
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
          <div>
            <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">迁移任务</h2>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
              列表展示所有迁移任务，点击某一行可查看任务详情、迁移进度、最终结果，并支持切换到已成功任务。
            </p>
          </div>
          <div class="text-sm text-slate-500 dark:text-slate-400">
            共 {{ taskList.length }} 条任务记录
          </div>
        </div>

        <div class="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
          <div class="min-w-0">
            <el-table
              :data="taskList"
              stripe
              border
              table-layout="auto"
              empty-text="暂无迁移任务"
              @row-click="handleSelectTask"
            >
              <el-table-column label="任务 ID" min-width="220" show-overflow-tooltip>
                <template #default="{ row }">
                  <span class="font-mono text-xs">{{ row.id }}</span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100" align="center">
                <template #default="{ row }">
                  <el-tag :type="getTaskStatusTagType(row.status)" effect="light">
                    {{ getTaskStatusLabel(row.status) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="当前阶段" min-width="220" show-overflow-tooltip>
                <template #default="{ row }">{{ row.progress.currentStage || '-' }}</template>
              </el-table-column>
              <el-table-column label="目标库" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">{{ row.target.host }}:{{ row.target.port }}/{{ row.target.database }}</template>
              </el-table-column>
              <el-table-column label="更新时间" min-width="168">
                <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" min-width="220" fixed="right">
                <template #default="{ row }">
                  <div class="flex flex-wrap gap-2">
                    <el-button
                      size="small"
                      type="primary"
                      :loading="taskRunningId === row.id"
                      :disabled="!canOperateMigration || row.status === 'running' || row.status === 'succeeded'"
                      @click.stop="handleRunTask(row)"
                    >
                      执行
                    </el-button>
                    <el-button
                      size="small"
                      type="success"
                      plain
                      :loading="switchingTaskId === row.id"
                      :disabled="!canOperateMigration || row.status !== 'succeeded'"
                      @click.stop="handleSwitchToTask(row)"
                    >
                      切换
                    </el-button>
                    <el-button size="small" @click.stop="handleSelectTask(row)">详情</el-button>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-slate-900/20">
            <template v-if="selectedTask">
              <div class="border-b border-slate-200/80 pb-4 dark:border-white/10">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">任务详情</h3>
                    <div class="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">{{ selectedTask.id }}</div>
                  </div>
                  <el-tag :type="getTaskStatusTagType(selectedTask.status)" effect="light">
                    {{ getTaskStatusLabel(selectedTask.status) }}
                  </el-tag>
                </div>
              </div>

              <div class="mt-4 space-y-4">
                <el-progress
                  :percentage="selectedTaskProgressPercent"
                  :status="selectedTask.status === 'failed' ? 'exception' : selectedTask.status === 'succeeded' ? 'success' : undefined"
                />

                <el-descriptions :column="1" border>
                  <el-descriptions-item label="当前阶段">
                    {{ selectedTask.progress.currentStage || '-' }}
                  </el-descriptions-item>
                  <el-descriptions-item label="SQLite 源路径">
                    {{ selectedTask.source.sqlitePath }}
                  </el-descriptions-item>
                  <el-descriptions-item label="目标 MySQL">
                    {{ selectedTask.target.host }}:{{ selectedTask.target.port }}/{{ selectedTask.target.database }}
                  </el-descriptions-item>
                  <el-descriptions-item label="创建时间">
                    {{ formatDateTime(selectedTask.createdAt) }}
                  </el-descriptions-item>
                  <el-descriptions-item label="开始时间">
                    {{ formatDateTime(selectedTask.startedAt) }}
                  </el-descriptions-item>
                  <el-descriptions-item label="完成时间">
                    {{ formatDateTime(selectedTask.finishedAt) }}
                  </el-descriptions-item>
                  <el-descriptions-item label="备注">
                    {{ selectedTask.note || '-' }}
                  </el-descriptions-item>
                  <el-descriptions-item label="执行选项">
                    <div class="flex flex-wrap gap-2">
                      <el-tag :type="selectedTask.options.initializeSchema ? 'success' : 'info'" effect="light">
                        {{ selectedTask.options.initializeSchema ? '初始化表结构' : '不初始化表结构' }}
                      </el-tag>
                      <el-tag :type="selectedTask.options.clearTargetBeforeImport ? 'warning' : 'info'" effect="light">
                        {{ selectedTask.options.clearTargetBeforeImport ? '导入前清空目标表' : '保留目标表原数据' }}
                      </el-tag>
                      <el-tag :type="selectedTask.options.createSqliteBackup ? 'success' : 'info'" effect="light">
                        {{ selectedTask.options.createSqliteBackup ? '执行前备份 SQLite' : '不创建 SQLite 备份' }}
                      </el-tag>
                      <el-tag :type="selectedTask.options.switchAfterSuccess ? 'warning' : 'info'" effect="light">
                        {{ selectedTask.options.switchAfterSuccess ? '成功后自动切换' : '成功后不自动切换' }}
                      </el-tag>
                    </div>
                  </el-descriptions-item>
                  <el-descriptions-item label="SQLite 备份文件">
                    {{ selectedTask.backupFile?.filePath || '-' }}
                  </el-descriptions-item>
                  <el-descriptions-item label="JSON 快照文件">
                    {{ selectedTask.jsonSnapshotFile?.filePath || '-' }}
                  </el-descriptions-item>
                  <el-descriptions-item label="失败原因">
                    {{ selectedTask.errorMessage || '-' }}
                  </el-descriptions-item>
                </el-descriptions>

                <div class="space-y-2">
                  <div class="text-sm font-medium text-slate-700 dark:text-slate-200">迁移表结果</div>
                  <el-table :data="selectedTask.result?.importedTables || selectedTask.progress.tableResults" size="small" border empty-text="暂无表级结果">
                    <el-table-column label="表名" prop="tableName" min-width="150" show-overflow-tooltip />
                    <el-table-column label="行数" prop="rowCount" width="100" align="right" />
                  </el-table>
                </div>

                <el-alert
                  v-if="selectedTask.result"
                  :title="`共导入 ${selectedTask.result.importedRows} 行数据，自动切换状态：${selectedTask.result.runtimeOverrideApplied ? '已写入 MySQL 覆盖配置' : '未自动切换'}`"
                  :type="selectedTask.status === 'succeeded' ? 'success' : 'info'"
                  :closable="false"
                  show-icon
                />

                <div v-if="selectedTask.result?.validation" class="space-y-2">
                  <div class="text-sm font-medium text-slate-700 dark:text-slate-200">迁后校验结果</div>
                  <el-alert
                    :title="selectedTask.result.validation.passed ? '迁后关键数据校验通过' : '迁后关键数据校验未通过'"
                    :description="`源库 ${selectedTask.result.validation.sourceTotalRows} 行，目标库 ${selectedTask.result.validation.targetTotalRows} 行；校验时间：${formatDateTime(selectedTask.result.validation.checkedAt)}`"
                    :type="selectedTask.result.validation.passed ? 'success' : 'error'"
                    :closable="false"
                    show-icon
                  />
                  <el-table :data="selectedTask.result.validation.items" size="small" border max-height="240">
                    <el-table-column label="表名" prop="tableName" min-width="150" show-overflow-tooltip />
                    <el-table-column label="源行数" prop="sourceRowCount" width="96" align="right" />
                    <el-table-column label="目标行数" prop="targetRowCount" width="96" align="right" />
                    <el-table-column label="关键表" width="88" align="center">
                      <template #default="{ row }">
                        <el-tag :type="row.blocking ? 'danger' : 'info'" effect="light">
                          {{ row.blocking ? '是' : '否' }}
                        </el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column label="结果" width="88" align="center">
                      <template #default="{ row }">
                        <el-tag :type="row.matched ? 'success' : 'danger'" effect="light">
                          {{ row.matched ? '一致' : '异常' }}
                        </el-tag>
                      </template>
                    </el-table-column>
                  </el-table>
                </div>
              </div>
            </template>
            <el-empty v-else description="点击左侧任务行后，可在这里查看迁移详情" />
          </div>
        </div>
      </section>
    </div>
  </PageContainer>
</template>
