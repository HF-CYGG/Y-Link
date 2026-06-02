<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientAuthView.vue
 * 文件职责：承载客户端登录、个人注册与部门注册三条认证入口，并根据服务端下发能力切换验证码或短信/邮箱校验流程。
 * 实现逻辑：
 * - 登录与注册共用同一页壳体，但通过 `activeMode` 明确区分“登录 / 个人注册 / 部门注册”三种可见模式；
 * - 部门注册会强制校验真实姓名、教职工号和所属部门，防止学生通过前端手工切换冒用部门账号；
 * - 图形验证码、短信/邮箱验证码与注册能力配置统一走最新请求守卫，避免重复点击后状态错乱。
 * 维护说明：
 * - 若后端继续扩展实名白名单或注册能力字段，优先同步本页的 `resolveAuthModeFromRouteTab()`、注册校验和提交参数；
 * - 若调整注册模式文案或入口结构，务必同步检查 `activeMode`、`registerAccountType` 与模板切换条件是否仍保持同一口径。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Key, Lock, Message, User } from '@element-plus/icons-vue'
import {
  type ClientAccountType,
  type ClientAuthCapabilities,
  type ClientDepartmentOptionNode,
  type ClientValidationMode,
  getClientAuthCapabilities,
  getClientCaptcha,
} from '@/api/modules/client-auth'
import { resolveClientPostLoginWarmupTargets, scheduleRouteComponentWarmup } from '@/router/route-performance'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { useIdempotentAction } from '@/composables/useIdempotentAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { APP_META } from '@/constants/app-meta'
import {
  CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE,
  CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER,
  CLIENT_NEW_PASSWORD_PLACEHOLDER,
  CLIENT_NEW_PASSWORD_RULE_HINT,
  CLIENT_NEW_PASSWORD_RULE_TEXT,
  isClientNewPasswordValid,
} from '@/utils/client-password-policy'
import { normalizeRequestError } from '@/utils/error'

type AuthMode = 'login' | 'register-personal' | 'register-department'

interface ClientCaptchaState {
  captchaId: string
  captchaSvg: string
  expiresInSeconds: number
}

interface RegisterDepartmentTreeSelectNode {
  id: string
  label: string
  value: string
  children: RegisterDepartmentTreeSelectNode[]
}

const resolveAuthModeFromRouteTab = (tab: unknown): AuthMode => {
  if (tab === 'register-department') return 'register-department'
  if (tab === 'register' || tab === 'register-personal') return 'register-personal'
  return 'login'
}

const router = useRouter()
const route = useRoute()
const clientAuthStore = useClientAuthStore(pinia)
const { runWithGate } = useIdempotentAction()
const { runLatest: runLatestCaptchaRequest, cancel: cancelCaptchaRequest } = useStableRequest()
const { runLatest: runLatestCapabilityRequest, cancel: cancelCapabilityRequest } = useStableRequest()
const { runLatest: runLatestLoginRequest, cancel: cancelLoginRequest } = useStableRequest()
const { runLatest: runLatestRegisterRequest, cancel: cancelRegisterRequest } = useStableRequest()
const { runLatest: runLatestVerificationCodeRequest, cancel: cancelVerificationCodeRequest } = useStableRequest()

const activeMode = ref<AuthMode>('login')
const registerAccountType = ref<ClientAccountType>('personal')
const loading = ref(false)
const captchaLoading = ref(false)
const capabilityLoading = ref(false)
const loginCaptchaVisible = ref(false)
const verificationSending = ref(false)
const registerVerificationCountdown = ref(0)
const authCapabilities = ref<ClientAuthCapabilities | null>(null)

const loginForm = reactive({
  account: '',
  password: '',
  captcha: '',
})

const registerForm = reactive({
  username: '', // 现在代表真实姓名
  account: '',
  staffNo: '',
  department: '',
  password: '',
  confirmPassword: '',
  verificationCode: '',
  captcha: '',
})

const captcha = reactive<ClientCaptchaState>({
  captchaId: '',
  captchaSvg: '',
  expiresInSeconds: 0,
})

let captchaExpireTimer: ReturnType<typeof globalThis.setInterval> | null = null
let registerVerificationTimer: ReturnType<typeof globalThis.setInterval> | null = null

const redirectPath = computed(() => {
  const raw = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/client/mall'
})
const isDepartmentRegister = computed(() => registerAccountType.value === 'department')
const registerAccountChannel = computed(() => resolveAccountChannel(registerForm.account))
const registerValidationMode = computed<ClientValidationMode>(() => {
  const channel = registerAccountChannel.value
  if (!channel) return 'captcha'
  return authCapabilities.value?.registerValidationModes[channel] ?? 'captcha'
})
const registerUsesVerificationCode = computed(() => registerValidationMode.value === 'verification_code')
const forgotPasswordAvailable = computed(() => authCapabilities.value?.forgotPasswordEnabled ?? false)
const registerDepartmentOptions = computed(() => authCapabilities.value?.departmentOptions ?? [])
const registerDepartmentTreeSelectData = computed(() => buildDepartmentTreeSelectData(authCapabilities.value?.departmentTree ?? []))
const hasRegisterDepartmentTree = computed(() => registerDepartmentTreeSelectData.value.length > 0)
const captchaImageSrc = computed(() => (
  captcha.captchaSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captcha.captchaSvg)}` : ''
))
const captchaHintText = computed(() => (
  captcha.expiresInSeconds > 0
    ? `图形验证码约 ${captcha.expiresInSeconds}s 后失效，点击右侧图片可刷新`
    : '点击右侧图片可刷新图形验证码'
))

const clearCaptchaTimer = () => {
  if (!captchaExpireTimer) return
  globalThis.clearInterval(captchaExpireTimer)
  captchaExpireTimer = null
}

const resetRegisterVerificationTimer = () => {
  if (registerVerificationTimer) {
    globalThis.clearInterval(registerVerificationTimer)
    registerVerificationTimer = null
  }
  registerVerificationCountdown.value = 0
}

const startRegisterVerificationCountdown = (seconds: number) => {
  const safeSeconds = Math.max(1, Math.floor(seconds))
  registerVerificationCountdown.value = safeSeconds
  if (registerVerificationTimer) {
    globalThis.clearInterval(registerVerificationTimer)
  }
  registerVerificationTimer = globalThis.setInterval(() => {
    if (registerVerificationCountdown.value <= 1) {
      resetRegisterVerificationTimer()
      return
    }
    registerVerificationCountdown.value -= 1
  }, 1000)
}

// 详细注释：认证页三态除了控制当前可见表单，还需要同步到路由 query，
// 这样刷新页面、分享链接或浏览器前进后退时，仍能回到用户刚才选择的登录/注册入口。
const syncRouteTabWithMode = async (mode: AuthMode) => {
  const currentTab = typeof route.query.tab === 'string' ? route.query.tab : ''
  const nextTab = mode === 'login' ? '' : mode
  if (currentTab === nextTab) {
    return
  }
  const nextQuery = { ...route.query }
  if (mode === 'login') {
    delete nextQuery.tab
  } else {
    nextQuery.tab = mode
  }
  await router.replace({ query: nextQuery })
}

const loadAuthCapabilities = async (silent = false) => {
  capabilityLoading.value = true
  await runLatestCapabilityRequest({
    executor: (signal) => getClientAuthCapabilities({ signal }),
    onSuccess: (result) => {
      authCapabilities.value = result
    },
    onError: (error) => {
      if (!silent) {
        ElMessage.error(normalizeRequestError(error, '加载认证能力失败').message)
      }
    },
    onFinally: () => {
      capabilityLoading.value = false
    },
  })
}

const refreshCaptcha = async (silent = false) => {
  captchaLoading.value = true
  await runLatestCaptchaRequest({
    executor: (signal) => getClientCaptcha({ signal }),
    onSuccess: (result) => {
      captcha.captchaId = result.captchaId
      captcha.captchaSvg = result.captchaSvg
      captcha.expiresInSeconds = result.expiresInSeconds
      clearCaptchaTimer()
      captchaExpireTimer = globalThis.setInterval(() => {
        if (captcha.expiresInSeconds <= 1) {
          captcha.expiresInSeconds = 0
          clearCaptchaTimer()
          return
        }
        captcha.expiresInSeconds -= 1
      }, 1000)
      if (!silent) ElMessage.success('验证码已刷新')
    },
    onError: (error) => {
      if (!silent) {
        ElMessage.error(normalizeRequestError(error, '验证码刷新失败').message)
      }
    },
    onFinally: () => {
      captchaLoading.value = false
    },
  })
}

const ensureCaptchaReady = async () => {
  if (captcha.captchaId && captcha.captchaSvg) return
  await refreshCaptcha(true)
}

const normalizeInputText = (value: string) => value.replaceAll(/\s+/g, ' ').trim()
const validateMobile = (mobile: string) => /^1\d{10}$/.test(mobile.trim())
const validateEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
const validateLoginAccount = (account: string) => account.trim().length > 0
const validateLoginPassword = (password: string) => password.trim().length > 0
const validateUsername = (username: string) => /^[\u4e00-\u9fa5][\u4e00-\u9fa5\u00B7 ]{1,19}$/.test(username.trim())
const validateRegisterPassword = (password: string) => isClientNewPasswordValid(password)
const resolveAccountChannel = (account: string): 'mobile' | 'email' | null => {
  const normalized = account.trim()
  if (!normalized) return null
  if (normalized.includes('@')) {
    return validateEmail(normalized) ? 'email' : null
  }
  return validateMobile(normalized) ? 'mobile' : null
}

const buildDepartmentTreeSelectData = (
  tree: ClientDepartmentOptionNode[],
  parentPath = '',
): RegisterDepartmentTreeSelectNode[] => {
  return tree.map((node) => {
    const currentPath = parentPath ? `${parentPath}-${node.label}` : node.label
    return {
      id: node.id,
      label: node.label,
      value: currentPath,
      children: buildDepartmentTreeSelectData(node.children, currentPath),
    }
  })
}

const warmupClientPostLoginTargets = (redirect: string) => {
  const warmupTargets = resolveClientPostLoginWarmupTargets(redirect)
  if (!warmupTargets.length) return
  scheduleRouteComponentWarmup(warmupTargets)
}

const handleLogin = async () => {
  if (!validateLoginAccount(loginForm.account)) {
    ElMessage.warning('请输入账号')
    return
  }
  if (!validateLoginPassword(loginForm.password)) {
    ElMessage.warning('请输入密码')
    return
  }
  if (loginCaptchaVisible.value && (!captcha.captchaId || !loginForm.captcha.trim())) {
    ElMessage.warning('请输入图形验证码')
    return
  }

  const runResult = await runWithGate({
    actionKey: 'client-auth-login',
    onDuplicated: () => ElMessage.info('登录请求处理中，请勿重复提交'),
    executor: async () => {
      loading.value = true
      await runLatestLoginRequest({
        executor: (signal) => clientAuthStore.login({
          account: normalizeInputText(loginForm.account),
          password: loginForm.password,
          captchaId: loginCaptchaVisible.value ? captcha.captchaId : undefined,
          captchaCode: loginCaptchaVisible.value ? normalizeInputText(loginForm.captcha) : undefined,
        }, { signal }),
        onSuccess: async () => {
          loginForm.captcha = ''
          await router.replace(redirectPath.value)
          warmupClientPostLoginTargets(redirectPath.value)
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '登录失败，请重试')
          ElMessage.error(normalizedError.message)
          loginCaptchaVisible.value = true
          loginForm.captcha = ''
          await ensureCaptchaReady()
        },
        onFinally: () => {
          loading.value = false
        },
      })
    },
  })
  if (runResult === null) return
}

const handleRegister = async () => {
  const accountChannel = resolveAccountChannel(registerForm.account)

  if (!validateUsername(registerForm.username)) {
    ElMessage.warning('姓名需为 2-20 位中文，可包含空格或·')
    return
  }

  if (!accountChannel) {
    ElMessage.warning('请输入正确的手机号或邮箱作为登录账号')
    return
  }
  if (isDepartmentRegister.value && !registerForm.staffNo.trim()) {
    ElMessage.warning('部门账号注册必须填写教职工号')
    return
  }
  if (isDepartmentRegister.value && !normalizeInputText(registerForm.department)) {
    ElMessage.warning('部门账号注册必须填写所属部门')
    return
  }
  if (!validateRegisterPassword(registerForm.password)) {
    ElMessage.warning(CLIENT_NEW_PASSWORD_RULE_TEXT)
    return
  }
  if (registerForm.password !== registerForm.confirmPassword) {
    ElMessage.warning(CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE)
    return
  }
  if (
    isDepartmentRegister.value
    && registerForm.department.trim()
    && !registerDepartmentOptions.value.includes(registerForm.department.trim())
  ) {
    ElMessage.warning('请选择系统配置中的部门选项')
    return
  }
  if (registerUsesVerificationCode.value) {
    if (!registerForm.verificationCode.trim()) {
      ElMessage.warning('请输入手机/邮箱验证码')
      return
    }
  } else if (!captcha.captchaId || !registerForm.captcha.trim()) {
    ElMessage.warning('请输入图形验证码')
    return
  }

  const runResult = await runWithGate({
    actionKey: 'client-auth-register',
    onDuplicated: () => ElMessage.info('注册请求处理中，请勿重复提交'),
    executor: async () => {
      loading.value = true
      await runLatestRegisterRequest({
        executor: (signal) => clientAuthStore.register({
          username: normalizeInputText(registerForm.username),
          account: normalizeInputText(registerForm.account),
          accountType: registerAccountType.value,
          staffNo: isDepartmentRegister.value ? (normalizeInputText(registerForm.staffNo) || undefined) : undefined,
          password: registerForm.password,
          departmentName: isDepartmentRegister.value ? (normalizeInputText(registerForm.department) || undefined) : undefined,
          verificationCode: registerUsesVerificationCode.value ? normalizeInputText(registerForm.verificationCode) : undefined,
          captchaId: registerUsesVerificationCode.value ? undefined : captcha?.captchaId,
          captchaCode: registerUsesVerificationCode.value ? undefined : normalizeInputText(registerForm.captcha),
        }, { signal }),
        onSuccess: async () => {
          ElMessage.success('注册成功，已自动登录')
          registerForm.username = ''
          registerForm.account = ''
          registerForm.staffNo = ''
          registerForm.department = ''
          registerForm.password = ''
          registerForm.confirmPassword = ''
          registerForm.verificationCode = ''
          registerForm.captcha = ''
          registerAccountType.value = 'personal'
          await router.replace(redirectPath.value)
          warmupClientPostLoginTargets(redirectPath.value)
        },
        onError: async (error) => {
          ElMessage.error(normalizeRequestError(error, '注册失败，请检查后重试').message)
          registerForm.captcha = ''
          await ensureCaptchaReady()
        },
        onFinally: () => {
          loading.value = false
        },
      })
    },
  })
  if (runResult === null) return
}

const handleSendRegisterVerificationCode = async () => {
  const channel = registerAccountChannel.value
  if (!channel) {
    ElMessage.warning('请先输入有效的手机号或邮箱')
    return
  }
  if (!captcha.captchaId || !registerForm.captcha.trim()) {
    ElMessage.warning('请先输入图形验证码')
    return
  }
  verificationSending.value = true
  await runLatestVerificationCodeRequest({
    executor: (signal) => clientAuthStore.sendVerificationCode({
      channel,
      target: normalizeInputText(registerForm.account),
      scene: 'register',
      captchaId: captcha.captchaId,
      captchaCode: normalizeInputText(registerForm.captcha),
    }, { signal }),
    onSuccess: (result) => {
      startRegisterVerificationCountdown(result.expireSeconds || 60)
      ElMessage.success('验证码已发送')
    },
    onError: async (error) => {
      ElMessage.error(normalizeRequestError(error, '验证码发送失败').message)
      await ensureCaptchaReady()
    },
    onFinally: () => {
      verificationSending.value = false
    },
  })
}

watch(
  () => route.fullPath,
  () => {
    activeMode.value = resolveAuthModeFromRouteTab(route.query.tab)
  },
)

watch(activeMode, (nextMode) => {
  void syncRouteTabWithMode(nextMode)
  if (nextMode === 'register-department' && registerAccountType.value !== 'department') {
    registerAccountType.value = 'department'
  } else if (nextMode === 'register-personal' && registerAccountType.value !== 'personal') {
    registerAccountType.value = 'personal'
  }
  if (nextMode !== 'login') {
    void ensureCaptchaReady()
    return
  }
  if (loginCaptchaVisible.value) {
    void ensureCaptchaReady()
  }
})

watch(registerValidationMode, (mode) => {
  if (mode !== 'verification_code') {
    resetRegisterVerificationTimer()
    registerForm.verificationCode = ''
  }
})

watch(registerAccountType, (type) => {
  if (type === 'personal') {
    registerForm.staffNo = ''
    registerForm.department = ''
  }
  const expectedMode = type === 'department' ? 'register-department' : 'register-personal'
  if (activeMode.value !== 'login' && activeMode.value !== expectedMode) {
    activeMode.value = expectedMode
  }
})

onMounted(async () => {
  if (clientAuthStore.isAuthenticated) {
    await router.replace(redirectPath.value)
    return
  }
  activeMode.value = resolveAuthModeFromRouteTab(route.query.tab)
  await loadAuthCapabilities(true)
  await ensureCaptchaReady()
})

onUnmounted(() => {
  cancelCapabilityRequest()
  cancelCaptchaRequest()
  cancelLoginRequest()
  cancelRegisterRequest()
  cancelVerificationCodeRequest()
  clearCaptchaTimer()
  resetRegisterVerificationTimer()
})
</script>

<template>
  <div class="client-auth-page">
    <main class="auth-shell">
      <section class="brand-panel">
        <div class="brand-tag">Y-LINK CLIENT</div>
        <h1 class="brand-title">野鹤文创<br>极简预订</h1>
        <p class="brand-desc">实时查看库存，在线预约即锁单。</p>
        <div class="brand-footer">
          <div>{{ APP_META.version }}</div>
          <a :href="APP_META.repositoryUrl" target="_blank" rel="noopener noreferrer">{{ APP_META.repositoryLabel }}</a>
        </div>
      </section>

      <section class="form-panel">
        <div class="mode-switch">
          <!-- Auth mode switch -->
          <button :class="{ active: activeMode === 'login' }" type="button" @click="activeMode = 'login'">登录</button>
          <button :class="{ active: activeMode === 'register-personal' }" type="button" @click="activeMode = 'register-personal'">个人注册</button>
          <button :class="{ active: activeMode === 'register-department' }" type="button" @click="activeMode = 'register-department'">部门注册</button>
        </div>

        <form v-if="activeMode === 'login'" class="form-body" @submit.prevent="handleLogin">
          <h2>欢迎回来</h2>
          <el-input v-model="loginForm.account" placeholder="用户名/手机号/邮箱" size="large" clearable>
            <template #prefix><el-icon><User /></el-icon></template>
          </el-input>
          <el-input v-model="loginForm.password" placeholder="密码" type="password" size="large" show-password>
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
          <div v-if="loginCaptchaVisible" class="captcha-row">
            <el-input v-model="loginForm.captcha" placeholder="图形验证码" size="large" clearable>
              <template #prefix><el-icon><Key /></el-icon></template>
            </el-input>
            <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha()">
              <img v-if="captchaImageSrc" :src="captchaImageSrc" alt="图形验证码">
              <span v-else>{{ captchaLoading ? '刷新中' : '获取验证码' }}</span>
            </button>
          </div>
          <p v-if="loginCaptchaVisible" class="captcha-hint">{{ captchaHintText }}</p>
          <div class="form-actions">
            <router-link v-if="forgotPasswordAvailable" to="/client/forgot-password" class="link-btn">忘记密码</router-link>
          </div>
          <el-button class="submit-btn" native-type="submit" :loading="loading">进入商品大厅</el-button>
        </form>

        <form v-else class="form-body" @submit.prevent="handleRegister">
          <h2>{{ isDepartmentRegister ? '创建部门账号' : '创建个人账号' }}</h2>
          <div class="register-type-switch">
            <button :class="{ active: registerAccountType === 'personal' }" type="button" @click="registerAccountType = 'personal'">个人注册</button>
            <button :class="{ active: registerAccountType === 'department' }" type="button" @click="registerAccountType = 'department'">部门注册</button>
          </div>

          <el-input v-model="registerForm.username" placeholder="真实姓名（必填）" size="large" clearable>
            <template #prefix><el-icon><User /></el-icon></template>
          </el-input>
          <el-input v-model="registerForm.account" placeholder="登录账号（手机号或邮箱）" size="large" clearable>
            <template #prefix><el-icon><User /></el-icon></template>
          </el-input>
          <el-input
            v-if="isDepartmentRegister"
            v-model="registerForm.staffNo"
            placeholder="教职工号（部门账号必填）"
            size="large"
            clearable
          />
          <el-tree-select
            v-if="isDepartmentRegister && hasRegisterDepartmentTree"
            v-model="registerForm.department"
            :data="registerDepartmentTreeSelectData"
            node-key="id"
            :props="{ label: 'label', value: 'value', children: 'children' }"
            check-strictly
            :expand-on-click-node="false"
            :render-after-expand="false"
            :placeholder="capabilityLoading ? '部门选项加载中' : '所属部门（目录未导入时需手动选择）'"
            size="large"
            clearable
            filterable
          />
          <el-input
            v-else-if="isDepartmentRegister"
            v-model="registerForm.department"
            placeholder="所属部门（部门账号必填）"
            size="large"
            clearable
          />
          <p v-if="isDepartmentRegister && !hasRegisterDepartmentTree" class="field-tip">
            当前尚未导入部门树，请手动填写所属部门名称
          </p>
          <p v-else-if="!isDepartmentRegister" class="field-tip">
            个人账号默认按散客流程下单
          </p>

          <div class="captcha-row">
            <el-input
              v-model="registerForm.captcha"
              :placeholder="registerUsesVerificationCode ? '先输入图形验证码，再发送短信/邮箱验证码' : '图形验证码'"
              size="large"
              clearable
            >
              <template #prefix><el-icon><Key /></el-icon></template>
            </el-input>
            <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha()">
              <img v-if="captchaImageSrc" :src="captchaImageSrc" alt="图形验证码">
              <span v-else>{{ captchaLoading ? '刷新中' : '获取验证码' }}</span>
            </button>
          </div>
          <p class="captcha-hint">{{ captchaHintText }}</p>

          <div v-if="registerUsesVerificationCode" class="captcha-row">
            <el-input v-model="registerForm.verificationCode" placeholder="手机/邮箱验证码" size="large" clearable>
              <template #prefix><el-icon><Message /></el-icon></template>
            </el-input>
            <el-button :disabled="verificationSending || registerVerificationCountdown > 0" @click="handleSendRegisterVerificationCode">
              {{ registerVerificationCountdown > 0 ? `${registerVerificationCountdown}s 后重发` : verificationSending ? '发送中' : '发送验证码' }}
            </el-button>
          </div>

          <el-input v-model="registerForm.password" :placeholder="CLIENT_NEW_PASSWORD_PLACEHOLDER" type="password" size="large" show-password>
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
          <el-input
            v-model="registerForm.confirmPassword"
            :placeholder="CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER"
            type="password"
            size="large"
            show-password
          >
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
          <p class="field-tip">{{ CLIENT_NEW_PASSWORD_RULE_HINT }}</p>

          <el-button class="submit-btn" native-type="submit" :loading="loading">立即注册</el-button>
        </form>
      </section>
    </main>
  </div>
</template>

<style scoped>
.client-auth-page {
  min-height: 100dvh;
  background: #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.auth-shell {
  width: min(1080px, 100%);
  min-height: 680px;
  background: #fff;
  border-radius: 28px;
  box-shadow: 0 18px 36px rgba(15, 23, 42, 0.08);
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(320px, 42%) 1fr;
}

.brand-panel {
  padding: 42px 36px;
  background: linear-gradient(135deg, #f0fdfa, #f8fafc);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.brand-tag {
  width: fit-content;
  font-size: 14px;
  letter-spacing: 0;
  color: #0f172a;
  background: #bde8e1;
  border-radius: 12px;
  padding: 8px 14px;
  font-weight: 700;
}

.brand-title {
  margin: 24px 0 0;
  font-size: 56px;
  line-height: 1.08;
  color: #0f172a;
}

.brand-desc {
  margin-top: 18px;
  font-size: 24px;
  color: #475569;
}

.brand-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
  color: #64748b;
}

.brand-footer a {
  color: inherit;
  text-decoration: none;
}

.form-panel {
  padding: 36px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.mode-switch {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  background: #e2e8f0;
  border-radius: 16px;
  padding: 6px;
}

.mode-switch button,
.register-type-switch button {
  height: 46px;
  border-radius: 12px;
  border: 0;
  background: transparent;
  color: #475569;
  font-weight: 700;
  cursor: pointer;
}

.mode-switch button.active,
.register-type-switch button.active {
  background: #fff;
  color: #0f172a;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}

.register-type-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  background: #f1f5f9;
  border-radius: 14px;
  padding: 6px;
}

.form-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-body h2 {
  margin: 8px 0 4px;
  font-size: 40px;
  line-height: 1.2;
  color: #0f172a;
}

.captcha-row {
  display: grid;
  grid-template-columns: 1fr 168px;
  gap: 10px;
}

.captcha-box {
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  background: #f8fafc;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
}

.captcha-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 12px;
}

.captcha-hint {
  margin: -6px 0 0;
  font-size: 12px;
  color: #64748b;
}

.field-tip {
  margin: -6px 0 0;
  font-size: 12px;
  color: #64748b;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.link-btn {
  font-size: 13px;
  color: #0d9488;
  text-decoration: none;
}

.submit-btn {
  margin-top: 4px;
  height: 48px;
  border-radius: 999px;
}

@media (max-width: 1024px) {
  .auth-shell {
    grid-template-columns: 1fr;
  }

  .brand-panel {
    padding: 24px 20px;
  }

  .brand-title {
    font-size: 42px;
  }

  .brand-desc {
    font-size: 16px;
  }

  .form-panel {
    padding: 24px 20px;
  }

  .form-body h2 {
    font-size: 32px;
  }
}

@media (max-width: 640px) {
  .client-auth-page {
    padding: 0;
  }

  .auth-shell {
    min-height: 100dvh;
    border-radius: 0;
  }

  .captcha-row {
    grid-template-columns: 1fr 132px;
  }
}
</style>
