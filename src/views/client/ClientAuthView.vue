


























































<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientAuthView.vue
 * 文件职责：客户端登录/注册总入口，负责账号登录、注册、验证码刷新与登录后回跳。
 * 维护说明：当前页面已切换为 Split-Card 一体化布局，视觉可继续调整，但登录/注册/验证码链路需保持可用。
 */

import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type { AxiosResponse } from 'axios'
import { http } from '@/api/http'
import { Key, Lock, Message, User } from '@element-plus/icons-vue'
import {
  type ClientAccountType,
  getClientAuthCapabilities,
  getClientCaptcha,
  lookupClientStaffDirectory,
  type ClientAuthCapabilities,
  type ClientRegisterResult,
  type ClientValidationMode,
} from '@/api/modules/client-auth'
import { resolveClientPostLoginWarmupTargets, scheduleRouteComponentWarmup } from '@/router/route-performance'
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
import { showCriticalErrorDialog } from '@/utils/error-dialog'

import { showAppError, showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'

type AuthMode = 'login' | 'register-personal' | 'register-department'

const AUTH_MODE_QUERY_TAB_MAP: Record<AuthMode, 'login' | 'register-personal' | 'register-department'> = {
  login: 'login',
  'register-personal': 'register-personal',
  'register-department': 'register-department',
}
const AUTH_MODE_SEQUENCE: AuthMode[] = ['login', 'register-personal', 'register-department']

interface ClientCaptchaState {
  captchaId: string
  captchaSvg: string
  expiresInSeconds: number
}

type StaffLookupStatus = 'idle' | 'typing' | 'loading' | 'matched' | 'registered' | 'not_found' | 'error'

const router = useRouter()
const route = useRoute()
const clientAuthStore = useClientAuthStore(pinia)
const { runLatest: runLatestCaptchaRequest, cancel: cancelCaptchaRequest } = useStableRequest()
const { runLatest: runLatestCapabilityRequest, cancel: cancelCapabilityRequest } = useStableRequest()
const { runLatest: runLatestLoginRequest, cancel: cancelLoginRequest } = useStableRequest()
const { runLatest: runLatestRegisterRequest, cancel: cancelRegisterRequest } = useStableRequest()
const { runLatest: runLatestVerificationCodeRequest, cancel: cancelVerificationCodeRequest } = useStableRequest()
const { runLatest: runLatestStaffLookupRequest, cancel: cancelStaffLookupRequest } = useStableRequest()
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
let staffLookupTimer: ReturnType<typeof globalThis.setTimeout> | null = null
const formWrapperRef = ref<HTMLElement | null>(null)
const formBlockRef = ref<HTMLElement | null>(null)
const formWrapperHeight = ref('auto')
const formAnimating = ref(false)
const usernameFocused = ref(false)
const passwordFocused = ref(false)
const authCapabilities = ref<ClientAuthCapabilities | null>(null)
const captcha = reactive<ClientCaptchaState>({
  captchaId: '',
  captchaSvg: '',
  expiresInSeconds: 0,
})
const staffLookup = reactive({
  status: 'idle' as StaffLookupStatus,
  staffNo: '',
  realName: '',
  departmentName: '',
  message: '',
})

const loginForm = reactive({
  account: '',
  password: '',
  captcha: '',
})

const registerForm = reactive({
  username: '',
  account: '',
  staffNo: '',
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
const isRegisterMode = computed(() => activeMode.value !== 'login')
const isDepartmentRegisterMode = computed(() => activeMode.value === 'register-department')

const geoMainText = computed(() => {
  if (activeMode.value === 'register-personal') return 'HI'
  if (activeMode.value === 'register-department') return 'TEA' // 教师注册：TEA (Teacher)
  if (usernameFocused.value) return 'ID'
  if (passwordFocused.value) return 'KEY'
  return 'Y'
})

const geoSubText = computed(() => {
  if (activeMode.value === 'register-personal') return 'NEW'
  if (activeMode.value === 'register-department') return 'DEPT' // 教师注册：DEPT (Department)
  if (usernameFocused.value) return 'USER'
  if (passwordFocused.value) return 'SAFE'
  return 'LINK'
})
const registerAccountType = computed<ClientAccountType>(() => {
  return 'personal'
})
const modeToggleSliderTransform = computed(() => {
  return `translateX(${AUTH_MODE_SEQUENCE.indexOf(activeMode.value) * 100}%)`
})
const registerValidationMode = computed<ClientValidationMode>(() => {
  const channel = registerAccountChannel.value
  if (!channel) {
    return 'captcha'
  }
  return authCapabilities.value?.registerValidationModes[channel] ?? 'captcha'
})
const registerUsesVerificationCode = computed(() => registerValidationMode.value === 'verification_code')
const shouldPrepareCaptcha = computed(() => isRegisterMode.value || loginCaptchaVisible.value)
const isCapabilityHintVisible = computed(() => capabilityLoading.value && !authCapabilities.value)
const isCapabilityFallbackVisible = computed(() => !capabilityLoading.value && !!capabilityErrorMessage.value && !authCapabilities.value)
const forgotPasswordAvailable = computed(() => authCapabilities.value?.forgotPasswordEnabled ?? false)
const isStaffLookupVisible = computed(() => {
  return isDepartmentRegisterMode.value && Boolean(registerForm.staffNo.trim()) && staffLookup.status !== 'idle'
})
const staffLookupTone = computed(() => {
  if (staffLookup.status === 'matched') return 'success'
  if (staffLookup.status === 'registered') return 'warning'
  if (staffLookup.status === 'not_found' || staffLookup.status === 'error') return 'danger'
  return 'info'
})

// 安全说明：后端返回的是 SVG 字符串，这里统一转为 data URL 图片渲染，
// 避免通过 v-html 直接把未信任的 SVG 片段注入到页面 DOM 中。
const captchaImageSrc = computed(() => {
  return captcha.captchaSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captcha.captchaSvg)}`
    : ''
})

const captchaHintText = computed(() => {
  if (captcha.expiresInSeconds <= 0) {
    return '点击右侧验证码图片可立即刷新。'
  }
  return `图形验证码约 ${captcha.expiresInSeconds}s 后失效，点击图片可立即刷新。`
})

const extractRegisterRemainingMessage = (response: AxiosResponse | undefined) => {
  const rawHeader = response?.headers?.['x-ylink-register-remaining-message']
  return typeof rawHeader === 'string' ? rawHeader.trim() : ''
}

const extractRateLimitWaitSeconds = (message: string) => {
  const matchedSeconds = message.match(/(\d+)\s*秒(?:后重试|后再试)/)
  if (!matchedSeconds) {
    return null
  }

  const parsedSeconds = Number(matchedSeconds[1])
  return Number.isFinite(parsedSeconds) && parsedSeconds > 0 ? parsedSeconds : null
}

const isCompactLoginLayout = computed(() => {
  return activeMode.value === 'login' && !loginCaptchaVisible.value && !successTip.value && !securityHint.value
})

// 三态模式和 query.tab 映射：
// - 兼容历史 `register` 链接，默认回落到个人注册；
// - 点击顶部切换器后同步刷新当前路由 query，保证刷新与分享链接能恢复正确表单。
const resolveAuthModeFromQueryTab = (tab: unknown): AuthMode => {
  if (tab === 'register-department') {
    return 'register-department'
  }
  if (tab === 'register-personal' || tab === 'register') {
    return 'register-personal'
  }
  return 'login'
}

const syncModeQuery = async (nextMode: AuthMode) => {
  const nextTab = AUTH_MODE_QUERY_TAB_MAP[nextMode]
  const currentTab = typeof route.query.tab === 'string' ? route.query.tab : ''
  if (currentTab === nextTab) {
    return
  }
  await router.replace({
    path: route.path,
    query: {
      ...route.query,
      tab: nextTab,
    },
  })
}

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
  if (formAnimating.value) {
    return
  }
  if (activeMode.value === nextMode) {
    await syncModeQuery(nextMode)
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
  await syncModeQuery(nextMode)
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
  activeMode.value = resolveAuthModeFromQueryTab(route.query.tab)
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
        showAppSuccess('已刷新验证码')
      }
    },
    onError: (error) => {
      const normalizedError = normalizeRequestError(error, '验证码刷新失败，请稍后重试')
      if (!silent) {
        showAppError(normalizedError.message)
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
        showAppError(normalizedError.message)
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
const validateRealName = (username: string) => /^\p{Script=Han}[\p{Script=Han}·\s]{1,19}$/u.test(normalizeHumanName(username))
const validateStaffNo = (staffNo: string) => /^[A-Za-z0-9-]{4,32}$/.test(staffNo.trim())
const validateLoginAccount = (account: string) => account.trim().length > 0
const resolveAccountChannel = (account: string): 'mobile' | 'email' | null => {
  const normalized = account.trim()
  if (!normalized) return null
  if (normalized.includes('@')) {
    return validateEmail(normalized) ? 'email' : null
  }
  return validateMobile(normalized) ? 'mobile' : null
}

const clearStaffLookupTimer = () => {
  if (staffLookupTimer) {
    globalThis.clearTimeout(staffLookupTimer)
    staffLookupTimer = null
  }
}

const resetStaffLookup = () => {
  clearStaffLookupTimer()
  cancelStaffLookupRequest()
  staffLookup.status = 'idle'
  staffLookup.staffNo = ''
  staffLookup.realName = ''
  staffLookup.departmentName = ''
  staffLookup.message = ''
}

const applyStaffLookupResult = (staffNo: string, result: Awaited<ReturnType<typeof lookupClientStaffDirectory>>) => {
  staffLookup.staffNo = staffNo
  staffLookup.realName = result.realName ?? ''
  staffLookup.departmentName = result.departmentName ?? ''

  if (!result.matched) {
    staffLookup.status = 'not_found'
    staffLookup.message = '未找到该教职工号，请确认输入或联系管理员导入目录。'
    return
  }

  if (result.isRegistered) {
    staffLookup.status = 'registered'
    staffLookup.message = '该教职工号已被占用，不能重复注册。'
    return
  }

  staffLookup.status = 'matched'
  staffLookup.message = '已匹配到姓名和部门，请确认无误后继续注册。'
}

const scheduleStaffDirectoryLookup = (staffNoInput: string) => {
  clearStaffLookupTimer()
  cancelStaffLookupRequest()
  const normalizedStaffNo = staffNoInput.trim()
  staffLookup.staffNo = normalizedStaffNo
  staffLookup.realName = ''
  staffLookup.departmentName = ''

  if (!isDepartmentRegisterMode.value || !normalizedStaffNo) {
    resetStaffLookup()
    return
  }

  if (!validateStaffNo(normalizedStaffNo)) {
    staffLookup.status = 'typing'
    staffLookup.message = '请输入 4-32 位教职工号，支持字母、数字和短横线。'
    return
  }

  staffLookup.status = 'typing'
  staffLookup.message = '系统将自动匹配姓名和部门。'
  staffLookupTimer = globalThis.setTimeout(() => {
    staffLookupTimer = null
    staffLookup.status = 'loading'
    staffLookup.message = '正在匹配教职工目录...'
    void runLatestStaffLookupRequest({
      executor: (signal) => lookupClientStaffDirectory(normalizedStaffNo, { signal }),
      onSuccess: (result) => {
        if (registerForm.staffNo.trim() !== normalizedStaffNo || !isDepartmentRegisterMode.value) {
          return
        }
        applyStaffLookupResult(normalizedStaffNo, result)
      },
      onError: (error) => {
        if (registerForm.staffNo.trim() !== normalizedStaffNo || !isDepartmentRegisterMode.value) {
          return
        }
        const normalizedError = normalizeRequestError(error, '工号匹配失败，请稍后重试')
        staffLookup.status = 'error'
        staffLookup.message = normalizedError.message
      },
    })
  }, 450)
}

const normalizeInputText = (value: string) => {
  return value.replaceAll(/\s+/g, ' ').trim()
}

const normalizeHumanName = (value: string) => {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replaceAll('　', ' ')
    .replace(/[•・･‧∙⋅·﹒]/g, '·')
    .replaceAll(/\s+/g, ' ')
    .trim()
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
      ? '请检查姓名、手机号、邮箱、工号和密码后重试；如果忘记密码，可直接进入找回密码。'
      : '请检查姓名、手机号、邮箱、工号和密码后重试；当前系统未启用自助找回密码，请联系管理员手动修改密码。'
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

  if (status === 409 && /该手机号已被占用|该邮箱已被占用|该手机号或邮箱已被占用/.test(message)) {
    const isEmailOccupied = /邮箱/.test(message) && !/手机号/.test(message)
    registerFeedbackTitle.value = isEmailOccupied ? '该邮箱已注册' : '该手机号已注册'
    registerFeedbackDescription.value = forgotPasswordAvailable.value
      ? '当前账号已经创建过客户端账号，可直接切换到登录；如果忘记密码，也可以进入找回密码流程。'
      : '当前账号已经创建过客户端账号，可直接切换到登录；当前系统未启用自助找回密码，请联系管理员手动修改密码。'
    registerFeedbackType.value = 'warning'
    registerFeedbackShowLoginAction.value = true
    registerFeedbackShowForgotAction.value = forgotPasswordAvailable.value
    return
  }

  if (status === 409 && /该姓名已被占用|该用户名已被占用/.test(message)) {
    registerFeedbackTitle.value = '姓名已被占用'
    registerFeedbackDescription.value = '该姓名已经创建过客户端账号，请核对姓名是否填写正确；如需继续使用，请联系管理员处理。'
    registerFeedbackType.value = 'warning'
    return
  }

  if (status === 409 && /该教职工号已被占用|教职工号已绑定/.test(message)) {
    registerFeedbackTitle.value = '教职工号已被占用'
    registerFeedbackDescription.value = '该教职工号已经绑定其他客户端账号，请核对输入或联系管理员处理。'
    registerFeedbackType.value = 'warning'
    return
  }

  if (status === 429) {
    registerFeedbackTitle.value = '注册过于频繁'
    const waitSeconds = extractRateLimitWaitSeconds(message)
    registerFeedbackDescription.value = waitSeconds
      ? `当前窗口还需等待约 ${waitSeconds} 秒才能继续注册，请稍后再试。`
      : message
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
    showAppWarning('当前账号类型未启用验证码注册，请根据页面提示使用图片验证码完成注册')
    return
  }
  const channel = resolveAccountChannel(registerForm.account)
  if (!channel) {
    showAppWarning('请输入正确的手机号或邮箱')
    return
  }
  if (!captcha.captchaId || !registerForm.captcha.trim()) {
    showAppWarning('发送验证码前请先输入图形验证码')
    await ensureCaptchaReady()
    return
  }
  const runResult = await runWithGate({
    actionKey: 'client-auth-register-send-verification-code',
    onDuplicated: () => {
      showAppInfo('验证码发送中，请勿重复点击')
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
          showAppSuccess(`${channel === 'email' ? '邮箱' : '手机'}验证码已发送`)
          registerForm.captcha = ''
          await refreshCaptcha(true)
          startRegisterVerificationCountdown(result.expireSeconds)
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '验证码发送失败，请稍后重试')
          applySecurityHintFromMessage(normalizedError.message)
          showAppError(normalizedError.message)
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

/**
 * 登录成功后的空闲预热：
 * - 先完成真正的路由跳转，把当前落点页交给路由本身去加载；
 * - 再只预热“下一跳高频页”，避免把当前落点页再次加入预热队列，和真实首跳争抢带宽。
 */
const warmupClientPostLoginTargets = (redirectPath: string) => {
  const [, ...adjacentTargets] = resolveClientPostLoginWarmupTargets(redirectPath)
  if (!adjacentTargets.length) {
    return
  }
  scheduleRouteComponentWarmup(adjacentTargets)
}

// 详细注释：提交登录表单。首先进行基础校验，然后调用 auth store 登录，成功后优先跳转，再在空闲时预热高频相邻页面。
const handleLogin = async () => {
  if (!validateLoginAccount(loginForm.account)) {
    showAppWarning('请输入姓名、手机号、邮箱或工号')
    return
  }
  if (!validateLoginPassword(loginForm.password)) {
    showAppWarning('请输入密码')
    return
  }
  if (loginCaptchaVisible.value) {
    if (!captcha.captchaId || !loginForm.captcha.trim()) {
      showAppWarning('请输入图形验证码')
      return
    }
  }

  const runResult = await runWithGate({
    actionKey: 'client-auth-login',
    onDuplicated: () => {
      showAppInfo('登录请求处理中，请勿重复提交')
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
          showAppSuccess('登录成功，欢迎来到 Y-Link 客户端')
          await router.replace(redirectPath.value)
          warmupClientPostLoginTargets(redirectPath.value)
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '登录失败，请检查姓名、手机号、邮箱、工号、密码和验证码后重试')
          applySecurityHintFromMessage(normalizedError.message)
          applyLoginFeedbackFromError(normalizedError.message, normalizedError.status)
          showAppError(normalizedError.message)
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

// 教师注册只校验工号本身；姓名和部门必须由后端教职工目录反查，前端不再提供自选入口。
const validateDepartmentRegisterFields = () => {
  if (!isDepartmentRegisterMode.value) {
    return true
  }
  const normalizedStaffNo = registerForm.staffNo.trim()
  if (!normalizedStaffNo) {
    showAppWarning('请输入教职工号')
    return false
  }
  if (!validateStaffNo(normalizedStaffNo)) {
    showAppWarning('教职工号仅支持字母、数字和短横线（4-32位）')
    return false
  }
  if (staffLookup.staffNo !== normalizedStaffNo || staffLookup.status === 'typing' || staffLookup.status === 'loading') {
    showAppWarning('请等待系统完成工号匹配后再注册')
    scheduleStaffDirectoryLookup(normalizedStaffNo)
    return false
  }
  if (staffLookup.status === 'registered') {
    showAppWarning('该教职工号已被占用，不能重复注册')
    return false
  }
  if (staffLookup.status !== 'matched') {
    showAppWarning('教职工号未匹配到有效目录，暂不能注册教师账号')
    return false
  }
  return true
}

// 注册验证码校验与部门字段校验拆开维护，便于后续继续扩展不同通道策略。
const validateRegisterChallengeFields = () => {
  if (isDepartmentRegisterMode.value && !registerUsesVerificationCode.value) {
    showAppWarning('教师注册需要启用短信或邮箱验证码，请联系管理员')
    return false
  }
  if (registerUsesVerificationCode.value) {
    if (!registerForm.verificationCode.trim()) {
      showAppWarning('请输入手机/邮箱验证码')
      return false
    }
    return true
  }
  if (!captcha.captchaId || !registerForm.captcha.trim()) {
    showAppWarning('请输入图形验证码')
    return false
  }
  return true
}

// 注册前置校验只负责拦截非法输入并整理提交上下文，避免注册主流程堆叠过多分支。
const validateRegisterBeforeSubmit = () => {
  const accountChannel = resolveAccountChannel(registerForm.account)
  if (isDepartmentRegisterMode.value) {
    if (!accountChannel) {
      showAppWarning('教师注册必须填写正确格式的手机号或邮箱')
      return null
    }
  } else {
    if (!validateRealName(registerForm.username)) {
      showAppWarning('请输入 2-20 位中文真实姓名，可包含空格或·')
      return null
    }
    if (!accountChannel) {
      showAppWarning('请输入正确的手机号或邮箱作为登录账号')
      return null
    }
  }
  if (!validateRegisterPassword(registerForm.password)) {
    showAppWarning(CLIENT_NEW_PASSWORD_RULE_TEXT)
    return null
  }
  if (registerForm.password !== registerForm.confirmPassword) {
    showAppWarning(CLIENT_CONFIRM_INPUT_MISMATCH_MESSAGE)
    return null
  }
  if (!validateDepartmentRegisterFields()) {
    return null
  }
  if (!validateRegisterChallengeFields()) {
    return null
  }

  return {
    registeredAccount: normalizeInputText(registerForm.account),
    registeredUsername: isDepartmentRegisterMode.value ? '' : normalizeInputText(registerForm.username),
  }
}

// 注册请求体按当前注册通道集中生成，保证部门字段与验证码字段的启停逻辑只维护一处。
const buildRegisterRequestPayload = (registeredAccount: string, registeredUsername: string) => {
  return {
    username: registeredUsername || undefined,
    account: registeredAccount || undefined,
    accountType: registerAccountType.value,
    staffNo: isDepartmentRegisterMode.value ? registerForm.staffNo.trim() : undefined,
    password: registerForm.password,
    verificationCode: registerUsesVerificationCode.value ? normalizeInputText(registerForm.verificationCode) : undefined,
    captchaId: registerUsesVerificationCode.value ? undefined : captcha.captchaId,
    captchaCode: registerUsesVerificationCode.value ? undefined : normalizeInputText(registerForm.captcha),
  }
}

// 注册成功后的状态收口：
// - 清空注册表单，避免再次进入注册态时残留旧数据；
// - 预填登录账号与成功提示，保证回到登录页后能立即继续操作。
const resetRegisterStateAfterSuccess = (registeredAccount: string, registerRemainingMessage: string) => {
  clientAuthStore.clearAuthState()
  clientAuthStore.initialized = true
  activeMode.value = 'login'
  loginForm.account = registeredAccount || registerForm.staffNo.trim()
  loginForm.password = ''
  loginForm.captcha = ''
  successTip.value = registerRemainingMessage
    ? `账号已创建成功，请使用姓名、工号、手机号或邮箱与密码登录。${registerRemainingMessage}`
    : '账号已创建成功，请使用姓名、工号、手机号或邮箱与密码登录。'
  registerForm.captcha = ''
  registerForm.verificationCode = ''
  registerForm.username = ''
  registerForm.staffNo = ''
  registerForm.password = ''
  registerForm.confirmPassword = ''
  registerForm.department = ''
}

const handleRegister = async () => {
  const registerContext = validateRegisterBeforeSubmit()
  if (!registerContext) {
    return
  }

  const runResult = await runWithGate({
    actionKey: 'client-auth-register',
    onDuplicated: () => {
      showAppInfo('注册请求处理中，请勿重复提交')
    },
    executor: async () => {
      isLoading.value = true
      successTip.value = ''
      securityHint.value = ''
      clearRegisterFeedback()
      const { registeredAccount, registeredUsername } = registerContext
      await runLatestRegisterRequest({
        executor: (signal): Promise<AxiosResponse<ClientRegisterResult>> =>
          http.request<ClientRegisterResult>({
            method: 'POST',
            url: '/client-auth/register',
            data: buildRegisterRequestPayload(registeredAccount, registeredUsername),
            signal,
          }),
        onSuccess: async (response) => {
          const registerRemainingMessage = extractRegisterRemainingMessage(response)
          const nextLoginAccount = registeredAccount || registerForm.staffNo.trim()
          showAppSuccess('注册成功，请登录')
          resetRegisterStateAfterSuccess(registeredAccount, registerRemainingMessage)
          await refreshCaptcha(true)
          await router.replace({
            path: '/client/login',
            query: {
              tab: 'login',
              account: nextLoginAccount,
              notice: successTip.value,
            },
          })
        },
        onError: async (error) => {
          const normalizedError = normalizeRequestError(error, '注册失败，请检查信息后重试')
          applySecurityHintFromMessage(normalizedError.message)
          applyRegisterFeedbackFromError(normalizedError.message, normalizedError.status)
          void showCriticalErrorDialog(normalizedError, {
            title: '注册失败',
            fallback: '注册失败，请检查信息后重试',
            operation: activeMode.value === 'register-department' ? '教师账号注册' : '个人账号注册',
          })
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
    await router.replace(redirectPath.value)
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

watch(
  () => [activeMode.value, registerForm.staffNo] as const,
  ([mode, staffNo]) => {
    if (mode !== 'register-department') {
      resetStaffLookup()
      return
    }
    scheduleStaffDirectoryLookup(staffNo)
  },
)

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
  cancelStaffLookupRequest()
  if (capabilityDeferredTimer) {
    globalThis.clearTimeout(capabilityDeferredTimer)
    capabilityDeferredTimer = null
  }
  clearStaffLookupTimer()
  resetRegisterVerificationTimer()
  clearCaptcha()
})
</script>

<template>
  <div class="client-auth-page">
    <!-- 动态几何背景层 (Fluent / Apple Aesthetic) -->
    <div class="geo-animation-layer" aria-hidden="true">
      <div class="geo-blob blob-1"></div>
      <div class="geo-blob blob-2"></div>
      <div class="geo-blob blob-3"></div>
    </div>
    <!-- 整体毛玻璃遮罩层 -->
    <div class="glass-overlay" aria-hidden="true"></div>

    <main class="auth-shell">
      <aside 
        class="brand-panel"
        :class="{
          'is-username-focus': usernameFocused,
          'is-password-focus': passwordFocused,
          'is-register-personal': activeMode === 'register-personal',
          'is-register-department': activeMode === 'register-department'
        }"
      >
        <div class="geo-decor-wrapper wrapper-main">
          <div class="geo-decor circle-main">
            <div class="glass-specular" aria-hidden="true"></div>
            <Transition name="geo-fade" mode="out-in">
              <span :key="geoMainText" class="geo-text">{{ geoMainText }}</span>
            </Transition>
          </div>
        </div>
        <div class="geo-decor-wrapper wrapper-sub">
          <div class="geo-decor circle-sub">
            <div class="glass-specular" aria-hidden="true"></div>
            <Transition name="geo-fade" mode="out-in">
              <span :key="geoSubText" class="geo-text">{{ geoSubText }}</span>
            </Transition>
          </div>
        </div>

        <div class="brand-content">
          <div class="brand-tag">Y-LINK CLIENT</div>
          <h1 class="brand-title">野辙文创<br />极简预订</h1>
          <p class="brand-desc">实时查看库存，在线预订即锁单。<br />线下出示核销码，即刻带走心仪好物。</p>
        </div>

        <div class="brand-footer">
          <div class="brand-footer__version">{{ APP_META.version }}</div>
          <a
            class="brand-footer__repo-link"
            :href="APP_META.repositoryUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg class="brand-footer__repo-icon" aria-hidden="true">
              <use href="/icons.svg#github-icon"></use>
            </svg>
            {{ APP_META.repositoryLabel }}
          </a>
          <div class="brand-footer__copyright">{{ APP_META.copyright }}</div>
        </div>
      </aside>

      <section class="form-panel">
        <div class="form-container">
          <div class="mode-toggle">
            <div class="toggle-slider" :style="{ transform: modeToggleSliderTransform }"></div>
            <button type="button" class="toggle-btn" :class="{ 'is-active': activeMode === 'login' }" @click="switchMode('login')">登录</button>
            <button
              type="button"
              class="toggle-btn"
              :class="{ 'is-active': activeMode === 'register-personal' }"
              @click="switchMode('register-personal')"
            >
              个人注册
            </button>
            <button
              type="button"
              class="toggle-btn"
              :class="{ 'is-active': activeMode === 'register-department' }"
              @click="switchMode('register-department')"
            >
              教师注册
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

          <div ref="formWrapperRef" class="form-wrapper" :class="{ 'is-animating': formAnimating }" :style="{ height: formWrapperHeight }">
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
                <p class="block-subtitle">请输入姓名、手机号、邮箱或工号与密码登录客户端</p>

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
                  <el-input 
                    v-model="loginForm.account" 
                    placeholder="姓名 / 手机号 / 邮箱 / 工号" 
                    class="geo-input" 
                    size="large" 
                    clearable
                    @focus="usernameFocused = true"
                    @blur="usernameFocused = false"
                  >
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>

                  <el-input 
                    v-model="loginForm.password" 
                    placeholder="密码" 
                    type="password" 
                    class="geo-input" 
                    size="large" 
                    show-password
                    @focus="passwordFocused = true"
                    @blur="passwordFocused = false"
                  >
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
                      <img
                        v-else
                        class="captcha-render"
                        :src="captchaImageSrc"
                        alt="图形验证码"
                        draggable="false"
                      />
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

              <div
                v-else-if="activeMode === 'register-personal'"
                ref="formBlockRef"
                key="register-personal"
                class="form-block"
              >
                <h2 class="block-title">创建个人账号</h2>
                <p class="block-subtitle">填写真实姓名、登录账号与密码后，即可创建个人账号</p>
                <el-alert class="register-channel-alert" type="info" :closable="false" show-icon>
                  <template #title>
                    个人账号默认按个人/散客流程下单，无需填写教职工号或所属部门。
                  </template>
                </el-alert>

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
                  <el-input
                    v-model="registerForm.username"
                    placeholder="真实姓名"
                    class="geo-input"
                    size="large"
                    clearable
                  >
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>

                  <el-input 
                    v-model="registerForm.account" 
                    placeholder="登录账号（手机号或邮箱）" 
                    class="geo-input" 
                    size="large" 
                    clearable
                    @focus="usernameFocused = true"
                    @blur="usernameFocused = false"
                  >
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>

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
                      <img
                        v-else
                        class="captcha-render"
                        :src="captchaImageSrc"
                        alt="图形验证码"
                        draggable="false"
                      />
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
                    @focus="passwordFocused = true"
                    @blur="passwordFocused = false"
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
                      <img
                        v-else
                        class="captcha-render"
                        :src="captchaImageSrc"
                        alt="图形验证码"
                        draggable="false"
                      />
                    </button>
                  </div>
                  <el-button class="submit-btn" native-type="submit" :loading="isLoading">立即注册个人账号</el-button>
                </el-form>
              </div>

              <div v-else ref="formBlockRef" key="register-department" class="form-block">
                <h2 class="block-title">创建教师账号</h2>
                <p class="block-subtitle">填写教职工号、手机号或邮箱，并通过验证码后创建教师账号</p>
                <el-alert class="register-channel-alert" type="info" :closable="false" show-icon>
                  <template #title>
                    教师账号按教职工目录回填姓名和部门，注册后仍按个人/散客流程下单；部门共享账号请联系管理员创建。
                  </template>
                </el-alert>

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
                  <el-input v-model="registerForm.staffNo" placeholder="教职工号" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><Key /></el-icon>
                    </template>
                  </el-input>

                  <transition name="staff-lookup">
                    <div v-if="isStaffLookupVisible" class="staff-lookup-slot">
                      <div
                        class="staff-lookup-card"
                        :class="[`staff-lookup-card--${staffLookupTone}`, { 'is-loading': staffLookup.status === 'loading' }]"
                      >
                        <div class="staff-lookup-card__icon">
                          <span v-if="staffLookup.status === 'loading'" class="staff-lookup-spinner"></span>
                          <span v-else-if="staffLookup.status === 'matched'">✓</span>
                          <span v-else-if="staffLookup.status === 'registered'">!</span>
                          <span v-else-if="staffLookup.status === 'not_found' || staffLookup.status === 'error'">×</span>
                          <span v-else>…</span>
                        </div>
                        <div class="staff-lookup-card__content">
                          <div class="staff-lookup-card__message">{{ staffLookup.message }}</div>
                          <div v-if="staffLookup.realName || staffLookup.departmentName" class="staff-lookup-card__grid">
                            <div>
                              <span>姓名</span>
                              <strong>{{ staffLookup.realName || '-' }}</strong>
                            </div>
                            <div>
                              <span>部门</span>
                              <strong>{{ staffLookup.departmentName || '-' }}</strong>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </transition>

                  <el-input 
                    v-model="registerForm.account" 
                    placeholder="手机号或邮箱" 
                    class="geo-input" 
                    size="large" 
                    clearable
                    @focus="usernameFocused = true"
                    @blur="usernameFocused = false"
                  >
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>
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
                      <img
                        v-else
                        class="captcha-render"
                        :src="captchaImageSrc"
                        alt="图形验证码"
                        draggable="false"
                      />
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
                    @focus="passwordFocused = true"
                    @blur="passwordFocused = false"
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
                      <img
                        v-else
                        class="captcha-render"
                        :src="captchaImageSrc"
                        alt="图形验证码"
                        draggable="false"
                      />
                    </button>
                  </div>
                  <el-button class="submit-btn" native-type="submit" :loading="isLoading">立即注册教师账号</el-button>
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
  --ca-fg: #0f172a;
  --ca-sub: #475569;
  --ca-muted: #64748b;
  --ca-chip-bg: rgba(13, 148, 136, 0.22);
  --ca-chip-text: #0f172a;
  --ca-bg: rgba(255, 255, 255, 0.55);
  --ca-border: rgba(255, 255, 255, 0.7);
  --ca-hover-bg: rgba(255, 255, 255, 0.8);
  --ca-hover-bd: rgba(255, 255, 255, 0.9);
  --ca-focus-bg: #ffffff;
  --ca-focus-bd: #0d9488;
  --ca-ring: 0 0 0 1px #0d9488, 0 4px 14px rgba(13, 148, 136, 0.1);

  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #f1f5f9;
  position: relative;
  overflow: hidden;
  padding: 24px;
}

/* 动态几何背景层 (硬件加速流体动画 - Apple/Fluent 设计美学) */
:global(.dark .client-auth-page) {
  --ca-fg: #f8fafc;
  --ca-sub: #cbd5e1;
  --ca-muted: #94a3b8;
  --ca-chip-bg: rgba(20, 184, 166, 0.18);
  --ca-chip-text: #ccfbf1;
  --ca-bg: rgba(0, 0, 0, 0.25);
  --ca-border: rgba(255, 255, 255, 0.08);
  --ca-hover-bg: rgba(0, 0, 0, 0.45);
  --ca-hover-bd: rgba(255, 255, 255, 0.15);
  --ca-focus-bg: rgba(0, 0, 0, 0.6);
  --ca-focus-bd: #14b8a6;
  --ca-ring: 0 0 0 1px #14b8a6, 0 4px 14px rgba(20, 184, 166, 0.15);
}

.geo-animation-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  background-color: #f8fafc;
  filter: blur(100px);
}

.geo-blob {
  position: absolute;
  border-radius: 50%;
  opacity: 0.35;
  will-change: transform;
  animation: blob-float 25s cubic-bezier(0.4, 0, 0.2, 1) infinite alternate;
}

.blob-1 {
  top: -10%;
  left: -10%;
  width: 55vw;
  height: 55vw;
  background: radial-gradient(circle, rgba(13, 148, 136, 0.5) 0%, rgba(13, 148, 136, 0) 70%);
  animation-duration: 25s;
  animation-delay: 0s;
}

.blob-2 {
  bottom: -20%;
  right: -10%;
  width: 65vw;
  height: 65vw;
  background: radial-gradient(circle, rgba(56, 189, 248, 0.4) 0%, rgba(56, 189, 248, 0) 70%);
  animation-duration: 22s;
  animation-delay: -5s;
  animation-direction: alternate-reverse;
}

.blob-3 {
  top: 30%;
  left: 20%;
  width: 45vw;
  height: 45vw;
  background: radial-gradient(circle, rgba(15, 118, 110, 0.35) 0%, rgba(15, 118, 110, 0) 70%);
  animation-duration: 28s;
  animation-delay: -10s;
}

@keyframes blob-float {
  0% {
    transform: translate3d(0, 0, 0) scale(1) rotate(0deg);
  }
  33% {
    transform: translate3d(8%, 12%, 0) scale(1.1) rotate(10deg);
  }
  66% {
    transform: translate3d(-5%, 8%, 0) scale(0.9) rotate(-8deg);
  }
  100% {
    transform: translate3d(5%, -12%, 0) scale(1.05) rotate(5deg);
  }
}

/* 整体毛玻璃遮罩层 */
.glass-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  backdrop-filter: saturate(150%) blur(60px);
  -webkit-backdrop-filter: saturate(150%) blur(60px);
  background: rgba(255, 255, 255, 0.02);
}

.auth-shell {
  position: relative;
  z-index: 10;
  display: flex;
  width: 100%;
  max-width: 960px;
  min-height: 600px;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(32px) saturate(180%);
  -webkit-backdrop-filter: blur(32px) saturate(180%);
  border-radius: 32px;
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.04),
    inset 0 0 0 1px rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.5);
  overflow: hidden;
  animation: card-entrance 0.8s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

@keyframes card-entrance {
  0% {
    opacity: 0;
    transform: translate3d(0, 30px, 0) scale(0.98);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

:global(.dark .auth-shell) {
  background: rgba(17, 17, 18, 0.75);
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.2),
    inset 0 0 0 1px rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.brand-panel {
  flex: 1;
  background: transparent;
  padding: 48px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  position: relative;
  border-right: 1px solid rgba(255, 255, 255, 0.6);
}

:global(.dark .brand-panel) {
  border-right-color: rgba(255, 255, 255, 0.06);
}

.geo-decor-wrapper {
  position: absolute;
  pointer-events: none;
  z-index: 0;
  will-change: transform;
  transition: transform 1.2s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 初始进场弹性动画 */
.wrapper-main {
  top: 11%;
  right: 5%;
  width: 290px;
  height: 290px;
  animation: geo-entrance 1s cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
}

.wrapper-sub {
  bottom: 16%;
  left: 6%;
  width: 210px;
  height: 210px;
  animation: geo-entrance 1.2s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s backwards;
}

@keyframes geo-entrance {
  0% {
    opacity: 0;
    transform: scale(0.5) translate3d(0, 50px, 0);
  }
  100% {
    opacity: 1;
    transform: scale(1) translate3d(0, 0, 0);
  }
}

/* 交互状态：用户名聚焦 (ID / USER) */
.brand-panel.is-username-focus .wrapper-main {
  transform: translate3d(-18px, 15px, 0) scale(1.06);
}
.brand-panel.is-username-focus .wrapper-sub {
  transform: translate3d(25px, -15px, 0) scale(0.92);
}

/* 交互状态：密码聚焦 (KEY / SAFE) */
.brand-panel.is-password-focus .wrapper-main {
  transform: translate3d(15px, -25px, 0) scale(1.12);
}
.brand-panel.is-password-focus .wrapper-sub {
  transform: translate3d(-20px, 15px, 0) scale(0.86);
}

/* ========================================================= 
   个人注册状态：亲和液态 (is-register-personal) 
   ========================================================= */ 
.brand-panel.is-register-personal .wrapper-main { 
  /* 大幅舒展，向下移动包裹欢迎词 */ 
  transform: translate3d(-50px, 75px, 0) scale(1.26) rotate(-5deg); 
} 

.brand-panel.is-register-personal .circle-main { 
  /* 柔软不对称的液态水滴超椭圆 */ 
  border-radius: 28% 72% 65% 35% / 35% 32% 68% 65%; 
  background: linear-gradient(135deg, rgba(13, 148, 136, 0.18) 0%, rgba(255, 255, 255, 0.22) 100%); 
} 

.brand-panel.is-register-personal .wrapper-sub { 
  transform: translate3d(40px, -45px, 0) scale(1.15); 
} 

.brand-panel.is-register-personal .circle-sub { 
  border-radius: 68% 32% 35% 65% / 65% 38% 62% 35%; 
} 


/* ========================================================= 
   教师注册状态：严谨学术徽章 (is-register-department) 
   ========================================================= */ 
.brand-panel.is-register-department .wrapper-main { 
  /* 呈现高雅的倾斜陈列，大小与位置精细契合 */ 
  transform: translate3d(-40px, 60px, 0) scale(1.24) rotate(15deg); 
} 

.brand-panel.is-register-department .circle-main { 
  /* 极其高贵的双尖叶形/菱形超椭圆 (Academic Crest Squircle) */ 
  border-radius: 22% 78% 22% 78% / 78% 22% 78% 22%; 
  
  /* 略带权威感的常春藤深碧绿微调，增强质感深度 */ 
  background: linear-gradient( 
    135deg, 
    rgba(15, 118, 110, 0.22) 0%, 
    rgba(255, 255, 255, 0.25) 100% 
  ); 
  box-shadow: 
    0 35px 70px -15px rgba(15, 118, 110, 0.12), 
    inset 0 1.5px 2px rgba(255, 255, 255, 0.8); 
} 

.brand-panel.is-register-department .wrapper-sub { 
  /* 互补咬合交叉位移 */ 
  transform: translate3d(30px, -50px, 0) scale(1.16) rotate(-15deg); 
} 

.brand-panel.is-register-department .circle-sub { 
  /* 与主几何体反向咬合的菱形超椭圆 */ 
  border-radius: 78% 22% 78% 22% / 22% 78% 22% 78%; 
  background: linear-gradient( 
    135deg, 
    rgba(56, 189, 248, 0.16) 0%, 
    rgba(255, 255, 255, 0.18) 100% 
  ); 
}

/* 2. 内层 Decor：专职负责 Squircle 圆角形态切换，以及无限微漂浮 */
.geo-decor {
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  will-change: border-radius, background, box-shadow;
  
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.28) 0%,
    rgba(255, 255, 255, 0.08) 100%
  );
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow:
    0 25px 50px -12px rgba(13, 148, 136, 0.05),
    inset 0 1px 1.5px rgba(255, 255, 255, 0.35);

  transition:
    border-radius 1.2s cubic-bezier(0.16, 1, 0.3, 1),
    background 1.2s cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 1.2s cubic-bezier(0.16, 1, 0.3, 1);
    
  animation: apple-fluid-float 18s cubic-bezier(0.4, 0, 0.2, 1) infinite alternate;
}

/* 3. 各种状态下，主/次几何体的超椭圆（Squircle）圆角变形设定 */

/* 默认状态 */
.circle-main {
  border-radius: 62% 38% 62% 38% / 45% 48% 52% 55%;
  background: linear-gradient(135deg, rgba(13, 148, 136, 0.16) 0%, rgba(255, 255, 255, 0.15) 100%);
  animation-duration: 22s;
}
.circle-sub {
  border-radius: 38% 62% 45% 55% / 50% 42% 58% 50%;
  background: linear-gradient(135deg, rgba(56, 189, 248, 0.12) 0%, rgba(255, 255, 255, 0.12) 100%);
  animation-duration: 16s;
  animation-direction: alternate-reverse;
}

/* 用户名聚焦形态 */
.brand-panel.is-username-focus .circle-main {
  border-radius: 38% 62% 45% 55% / 55% 38% 62% 45%;
}
.brand-panel.is-username-focus .circle-sub {
  border-radius: 55% 45% 55% 45% / 45% 55% 45% 55%;
}

/* 密码聚焦形态：安全密封舱 (Highly Symmetric Capsule) */
.brand-panel.is-password-focus .circle-main {
  border-radius: 46% 46% 46% 46% / 46% 46% 46% 46%;
  background: linear-gradient(135deg, rgba(13, 148, 136, 0.22) 0%, rgba(255, 255, 255, 0.22) 100%);
}
.brand-panel.is-password-focus .circle-sub {
  border-radius: 50% 50% 65% 35% / 35% 65% 35% 65%;
}



/* 4. 边缘高光折射反射层 */
.glass-specular {
  position: absolute;
  top: 6%;
  left: 10%;
  width: 40%;
  height: 22%;
  border-radius: 50%;
  background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.45) 0%, rgba(255, 255, 255, 0) 70%);
  pointer-events: none;
  opacity: 0.8;
}

/* 5. 纯物理无感位移漂浮动画：仅作用于子级的 transform，实现 120Hz 极限流畅 */
@keyframes apple-fluid-float {
  0% {
    transform: translate3d(0, 0, 0) rotate(0deg);
  }
  50% {
    transform: translate3d(8px, -12px, 0) rotate(3.5deg);
  }
  100% {
    transform: translate3d(-5px, 6px, 0) rotate(-3deg);
  }
}

.geo-text {
  position: relative;
  z-index: 2;
  font-size: 3.2rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: transparent;
  -webkit-text-stroke: 1.2px rgba(13, 148, 136, 0.45);
  text-shadow: 0 4px 12px rgba(255, 255, 255, 0.6);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;
  text-transform: uppercase;
}

:global(.dark .geo-decor) {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.02) 100%);
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow:
    0 30px 60px rgba(0, 0, 0, 0.35),
    inset 0 1px 1.5px rgba(255, 255, 255, 0.18);
}

:global(.dark .geo-text) {
  -webkit-text-stroke: 1.2px rgba(20, 184, 166, 0.6);
  text-shadow: none;
}

.geo-fade-enter-active,
.geo-fade-leave-active {
  transition: opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.5s cubic-bezier(0.16, 1, 0.3, 1),
              filter 0.5s ease;
}

.geo-fade-leave-to {
  opacity: 0;
  transform: scale(1.1) translate3d(0, -8px, 0);
  filter: blur(4px);
}

.geo-fade-enter-from {
  opacity: 0;
  transform: scale(0.85) translate3d(0, 8px, 0);
  filter: blur(4px);
}

.brand-content {
  position: relative;
  z-index: 1;
  margin-top: 20px;
}

.brand-tag {
  display: inline-block;
  padding: 6px 14px;
  background: var(--ca-chip-bg);
  color: var(--ca-chip-text);
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
  color: var(--ca-fg);
}

.brand-desc {
  font-size: 15px;
  line-height: 1.8;
  color: var(--ca-sub);
  max-width: 90%;
}

.brand-footer {
  color: var(--ca-muted);
  position: relative;
  z-index: 1;
}

.brand-footer__version {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.2;
}

.brand-footer__repo-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  color: inherit;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.35;
  opacity: 0.92;
  text-decoration: none;
}

.brand-footer__repo-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.brand-footer__repo-link:hover {
  text-decoration: underline;
}

.brand-footer__copyright {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
}

.form-panel {
  flex: 1.1;
  background: transparent;
  padding: 48px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  position: relative;
}

.form-container {
  width: 100%;
  max-width: 340px;
  position: relative;
  z-index: 1;
  margin-top: 0;
}

.form-wrapper {
  transition: height 0.35s cubic-bezier(0.25, 1, 0.5, 1);
  will-change: height;
  position: relative;
}

.form-wrapper.is-animating {
  overflow: hidden;
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
  background: rgba(0, 0, 0, 0.03);
  padding: 5px;
  border-radius: 16px;
  margin-bottom: 40px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.02);
}

:global(.dark .mode-toggle) {
  background: rgba(0, 0, 0, 0.3);
  border-color: rgba(255, 255, 255, 0.05);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
}

.toggle-slider {
  position: absolute;
  top: 5px;
  left: 5px;
  width: calc((100% - 10px) / 3);
  height: calc(100% - 10px);
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.04);
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

:global(.dark .toggle-slider) {
  background: rgba(255, 255, 255, 0.15);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.toggle-btn {
  flex: 1;
  position: relative;
  z-index: 10;
  padding: 10px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ca-muted);
  border: none;
  background: transparent;
  cursor: pointer;
  transition: color 0.3s;
}

.toggle-btn.is-active {
  color: var(--ca-fg);
}

.success-pill {
  margin-bottom: 20px;
  border-radius: 16px;
  background: rgba(13, 148, 136, 0.12);
  border: 1px solid rgba(13, 148, 136, 0.2);
  color: #0f766e;
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
  color: var(--ca-fg);
  margin-bottom: 6px;
  letter-spacing: -0.5px;
}

.block-subtitle {
  font-size: 13px;
  color: var(--ca-sub);
  margin-bottom: 24px;
}

.register-channel-alert {
  margin-bottom: 20px;
}

.geo-input :deep(.el-input__wrapper) {
  height: 52px;
  border-radius: 14px;
  background-color: var(--ca-bg);
  border: 1px solid var(--ca-border);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02) !important;
  padding: 0 16px;
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.geo-input :deep(.el-input__wrapper:hover) {
  background-color: var(--ca-hover-bg);
  border-color: var(--ca-hover-bd);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04) !important;
}

.geo-input :deep(.el-input__wrapper.is-focus) {
  background-color: var(--ca-focus-bg);
  border-color: var(--ca-focus-bd);
  box-shadow: var(--ca-ring) !important;
}

.geo-input :deep(.el-input__inner) {
  color: var(--ca-fg);
  font-weight: 500;
  font-size: 14px;
}

:global(.dark .geo-input .el-input__inner) {
  color: var(--ca-fg);
}

.geo-input-select :deep(.el-select__wrapper),
.geo-input-select :deep(.el-tree-select__wrapper) {
  min-height: 52px;
  border-radius: 14px;
  background-color: var(--ca-bg);
  border: 1px solid var(--ca-border);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02) !important;
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.geo-input-select :deep(.el-select__wrapper:hover),
.geo-input-select :deep(.el-tree-select__wrapper:hover) {
  background-color: var(--ca-hover-bg);
  border-color: var(--ca-hover-bd);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04) !important;
}

.geo-input-select :deep(.el-select__wrapper.is-focused),
.geo-input-select :deep(.el-tree-select__wrapper.is-focused) {
  background-color: var(--ca-focus-bg);
  border-color: var(--ca-focus-bd);
  box-shadow: var(--ca-ring) !important;
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
  color: var(--ca-muted);
}

.geo-input :deep(.el-input__wrapper.is-focus .input-icon) {
  color: #0d9488;
}

.staff-lookup-enter-active,
.staff-lookup-leave-active {
  transition:
    grid-template-rows 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.22s ease;
  overflow: hidden;
  display: grid;
  grid-template-rows: 1fr;
  will-change: grid-template-rows, opacity;
}

.staff-lookup-enter-from,
.staff-lookup-leave-to {
  opacity: 0;
  grid-template-rows: 0fr;
}

.staff-lookup-enter-to,
.staff-lookup-leave-from {
  opacity: 1;
  grid-template-rows: 1fr;
}

.staff-lookup-slot {
  min-height: 0;
  overflow: hidden;
  contain: layout paint;
}

.staff-lookup-enter-active .staff-lookup-card,
.staff-lookup-leave-active .staff-lookup-card {
  transition:
    transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.24s ease,
    filter 0.28s ease;
  will-change: transform, opacity, filter;
}

.staff-lookup-enter-from .staff-lookup-card,
.staff-lookup-leave-to .staff-lookup-card {
  opacity: 0;
  transform: translate3d(0, -6px, 0) scale(0.985);
  filter: saturate(0.92);
}

.staff-lookup-enter-to .staff-lookup-card,
.staff-lookup-leave-from .staff-lookup-card {
  opacity: 1;
  transform: translate3d(0, 0, 0) scale(1);
  filter: saturate(1);
}

.staff-lookup-card {
  position: relative;
  display: flex;
  gap: 12px;
  min-height: 88px;
  padding: 14px 15px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.45);
  overflow: hidden;
  backface-visibility: hidden;
  transform: translateZ(0);
  transition:
    background-color 0.24s ease,
    border-color 0.24s ease,
    box-shadow 0.24s ease;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.02);
}

.staff-lookup-card.is-loading::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.72), transparent);
  transform: translateX(-100%);
  animation: staff-lookup-shine 1.25s ease-in-out infinite;
}

.staff-lookup-card--success {
  border-color: rgba(13, 148, 136, 0.26);
  background: rgba(240, 253, 250, 0.92);
  box-shadow: 0 10px 24px rgba(13, 148, 136, 0.08);
}

.staff-lookup-card--warning {
  border-color: rgba(245, 158, 11, 0.28);
  background: rgba(255, 251, 235, 0.92);
  box-shadow: 0 10px 24px rgba(245, 158, 11, 0.08);
}

.staff-lookup-card--danger {
  border-color: rgba(244, 63, 94, 0.22);
  background: rgba(255, 241, 242, 0.88);
  box-shadow: 0 10px 24px rgba(244, 63, 94, 0.07);
}

.staff-lookup-card--info {
  border-color: rgba(148, 163, 184, 0.26);
  background: rgba(248, 250, 252, 0.94);
}

.staff-lookup-card__icon {
  position: relative;
  z-index: 1;
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: #ffffff;
  color: #0f766e;
  font-size: 15px;
  font-weight: 800;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
}

.staff-lookup-card--warning .staff-lookup-card__icon {
  color: #b45309;
}

.staff-lookup-card--danger .staff-lookup-card__icon {
  color: #be123c;
}

.staff-lookup-card__content {
  position: relative;
  z-index: 1;
  min-width: 0;
  flex: 1;
}

.staff-lookup-card__message {
  color: #334155;
  font-size: 12px;
  line-height: 1.6;
}

.staff-lookup-card__grid {
  display: grid;
  grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.25fr);
  gap: 10px;
  margin-top: 8px;
}

.staff-lookup-card__grid span,
.staff-lookup-card__grid strong {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.staff-lookup-card__grid span {
  color: var(--ca-muted);
  font-size: 11px;
  line-height: 1.4;
}

.staff-lookup-card__grid strong {
  color: #0f172a;
  font-size: 13px;
  line-height: 1.6;
}

.staff-lookup-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(13, 148, 136, 0.2);
  border-top-color: #0f766e;
  border-radius: 999px;
  animation: staff-lookup-spin 0.8s linear infinite;
}

@keyframes staff-lookup-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes staff-lookup-shine {
  to {
    transform: translateX(100%);
  }
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
  background: rgba(255, 255, 255, 0.4);
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: none;
  overflow: hidden;
}

.captcha-box--placeholder {
  border-color: transparent;
  background: transparent;
}

.captcha-box:hover {
  background: rgba(255, 255, 255, 0.6);
  border-color: rgba(255, 255, 255, 0.9);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
}

.captcha-box:active {
  transform: scale(0.98);
}

.captcha-box:disabled {
  cursor: wait;
  transform: none;
}

.captcha-loading {
  font-size: 12px;
  color: var(--ca-muted);
}

.captcha-render {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100px;
  height: 36px;
  object-fit: contain;
}

.captcha-hint-text,
.password-hint-text {
  margin-top: -6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ca-muted);
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
  color: var(--ca-muted);
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
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 52px;
  border-radius: 14px !important;
  background-color: #0f766e !important;
  color: #ffffff !important;
  border: none !important;
  font-size: 15px !important;
  font-weight: 600 !important;
  margin-top: 24px;
  transition: box-shadow 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), 
              transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
  z-index: 1;
}

.submit-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: #14b8a6; /* 亮绿色填充 */
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: -1;
  border-radius: inherit;
}

.submit-btn:hover::before {
  transform: scaleX(1);
}

.submit-btn:hover {
  background-color: #0f766e !important; /* 保持原底色，让伪元素覆盖 */
  transform: translate3d(0, -2px, 0);
  box-shadow: 0 10px 20px rgba(13, 148, 136, 0.3) !important;
}

.submit-btn:active {
  transform: scale(0.96) translate3d(0, 1px, 0) !important;
  box-shadow: 0 4px 8px rgba(13, 148, 136, 0.15) !important;
}

.auth-fade-enter-active,
.auth-fade-leave-active {
  transition: opacity 0.35s cubic-bezier(0.25, 1, 0.5, 1),
              transform 0.35s cubic-bezier(0.25, 1, 0.5, 1);
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

.auth-fade-enter-from {
  opacity: 0;
  transform: scale(0.97) translate3d(12px, 0, 0);
}

.auth-fade-leave-to {
  opacity: 0;
  transform: scale(0.97) translate3d(-12px, 0, 0);
}

@media (max-width: 860px) {
  .auth-shell {
    flex-direction: column;
    min-height: auto;
  }

  .brand-panel {
    padding: 32px 24px;
    flex: none;
    min-height: 240px;
    max-height: 280px;
    overflow: hidden; /* 移动端限制高度并裁剪流体 */
    border-right: none;
    border-bottom: 1px solid rgba(0, 0, 0, 0.02); /* 淡化底部边界线 */
  }

  .brand-title {
    font-size: 28px;
    margin-bottom: 8px;
  }

  .brand-subtitle {
    font-size: 14px;
    margin-top: 12px; /* 增加副标题上方留白 */
    opacity: 0.8;
  }

  .brand-footer {
    display: none;
  }

  /* 移动端：缩小流体几何与位移范围，深度防遮挡 */
  .wrapper-main {
    width: 160px;
    height: 160px;
    top: -10px;
    right: 0px;
  }

  .wrapper-sub {
    width: 110px;
    height: 110px;
    bottom: 0px;
    left: 0px;
  }

  .geo-text {
    font-size: 1.4rem; /* 进一步缩小线框字，完美嵌入几何体 */
    -webkit-text-stroke-width: 1px;
  }

  .wrapper-main .geo-text {
    transform: translate3d(-4px, 4px, 0);
  }

  .wrapper-sub .geo-text {
    transform: translate3d(4px, -4px, 0);
  }

  /* 移动端交互坐标覆写：极限压缩下方的位移，防止触碰底边裁切线 */
  .brand-panel.is-username-focus .wrapper-main {
    transform: translate3d(-5px, 5px, 0) scale(1.05);
  }
  .brand-panel.is-username-focus .wrapper-sub {
    transform: translate3d(5px, -5px, 0) scale(0.95);
  }

  .brand-panel.is-password-focus .wrapper-main {
    transform: translate3d(5px, -5px, 0) scale(1.05);
  }
  .brand-panel.is-password-focus .wrapper-sub {
    /* 重点修复：向上方移动，避免 "SAFE" 被裁切 */
    transform: translate3d(-5px, -10px, 0) scale(0.9);
  }

  .brand-panel.is-register-mode .wrapper-main {
    transform: translate3d(-20px, 20px, 0) scale(1.1);
  }
  .brand-panel.is-register-mode .wrapper-sub {
    transform: translate3d(10px, -20px, 0) scale(1.05);
  }

  .form-panel {
    padding: 32px 20px;
  }

  .auth-form {
    padding: 0;
  }

  .auth-mode-toggle {
    margin-bottom: 24px; /* 稍微拉近与下方的距离，优化留白 */
  }

  .auth-welcome {
    margin-bottom: 24px;
  }

  .register-feedback-alert__actions {
    gap: 4px 10px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .client-auth-page *,
  .client-auth-page *::before,
  .client-auth-page *::after {
    animation: none !important;
    transition: none !important;
  }

  .wrapper-main,
  .wrapper-sub,
  .brand-panel:is(.is-username-focus, .is-password-focus, .is-register-mode) :is(.wrapper-main, .wrapper-sub) {
    opacity: 1 !important;
    transform: none !important;
  }

  .geo-decor,
  .brand-panel:is(.is-username-focus, .is-password-focus, .is-register-mode) :is(.circle-main, .circle-sub) {
    border-radius: 50% !important;
    box-shadow: none !important;
    transform: none !important;
  }

  :is(.geo-fade-enter-from, .geo-fade-leave-to, .auth-fade-enter-from, .auth-fade-leave-to, .staff-lookup-enter-from, .staff-lookup-leave-to),
  :is(.staff-lookup-enter-from, .staff-lookup-leave-to) .staff-lookup-card {
    filter: none !important;
    grid-template-rows: 1fr !important;
    opacity: 1 !important;
    transform: none !important;
  }

}
</style>
