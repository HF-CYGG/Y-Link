


























































<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientAuthView.vue
 * 文件职责：客户端登录/注册总入口，负责账号登录、注册、验证码刷新与登录后回跳。
 * 维护说明：当前页面已切换为 Split-Card 一体化布局，视觉可继续调整，但登录/注册/验证码链路需保持可用。
 */

import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Key, Lock, Message, User } from '@element-plus/icons-vue'
import { getClientAuthCapabilities, getClientCaptcha, type ClientAuthCapabilities, type ClientValidationMode } from '@/api/modules/client-auth'
import { useClientAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

type AuthMode = 'login' | 'register'

interface ClientCaptchaState {
  captchaId: string
  captchaSvg: string
  expiresInSeconds: number
}

const router = useRouter()
const route = useRoute()
const clientAuthStore = useClientAuthStore()

// 登录 / 注册模式切换：
// - UI 上通过胶囊滑块展示；
// - 状态上仍兼容 query 透传，便于注册后回到登录页。
const activeMode = ref<AuthMode>('login')
const isLoading = ref(false)
const captchaLoading = ref(false)
const loginCaptchaVisible = ref(false)
const successTip = ref('')
const securityHint = ref('')
const verificationSending = ref(false)
const capabilityLoading = ref(false)
const registerVerificationCountdown = ref(0)
let registerVerificationTimer: ReturnType<typeof globalThis.setInterval> | null = null
let captchaExpireTimer: ReturnType<typeof globalThis.setInterval> | null = null
const formWrapperRef = ref<HTMLElement | null>(null)
const formBlockRef = ref<HTMLElement | null>(null)
const formWrapperHeight = ref('auto')
const formAnimating = ref(false)
const formTransitionName = ref<'slide-left' | 'slide-right'>('slide-right')
const authCapabilities = ref<ClientAuthCapabilities | null>(null)
const captcha = reactive<ClientCaptchaState>({
  captchaId: '',
  captchaSvg: '',
  expiresInSeconds: 0,
})

const loginForm = reactive({
  account: '',
  password: '',
  captcha: '',
})

const registerForm = reactive({
  username: '',
  account: '',
  department: '',
  password: '',
  confirmPassword: '',
  verificationCode: '',
  captcha: '',
})

// 登录成功后优先跳回用户原本准备访问的客户端页面，否则进入商品大厅。
const redirectPath = computed(() => {
  const raw = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/client/mall'
})

const registerAccountChannel = computed(() => resolveAccountChannel(registerForm.account))
const registerValidationMode = computed<ClientValidationMode>(() => {
  const channel = registerAccountChannel.value
  if (!channel) {
    return 'captcha'
  }
  return authCapabilities.value?.registerValidationModes[channel] ?? 'captcha'
})
const registerUsesVerificationCode = computed(() => registerValidationMode.value === 'verification_code')
const registerDepartmentOptions = computed(() => authCapabilities.value?.departmentOptions ?? [])
const registerValidationHint = computed(() => {
  const channel = registerAccountChannel.value
  if (!channel) {
    return '请输入手机号或邮箱，系统会自动选择当前可用的注册校验方式。'
  }
  if (registerUsesVerificationCode.value) {
    return `${channel === 'email' ? '当前邮箱通道已启用邮箱验证码' : '当前手机通道已启用短信验证码'}，发送验证码前仍需先通过图形验证码校验。`
  }
  return `${channel === 'email' ? '当前邮箱通道未启用邮箱验证码' : '当前手机通道未启用短信验证码'}，注册时将改用图片验证码校验。`
})

const captchaHintText = computed(() => {
  if (captcha.expiresInSeconds <= 0) {
    return '点击右侧验证码图片可立即刷新。'
  }
  return `图形验证码约 ${captcha.expiresInSeconds}s 后失效，点击图片可立即刷新。`
})

const isCompactLoginLayout = computed(() => {
  return activeMode.value === 'login' && !loginCaptchaVisible.value && !successTip.value && !securityHint.value
})

const getElementHeight = (element: Element | HTMLElement | null | undefined) => {
  return element instanceof HTMLElement ? element.offsetHeight : 0
}

const syncWrapperHeight = (heightMode: 'auto' | 'measured' = 'auto', element?: Element | HTMLElement | null) => {
  const targetElement = element ?? formBlockRef.value
  if (heightMode === 'auto') {
    formWrapperHeight.value = 'auto'
    return
  }
  const nextHeight = getElementHeight(targetElement)
  if (nextHeight > 0) {
    formWrapperHeight.value = `${nextHeight}px`
  }
}

const switchMode = async (nextMode: AuthMode) => {
  if (activeMode.value === nextMode || formAnimating.value) {
    return
  }

  formTransitionName.value = nextMode === 'register' ? 'slide-left' : 'slide-right'
  formAnimating.value = true
  syncWrapperHeight('measured')
  activeMode.value = nextMode
}

const handleFormBeforeLeave = () => {
  syncWrapperHeight('measured', formWrapperRef.value)
  // 强制浏览器确认当前高度帧，避免切换起始时出现跳帧或闪现。
  if (formWrapperRef.value) {
    formWrapperRef.value.getBoundingClientRect()
  }
}

const handleFormBeforeEnter = () => {
  syncWrapperHeight('measured', formWrapperRef.value)
}

const handleFormEnter = (element: Element) => {
  requestAnimationFrame(() => {
    syncWrapperHeight('measured', element)
  })
}

const handleFormAfterEnter = () => {
  formAnimating.value = false
  syncWrapperHeight('auto')
}

const handleFormTransitionCancelled = () => {
  formAnimating.value = false
  syncWrapperHeight('auto')
}

const applyRouteState = () => {
  const registeredAccount = typeof route.query.account === 'string' ? route.query.account.trim() : ''
  activeMode.value = route.query.tab === 'register' ? 'register' : 'login'
  successTip.value = typeof route.query.notice === 'string' ? route.query.notice : ''

  if (registeredAccount) {
    loginForm.account = registeredAccount
  }
}

// 图形验证码按需拉取：
// - 登录页仅在首轮失败后展示；
// - 注册页在当前通道走图片验证码时展示。
const refreshCaptcha = async (silent = false) => {
  captchaLoading.value = true
  try {
    const result = await getClientCaptcha()
    captcha.captchaId = result.captchaId
    captcha.captchaSvg = result.captchaSvg
    captcha.expiresInSeconds = result.expiresInSeconds
    if (captchaExpireTimer) {
      globalThis.clearInterval(captchaExpireTimer)
    }
    captchaExpireTimer = globalThis.setInterval(() => {
      if (captcha.expiresInSeconds <= 1) {
        captcha.expiresInSeconds = 0
        if (captchaExpireTimer) {
          globalThis.clearInterval(captchaExpireTimer)
          captchaExpireTimer = null
        }
        return
      }
      captcha.expiresInSeconds -= 1
    }, 1000)
    if (!silent) {
      ElMessage.success('已刷新验证码')
    }
  } finally {
    captchaLoading.value = false
  }
}

const clearCaptcha = () => {
  captcha.captchaId = ''
  captcha.captchaSvg = ''
  captcha.expiresInSeconds = 0
  if (captchaExpireTimer) {
    globalThis.clearInterval(captchaExpireTimer)
    captchaExpireTimer = null
  }
}

const ensureCaptchaReady = async () => {
  if (captcha.captchaId && captcha.captchaSvg) {
    return
  }
  await refreshCaptcha(true)
}

const handleManualRefreshCaptcha = async () => {
  await refreshCaptcha()
}

const loadAuthCapabilities = async () => {
  capabilityLoading.value = true
  try {
    authCapabilities.value = await getClientAuthCapabilities()
  } catch (error) {
    const message = extractErrorMessage(error, '加载客户端校验策略失败，请稍后重试')
    ElMessage.error(message)
  } finally {
    capabilityLoading.value = false
  }
}

const validateMobile = (mobile: string) => /^1\d{10}$/.test(mobile.trim())
const validateEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
const validatePassword = (password: string) => {
  const normalized = password.trim()
  return normalized.length >= 8 && /[A-Za-z]/.test(normalized) && /\d/.test(normalized)
}
const validateUsername = (username: string) => username.trim().length >= 2
const validateLoginAccount = (account: string) => account.trim().length > 0
const resolveAccountChannel = (account: string): 'mobile' | 'email' | null => {
  const normalized = account.trim()
  if (!normalized) return null
  if (normalized.includes('@')) {
    return validateEmail(normalized) ? 'email' : null
  }
  return validateMobile(normalized) ? 'mobile' : null
}

const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
}

const resetRegisterVerificationTimer = () => {
  if (registerVerificationTimer) {
    globalThis.clearInterval(registerVerificationTimer)
    registerVerificationTimer = null
  }
  registerVerificationCountdown.value = 0
}

const startRegisterVerificationCountdown = (seconds: number) => {
  resetRegisterVerificationTimer()
  registerVerificationCountdown.value = seconds
  registerVerificationTimer = globalThis.setInterval(() => {
    if (registerVerificationCountdown.value <= 1) {
      resetRegisterVerificationTimer()
      return
    }
    registerVerificationCountdown.value -= 1
  }, 1000)
}

const handleSendRegisterVerificationCode = async () => {
  if (!registerUsesVerificationCode.value) {
    ElMessage.warning('当前账号类型未启用验证码注册，请根据页面提示使用图片验证码完成注册')
    return
  }
  const channel = resolveAccountChannel(registerForm.account)
  if (!channel) {
    ElMessage.warning('请输入正确的手机号或邮箱')
    return
  }
  if (!captcha.captchaId || !registerForm.captcha.trim()) {
    ElMessage.warning('发送验证码前请先输入图形验证码')
    await ensureCaptchaReady()
    return
  }
  verificationSending.value = true
  try {
    const result = await clientAuthStore.sendVerificationCode({
      channel,
      target: registerForm.account.trim(),
      scene: 'register',
      captchaId: captcha.captchaId,
      captchaCode: registerForm.captcha.trim(),
    })
    ElMessage.success(`${channel === 'email' ? '邮箱' : '手机'}验证码已发送`)
    registerForm.captcha = ''
    await refreshCaptcha(true)
    startRegisterVerificationCountdown(result.expireSeconds)
  } catch (error) {
    const message = extractErrorMessage(error, '验证码发送失败，请稍后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
    registerForm.captcha = ''
    await refreshCaptcha(true)
  } finally {
    verificationSending.value = false
  }
}

// 详细注释：提交登录表单。首先进行基础校验，然后调用 auth store 登录，成功后跳转至原页面或大厅。
const handleLogin = async () => {
  if (!validateLoginAccount(loginForm.account)) {
    ElMessage.warning('请输入用户名、手机号或邮箱')
    return
  }
  if (!validatePassword(loginForm.password)) {
    ElMessage.warning('密码至少 8 位，且需包含字母和数字')
    return
  }
  if (loginCaptchaVisible.value) {
    if (!captcha.captchaId || !loginForm.captcha.trim()) {
      ElMessage.warning('请输入图形验证码')
      return
    }
  }

  isLoading.value = true
  try {
    await clientAuthStore.login({
      account: loginForm.account.trim(),
      password: loginForm.password,
      captchaId: loginCaptchaVisible.value ? captcha.captchaId : undefined,
      captchaCode: loginCaptchaVisible.value ? loginForm.captcha.trim() : undefined,
    })
    loginCaptchaVisible.value = false
    loginForm.captcha = ''
    clearCaptcha()
    ElMessage.success('登录成功，欢迎来到 Y-Link 客户端')
    await router.replace(redirectPath.value)
  } catch (error) {
    const message = extractErrorMessage(error, '登录失败，请检查用户名、手机号、邮箱、密码和验证码后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
    if (/用户名或密码错误|图形验证码|锁定|稍后|重试/.test(message)) {
      loginCaptchaVisible.value = true
      loginForm.captcha = ''
      await refreshCaptcha(true)
    }
  } finally {
    isLoading.value = false
  }
}

const handleRegister = async () => {
  const accountChannel = resolveAccountChannel(registerForm.account)
  if (!validateUsername(registerForm.username)) {
    ElMessage.warning('用户名至少 2 位')
    return
  }
  if (!accountChannel) {
    ElMessage.warning('请输入正确的手机号或邮箱作为登录账号')
    return
  }
  if (!validatePassword(registerForm.password)) {
    ElMessage.warning('密码至少 8 位，且需包含字母和数字')
    return
  }
  if (registerForm.password !== registerForm.confirmPassword) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  if (registerForm.department.trim() && !registerDepartmentOptions.value.includes(registerForm.department.trim())) {
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

  isLoading.value = true
  try {
    const registeredAccount = registerForm.account.trim()
    const registeredUsername = registerForm.username.trim()
    await clientAuthStore.register({
      username: registeredUsername,
      account: registeredAccount,
      password: registerForm.password,
      departmentName: registerForm.department.trim() || undefined,
      verificationCode: registerUsesVerificationCode.value ? registerForm.verificationCode.trim() : undefined,
      captchaId: registerUsesVerificationCode.value ? undefined : captcha.captchaId,
      captchaCode: registerUsesVerificationCode.value ? undefined : registerForm.captcha.trim(),
    })
    ElMessage.success('注册成功，请登录')
    activeMode.value = 'login'
    loginForm.account = registeredAccount
    loginForm.password = ''
    loginForm.captcha = ''
    successTip.value = '账号已创建成功，请使用用户名、手机号或邮箱与密码登录。'
    registerForm.captcha = ''
    registerForm.verificationCode = ''
    registerForm.username = ''
    registerForm.password = ''
    registerForm.confirmPassword = ''
    registerForm.department = ''
    await refreshCaptcha(true)
    await router.replace({
      path: '/client/login',
      query: {
        tab: 'login',
        account: registeredAccount,
        notice: successTip.value,
      },
    })
  } catch (error) {
    const message = extractErrorMessage(error, '注册失败，请检查信息后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
    registerForm.captcha = ''
    await refreshCaptcha(true)
  } finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  if (clientAuthStore.isAuthenticated) {
    await router.replace('/client/mall')
    return
  }
  applyRouteState()
  await loadAuthCapabilities()
  await nextTick()
  syncWrapperHeight()
  resetRegisterVerificationTimer()
})

watch(
  () => route.fullPath,
  () => {
    applyRouteState()
  },
)

watch(registerValidationMode, (mode) => {
  if (mode !== 'verification_code') {
    resetRegisterVerificationTimer()
    registerForm.verificationCode = ''
  }
})

watch(
  [activeMode, loginCaptchaVisible, registerUsesVerificationCode],
  async ([mode, shouldShowLoginCaptcha, usesVerificationCode]) => {
    const shouldShowCaptcha = (mode === 'login' && shouldShowLoginCaptcha) || mode === 'register' || !usesVerificationCode
    if (shouldShowCaptcha) {
      await ensureCaptchaReady()
    }
  },
  { immediate: true },
)

watch(successTip, async () => {
  await nextTick()
  syncWrapperHeight('measured')
  requestAnimationFrame(() => {
    syncWrapperHeight('auto')
  })
})

onUnmounted(() => {
  // 页面离开时主动清理倒计时，避免重复进入后产生多个定时器。
  resetRegisterVerificationTimer()
  clearCaptcha()
})
</script>

<template>
  <div class="client-auth-page">
    <div class="bg-shape shape-1"></div>
    <div class="bg-shape shape-2"></div>

    <main class="auth-shell">
      <aside class="brand-panel">
        <div class="geo-decor circle-main"></div>
        <div class="geo-decor circle-sub"></div>

        <div class="brand-content">
          <div class="brand-tag">Y-LINK CLIENT</div>
          <h1 class="brand-title">野辙文创<br />极简预订</h1>
          <p class="brand-desc">实时查看库存，在线预订即锁单。<br />线下出示核销码，即刻带走心仪好物。</p>
        </div>

        <div class="brand-footer">&copy; 2026 Y-Link System. All rights reserved.</div>
      </aside>

      <section class="form-panel">
        <div class="form-container">
          <div class="mode-toggle">
            <div class="toggle-slider" :class="activeMode === 'register' ? 'translate-x-full' : 'translate-x-0'"></div>
            <button class="toggle-btn" :class="{ 'is-active': activeMode === 'login' }" @click="switchMode('login')">登录</button>
            <button class="toggle-btn" :class="{ 'is-active': activeMode === 'register' }" @click="switchMode('register')">
              注册
            </button>
          </div>

          <div v-if="successTip" class="success-pill">
            <span>{{ successTip }}</span>
          </div>

          <el-alert
            v-if="securityHint"
            class="mb-4"
            type="warning"
            :closable="false"
            show-icon
            :title="securityHint"
          />

          <div ref="formWrapperRef" class="form-wrapper" :style="{ height: formWrapperHeight }">
            <transition
              :name="formTransitionName"
              @before-enter="handleFormBeforeEnter"
              @before-leave="handleFormBeforeLeave"
              @enter="handleFormEnter"
              @after-enter="handleFormAfterEnter"
              @enter-cancelled="handleFormTransitionCancelled"
              @leave-cancelled="handleFormTransitionCancelled"
            >
              <div
                v-if="activeMode === 'login'"
                ref="formBlockRef"
                key="login"
                class="form-block"
                :class="{ 'form-block--login-compact': isCompactLoginLayout }"
              >
                <h2 class="block-title">欢迎回来</h2>
                <p class="block-subtitle">请输入用户名、手机号或邮箱与密码登录客户端</p>

                <el-form
                  @submit.prevent="handleLogin"
                  class="mt-6 space-y-4"
                  :class="{ 'login-form--compact': isCompactLoginLayout }"
                >
                  <el-input v-model="loginForm.account" placeholder="用户名 / 手机号 / 邮箱" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>

                  <el-input v-model="loginForm.password" placeholder="密码" type="password" class="geo-input" size="large" show-password>
                    <template #prefix>
                      <el-icon class="input-icon"><Lock /></el-icon>
                    </template>
                  </el-input>

                  <div v-if="loginCaptchaVisible" class="captcha-row">
                    <el-input v-model="loginForm.captcha" placeholder="图形验证码" class="geo-input flex-1" size="large" clearable>
                      <template #prefix>
                        <el-icon class="input-icon"><Key /></el-icon>
                      </template>
                    </el-input>

                    <button type="button" class="captcha-box" :disabled="captchaLoading" @click="handleManualRefreshCaptcha">
                      <span v-if="captchaLoading" class="captcha-loading">刷新中</span>
                      <span v-else class="captcha-render" v-html="captcha.captchaSvg" />
                    </button>
                  </div>
                  <p v-if="loginCaptchaVisible" class="captcha-hint-text">{{ captchaHintText }}</p>
                  <div
                    v-else
                    class="captcha-row captcha-row--placeholder"
                    :class="{ 'captcha-row--compact-placeholder': isCompactLoginLayout }"
                    aria-hidden="true"
                  >
                    <div class="captcha-placeholder flex-1"></div>
                    <div class="captcha-box captcha-box--placeholder"></div>
                  </div>

                  <div v-if="!capabilityLoading && authCapabilities?.forgotPasswordEnabled" class="flex justify-end mt-2">
                    <router-link to="/client/forgot-password" class="forgot-link">忘记密码？</router-link>
                  </div>

                  <el-button class="submit-btn" :loading="isLoading" @click="handleLogin">进入商品大厅</el-button>
                </el-form>
              </div>

              <div v-else ref="formBlockRef" key="register" class="form-block">
                <h2 class="block-title">创建账号</h2>
                <p class="block-subtitle">只需几步，创建用户名并绑定手机号或邮箱账号</p>
                <div class="auth-hint-card">
                  {{ capabilityLoading ? '正在加载当前注册校验策略...' : registerValidationHint }}
                </div>

                <el-form @submit.prevent="handleRegister" class="space-y-4 mt-6">
                  <el-input v-model="registerForm.username" placeholder="用户名（可自定义）" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>

                  <el-input v-model="registerForm.account" placeholder="登录账号（手机号或邮箱）" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>

                  <el-select
                    v-model="registerForm.department"
                    placeholder="所属部门（选填）"
                    class="geo-input-select"
                    size="large"
                    clearable
                    filterable
                  >
                    <el-option
                      v-for="department in registerDepartmentOptions"
                      :key="department"
                      :label="department"
                      :value="department"
                    />
                  </el-select>
                  <p v-if="registerDepartmentOptions.length === 0" class="mt-1 text-xs text-slate-400">暂无可选部门，请联系管理员配置</p>
                  <div class="captcha-row">
                    <el-input
                      v-model="registerForm.captcha"
                      :placeholder="registerUsesVerificationCode ? '先输入图形验证码，再发送手机/邮箱验证码' : '图形验证码'"
                      class="geo-input flex-1"
                      size="large"
                      clearable
                    >
                      <template #prefix>
                        <el-icon class="input-icon"><Key /></el-icon>
                      </template>
                    </el-input>

                    <button type="button" class="captcha-box" :disabled="captchaLoading" @click="handleManualRefreshCaptcha">
                      <span v-if="captchaLoading" class="captcha-loading">刷新中</span>
                      <span v-else class="captcha-render" v-html="captcha.captchaSvg" />
                    </button>
                  </div>
                  <p class="captcha-hint-text">{{ captchaHintText }}</p>
                  <div v-if="registerUsesVerificationCode" class="captcha-row">
                    <el-input v-model="registerForm.verificationCode" placeholder="手机/邮箱验证码" class="geo-input flex-1" size="large" clearable>
                      <template #prefix>
                        <el-icon class="input-icon"><Message /></el-icon>
                      </template>
                    </el-input>
                    <el-button
                      class="verification-code-button"
                      :disabled="verificationSending || registerVerificationCountdown > 0"
                      @click="handleSendRegisterVerificationCode"
                    >
                      {{
                        registerVerificationCountdown > 0
                          ? `${registerVerificationCountdown}s 后重发`
                          : verificationSending
                            ? '发送中'
                            : '发送验证码'
                      }}
                    </el-button>
                  </div>

                  <el-input v-model="registerForm.password" placeholder="设置至少 6 位密码" type="password" class="geo-input" size="large" show-password>
                    <template #prefix>
                      <el-icon class="input-icon"><Lock /></el-icon>
                    </template>
                  </el-input>
                  <el-input
                    v-model="registerForm.confirmPassword"
                    placeholder="再次输入密码"
                    type="password"
                    class="geo-input"
                    size="large"
                    show-password
                  >
                    <template #prefix>
                      <el-icon class="input-icon"><Lock /></el-icon>
                    </template>
                  </el-input>
                  <p class="password-hint-text">密码至少 8 位，且需同时包含字母和数字。</p>

                  <div v-if="!registerUsesVerificationCode" class="captcha-row sr-only">
                    <el-input v-model="registerForm.captcha" placeholder="图形验证码" class="geo-input flex-1" size="large" clearable>
                      <template #prefix>
                        <el-icon class="input-icon"><Key /></el-icon>
                      </template>
                    </el-input>

                    <button type="button" class="captcha-box" :disabled="captchaLoading" @click="handleManualRefreshCaptcha">
                      <span v-if="captchaLoading" class="captcha-loading">刷新中</span>
                      <span v-else class="captcha-render" v-html="captcha.captchaSvg" />
                    </button>
                  </div>
                  <el-button class="submit-btn" :loading="isLoading" @click="handleRegister">立即注册</el-button>
                </el-form>
              </div>
            </transition>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.client-auth-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #f1f5f9;
  position: relative;
  overflow: hidden;
  padding: 24px;
}

.bg-shape {
  position: absolute;
  filter: blur(100px);
  z-index: 0;
  pointer-events: none;
}

.shape-1 {
  width: 60vw;
  height: 60vw;
  background: rgba(13, 148, 136, 0.05);
  top: -20%;
  left: -20%;
  border-radius: 50%;
}

.shape-2 {
  width: 50vw;
  height: 50vw;
  background: rgba(56, 189, 248, 0.05);
  bottom: -10%;
  right: -10%;
  border-radius: 50%;
}

.auth-shell {
  position: relative;
  z-index: 10;
  display: flex;
  width: 100%;
  max-width: 960px;
  min-height: 600px;
  background: #ffffff;
  border-radius: 32px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.02);
  overflow: hidden;
}

.brand-panel {
  flex: 1;
  background: linear-gradient(135deg, #f0fdfa 0%, #f8fafc 100%);
  padding: 48px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  position: relative;
  overflow: hidden;
}

.geo-decor {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}

.circle-main {
  width: 300px;
  height: 300px;
  background: rgba(13, 148, 136, 0.04);
  border: 1px solid rgba(13, 148, 136, 0.08);
  top: -50px;
  right: -80px;
}

.circle-sub {
  width: 200px;
  height: 200px;
  background: rgba(13, 148, 136, 0.03);
  bottom: 10%;
  left: -50px;
}

.brand-content {
  position: relative;
  z-index: 1;
  margin-top: 20px;
}

.brand-tag {
  display: inline-block;
  padding: 6px 14px;
  background: rgba(13, 148, 136, 0.22);
  color: #0f172a;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1px;
  margin-bottom: 32px;
}

.brand-title {
  font-size: 44px;
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.02em;
  margin-bottom: 24px;
  color: #0f172a;
}

.brand-desc {
  font-size: 15px;
  line-height: 1.8;
  color: #475569;
  max-width: 90%;
}

.brand-footer {
  font-size: 12px;
  color: #94a3b8;
  position: relative;
  z-index: 1;
}

.form-panel {
  flex: 1.1;
  background: #ffffff;
  padding: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.form-container {
  width: 100%;
  max-width: 340px;
  position: relative;
  z-index: 1;
}

.form-wrapper {
  overflow: hidden;
  transition: height 0.45s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: height;
  position: relative;
}

.form-block {
  width: 100%;
}

.form-block--login-compact {
  padding-top: 18px;
}

.mode-toggle {
  position: relative;
  display: flex;
  background: #f1f5f9;
  padding: 5px;
  border-radius: 16px;
  margin-bottom: 40px;
}

.toggle-slider {
  position: absolute;
  top: 5px;
  left: 5px;
  width: calc(50% - 5px);
  height: calc(100% - 10px);
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.toggle-btn {
  flex: 1;
  position: relative;
  z-index: 10;
  padding: 10px 0;
  font-size: 14px;
  font-weight: 600;
  color: #64748b;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: color 0.3s;
}

.toggle-btn.is-active {
  color: #0f172a;
}

.success-pill {
  margin-bottom: 20px;
  border-radius: 16px;
  background: rgba(13, 148, 136, 0.18);
  color: #0f172a;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
}

.auth-hint-card {
  margin-top: 16px;
  border-radius: 16px;
  background: rgba(13, 148, 136, 0.16);
  color: #0f172a;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.7;
}

.block-title {
  font-size: 26px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 6px;
  letter-spacing: -0.5px;
}

.block-subtitle {
  font-size: 13px;
  color: #475569;
  margin-bottom: 24px;
}

.geo-input :deep(.el-input__wrapper) {
  height: 52px;
  border-radius: 14px;
  background-color: #f8fafc;
  border: 1px solid transparent;
  box-shadow: none !important;
  padding: 0 16px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.geo-input :deep(.el-input__wrapper:hover) {
  background-color: #f1f5f9;
}

.geo-input :deep(.el-input__wrapper.is-focus) {
  background-color: #ffffff;
  border-color: #0d9488;
  box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.1) !important;
}

.geo-input :deep(.el-input__inner) {
  color: #0f172a;
  font-weight: 500;
  font-size: 14px;
}

.geo-input-select :deep(.el-select__wrapper) {
  min-height: 52px;
  border-radius: 14px;
  background-color: #f8fafc;
  border: 1px solid transparent;
  box-shadow: none !important;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.geo-input-select :deep(.el-select__wrapper:hover) {
  background-color: #f1f5f9;
}

.geo-input-select :deep(.el-select__wrapper.is-focused) {
  background-color: #ffffff;
  border-color: #0d9488;
  box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.1) !important;
}

.input-icon {
  font-size: 18px;
  color: #94a3b8;
}

.geo-input :deep(.el-input__wrapper.is-focus .input-icon) {
  color: #0d9488;
}

.captcha-row {
  display: flex;
  gap: 12px;
}

.captcha-row--placeholder {
  pointer-events: none;
}

.captcha-row--compact-placeholder {
  margin-bottom: -36px;
}

.captcha-placeholder {
  height: 52px;
  border-radius: 14px;
  background: transparent;
}

.captcha-box {
  width: 120px;
  height: 52px;
  background: #f8fafc;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: background 0.2s, border-color 0.2s, transform 0.2s;
  border: 1px dashed #e2e8f0;
  overflow: hidden;
}

.captcha-box--placeholder {
  border-color: transparent;
  background: transparent;
}

.captcha-box:hover {
  background: #f1f5f9;
  transform: translateY(-1px);
}

.captcha-box:disabled {
  cursor: wait;
  transform: none;
}

.captcha-loading {
  font-size: 12px;
  color: #64748b;
}

.captcha-render {
  display: flex;
  align-items: center;
  justify-content: center;
}

.captcha-render :deep(svg) {
  width: 100px;
  height: 36px;
}

.captcha-hint-text,
.password-hint-text {
  margin-top: -6px;
  font-size: 12px;
  line-height: 1.6;
  color: #64748b;
}

.verification-code-button {
  min-width: 120px;
  border-radius: 14px;
}

.sr-only {
  display: none;
}

.forgot-link {
  font-size: 13px;
  color: #64748b;
  text-decoration: none;
  transition: color 0.2s;
}

.forgot-link:hover {
  color: #0d9488;
}

.login-form--compact {
  padding-top: 12px;
}

.submit-btn {
  width: 100%;
  height: 52px;
  border-radius: 14px !important;
  background-color: #0f766e !important;
  color: #ffffff !important;
  border: none !important;
  font-size: 15px !important;
  font-weight: 600 !important;
  margin-top: 24px;
  transition: all 0.2s !important;
}

.submit-btn:hover {
  background-color: #0f766e !important;
  box-shadow: 0 8px 20px rgba(13, 148, 136, 0.2) !important;
  transform: translateY(-1px);
}

.submit-btn:active {
  transform: translateY(1px);
}

.slide-right-enter-active,
.slide-right-leave-active,
.slide-left-enter-active,
.slide-left-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.32s cubic-bezier(0.4, 0, 0.2, 1);
}

.slide-right-enter-from {
  opacity: 0;
  transform: translateX(-10px);
}

.slide-right-leave-to {
  opacity: 0;
  transform: translateX(6px);
}

.slide-left-enter-from {
  opacity: 0;
  transform: translateX(10px);
}

.slide-left-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}

.slide-right-enter-active,
.slide-left-enter-active {
  position: relative;
  z-index: 2;
}

.slide-right-leave-active,
.slide-left-leave-active {
  position: absolute;
  inset: 0;
  width: 100%;
  z-index: 1;
  pointer-events: none;
}

@media (max-width: 860px) {
  .auth-shell {
    flex-direction: column;
    min-height: auto;
  }

  .brand-panel {
    padding: 40px 24px;
    flex: none;
  }

  .brand-title {
    font-size: 32px;
  }

  .brand-footer {
    display: none;
  }

  .form-panel {
    padding: 40px 24px;
  }
}
</style>
