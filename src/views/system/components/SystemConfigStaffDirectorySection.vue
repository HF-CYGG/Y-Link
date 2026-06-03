<!--
  文件说明：系统配置页中的教职工目录维护面板，负责目录查询、单条维护以及 txt/xlsx 拖拽导入预览入口。
  实现逻辑：
  1. 统一承接目录列表筛选、分页与启停操作，保证管理员维护入口集中在同一块配置面板内；
  2. 新增与编辑共用同一套表单校验规则，避免教职工号、实名和部门字段出现口径不一致；
  3. 批量导入支持拖拽/选择 txt、xlsx 或直接粘贴文本，先请求后端生成预览，再由管理员确认后正式入库。
-->
<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type TableInstance, type UploadFile, type UploadInstance } from 'element-plus'
import {
  createClientStaffDirectoryRecord,
  deleteClientStaffDirectoryBatch,
  getClientStaffDirectoryList,
  importClientStaffDirectory,
  previewClientStaffDirectoryImport,
  previewClientStaffDirectoryImportFile,
  updateClientStaffDirectoryRecord,
  updateClientStaffDirectoryStatus,
  type ImportClientStaffDirectoryPreviewResult,
  type ImportClientStaffDirectoryPreviewRow,
  type ClientStaffDirectoryRecord,
  type ClientStaffDirectoryRegistrationStatus,
  type ClientStaffDirectoryStatus,
} from '@/api/modules/system-config'
import { extractErrorMessage } from '@/utils/error'

const props = defineProps<{
  canUpdateConfigs: boolean
  loading: boolean
}>()

type StaffDirectoryDialogMode = 'create' | 'edit'

const listLoading = ref(false)
const records = ref<ClientStaffDirectoryRecord[]>([])
const total = ref(0)
const tableRef = ref<TableInstance>()
const selectedRecords = ref<ClientStaffDirectoryRecord[]>([])

const queryForm = reactive<{
  keyword: string
  status: '' | ClientStaffDirectoryStatus
  registrationStatus: '' | ClientStaffDirectoryRegistrationStatus
  page: number
  pageSize: number
}>({
  keyword: '',
  status: '',
  registrationStatus: '',
  page: 1,
  pageSize: 10,
})

const dialogVisible = ref(false)
const dialogSubmitting = ref(false)
const dialogMode = ref<StaffDirectoryDialogMode>('create')
const dialogFormRef = ref<FormInstance>()
const editingRecordId = ref('')
const dialogForm = reactive({
  staffNo: '',
  realName: '',
  departmentName: '',
  status: 'active' as ClientStaffDirectoryStatus,
})

const importVisible = ref(false)
const importSubmitting = ref(false)
const importPreviewLoading = ref(false)
const importFormRef = ref<FormInstance>()
const importUploadRef = ref<UploadInstance>()
const selectedImportFile = ref<File | null>(null)
const importPreviewResult = ref<ImportClientStaffDirectoryPreviewResult | null>(null)
const importForm = reactive({
  rawText: '',
})
const STAFF_DIRECTORY_IMPORT_FILE_ACCEPT = '.txt,.xlsx'
const STAFF_DIRECTORY_IMPORT_MAX_FILE_SIZE = 8 * 1024 * 1024

const dialogTitle = computed(() => (dialogMode.value === 'create' ? '新增教职工目录记录' : '编辑教职工目录记录'))
const actionDisabled = computed(() => props.loading || listLoading.value)
const hasImportPreview = computed(() => Boolean(importPreviewResult.value?.rows.length))
const selectedRecordCount = computed(() => selectedRecords.value.length)
const selectedRegisteredStaffAccountCount = computed(() => {
  return selectedRecords.value.reduce((count, item) => count + (item.isRegistered ? 1 : 0), 0)
})

const staffNoRule = (_rule: unknown, value: string, callback: (error?: Error) => void) => {
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
}

const realNameRule = (_rule: unknown, value: string, callback: (error?: Error) => void) => {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replaceAll('　', ' ')
    .replace(/[•・･‧∙⋅·﹒]/g, '·')
    .trim()
    .replaceAll(/\s+/g, ' ')
  if (!normalized) {
    callback(new Error('请输入真实姓名'))
    return
  }
  if (!/^[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z·\s()'’-]{1,39}$/u.test(normalized)) {
    callback(new Error('姓名长度需为2-40位，支持中文、英文、空格、·、括号和短横线'))
    return
  }
  callback()
}

const rules: FormRules = {
  staffNo: [{ validator: staffNoRule, trigger: 'blur' }],
  realName: [{ validator: realNameRule, trigger: 'blur' }],
  departmentName: [
    { required: true, message: '请输入所属部门', trigger: 'blur' },
    { min: 1, max: 128, message: '所属部门长度需在1-128个字符内', trigger: 'blur' },
  ],
}

const getStatusTagType = (status: ClientStaffDirectoryStatus) => (status === 'active' ? 'success' : 'info')
const getStatusLabel = (status: ClientStaffDirectoryStatus) => (status === 'active' ? '启用中' : '已停用')
const getImportActionTagType = (action: ImportClientStaffDirectoryPreviewRow['action']) => {
  if (action === 'create') {
    return 'success'
  }
  if (action === 'update') {
    return 'warning'
  }
  return 'info'
}
const getImportActionLabel = (action: ImportClientStaffDirectoryPreviewRow['action']) => {
  if (action === 'create') {
    return '新增'
  }
  if (action === 'update') {
    return '更新'
  }
  return '跳过'
}

const resetDialogForm = () => {
  editingRecordId.value = ''
  dialogForm.staffNo = ''
  dialogForm.realName = ''
  dialogForm.departmentName = ''
  dialogForm.status = 'active'
  dialogFormRef.value?.clearValidate()
}

const resetImportPreview = () => {
  importPreviewResult.value = null
}

const resetImportForm = () => {
  importForm.rawText = ''
  resetImportPreview()
  selectedImportFile.value = null
  importUploadRef.value?.clearFiles()
  importFormRef.value?.clearValidate()
}

const clearSelectedImportFile = () => {
  resetImportPreview()
  selectedImportFile.value = null
  importUploadRef.value?.clearFiles()
}

const applySelectedImportFile = (file: File) => {
  if (!/\.(txt|xlsx)$/i.test(file.name)) {
    ElMessage.warning('仅支持上传 txt 或 xlsx 文件')
    return false
  }
  if (file.size > STAFF_DIRECTORY_IMPORT_MAX_FILE_SIZE) {
    ElMessage.warning('导入文件不能超过 8 MB')
    return false
  }
  resetImportPreview()
  selectedImportFile.value = file
  importFormRef.value?.clearValidate()
  return true
}

const handleImportUploadChange = (uploadFile: UploadFile) => {
  const rawFile = uploadFile.raw
  importUploadRef.value?.clearFiles()
  if (!(rawFile instanceof File)) {
    clearSelectedImportFile()
    return
  }
  if (!applySelectedImportFile(rawFile)) {
    clearSelectedImportFile()
  }
}

const buildConfirmedImportRows = (rows: ImportClientStaffDirectoryPreviewRow[]) => {
  return rows.map((item) => ({
    staffNo: item.staffNo,
    realName: item.realName,
    departmentName: item.departmentName,
    status: item.status,
  }))
}

const handleGenerateImportPreview = async () => {
  if (!props.canUpdateConfigs) {
    return
  }
  if (!selectedImportFile.value && !importForm.rawText.trim()) {
    ElMessage.warning('请先拖拽/选择 txt/xlsx 文件，或粘贴至少一条目录记录')
    return
  }
  importPreviewLoading.value = true
  try {
    const result = selectedImportFile.value
      ? await previewClientStaffDirectoryImportFile(selectedImportFile.value)
      : await previewClientStaffDirectoryImport({
          rawText: importForm.rawText,
        })
    importPreviewResult.value = result
    ElMessage.success('识别完成，请核对预览结果后再确认导入')
  } catch (error) {
    resetImportPreview()
    ElMessage.error(extractErrorMessage(error, '生成导入预览失败'))
  } finally {
    importPreviewLoading.value = false
  }
}

const loadList = async () => {
  listLoading.value = true
  try {
    const result = await getClientStaffDirectoryList({
      page: queryForm.page,
      pageSize: queryForm.pageSize,
      keyword: queryForm.keyword.trim() || undefined,
      status: queryForm.status || undefined,
      registrationStatus: queryForm.registrationStatus || undefined,
    })
    records.value = result.list
    total.value = result.total
    selectedRecords.value = []
    await nextTick()
    tableRef.value?.clearSelection()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '加载教职工目录失败，请稍后重试'))
  } finally {
    listLoading.value = false
  }
}

const handleSearch = () => {
  queryForm.page = 1
  void loadList()
}

const handleReset = () => {
  queryForm.keyword = ''
  queryForm.status = ''
  queryForm.registrationStatus = ''
  queryForm.page = 1
  queryForm.pageSize = 10
  void loadList()
}

const handleOpenCreate = () => {
  dialogMode.value = 'create'
  resetDialogForm()
  dialogVisible.value = true
}

const handleOpenEdit = (record: ClientStaffDirectoryRecord) => {
  dialogMode.value = 'edit'
  editingRecordId.value = record.id
  dialogForm.staffNo = record.staffNo
  dialogForm.realName = record.realName
  dialogForm.departmentName = record.departmentName
  dialogForm.status = record.status
  dialogVisible.value = true
}

const handleSubmitDialog = async () => {
  if (!props.canUpdateConfigs) {
    return
  }
  const valid = await dialogFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }
  dialogSubmitting.value = true
  try {
    if (dialogMode.value === 'create') {
      await createClientStaffDirectoryRecord({
        staffNo: dialogForm.staffNo.trim(),
        realName: dialogForm.realName.trim(),
        departmentName: dialogForm.departmentName.trim(),
        status: dialogForm.status,
      })
      ElMessage.success('教职工目录记录已新增')
    } else {
      await updateClientStaffDirectoryRecord(editingRecordId.value, {
        staffNo: dialogForm.staffNo.trim(),
        realName: dialogForm.realName.trim(),
        departmentName: dialogForm.departmentName.trim(),
      })
      ElMessage.success('教职工目录记录已更新')
    }
    dialogVisible.value = false
    resetDialogForm()
    void loadList()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '保存教职工目录记录失败'))
  } finally {
    dialogSubmitting.value = false
  }
}

const handleToggleStatus = async (record: ClientStaffDirectoryRecord) => {
  if (!props.canUpdateConfigs) {
    return
  }
  const nextStatus: ClientStaffDirectoryStatus = record.status === 'active' ? 'inactive' : 'active'
  const actionLabel = nextStatus === 'active' ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(`确认${actionLabel}教职工号 ${record.staffNo} 吗？`, `${actionLabel}确认`, {
      type: 'warning',
      confirmButtonText: `确认${actionLabel}`,
      cancelButtonText: '取消',
    })
    await updateClientStaffDirectoryStatus(record.id, nextStatus)
    ElMessage.success(`已${actionLabel}教职工目录记录`)
    void loadList()
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error(extractErrorMessage(error, `${actionLabel}教职工目录记录失败`))
  }
}

const handleSelectionChange = (value: ClientStaffDirectoryRecord[]) => {
  selectedRecords.value = value
}

const handleBatchDelete = async () => {
  if (!props.canUpdateConfigs || selectedRecords.value.length === 0) {
    return
  }
  const selectedIds = selectedRecords.value.map((item) => item.id)
  const linkedDepartmentAccountCount = selectedRegisteredStaffAccountCount.value
  const linkedDepartmentAccountText = linkedDepartmentAccountCount > 0
    ? `，其中会影响 ${linkedDepartmentAccountCount} 个已注册部门账号的工号校验状态`
    : ''

  try {
    await ElMessageBox.confirm(
      `确认批量删除已选中的 ${selectedIds.length} 条教职工目录记录吗？${linkedDepartmentAccountText}`,
      '批量删除确认',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
      },
    )
    const result = await deleteClientStaffDirectoryBatch({ ids: selectedIds })
    const linkedDepartmentAccountSummary = result.summary.linkedDepartmentAccounts > 0
      ? `，同步回收 ${result.summary.linkedDepartmentAccounts} 个已注册部门账号的工号校验`
      : ''
    ElMessage.success(`已删除 ${result.summary.deleted} 条教职工目录记录${linkedDepartmentAccountSummary}`)
    if (records.value.length === selectedIds.length && queryForm.page > 1) {
      queryForm.page -= 1
    }
    void loadList()
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error(extractErrorMessage(error, '批量删除教职工目录记录失败'))
  }
}

const handleSubmitImport = async () => {
  if (!props.canUpdateConfigs) {
    return
  }
  if (!importPreviewResult.value || importPreviewResult.value.rows.length === 0) {
    ElMessage.warning('请先生成导入预览，并确认识别结果无误后再导入')
    return
  }
  importSubmitting.value = true
  try {
    const result = await importClientStaffDirectory({
      rows: buildConfirmedImportRows(importPreviewResult.value.rows),
    })
    const autoCreatedDepartmentText = result.summary.autoCreatedDepartments.length > 0
      ? `，自动补齐部门 ${result.summary.autoCreatedDepartments.length} 个`
      : ''
    ElMessage.success(
      `导入完成：新增 ${result.summary.created} 条，更新 ${result.summary.updated} 条，跳过 ${result.summary.skipped} 条${autoCreatedDepartmentText}`,
    )
    importVisible.value = false
    resetImportForm()
    queryForm.page = 1
    void loadList()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '导入教职工目录失败'))
  } finally {
    importSubmitting.value = false
  }
}

watch(
  () => importForm.rawText,
  (value, previousValue) => {
    if (value === previousValue) {
      return
    }
    if (importPreviewResult.value) {
      resetImportPreview()
    }
  },
)

onMounted(() => {
  void loadList()
})
</script>

<template>
  <div class="rounded-2xl border border-slate-200/80 bg-white/90 p-4 shadow-sm dark:border-white/10 dark:bg-slate-950/40">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">教职工工号库</h3>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          用于部门账号注册时校验工号，并自动回填实名与所属部门。目录变更会同步影响已绑定的部门账号校验状态。
        </p>
        <p class="mt-1 text-xs text-slate-400 dark:text-slate-500">
          是否已注册：每个教职工号最多只能对应一个部门账户，用于判断该工号是否已被注册使用。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <el-button
          type="danger"
          plain
          :disabled="actionDisabled || !canUpdateConfigs || selectedRecordCount === 0"
          @click="handleBatchDelete"
        >
          批量删除<span v-if="selectedRecordCount > 0">（{{ selectedRecordCount }}）</span>
        </el-button>
        <el-button :disabled="actionDisabled || !canUpdateConfigs" @click="importVisible = true">批量导入</el-button>
        <el-button type="primary" :disabled="actionDisabled || !canUpdateConfigs" @click="handleOpenCreate">新增记录</el-button>
      </div>
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <el-input
        v-model="queryForm.keyword"
        placeholder="搜索工号、姓名或部门"
        clearable
        class="!w-[280px]"
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-select v-model="queryForm.status" clearable placeholder="全部状态" class="!w-[160px]" @change="handleSearch">
        <el-option label="启用中" value="active" />
        <el-option label="已停用" value="inactive" />
      </el-select>
      <el-select
        v-model="queryForm.registrationStatus"
        clearable
        placeholder="全部注册状态"
        class="!w-[180px]"
        @change="handleSearch"
      >
        <el-option label="已注册" value="registered" />
        <el-option label="未注册" value="unregistered" />
      </el-select>
      <el-button type="primary" :loading="listLoading" @click="handleSearch">搜索</el-button>
      <el-button :disabled="listLoading" @click="handleReset">重置</el-button>
    </div>

    <el-alert
      class="mt-4"
      type="info"
      :closable="false"
      show-icon
      title="导入格式"
      description="支持上传 txt、xlsx 文件，也支持粘贴多行文本。列顺序优先按：姓名, 工号, 所属部门 解析，也兼容旧格式“工号, 姓名, 所属部门”；支持英文逗号、中文逗号或 Tab 分隔。若部门尚未在系统配置中维护，导入时会自动补齐。"
    />

    <el-table
      ref="tableRef"
      class="mt-4"
      :data="records"
      row-key="id"
      border
      stripe
      table-layout="auto"
      v-loading="listLoading"
      empty-text="暂无教职工目录数据"
      @selection-change="handleSelectionChange"
    >
      <el-table-column v-if="canUpdateConfigs" type="selection" width="52" align="center" />
      <el-table-column prop="staffNo" label="教职工号" min-width="140" />
      <el-table-column prop="realName" label="真实姓名" min-width="120" />
      <el-table-column prop="departmentName" label="所属部门" min-width="180" show-overflow-tooltip />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="getStatusTagType(row.status)" effect="light">{{ getStatusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column width="130" align="center">
        <template #header>
          <div class="flex items-center justify-center gap-1">
            <span>是否已注册</span>
            <el-tooltip
              content="指当前教职工号是否已有部门账户注册使用。若停用或删除该记录，对应部门账户会失去工号校验通过状态。"
              placement="top"
            >
              <span class="cursor-help text-slate-400">?</span>
            </el-tooltip>
          </div>
        </template>
        <template #default="{ row }">
          <el-tag :type="row.isRegistered ? 'success' : 'info'" effect="light">
            {{ row.isRegistered ? '已注册' : '未注册' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" min-width="170">
        <template #default="{ row }">{{ dayjs(row.updatedAt).format('YYYY-MM-DD HH:mm:ss') }}</template>
      </el-table-column>
      <el-table-column v-if="canUpdateConfigs" label="操作" fixed="right" width="180" align="right">
        <template #default="{ row }">
          <div class="flex items-center justify-end gap-3">
            <el-button link type="primary" :disabled="actionDisabled" @click="handleOpenEdit(row)">编辑</el-button>
            <el-button
              link
              :type="row.status === 'active' ? 'warning' : 'success'"
              :disabled="actionDisabled"
              @click="handleToggleStatus(row)"
            >
              {{ row.status === 'active' ? '停用' : '启用' }}
            </el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="total > 0" class="mt-4 flex justify-end">
      <el-pagination
        v-model:current-page="queryForm.page"
        v-model:page-size="queryForm.pageSize"
        layout="total, sizes, prev, pager, next"
        :page-sizes="[10, 20, 50]"
        :total="total"
        @current-change="loadList"
        @size-change="handleSearch"
      />
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="560px"
      destroy-on-close
      append-to-body
      :modal-append-to-body="true"
      align-center
      @closed="resetDialogForm"
    >
      <el-form ref="dialogFormRef" :model="dialogForm" :rules="rules" label-position="top">
        <el-form-item label="教职工号" prop="staffNo">
          <el-input v-model.trim="dialogForm.staffNo" placeholder="请输入教职工号" />
        </el-form-item>
        <el-form-item label="真实姓名" prop="realName">
          <el-input v-model.trim="dialogForm.realName" placeholder="请输入真实姓名" />
        </el-form-item>
        <el-form-item label="所属部门" prop="departmentName">
          <el-input v-model.trim="dialogForm.departmentName" placeholder="请输入所属部门" />
        </el-form-item>
        <el-form-item v-if="dialogMode === 'create'" label="初始状态" prop="status">
          <el-select v-model="dialogForm.status" class="w-full">
            <el-option label="启用中" value="active" />
            <el-option label="已停用" value="inactive" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex justify-end gap-3">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="dialogSubmitting" @click="handleSubmitDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="importVisible"
      title="批量导入教职工目录"
      width="820px"
      destroy-on-close
      append-to-body
      :modal-append-to-body="true"
      align-center
      @closed="resetImportForm"
    >
      <el-form ref="importFormRef" :model="importForm" label-position="top">
        <el-form-item label="上传导入文件">
          <el-upload
            ref="importUploadRef"
            class="w-full"
            drag
            action=""
            :auto-upload="false"
            :show-file-list="false"
            :accept="STAFF_DIRECTORY_IMPORT_FILE_ACCEPT"
            @change="handleImportUploadChange"
          >
            <div class="py-3">
              <p class="text-base font-medium text-slate-700">将 txt / xlsx 文件拖到此处，或点击选择文件</p>
              <p class="mt-2 text-sm text-slate-500">系统会先自动识别内容并生成预览，确认无误后才会正式导入。</p>
            </div>
          </el-upload>
          <div v-if="selectedImportFile" class="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <span>已选择：{{ selectedImportFile.name }}</span>
            <span>大小：{{ Math.max(1, Math.round(selectedImportFile.size / 1024)) }} KB</span>
            <el-button link type="danger" @click="clearSelectedImportFile">移除文件</el-button>
          </div>
        </el-form-item>
        <el-form-item label="目录文本（可选兜底）" prop="rawText">
          <el-input
            v-model="importForm.rawText"
            type="textarea"
            :rows="12"
            placeholder="未上传文件时，可直接粘贴文本。示例：&#10;张老师,HY1001,海右书院&#10;李老师,HY1002,海右书院"
          />
        </el-form-item>
        <div v-if="importPreviewResult" class="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
          <div class="flex flex-wrap items-center gap-2">
            <el-tag type="primary">共识别 {{ importPreviewResult.summary.total }} 条</el-tag>
            <el-tag type="success">待新增 {{ importPreviewResult.summary.creatable }} 条</el-tag>
            <el-tag type="warning">待更新 {{ importPreviewResult.summary.updatable }} 条</el-tag>
            <el-tag type="info">将跳过 {{ importPreviewResult.summary.skippable }} 条</el-tag>
          </div>
          <el-alert
            v-if="importPreviewResult.summary.autoCreatedDepartments.length > 0"
            class="mt-3"
            type="warning"
            :closable="false"
            show-icon
            :title="`确认导入后将自动补齐部门：${importPreviewResult.summary.autoCreatedDepartments.join('、')}`"
          />
          <el-table
            class="mt-3"
            :data="importPreviewResult.rows"
            border
            stripe
            table-layout="auto"
            max-height="320"
            empty-text="暂无可导入记录"
          >
            <el-table-column label="处理结果" width="110">
              <template #default="{ row }">
                <el-tag :type="getImportActionTagType(row.action)" effect="light">
                  {{ getImportActionLabel(row.action) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="staffNo" label="教职工号" min-width="130" />
            <el-table-column prop="realName" label="真实姓名" min-width="110" />
            <el-table-column prop="departmentName" label="所属部门" min-width="180" show-overflow-tooltip />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="getStatusTagType(row.status)" effect="light">{{ getStatusLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-form>
      <template #footer>
        <div class="flex justify-end gap-3">
          <el-button @click="importVisible = false">取消</el-button>
          <el-button type="primary" plain :loading="importPreviewLoading" @click="handleGenerateImportPreview">识别并预览</el-button>
          <el-button type="primary" :disabled="!hasImportPreview" :loading="importSubmitting" @click="handleSubmitImport">确认导入</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>
