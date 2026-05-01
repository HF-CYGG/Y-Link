<script setup lang="ts">
/**
 * 模块说明：src/views/system/ClientUserManageView.vue
 * 文件职责：管理端对客户端用户进行查询、启停与密码重置。
 * 维护说明：
 * - 客户端用户与管理端用户分开治理，避免字段语义和操作入口混淆；
 * - 当前不提供手动新增客户端用户，客户端账号仍以用户自助注册为主。
 */

import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { BizCrudDialogShell, BizResponsiveDataCollectionShell, PageContainer, PagePaginationBar, PageToolbarCard } from '@/components/common'
import {
  getClientUserList,
  resetClientUserPassword,
  updateClientUser,
  updateClientUserStatus,
  type ClientUserManageProfile,
  type ClientUserStatus,
  type ResetClientUserPasswordPayload,
  type ClientUserListQuery,
  type UpdateClientUserPayload,
} from '@/api/modules/client-user-manage'
import { getClientDepartmentConfigs } from '@/api/modules/system-config'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { showPermissionDenied } from '@/utils/permission'

const authStore = useAuthStore()
const listRequest = useStableRequest()

const searchForm = reactive({
  keyword: '',
  status: '' as '' | ClientUserStatus,
})

const listState = reactive(
  createPaginatedListState<ClientUserManageProfile>({
    loading: true,
    query: {
      pageSize: 10,
    },
  }),
)

const canViewUsers = computed(() => authStore.hasPermission('users:view'))
const canEditUser = computed(() => authStore.hasPermission('users:update'))
const canToggleUser = computed(() => authStore.hasPermission('users:status'))
const canResetUserPassword = computed(() => authStore.hasPermission('users:reset_password'))
const canOperateUsers = computed(() => canEditUser.value || canToggleUser.value || canResetUserPassword.value)
const departmentOptions = ref<string[]>([])
const departmentPathLookup = ref<Record<string, string>>({})
const departmentOptionsLoading = ref(false)

const editVisible = ref(false)
const editSubmitting = ref(false)
const editFormRef = ref<FormInstance>()
const editForm = reactive({
  id: '',
  username: '',
  mobile: '',
  email: '',
  departmentName: '',
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
        if (!value.trim() && !editForm.email.trim()) {
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
        if (!value.trim() && !editForm.mobile.trim()) {
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

const resetEditForm = () => {
  editForm.id = ''
  editForm.username = ''
  editForm.mobile = ''
  editForm.email = ''
  editForm.departmentName = ''
  editForm.status = 'enabled'
  editFormRef.value?.clearValidate()
}

const normalizeOptionalText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const buildDepartmentPathLookup = (tree: Array<{ label: string; children: Array<{ label: string; children: unknown[] }> }>) => {
  const pathMap: Record<string, string> = {}
  const labelPathMap = new Map<string, string[]>()
  const walk = (nodes: Array<{ label: string; children: unknown[] }>, parentPath = '') => {
    nodes.forEach((node) => {
      const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
      pathMap[currentPath] = currentPath
      const paths = labelPathMap.get(node.label) ?? []
      paths.push(currentPath)
      labelPathMap.set(node.label, paths)
      if (Array.isArray(node.children) && node.children.length > 0) {
        walk(node.children as Array<{ label: string; children: unknown[] }>, currentPath)
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

const resolveDepartmentPathDisplay = (value: unknown) => {
  const normalized = normalizeOptionalText(value)
  if (!normalized) {
    return ''
  }
  return departmentPathLookup.value[normalized] ?? normalized
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

  return params
}

const loadData = async () => {
  if (!canViewUsers.value) {
    listState.loading = false
    listState.records = []
    listState.total = 0
    showPermissionDenied()
    return
  }

  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getClientUserList(buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error, '获取客户端用户列表失败'))
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
    departmentPathLookup.value = buildDepartmentPathLookup(result.tree)
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '加载部门配置失败'))
  } finally {
    departmentOptionsLoading.value = false
  }
}

const handleSearch = () => {
  listState.query.page = 1
  void loadData()
}

const handleReset = () => {
  searchForm.keyword = ''
  searchForm.status = ''
  handleSearch()
}

const handleCurrentChange = (page: number) => {
  listState.query.page = page
  void loadData()
}

const handleOpenEdit = (row: ClientUserManageProfile) => {
  if (!canEditUser.value) {
    showPermissionDenied()
    return
  }
  editVisible.value = true
  resetEditForm()
  editForm.id = row.id
  editForm.username = row.username
  editForm.mobile = row.mobile || ''
  editForm.email = row.email || ''
  editForm.departmentName = resolveDepartmentPathDisplay(row.departmentName)
  editForm.status = row.status
}

const handleSubmitEdit = async () => {
  const valid = await editFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }
  if (!canEditUser.value) {
    showPermissionDenied()
    return
  }

  const normalizedUsername = editForm.username.trim()
  if (!normalizedUsername) {
    ElMessage.warning('请输入用户名')
    return
  }
  const normalizedMobile = editForm.mobile.trim()
  const normalizedEmail = editForm.email.trim().toLowerCase()
  const normalizedDepartmentName = normalizeOptionalText(editForm.departmentName)
  if (normalizedDepartmentName && !departmentOptions.value.includes(normalizedDepartmentName)) {
    ElMessage.warning('请选择系统配置中的部门选项')
    return
  }

  editSubmitting.value = true
  try {
    const payload: UpdateClientUserPayload = {
      username: normalizedUsername,
      mobile: normalizedMobile || undefined,
      email: normalizedEmail || undefined,
      departmentName: normalizedDepartmentName || undefined,
      status: editForm.status,
    }
    await updateClientUser(editForm.id, payload)
    editVisible.value = false
    resetEditForm()
    ElMessage.success('客户端用户资料已更新')
    await loadData()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '更新客户端用户资料失败'))
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
  if (!canResetUserPassword.value) {
    showPermissionDenied()
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
  if (!canResetUserPassword.value) {
    showPermissionDenied()
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
    ElMessage.error(extractErrorMessage(error, '二次确认失败'))
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
    ElMessage.success('客户端用户密码已修改')
    await loadData()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '修改客户端用户密码失败'))
  } finally {
    resetPasswordSubmitting.value = false
  }
}

const handleToggleStatus = async (row: ClientUserManageProfile) => {
  if (!canToggleUser.value) {
    showPermissionDenied()
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
    ElMessage.success(`${actionLabel}成功`)
    await loadData()
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return
    }
    ElMessage.error(extractErrorMessage(error, `${actionLabel}失败`))
  }
}

onMounted(() => {
  void loadDepartmentOptions()
  void loadData()
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
            <el-button :class="isPhone ? 'w-full' : ''" type="primary" icon="Search" @click="handleSearch">搜索</el-button>
            <el-button :class="isPhone ? 'w-full' : ''" icon="Refresh" @click="handleReset">重置</el-button>
          </div>
        </template>
      </PageToolbarCard>

      <div class="rounded-2xl border border-dashed border-brand/20 bg-brand/5 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-brand/20 dark:bg-brand/10 dark:text-slate-300">
        这里管理的是客户端注册用户，不包含系统后台账号。密码修改采用二次确认，修改成功后目标用户当前登录会话会立即失效。
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
            <el-table :data="listState.records" stripe class="w-full flex-1" height="100%" table-layout="auto">
              <el-table-column prop="username" label="用户名" min-width="180" show-overflow-tooltip />
              <el-table-column prop="mobile" label="手机号" min-width="140" show-overflow-tooltip />
              <el-table-column prop="email" label="邮箱" min-width="220" show-overflow-tooltip />
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
        <el-form-item label="所属部门" prop="departmentName">
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
  </PageContainer>
</template>
