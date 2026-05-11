


























































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
import {
  getClientAuthCapabilities,
  getClientCaptcha,
  type ClientAuthCapabilities,
  type ClientDepartmentOptionNode,
  type ClientValidationMode,
} from '@/api/modules/client-auth'
import { preloadRouteComponents, resolveClientPostLoginWarmupTargets } from '@/router/route-performance'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { useStableRequest } from '@/composables/useStableRequest'
import { useIdempotentAction } from '@/composables/useIdempotentAction'
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

type AuthMode = 'login' | 'register'

interface ClientCaptchaState {
  captchaId: string
  captchaSvg: string
  expiresInSeconds: number
}

const router = useRouter()
const route = useRoute()
const clientAuthStore = useClientAuthStore(pinia)
const { runLatest: runLatestCaptchaRequest, cancel: cancelCaptchaRequest } = useStableRequest()
const { runLatest: runLatestCapabilityRequest, cancel: cancelCapabilityRequest } = useStableRequest()
const { runLatest: runLatestLoginRequest, cancel: cancelLoginRequest } = useStableRequest()
const { runLatest: runLatestRegisterRequest, cancel: cancelRegisterRequest } = useStableRequest()
const { runLatest: runLatestVerificationCodeRequest, cancel: cancelVerificationCodeRequest } = useStableRequest()
const { runWithGate } = useIdempotentAction()

// 登录 / 注册模式切换：
// - UI 上通过胶囊滑块展示；
// - 状态上仍兼容 query 透传，便于注册后回到登录页。
const activeMode = ref<AuthMode>('login')
const isLoading = ref(false)
const captchaLoading = ref(false)
const loginCaptchaVisible = ref(false)
const successTip = ref('')
const securityHint = ref('')
const loginFeedbackTitle = ref('')
const loginFeedbackDescription = ref('')
const loginFeedbackType = ref<'warning' | 'error' | 'info'>('warning')
const loginFeedbackShowForgotAction = ref(false)
const registerFeedbackTitle = ref('')
const registerFeedbackDescription = ref('')
const registerFeedbackType = ref<'warning' | 'error' | 'info'>('warning')
const registerFeedbackShowLoginAction = ref(false)
const registerFeedbackShowForgotAction = ref(false)
const verificationSending = ref(false)
const capabilityLoading = ref(false)
const capabilityErrorMessage = ref('')
const registerVerificationCountdown = ref(0)
let registerVerificationTimer: ReturnType<typeof globalThis.setInterval> | null = null
let captchaExpireTimer: ReturnType<typeof globalThis.setInterval> | null = null
let capabilityDeferredTimer: ReturnType<typeof globalThis.setTimeout> | null = null
const formWrapperRef = ref<HTMLElement | null>(null)
const formBlockRef = ref<HTMLElement | null>(null)
const formWrapperHeight = ref('auto')
const formAnimating = ref(false)
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
const registerDepartmentTreeSelectData = computed(() => {
  return buildDepartmentTreeSelectData(authCapabilities.value?.departmentTree ?? [])
})
const shouldPrepareCaptcha = computed(() => activeMode.value === 'register' || loginCaptchaVisible.value)
const isCapabilityHintVisible = computed(() => capabilityLoading.value && !authCapabilities.value)
const isCapabilityFallbackVisible = computed(() => !capabilityLoading.value && !!capabilityErrorMessage.value && !authCapabilities.value)
const forgotPasswordAvailable = computed(() => authCapabilities.value?.forgotPasswordEnabled ?? false)

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

  formAnimating.value = true
  syncWrapperHeight('measured')
  loginFeedbackTitle.value = ''
  loginFeedbackDescription.value = ''
  loginFeedbackShowForgotAction.value = false
  registerFeedbackTitle.value = ''
  registerFeedbackDescription.value = ''
  registerFeedbackShowLoginAction.value = false
  registerFeedbackShowForgotAction.value = false
  activeMode.value = nextMode
}

const handleFormBeforeLeave = () => {
  syncWrapperHeight('measured', formWrapperRef.value)
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
  await runLatestCaptchaRequest({
    executor: (signal) => getClientCaptcha({ signal }),
    onSuccess: (result) => {
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
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '验证码刷新失败，请稍后重试')
      if (!silent) {
        ElMessage.error(normalizedError.message)
      }
    },
    onFinally: () => {
      captchaLoading.value = false
    },
  })
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

const loadAuthCapabilities = async (options: { silent?: boolean } = {}) => {
  capabilityLoading.value = true
  capabilityErrorMessage.value = ''
  await runLatestCapabilityRequest({
    executor: (signal) => getClientAuthCapabilities({ signal }),
    onSuccess: (result) => {
      authCapabilities.value = result
      capabilityErrorMessage.value = ''
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '加载客户端校验策略失败，请稍后重试')
      capabilityErrorMessage.value = normalizedError.message
      if (!options.silent) {
        ElMessage.error(normalizedError.message)
      }
    },
    onFinally: () => {
      capabilityLoading.value = false
    },
  })
}

const scheduleDeferredCapabilityLoad = () => {
  if (authCapabilities.value || capabilityLoading.value) {
    return
  }
  if (capabilityDeferredTimer) {
    globalThis.clearTimeout(capabilityDeferredTimer)
  }
  // 认证页首屏先让输入区和主按钮稳定渲染，辅助能力在首帧之后补齐。
  capabilityDeferredTimer = globalThis.setTimeout(() => {
    capabilityDeferredTimer = null
    void loadAuthCapabilities({ silent: true })
  }, 0)
}

const handleRetryLoadAuthCapabilities = async () => {
  await loadAuthCapabilities()
}

const validateMobile = (mobile: string) => /^1\d{10}$/.test(mobile.trim())
const validateEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
/**
 * 登录密码前端校验：
 * - 登录阶段只校验是否已输入密码，不在前端拦截历史弱密码账号；
 * - 真实密码正确性、是否需要验证码、是否被锁定，统一以后端返回为准。
 */
const validateLoginPassword = (password: string) => password.trim().length > 0
/**
 * 注册密码前端校验：
 * - 仅用于“创建新密码”的场景；
 * - 继续复用共享的新密码强度规则，保证注册与改密口径一致。
 */
const validateRegisterPassword = (password: string) => isClientNewPasswordValid(password)
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

const normalizeInputText = (value: string) => {
  return value.replaceAll(/\s+/g, ' ').trim()
}

interface RegisterDepartmentTreeSelectNode {
  id: string
  label: string
  value: string
  children: RegisterDepartmentTreeSelectNode[]
}

// 部门树下拉数据转换：
// - 下拉面板显示当前层级名称，保持类似“图 2”的紧凑树菜单；
// - 实际提交值仍保存为完整路径，继续兼容后端现有 departmentOptions 校验口径。
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

const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
}

const clearLoginFeedback = () => {
  loginFeedbackTitle.value = ''
  loginFeedbackDescription.value = ''
  loginFeedbackType.value = 'warning'
  loginFeedbackShowForgotAction.value = false
}

const applyLoginFeedbackFromError = (message: string, status?: number) => {
  clearLoginFeedback()

  if (status === 401 && /用户名或密码错误/.test(message)) {
    loginFeedbackTitle.value = '账号或密码不正确'
    loginFeedbackDescription.value = forgotPasswordAvailable.value
      ? '请检查用户名、手机号、邮箱和密码后重试；如果忘记密码，可直接进入找回密码。'
      : '请检查用户名、手机号、邮箱和密码后重试；当前系统未启用自助找回密码，请联系管理员手动修改密码。'
    loginFeedbackType.value = 'warning'
    loginFeedbackShowForgotAction.value = forgotPasswordAvailable.value
    return
  }

  if (status === 403 && /停用/.test(message)) {
    loginFeedbackTitle.value = '当前账号已停用'
    loginFeedbackDescription.value = '该客户端账号暂时不可用，请联系管理员确认账号状态。'
    loginFeedbackType.value = 'error'
    return
  }

  if (status === 429) {
    loginFeedbackTitle.value = /锁定/.test(message) ? '登录已被临时锁定' : '登录过于频繁'
    loginFeedbackDescription.value = forgotPasswordAvailable.value
      ? `${message} 如忘记密码，也可进入找回密码流程。`
      : message
    loginFeedbackType.value = 'warning'
    loginFeedbackShowForgotAction.value = forgotPasswordAvailable.value
    return
  }

  if (/图形验证码|验证码/.test(message)) {
    loginFeedbackTitle.value = '请先完成验证码校验'
    loginFeedbackDescription.value = message
    loginFeedbackType.value = 'info'
  }
}

const clearRegisterFeedback = () => {
  registerFeedbackTitle.value = ''
  registerFeedbackDescription.value = ''
  registerFeedbackType.value = 'warning'
  registerFeedbackShowLoginAction.value = false
  registerFeedbackShowForgotAction.value = false
}

const applyRegisterFeedbackFromError = (message: string, status?: number) => {
  clearRegisterFeedback()

  if (status === 409 && /该手机号或邮箱已被占用/.test(message)) {
    registerFeedbackTitle.value = '该手机号或邮箱已注册'
    registerFeedbackDescription.value = forgotPasswordAvailable.value
      ? '当前账号已经创建过客户端账号，可直接切换到登录；如果忘记密码，也可以进入找回密码流程。'
      : '当前账号已经创建过客户端账号，可直接切换到登录；当前系统未启用自助找回密码，请联系管理员手动修改密码。'
    registerFeedbackType.value = 'warning'
    registerFeedbackShowLoginAction.value = true
    registerFeedbackShowForgotAction.value = forgotPasswordAvailable.value
    return
  }

  if (status === 409 && /该用户名已被占用/.test(message)) {
    registerFeedbackTitle.value = '用户名已被占用'
    registerFeedbackDescription.value = '请更换一个新的用户名后再试，当前手机号或邮箱仍可继续作为登录账号使用。'
    registerFeedbackType.value = 'warning'
    return
  }

  if (status === 429) {
    registerFeedbackTitle.value = '注册过于频繁'
    registerFeedbackDescription.value = message
    registerFeedbackType.value = 'warning'
    registerFeedbackShowLoginAction.value = true
    return
  }

  if (/图形验证码|验证码/.test(message)) {
    registerFeedbackTitle.value = '请先完成验证码校验'
    registerFeedbackDescription.value = message
    registerFeedbackType.value = 'info'
  }
}

const handleRegisterFeedbackLogin = async () => {
  const registeredAccount = normalizeInputText(registerForm.account)
  if (registeredAccount) {
    loginForm.account = registeredAccount
  }
  await switchMode('login')
}

const handleRegisterFeedbackForgotPassword = async () => {
  const account = normalizeInputText(registerForm.account)
  await router.push({
    path: '/client/forgot-password',
    query: account ? { account } : undefined,
  })
}

const handleLoginFeedbackForgotPassword = async () => {
  const account = normalizeInputText(loginForm.account)
  await router.push({
    path: '/client/forgot-password',
    query: account ? { account } : undefined,
  })
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
  const runResult = await runWithGate({
    actionKey: 'client-auth-register-send-verification-code',
    onDuplicated: () => {
      ElMessage.info('验证码发送中，请勿重复点击')
    },
    executor: async () => {
      verificationSending.value = true
      securityHint.value = ''
      await runLatestVerificationCodeRequest({
        executor: (signal) =>
          clientAuthStore.sendVerificationCode(
            {
              channel,
              target: normalizeInputText(registerForm.account),
              scene: 'register',
              captchaId: captcha.captchaId,
              captchaCode: normalizeInputText(registerForm.captcha),
            },
            { signal },
          ),
        onSuccess: async (result) => {
          ElMessage.success(`${channel === 'email' ? '邮箱' : '手机'}验证码已发送`)
          registerForm.captcha = ''
          await refreshCaptcha(true)
          startRegisterVerificationCountdown(result.expireSeconds)
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '验证码发送失败，请稍后重试')
          applySecurityHintFromMessage(normalizedError.message)
          ElMessage.error(normalizedError.message)
          registerForm.captcha = ''
          await refreshCaptcha(true)
        },
        onFinally: () => {
          verificationSending.value = false
        },
      })
    },
  })
  if (runResult === null) {
    return
  }
}

// 详细注释：提交登录表单。首先进行基础校验，然后调用 auth store 登录，成功后跳转至原页面或大厅。
const handleLogin = async () => {
  if (!validateLoginAccount(loginForm.account)) {
    ElMessage.warning('请输入用户名、手机号或邮箱')
    return
  }
  if (!validateLoginPassword(loginForm.password)) {
    ElMessage.warning('请输入密码')
    return
  }
  if (loginCaptchaVisible.value) {
    if (!captcha.captchaId || !loginForm.captcha.trim()) {
      ElMessage.warning('请输入图形验证码')
      return
    }
  }

  const runResult = await runWithGate({
    actionKey: 'client-auth-login',
    onDuplicated: () => {
      ElMessage.info('登录请求处理中，请勿重复提交')
    },
    executor: async () => {
      isLoading.value = true
      successTip.value = ''
      securityHint.value = ''
      clearLoginFeedback()
      await runLatestLoginRequest({
        executor: (signal) =>
          clientAuthStore.login(
            {
              account: normalizeInputText(loginForm.account),
              password: loginForm.password,
              captchaId: loginCaptchaVisible.value ? captcha.captchaId : undefined,
              captchaCode: loginCaptchaVisible.value ? normalizeInputText(loginForm.captcha) : undefined,
            },
            { signal },
          ),
        onSuccess: async () => {
          loginCaptchaVisible.value = false
          loginForm.captcha = ''
          clearCaptcha()
          await preloadRouteComponents(resolveClientPostLoginWarmupTargets(redirectPath.value))
          ElMessage.success('登录成功，欢迎来到 Y-Link 客户端')
          await router.replace(redirectPath.value)
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '登录失败，请检查用户名、手机号、邮箱、密码和验证码后重试')
          applySecurityHintFromMessage(normalizedError.message)
          applyLoginFeedbackFromError(normalizedError.message, normalizedError.status)
          ElMessage.error(normalizedError.message)
          if (/用户名或密码错误|图形验证码|锁定|稍后|重试/.test(normalizedError.message)) {
            loginCaptchaVisible.value = true
            loginForm.captcha = ''
            await refreshCaptcha(true)
          }
        },
        onFinally: () => {
          isLoading.value = false
        },
      })
    },
  })
  if (runResult === null) {
    return
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
  if (!validateRegisterPassword(registerForm.password)) {
    ElMessage.warning(CLIENT_NEW_PASSWORD_RULE_TEXT)
    return
  }
  if (registerForm.password !== registerForm.confirmPassword) {
    ElMessage.warning(CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE)
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

  const runResult = await runWithGate({
    actionKey: 'client-auth-register',
    onDuplicated: () => {
      ElMessage.info('注册请求处理中，请勿重复提交')
    },
    executor: async () => {
      isLoading.value = true
      successTip.value = ''
      securityHint.value = ''
      clearRegisterFeedback()
      const registeredAccount = normalizeInputText(registerForm.account)
      const registeredUsername = normalizeInputText(registerForm.username)
      await runLatestRegisterRequest({
        executor: (signal) =>
          clientAuthStore.register(
            {
              username: registeredUsername,
              account: registeredAccount,
              password: registerForm.password,
              departmentName: normalizeInputText(registerForm.department) || undefined,
              verificationCode: registerUsesVerificationCode.value ? normalizeInputText(registerForm.verificationCode) : undefined,
              captchaId: registerUsesVerificationCode.value ? undefined : captcha.captchaId,
              captchaCode: registerUsesVerificationCode.value ? undefined : normalizeInputText(registerForm.captcha),
            },
            { signal },
          ),
        onSuccess: async () => {
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
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '注册失败，请检查信息后重试')
          applySecurityHintFromMessage(normalizedError.message)
          applyRegisterFeedbackFromError(normalizedError.message, normalizedError.status)
          ElMessage.error(normalizedError.message)
          registerForm.captcha = ''
          await refreshCaptcha(true)
        },
        onFinally: () => {
          isLoading.value = false
        },
      })
    },
  })
  if (runResult === null) {
    return
  }
}

onMounted(async () => {
  if (clientAuthStore.isAuthenticated) {
    await router.replace('/client/mall')
    return
  }
  applyRouteState()
  await nextTick()
  syncWrapperHeight()
  resetRegisterVerificationTimer()
  scheduleDeferredCapabilityLoad()
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

watch(shouldPrepareCaptcha, (shouldShowCaptcha) => {
  if (shouldShowCaptcha) {
    void ensureCaptchaReady()
  }
})

// 提示变化不再强制重算高度
watch(successTip, async () => {
  await nextTick()
  syncWrapperHeight('measured')
  requestAnimationFrame(() => {
    syncWrapperHeight('auto')
  })
})

onUnmounted(() => {
  // 页面离开时主动清理倒计时，避免重复进入后产生多个定时器。
  cancelCapabilityRequest()
  cancelCaptchaRequest()
  cancelLoginRequest()
  cancelRegisterRequest()
  cancelVerificationCodeRequest()
  if (capabilityDeferredTimer) {
    globalThis.clearTimeout(capabilityDeferredTimer)
    capabilityDeferredTimer = null
  }
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

        <div class="brand-footer">
          <div class="brand-footer__version">{{ APP_META.version }}</div>
          <div class="brand-footer__copyright">{{ APP_META.copyright }}</div>
        </div>
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
          <el-alert
            v-if="isCapabilityHintVisible"
            class="mb-4"
            type="info"
            :closable="false"
            show-icon
            title="正在补充认证辅助能力，核心输入区与主操作区已可直接使用。"
          />
          <el-alert v-else-if="isCapabilityFallbackVisible" class="mb-4" type="warning" :closable="false" show-icon>
            <template #title>
              认证辅助能力加载较慢，登录与注册基础流程仍可继续；如需忘记密码、部门选项或最新校验策略，请重试。
            </template>
            <template #default>
              <div class="capability-alert__content">
                <span>{{ capabilityErrorMessage }}</span>
                <el-button link type="primary" @click="handleRetryLoadAuthCapabilities">重新加载</el-button>
              </div>
            </template>
          </el-alert>

          <div ref="formWrapperRef" class="form-wrapper" :style="{ height: formWrapperHeight }">
            <transition
              name="auth-fade"
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

                <el-alert
                  v-if="loginFeedbackTitle"
                  class="mt-5"
                  :type="loginFeedbackType"
                  :closable="false"
                  show-icon
                >
                  <template #title>
                    {{ loginFeedbackTitle }}
                  </template>
                  <template #default>
                    <div class="register-feedback-alert">
                      <span>{{ loginFeedbackDescription }}</span>
                      <div v-if="loginFeedbackShowForgotAction" class="register-feedback-alert__actions">
                        <el-button link type="primary" @click="handleLoginFeedbackForgotPassword">
                          忘记密码
                        </el-button>
                      </div>
                    </div>
                  </template>
                </el-alert>

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

                  <div v-if="!capabilityLoading && forgotPasswordAvailable" class="flex justify-end mt-2">
                    <router-link to="/client/forgot-password" class="forgot-link">忘记密码？</router-link>
                  </div>

                  <el-button class="submit-btn" native-type="submit" :loading="isLoading">进入商品大厅</el-button>
                </el-form>
              </div>

              <div v-else ref="formBlockRef" key="register" class="form-block">
                <h2 class="block-title">创建账号</h2>
                <p class="block-subtitle">只需几步，创建用户名并绑定手机号或邮箱账号</p>

                <el-alert
                  v-if="registerFeedbackTitle"
                  class="mt-5"
                  :type="registerFeedbackType"
                  :closable="false"
                  show-icon
                >
                  <template #title>
                    {{ registerFeedbackTitle }}
                  </template>
                  <template #default>
                    <div class="register-feedback-alert">
                      <span>{{ registerFeedbackDescription }}</span>
                      <div
                        v-if="registerFeedbackShowLoginAction || registerFeedbackShowForgotAction"
                        class="register-feedback-alert__actions"
                      >
                        <el-button
                          v-if="registerFeedbackShowLoginAction"
                          link
                          type="primary"
                          @click="handleRegisterFeedbackLogin"
                        >
                          去登录
                        </el-button>
                        <el-button
                          v-if="registerFeedbackShowForgotAction"
                          link
                          type="primary"
                          @click="handleRegisterFeedbackForgotPassword"
                        >
                          忘记密码
                        </el-button>
                      </div>
                    </div>
                  </template>
                </el-alert>

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

                  <el-tree-select
                    v-model="registerForm.department"
                    :data="registerDepartmentTreeSelectData"
                    node-key="id"
                    :props="{ label: 'label', value: 'value', children: 'children' }"
                    check-strictly
                    :expand-on-click-node="false"
                    :render-after-expand="false"
                    :disabled="capabilityLoading && !authCapabilities"
                    :placeholder="capabilityLoading && !authCapabilities ? '部门选项加载中，可稍后再选' : '所属部门（选填）'"
                    class="geo-input-select"
                    size="large"
                    clearable
                    filterable
                    popper-class="client-auth-department-popper"
                  />
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

                  <el-input
                    v-model="registerForm.password"
                    :placeholder="CLIENT_NEW_PASSWORD_PLACEHOLDER"
                    type="password"
                    class="geo-input"
                    size="large"
                    show-password
                  >
                    <template #prefix>
                      <el-icon class="input-icon"><Lock /></el-icon>
                    </template>
                  </el-input>
                  <el-input
                    v-model="registerForm.confirmPassword"
                    :placeholder="CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER"
                    type="password"
                    class="geo-input"
                    size="large"
                    show-password
                  >
                    <template #prefix>
                      <el-icon class="input-icon"><Lock /></el-icon>
                    </template>
                  </el-input>
                  <p class="password-hint-text">{{ CLIENT_NEW_PASSWORD_RULE_HINT }}</p>

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
  color: #94a3b8;
  position: relative;
  z-index: 1;
}

.brand-footer__version {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.2;
}

.brand-footer__copyright {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
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
  transition: height 0.35s cubic-bezier(0.25, 1, 0.5, 1);
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

.register-feedback-alert {
  display: flex;
  flex-direction: column;
  gap: 10px;
  line-height: 1.6;
}

.register-feedback-alert__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
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
  transition:
    background-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    border-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    box-shadow var(--ylink-motion-normal) var(--ylink-motion-ease);
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

.geo-input-select :deep(.el-select__wrapper),
.geo-input-select :deep(.el-tree-select__wrapper) {
  min-height: 52px;
  border-radius: 14px;
  background-color: #f8fafc;
  border: 1px solid transparent;
  box-shadow: none !important;
  transition:
    background-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    border-color var(--ylink-motion-normal) var(--ylink-motion-ease),
    box-shadow var(--ylink-motion-normal) var(--ylink-motion-ease);
}

.geo-input-select :deep(.el-select__wrapper:hover),
.geo-input-select :deep(.el-tree-select__wrapper:hover) {
  background-color: #f1f5f9;
}

.geo-input-select :deep(.el-select__wrapper.is-focused),
.geo-input-select :deep(.el-tree-select__wrapper.is-focused) {
  background-color: #ffffff;
  border-color: #0d9488;
  box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.1) !important;
}

.geo-input-select :deep(.el-select__placeholder),
.geo-input-select :deep(.el-input__inner) {
  font-size: 14px;
  font-weight: 500;
}

:global(.client-auth-department-popper.el-select__popper) {
  border-radius: 16px;
  padding: 6px;
}

:global(.client-auth-department-popper .el-scrollbar__view) {
  padding: 4px 0;
}

:global(.client-auth-department-popper .el-tree) {
  --el-tree-node-hover-bg-color: #f1f5f9;
  background: transparent;
}

:global(.client-auth-department-popper .el-tree-node__content) {
  height: 40px;
  border-radius: 12px;
  margin: 2px 6px;
  color: #334155;
  font-size: 14px;
}

:global(.client-auth-department-popper .el-tree-node.is-current > .el-tree-node__content) {
  background: #eef2f7;
  color: #0f172a;
  font-weight: 600;
}

:global(.client-auth-department-popper .el-tree-node__expand-icon) {
  color: #94a3b8;
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

.capability-alert__content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  line-height: 1.6;
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
  transition:
    background-color var(--motion-duration-fast) var(--ylink-motion-ease),
    box-shadow var(--motion-duration-fast) var(--ylink-motion-ease),
    transform var(--motion-duration-fast) var(--ylink-motion-ease) !important;
}

.submit-btn:hover {
  background-color: #0f766e !important;
  box-shadow: 0 8px 20px rgba(13, 148, 136, 0.2) !important;
  transform: translateY(-1px);
}

.submit-btn:active {
  transform: translateY(1px);
}

.auth-fade-enter-active,
.auth-fade-leave-active {
  transition: opacity 0.35s ease;
}

.auth-fade-enter-active {
  position: relative;
  z-index: 2;
}

.auth-fade-leave-active {
  position: absolute;
  inset: 0;
  width: 100%;
  z-index: 1;
  pointer-events: none;
}

.auth-fade-enter-from,
.auth-fade-leave-to {
  opacity: 0;
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

  .register-feedback-alert__actions {
    gap: 4px 10px;
  }
}
</style>
