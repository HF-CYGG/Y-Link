<script setup lang="ts">
/**
 * 模块说明：src/layout/components/AppHeader.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { ArrowDown, Lock, Menu, SwitchButton } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { useRouter } from 'vue-router'
import { computed, reactive, ref, useAttrs } from 'vue'
import QuoteBanner from '@/layout/components/QuoteBanner.vue'
import { changePassword, ROLE_LABEL_MAP } from '@/api/modules/auth'
import { useAppStore, useAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

defineOptions({
  inheritAttrs: false,
})

/**
 * 手动接管外部透传属性：
 * - AppHeader 同时渲染顶部栏与密码弹窗，属于多根节点组件；
 * - Vue 在多根节点场景下不会自动继承 `class` 等非 prop attribute；
 * - 这里显式把外部属性绑定到 `<header>`，消除告警并保留布局层传入的层级样式。
 */
const headerAttrs = useAttrs()

/**
 * 顶栏状态：
 * - phone 模式显示导航开关按钮，并收缩为精简信息区；
 * - tablet / desktop 模式保留语录横幅与主题切换。
 */
const appStore = useAppStore()
const authStore = useAuthStore()
const router = useRouter()
const passwordDialogVisible = ref(false)
const passwordSubmitting = ref(false)
const passwordFormRef = ref<FormInstance>()

/**
 * 修改密码表单：
 * - currentPassword 用于校验本人身份；
 * - newPassword/confirmPassword 由前端先做一致性校验，再提交给后端。
 */
const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})

/**
 * 修改密码校验规则：
 * - 延续后台管理系统的直接反馈方式；
 * - 确保用户在提交前就能明确看到问题所在。
 */
const passwordRules: FormRules = {
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
        if (value !== passwordForm.newPassword) {
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
 * 当前登录用户角色文案：
 * - 供顶部信息区与移动端卡片展示；
 * - 若无用户信息则回退为空字符串，避免模板出现 undefined。
 */
const currentRoleLabel = computed(() => {
  const role = authStore.currentUser?.role
  return role ? ROLE_LABEL_MAP[role] : ''
})

/**
 * 重置修改密码表单：
 * - 每次打开或关闭弹窗都回到干净状态；
 * - 避免上一次输入残留在下次操作中。
 */
const resetPasswordForm = () => {
  passwordForm.currentPassword = ''
  passwordForm.newPassword = ''
  passwordForm.confirmPassword = ''
  passwordFormRef.value?.clearValidate()
}

/**
 * 打开修改密码弹窗：
 * - 入口放在顶部用户菜单中；
 * - 让安全设置保持就近、低学习成本。
 */
const handleOpenPasswordDialog = () => {
  passwordDialogVisible.value = true
  resetPasswordForm()
}

/**
 * 提交本人修改密码：
 * - 成功后服务端会使当前账号已有会话全部失效；
 * - 前端同步清空本地登录态，并要求使用新密码重新登录。
 */
const handleChangePassword = async () => {
  const valid = await passwordFormRef.value?.validate().catch(() => false)
  if (!valid) {
    return
  }

  passwordSubmitting.value = true
  try {
    await changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    })
    passwordDialogVisible.value = false
    resetPasswordForm()
    await authStore.logout()
    await router.replace('/login')
    ElMessage.success('密码修改成功，请使用新密码重新登录')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '修改密码失败'))
  } finally {
    passwordSubmitting.value = false
  }
}

/**
 * 统一退出流程：
 * - 先做轻量确认，防止误触；
 * - 成功后回到登录页，并保留简洁提示反馈。
 */
const handleLogout = async () => {
  try {
    await ElMessageBox.confirm('确认退出当前登录状态吗？', '退出登录', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--primary',
    })

    await authStore.logout()
    await router.replace('/login')
    ElMessage.success('已退出登录')
  } catch (error) {
    if (error === 'cancel') {
      return
    }

    ElMessage.error(extractErrorMessage(error, '退出登录失败'))
  }
}
</script>

<template>
  <header
    v-bind="headerAttrs"
    :class="[
      'flex h-16 flex-shrink-0 items-center justify-between gap-3 border-b border-slate-200/60 bg-white/80 backdrop-blur-md dark:border-white/5 dark:bg-[#141415]/80',
      appStore.isDesktop ? 'px-6' : 'px-3 sm:px-4',
    ]"
  >
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <el-button
        v-if="appStore.isPhone"
        circle
        plain
        aria-label="打开导航菜单"
        class="flex-shrink-0"
        @click="appStore.toggleSidebar"
      >
        <el-icon><Menu /></el-icon>
      </el-button>

      <div v-if="appStore.isPhone" class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">Y-Link</div>
        <div class="truncate text-xs text-slate-500 dark:text-slate-400">业务管理控制台</div>
      </div>

      <div v-else class="min-w-0 flex-1" :class="appStore.isTablet ? 'max-w-[420px]' : ''">
        <QuoteBanner />
      </div>
    </div>

    <div class="flex flex-shrink-0 items-center gap-2">
      <span
        v-if="appStore.isTablet"
        class="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-white/5 dark:text-slate-400 md:inline-flex"
      >
        平板布局
      </span>

      <el-dropdown trigger="click" placement="bottom-end">
        <button
          type="button"
          class="flex items-center gap-2 rounded-full border border-slate-200/70 bg-white/90 px-2.5 py-1.5 text-left shadow-sm transition-all duration-200 hover:border-brand/30 hover:shadow dark:border-white/10 dark:bg-white/5"
        >
          <div class="flex h-9 w-9 items-center justify-center rounded-full bg-brand/10 text-sm font-semibold text-brand dark:bg-brand/20 dark:text-teal-300">
            {{ authStore.currentUser?.displayName?.slice(0, 1) || 'Y' }}
          </div>
          <div v-if="!appStore.isPhone" class="min-w-0">
            <div class="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
              {{ authStore.currentUser?.displayName || '未登录' }}
            </div>
            <div class="truncate text-xs text-slate-500 dark:text-slate-400">
              {{ authStore.currentUser?.username || '-' }}<span v-if="currentRoleLabel"> · {{ currentRoleLabel }}</span>
            </div>
          </div>
          <el-icon class="text-slate-400"><ArrowDown /></el-icon>
        </button>

        <template #dropdown>
          <el-dropdown-menu>
            <div class="px-3 py-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
              <div class="font-semibold text-slate-700 dark:text-slate-200">{{ authStore.currentUser?.displayName || '-' }}</div>
              <div>{{ authStore.currentUser?.username || '-' }}</div>
              <div v-if="currentRoleLabel">{{ currentRoleLabel }}</div>
            </div>
            <el-dropdown-item @click="handleOpenPasswordDialog">
              <el-icon><Lock /></el-icon>
              修改密码
            </el-dropdown-item>
            <el-dropdown-item divided @click="handleLogout">
              <el-icon><SwitchButton /></el-icon>
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>

  <el-dialog
    v-model="passwordDialogVisible"
    title="修改密码"
    width="420px"
    destroy-on-close
    append-to-body
    :modal-append-to-body="true"
    :lock-scroll="true"
    @closed="resetPasswordForm"
  >
    <div class="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-500 dark:bg-white/5 dark:text-slate-400">
      修改成功后，当前账号已有登录会话会立即失效，需要使用新密码重新登录系统。
    </div>
    <el-form ref="passwordFormRef" :model="passwordForm" :rules="passwordRules" label-position="top">
      <el-form-item label="当前密码" prop="currentPassword">
        <el-input
          v-model="passwordForm.currentPassword"
          type="password"
          show-password
          placeholder="请输入当前密码"
          autocomplete="current-password"
        />
      </el-form-item>
      <el-form-item label="新密码" prop="newPassword">
        <el-input
          v-model="passwordForm.newPassword"
          type="password"
          show-password
          placeholder="请输入新密码"
          autocomplete="new-password"
        />
      </el-form-item>
      <el-form-item label="确认新密码" prop="confirmPassword">
        <el-input
          v-model="passwordForm.confirmPassword"
          type="password"
          show-password
          placeholder="请再次输入新密码"
          autocomplete="new-password"
          @keyup.enter="handleChangePassword"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <div class="flex items-center justify-end gap-3">
        <el-button @click="passwordDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="passwordSubmitting" @click="handleChangePassword">确认修改</el-button>
      </div>
    </template>
  </el-dialog>
</template>
