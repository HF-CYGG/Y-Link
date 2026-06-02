<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  createClientStaffDirectoryRecord,
  getClientStaffDirectoryList,
  importClientStaffDirectory,
  updateClientStaffDirectoryRecord,
  updateClientStaffDirectoryStatus,
  type ClientStaffDirectoryRecord,
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

const queryForm = reactive<{
  keyword: string
  status: '' | ClientStaffDirectoryStatus
  page: number
  pageSize: number
}>({
  keyword: '',
  status: '',
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
const importFormRef = ref<FormInstance>()
const importForm = reactive({
  rawText: '',
})

const dialogTitle = computed(() => (dialogMode.value === 'create' ? '新增教职工目录记录' : '编辑教职工目录记录'))
const actionDisabled = computed(() => props.loading || listLoading.value)

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
  const normalized = value.trim().replaceAll(/\s+/g, ' ')
  if (!normalized) {
    callback(new Error('请输入真实姓名'))
    return
  }
  if (!/^[\u4e00-\u9fa5][\u4e00-\u9fa5·\s]{1,19}$/.test(normalized)) {
    callback(new Error('姓名必须为2-20位中文，可包含空格或·'))
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

const importRules: FormRules = {
  rawText: [{ required: true, message: '请粘贴至少一条目录记录', trigger: 'blur' }],
}

const getStatusTagType = (status: ClientStaffDirectoryStatus) => (status === 'active' ? 'success' : 'info')
const getStatusLabel = (status: ClientStaffDirectoryStatus) => (status === 'active' ? '启用中' : '已停用')

const resetDialogForm = () => {
  editingRecordId.value = ''
  dialogForm.staffNo = ''
  dialogForm.realName = ''
  dialogForm.departmentName = ''
  dialogForm.status = 'active'
  dialogFormRef.value?.clearValidate()
}

const resetImportForm = () => {
  importForm.rawText = ''
  importFormRef.value?.clearValidate()
}

const loadList = async () => {
  listLoading.value = true
  try {
    const result = await getClientStaffDirectoryList({
      page: queryForm.page,
      pageSize: queryForm.pageSize,
      keyword: queryForm.keyword.trim() || undefined,
      status: queryForm.status || undefined,
    })
    records.value = result.list
    total.value = result.total
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

const handleSubmitImport = async () => {
  if (!props.canUpdateConfigs) {
    return
  }
  const valid = await importFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }
  importSubmitting.value = true
  try {
    const result = await importClientStaffDirectory({
      rawText: importForm.rawText,
    })
    ElMessage.success(
      `导入完成：新增 ${result.summary.created} 条，更新 ${result.summary.updated} 条，跳过 ${result.summary.skipped} 条`,
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
      </div>
      <div class="flex flex-wrap items-center gap-2">
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
      <el-button type="primary" :loading="listLoading" @click="handleSearch">搜索</el-button>
      <el-button :disabled="listLoading" @click="handleReset">重置</el-button>
    </div>

    <el-alert
      class="mt-4"
      type="info"
      :closable="false"
      show-icon
      title="导入格式"
      description="支持粘贴多行文本，每行一条记录。列顺序为：工号, 姓名, 所属部门，支持英文逗号、中文逗号或 Tab 分隔。示例：HY1001,张老师,海右书院。"
    />

    <el-table
      class="mt-4"
      :data="records"
      border
      stripe
      table-layout="auto"
      v-loading="listLoading"
      empty-text="暂无教职工目录数据"
    >
      <el-table-column prop="staffNo" label="教职工号" min-width="140" />
      <el-table-column prop="realName" label="真实姓名" min-width="120" />
      <el-table-column prop="departmentName" label="所属部门" min-width="180" show-overflow-tooltip />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="getStatusTagType(row.status)" effect="light">{{ getStatusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="已绑定部门账号" width="130" align="center">
        <template #default="{ row }">{{ row.linkedClientUserCount }}</template>
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

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="560px" destroy-on-close @closed="resetDialogForm">
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

    <el-dialog v-model="importVisible" title="批量导入教职工目录" width="680px" destroy-on-close @closed="resetImportForm">
      <el-form ref="importFormRef" :model="importForm" :rules="importRules" label-position="top">
        <el-form-item label="目录文本" prop="rawText">
          <el-input
            v-model="importForm.rawText"
            type="textarea"
            :rows="12"
            placeholder="示例：&#10;HY1001,张老师,海右书院&#10;HY1002,李老师,海右书院"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="flex justify-end gap-3">
          <el-button @click="importVisible = false">取消</el-button>
          <el-button type="primary" :loading="importSubmitting" @click="handleSubmitImport">开始导入</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>
