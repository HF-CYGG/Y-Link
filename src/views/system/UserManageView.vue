<script setup lang="ts">
import dayjs from 'dayjs'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { BizCrudDialogShell, BizResponsiveDataCollectionShell, PageContainer, PagePaginationBar, PageToolbarCard } from '@/components/common'
import {
  changePassword,
  GOVERNANCE_PERMISSION_CODES,
  PERMISSION_LABEL_MAP,
  ROLE_LABEL_MAP,
  STATUS_LABEL_MAP,
  type PermissionCode,
  type UserRole,
  type UserSafeProfile,
  type UserStatus,
} from '@/api/modules/auth'
import {
  createUser,
  getUserList,
  resetUserPassword,
  updateUser,
  updateUserStatus,
  type CreateUserPayload,
  type ResetUserPasswordPayload,
  type UpdateUserPayload,
  type UserListQuery,
} from '@/api/modules/user'
import { useStableRequest } from '@/composables/useStableRequest'
import { useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'
import { applyPaginatedResult, createPaginatedListState } from '@/utils/list'
import { useRouter } from 'vue-router'

/**
 * 用户管理搜索表单：
 * - keyword 支持账号/姓名模糊查询；
 * - role/status 适配企业后台最常见筛选维度。
 */
const searchForm = reactive({
  keyword: '',
  role: '' as '' | UserRole,
  status: '' as '' | UserStatus,
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
const authStore = useAuthStore()
const router = useRouter()
const listRequest = useStableRequest()

/**
 * 页面权限能力：
 * - 查看权限控制整页是否允许加载用户数据；
 * - 新增/编辑/启停/重置密码分别映射到对应按钮和提交动作。
 */
const canViewUsers = computed(() => authStore.hasPermission('users:view'))
const canCreateUser = computed(() => authStore.hasPermission('users:create'))
const canEditUser = computed(() => authStore.hasPermission('users:update'))
const canToggleUser = computed(() => authStore.hasPermission('users:status'))
const canResetUserPassword = computed(() => authStore.hasPermission('users:reset_password'))
const canOperateUsers = computed(() => authStore.hasAnyPermission(['users:update', 'users:status', 'users:reset_password']))

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
        if (value && value.length < 6) {
          callback(new Error('密码长度至少为 6 位'))
          return
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
  displayName: [{ required: true, message: '请输入用户姓名', trigger: 'blur' }],
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

/**
 * 本人修改密码校验规则：
 * - 先校验当前密码，再校验新密码长度与确认一致性；
 * - 与登录页/顶栏规则保持一致，降低理解成本。
 */
const ownPasswordRules: FormRules = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
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
 * 状态标签样式：
 * - enabled 用成功色，disabled 用警告色；
 * - 统一应用于表格与卡片模式。
 */
const getStatusTagType = (status: UserStatus) => {
  return status === 'enabled' ? 'success' : 'warning'
}

/**
 * 角色标签样式：
 * - 管理员使用品牌主色，突出系统治理职责；
 * - 普通操作员保持中性色。
 */
const getRoleTagType = (role: UserRole) => {
  return role === 'admin' ? 'primary' : 'info'
}

/**
 * 角色与状态文案辅助：
 * - 模板中通过函数访问映射，避免 SFC 模板类型被推断成 any；
 * - 同时保证文案字典仍集中维护。
 */
const getRoleLabel = (role: UserRole) => ROLE_LABEL_MAP[role]
const getStatusLabel = (status: UserStatus) => STATUS_LABEL_MAP[status]

/**
 * 关键治理权限文案：
 * - 只展示用户治理与审计相关能力，避免在用户列表中塞入全部业务权限；
 * - 用于明确展示每个角色当前边界。
 */
const getGovernancePermissionLabels = (permissions: PermissionCode[]) => {
  return GOVERNANCE_PERMISSION_CODES.filter((permission) => permissions.includes(permission)).map((permission) => PERMISSION_LABEL_MAP[permission])
}

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
  if (searchForm.status) {
    params.status = searchForm.status
  }

  return params
}

/**
 * 拉取用户分页列表：
 * - 若当前账号无 users:view，则直接提示并保持空列表；
 * - 成功后统一回填到 listState。
 */
const loadData = async () => {
  if (!canViewUsers.value) {
    listState.loading = false
    listState.records = []
    listState.total = 0
    ElMessage.warning('当前账号无权查看用户列表')
    return
  }

  listState.loading = true
  await listRequest.runLatest({
    executor: (signal) => getUserList(buildQueryParams(), { signal }),
    onSuccess: (result) => {
      applyPaginatedResult(listState, result)
    },
    onError: (error) => {
      ElMessage.error(extractErrorMessage(error, '获取用户列表失败'))
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
  if (!canCreateUser.value) {
    ElMessage.warning('当前账号无权新增用户')
    return
  }

  dialogMode.value = 'create'
  dialogVisible.value = true
  userForm.id = ''
  userForm.username = ''
  userForm.password = ''
  userForm.displayName = ''
  userForm.role = 'operator'
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
  if (!canEditUser.value) {
    ElMessage.warning('当前账号无权编辑用户')
    return
  }

  dialogMode.value = 'edit'
  dialogVisible.value = true
  userForm.id = row.id
  userForm.username = row.username
  userForm.password = ''
  userForm.displayName = row.displayName
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
  if (!canResetUserPassword.value) {
    ElMessage.warning('当前账号无权重置他人密码')
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
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }

  if (dialogMode.value === 'create' && !canCreateUser.value) {
    ElMessage.warning('当前账号无权新增用户')
    return
  }
  if (dialogMode.value === 'edit' && !canEditUser.value) {
    ElMessage.warning('当前账号无权编辑用户')
    return
  }

  submitting.value = true
  try {
    if (dialogMode.value === 'create') {
      const payload: CreateUserPayload = {
        username: userForm.username.trim(),
        password: userForm.password,
        displayName: userForm.displayName.trim(),
        role: userForm.role,
        status: userForm.status,
      }
      await createUser(payload)
      ElMessage.success('用户创建成功')
    } else {
      const originalStatus = listState.records.find((item) => item.id === userForm.id)?.status
      if (userForm.status !== originalStatus && !canToggleUser.value) {
        ElMessage.warning('当前账号无权调整用户状态')
        return
      }

      const payload: UpdateUserPayload = {
        displayName: userForm.displayName.trim(),
        role: userForm.role,
      }

      await updateUser(userForm.id, payload)

      if (userForm.status !== originalStatus) {
        await updateUserStatus(userForm.id, userForm.status)
      }

      ElMessage.success('用户信息更新成功')
    }

    dialogVisible.value = false
    await loadData()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '保存用户失败'))
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

  if (!canResetUserPassword.value) {
    ElMessage.warning('当前账号无权重置他人密码')
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
    ElMessage.success(`已重置“${targetDisplayName}”的登录密码`)
    await loadData()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '重置密码失败'))
  } finally {
    resetPasswordSubmitting.value = false
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
    await router.replace('/login')
    ElMessage.success('密码修改成功，请使用新密码重新登录')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '修改密码失败'))
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
  if (!canToggleUser.value) {
    ElMessage.warning('当前账号无权启停用户')
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
    ElMessage.success(`${actionLabel}成功`)
    await loadData()
  } catch (error) {
    if (error === 'cancel') {
      return
    }
    ElMessage.error(extractErrorMessage(error, `${actionLabel}失败`))
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
  searchForm.status = ''
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
const canShowEditAction = (row: UserSafeProfile) => canEditUser.value && Boolean(row.id)
const canShowResetPasswordAction = (row: UserSafeProfile) => canResetUserPassword.value && !isSelfRow(row)
const canShowToggleStatusAction = (row: UserSafeProfile) => canToggleUser.value && !(isSelfRow(row) && row.status === 'enabled')

onMounted(() => {
  void loadData()
})
</script>

<template>
  <PageContainer title="用户管理" description="管理系统账号、角色、状态与关键权限边界，所有变更均自动进入审计链路。">
    <div class="flex min-w-0 flex-col gap-4">
      <PageToolbarCard content-class="items-start">
        <template #default="{ isPhone, isTablet }">
          <div class="flex flex-1 flex-wrap items-start gap-2">
            <el-input
              v-model="searchForm.keyword"
              placeholder="搜索账号或姓名"
              clearable
              :class="isPhone ? '!w-full' : isTablet ? '!w-[220px]' : '!w-60'"
              @clear="handleSearch"
              @keyup.enter="handleSearch"
            />
            <el-select
              v-model="searchForm.role"
              placeholder="角色"
              clearable
              :class="isPhone ? '!w-full' : '!w-36'"
              @change="handleSearch"
            >
              <el-option label="管理员" value="admin" />
              <el-option label="操作员" value="operator" />
            </el-select>
            <el-select
              v-model="searchForm.status"
              placeholder="状态"
              clearable
              :class="isPhone ? '!w-full' : '!w-36'"
              @change="handleSearch"
            >
              <el-option label="启用" value="enabled" />
              <el-option label="停用" value="disabled" />
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

      <div class="apple-card flex min-h-0 flex-1 flex-col p-4">
        <BizResponsiveDataCollectionShell
          :items="listState.records"
          :loading="listState.loading"
          empty-description="暂无用户数据"
          empty-min-height="260px"
          :skeleton-rows="6"
          wrapper-class="flex min-h-0 flex-1 flex-col"
          table-wrapper-class="flex min-h-0 flex-1 flex-col overflow-hidden"
          card-container-class="pb-4"
        >
          <template #table>
            <el-table :data="listState.records" stripe class="user-manage-table w-full flex-1" height="100%">
              <el-table-column prop="username" label="账号" min-width="150" />
              <el-table-column prop="displayName" label="姓名" min-width="120" />
              <el-table-column label="角色" width="110">
                <template #default="{ row }">
                  <el-tag :type="getRoleTagType(row.role)" effect="light">{{ getRoleLabel(row.role) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="getStatusTagType(row.status)" effect="light">{{ getStatusLabel(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="关键权限边界" min-width="320" class-name="user-manage__permission-cell">
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
              <el-table-column label="最后登录" min-width="168">
                <template #default="{ row }">{{ row.lastLoginAt ? dayjs(row.lastLoginAt).format('YYYY-MM-DD HH:mm') : '-' }}</template>
              </el-table-column>
              <el-table-column label="创建时间" min-width="168">
                <template #default="{ row }">{{ dayjs(row.createdAt).format('YYYY-MM-DD HH:mm') }}</template>
              </el-table-column>
              <el-table-column v-if="canOperateUsers" label="操作" min-width="260" align="right" class-name="user-manage__action-cell">
                <template #default="{ row }">
                  <div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 py-1">
                    <el-button v-if="canShowEditAction(row)" link type="primary" @click="handleOpenEdit(row)">编辑</el-button>
                    <el-button v-if="canShowResetPasswordAction(row)" link type="primary" @click="handleOpenResetPassword(row)">重置密码</el-button>
                    <el-button
                      v-if="canShowToggleStatusAction(row)"
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
                  <div class="truncate text-base font-semibold text-slate-800 dark:text-slate-100">{{ item.displayName }}</div>
                  <div class="truncate text-sm text-slate-500 dark:text-slate-400">{{ item.username }}</div>
                </div>
                <el-tag :type="getStatusTagType(item.status)" effect="light">{{ getStatusLabel(item.status) }}</el-tag>
              </div>

              <div class="grid gap-2 rounded-2xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">角色</span>
                  <el-tag size="small" :type="getRoleTagType(item.role)" effect="light">{{ getRoleLabel(item.role) }}</el-tag>
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
                  <span class="text-slate-400">最后登录</span>
                  <span>{{ item.lastLoginAt ? dayjs(item.lastLoginAt).format('YYYY-MM-DD HH:mm') : '-' }}</span>
                </div>
                <div class="flex items-center justify-between gap-3">
                  <span class="text-slate-400">创建时间</span>
                  <span>{{ dayjs(item.createdAt).format('YYYY-MM-DD HH:mm') }}</span>
                </div>
              </div>

              <div v-if="canOperateUsers" class="flex items-center justify-end gap-3 border-t border-slate-100 pt-3 dark:border-white/10">
                <el-button v-if="canShowEditAction(item)" link type="primary" @click="handleOpenEdit(item)">编辑</el-button>
                <el-button v-if="canShowResetPasswordAction(item)" link type="primary" @click="handleOpenResetPassword(item)">重置密码</el-button>
                <el-button
                  v-if="canShowToggleStatusAction(item)"
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
      v-model="dialogVisible"
      :title="dialogTitle"
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
        <div class="grid gap-3 sm:grid-cols-2">
          <el-form-item label="角色" prop="role">
            <el-select v-model="userForm.role" class="w-full">
              <el-option label="管理员" value="admin" />
              <el-option label="操作员" value="operator" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态" prop="status">
            <el-select v-model="userForm.status" class="w-full" :disabled="dialogMode === 'edit' && !canToggleUser">
              <el-option label="启用" value="enabled" />
              <el-option label="停用" value="disabled" />
            </el-select>
          </el-form-item>
        </div>
      </el-form>
    </BizCrudDialogShell>

    <BizCrudDialogShell
      v-model="resetPasswordVisible"
      title="重置密码"
      phone-width="94%"
      tablet-width="520px"
      desktop-width="440px"
      :confirm-loading="resetPasswordSubmitting"
      confirm-text="确认重置"
      @confirm="handleSubmitResetPassword"
      @closed="resetAdminPasswordForm"
    >
      <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
        即将为“{{ resetPasswordForm.targetDisplayName || '-' }}（{{ resetPasswordForm.targetUsername || '-' }}）”重置密码。提交成功后，该用户已有登录会话会立即失效。
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
