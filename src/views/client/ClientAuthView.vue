<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientAuthView.vue
 * 文件职责：承载客户端登录、个人注册与部门注册三条认证入口，并以参考样版骨架呈现左品牌区与右表单区。
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

interface AuthModeTabOption {
  mode: AuthMode
  label: string
  eyebrow: string
  title: string
  subtitle: string
  footnote: string
}

interface BrandFeatureItem {
  title: string
  description: string
}

const authModeTabs: AuthModeTabOption[] = [
  {
    mode: 'login',
    label: '登录',
    eyebrow: '欢迎回来',
    title: '进入文创预约大厅',
    subtitle: '继续使用现有账号即可查看库存、提交预约并同步订单状态。',
    footnote: '支持使用用户名、手机号或邮箱登录。',
  },
  {
    mode: 'register-personal',
    label: '个人注册',
    eyebrow: '新用户接入',
    title: '创建个人预约账号',
    subtitle: '适合散客或个人访客使用，注册后即可按个人流程进入商品预约。',
    footnote: '个人账号默认按散客流程下单，无需填写部门资料。',
  },
  {
    mode: 'register-department',
    label: '部门注册',
    eyebrow: '部门协同',
    title: '创建部门协同账号',
    subtitle: '适合校内部门或组织统一预约，注册时会校验真实姓名、教职工号与所属部门。',
    footnote: '部门账号会严格校验教职工号与部门信息，避免冒用。',
  },
]

const brandFeatureItems: BrandFeatureItem[] = [
  {
    title: '库存同步',
    description: '提交前即时确认库存状态，避免预约后才发现可用名额不足。',
  },
  {
    title: '在线锁单',
    description: '完成认证后即可进入商品大厅，在线预约后自动进入订单流程。',
  },
  {
    title: '部门协同',
    description: '支持部门实名注册、教职工号校验与部门归属确认。',
  },
]

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
const activeModeMeta = computed(() => authModeTabs.find((item) => item.mode === activeMode.value) ?? authModeTabs[0])
const activeModeIndex = computed(() => Math.max(authModeTabs.findIndex((item) => item.mode === activeMode.value), 0))
const registerModeHintText = computed(() => {
  if (isDepartmentRegister.value) {
    return hasRegisterDepartmentTree.value
      ? '部门账号需绑定系统内部门目录，后续预约、协同和对账都将按该归属执行。'
      : '当前尚未导入部门树，请先填写所属部门名称，后续可由管理员继续维护。'
  }
  return '个人账号默认按个人流程预约，无需填写教职工号和部门信息。'
})
const registerVerificationHintText = computed(() => (
  registerUsesVerificationCode.value
    ? '先完成图形验证码校验，再发送手机或邮箱验证码。'
    : captchaHintText.value
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
    && registerDepartmentOptions.value.length > 0
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
    <div class="bg-shape bg-shape--primary" aria-hidden="true"></div>
    <div class="bg-shape bg-shape--secondary" aria-hidden="true"></div>
    <main class="auth-shell">
      <aside class="brand-panel">
        <div class="brand-panel__decor brand-panel__decor--large" aria-hidden="true"></div>
        <div class="brand-panel__decor brand-panel__decor--small" aria-hidden="true"></div>

        <div class="brand-panel__header">
          <span class="brand-tag">Y-LINK CLIENT</span>
          <p class="brand-panel__eyebrow">企业级文创预约入口</p>
        </div>

        <div class="brand-panel__content">
          <div class="brand-copy">
            <h1 class="brand-title">野辙文创<br />在线预约</h1>
            <p class="brand-desc">
              以更接近经典认证页的双栏骨架承载登录、个人注册和部门注册，让用户在同一入口完成实名认证、验证码校验与预约前接入。
            </p>
          </div>

          <div class="brand-preview" aria-hidden="true">
            <div class="brand-preview__stack brand-preview__stack--back"></div>
            <div class="brand-preview__stack brand-preview__stack--middle"></div>
            <div class="brand-preview__stack brand-preview__stack--front">
              <div class="brand-preview__row">
                <span class="brand-preview__badge">在线可用</span>
                <span class="brand-preview__badge brand-preview__badge--soft">三态认证</span>
              </div>
              <div class="brand-preview__title">登录、个人注册、部门注册集中承载</div>
              <p class="brand-preview__desc">参考样版的左品牌右表单骨架已回归，原有实名、工号、部门与验证码链路继续保留。</p>
              <div class="brand-preview__lines">
                <span class="brand-preview__line brand-preview__line--long"></span>
                <span class="brand-preview__line"></span>
                <span class="brand-preview__line brand-preview__line--short"></span>
              </div>
              <div class="brand-preview__metrics">
                <span>实名注册</span>
                <span>部门归属</span>
                <span>验证码校验</span>
              </div>
            </div>
          </div>

          <ul class="brand-feature-list">
            <li v-for="item in brandFeatureItems" :key="item.title" class="brand-feature-item">
              <span class="brand-feature-item__dot"></span>
              <div>
                <strong>{{ item.title }}</strong>
                <p>{{ item.description }}</p>
              </div>
            </li>
          </ul>
        </div>

        <div class="brand-footer">
          <div class="brand-footer__version">{{ APP_META.version }}</div>
          <a
            class="brand-footer__link"
            :href="APP_META.repositoryUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ APP_META.repositoryLabel }}
          </a>
          <div class="brand-footer__copyright">{{ APP_META.copyright }}</div>
        </div>
      </aside>

      <section class="form-panel">
        <div class="form-panel__inner">
          <div class="mode-switch" :style="{ '--mode-index': `${activeModeIndex}` }">
            <span class="mode-switch__thumb" aria-hidden="true"></span>
            <button
              v-for="tab in authModeTabs"
              :key="tab.mode"
              :class="{ active: activeMode === tab.mode }"
              type="button"
              @click="activeMode = tab.mode"
            >
              {{ tab.label }}
            </button>
          </div>

          <transition name="auth-panel" mode="out-in">
            <div :key="activeMode" class="panel-stage">
              <div class="form-header">
                <p class="form-header__eyebrow">{{ activeModeMeta.eyebrow }}</p>
                <h2>{{ activeModeMeta.title }}</h2>
                <p class="form-header__subtitle">{{ activeModeMeta.subtitle }}</p>
              </div>

              <form v-if="activeMode === 'login'" class="form-body" @submit.prevent="handleLogin">
                <el-input v-model="loginForm.account" placeholder="用户名 / 手机号 / 邮箱" class="auth-input" size="large" clearable>
                  <template #prefix><el-icon><User /></el-icon></template>
                </el-input>
                <el-input v-model="loginForm.password" placeholder="密码" class="auth-input" type="password" size="large" show-password>
                  <template #prefix><el-icon><Lock /></el-icon></template>
                </el-input>
                <div v-if="loginCaptchaVisible" class="captcha-row">
                  <el-input v-model="loginForm.captcha" placeholder="图形验证码" class="auth-input" size="large" clearable>
                    <template #prefix><el-icon><Key /></el-icon></template>
                  </el-input>
                  <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha()">
                    <img v-if="captchaImageSrc" :src="captchaImageSrc" alt="图形验证码" />
                    <span v-else>{{ captchaLoading ? '刷新中' : '获取验证码' }}</span>
                  </button>
                </div>
                <p v-if="loginCaptchaVisible" class="field-tip">{{ captchaHintText }}</p>
                <div class="form-actions">
                  <span class="inline-help">登录后可直接进入商品大厅查看库存与订单状态。</span>
                  <router-link v-if="forgotPasswordAvailable" to="/client/forgot-password" class="link-btn">忘记密码</router-link>
                </div>
                <el-button class="submit-btn" type="primary" native-type="submit" :loading="loading">进入商品大厅</el-button>
              </form>

              <form v-else class="form-body" @submit.prevent="handleRegister">
                <div class="register-channel">
                  <div class="register-channel__tag">
                    {{ isDepartmentRegister ? '部门注册通道' : '个人注册通道' }}
                  </div>
                  <p class="register-channel__desc">
                    {{ isDepartmentRegister ? '继续保留真实姓名、教职工号、部门与验证码校验。' : '继续保留真实姓名、登录账号与验证码校验。' }}
                  </p>
                </div>

                <el-input v-model="registerForm.username" placeholder="真实姓名（必填）" class="auth-input" size="large" clearable>
                  <template #prefix><el-icon><User /></el-icon></template>
                </el-input>
                <el-input v-model="registerForm.account" placeholder="登录账号（手机号或邮箱）" class="auth-input" size="large" clearable>
                  <template #prefix><el-icon><User /></el-icon></template>
                </el-input>
                <el-input
                  v-if="isDepartmentRegister"
                  v-model="registerForm.staffNo"
                  placeholder="教职工号（部门账号必填）"
                  class="auth-input"
                  size="large"
                  clearable
                >
                  <template #prefix><el-icon><Key /></el-icon></template>
                </el-input>
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
                  class="auth-select"
                  size="large"
                  clearable
                  filterable
                />
                <el-input
                  v-else-if="isDepartmentRegister"
                  v-model="registerForm.department"
                  placeholder="所属部门（部门账号必填）"
                  class="auth-input"
                  size="large"
                  clearable
                />
                <p class="field-tip">{{ registerModeHintText }}</p>

                <div class="captcha-row">
                  <el-input
                    v-model="registerForm.captcha"
                    :placeholder="registerUsesVerificationCode ? '先输入图形验证码，再发送短信/邮箱验证码' : '图形验证码'"
                    class="auth-input"
                    size="large"
                    clearable
                  >
                    <template #prefix><el-icon><Key /></el-icon></template>
                  </el-input>
                  <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha()">
                    <img v-if="captchaImageSrc" :src="captchaImageSrc" alt="图形验证码" />
                    <span v-else>{{ captchaLoading ? '刷新中' : '获取验证码' }}</span>
                  </button>
                </div>
                <p class="field-tip">{{ registerVerificationHintText }}</p>

                <div v-if="registerUsesVerificationCode" class="captcha-row captcha-row--verification">
                  <el-input v-model="registerForm.verificationCode" placeholder="手机 / 邮箱验证码" class="auth-input" size="large" clearable>
                    <template #prefix><el-icon><Message /></el-icon></template>
                  </el-input>
                  <el-button
                    class="verification-button"
                    type="default"
                    :disabled="verificationSending || registerVerificationCountdown > 0"
                    @click="handleSendRegisterVerificationCode"
                  >
                    {{ registerVerificationCountdown > 0 ? `${registerVerificationCountdown}s 后重发` : verificationSending ? '发送中' : '发送验证码' }}
                  </el-button>
                </div>

                <el-input
                  v-model="registerForm.password"
                  :placeholder="CLIENT_NEW_PASSWORD_PLACEHOLDER"
                  class="auth-input"
                  type="password"
                  size="large"
                  show-password
                >
                  <template #prefix><el-icon><Lock /></el-icon></template>
                </el-input>
                <el-input
                  v-model="registerForm.confirmPassword"
                  :placeholder="CLIENT_CONFIRM_NEW_PASSWORD_PLACEHOLDER"
                  type="password"
                  class="auth-input"
                  size="large"
                  show-password
                >
                  <template #prefix><el-icon><Lock /></el-icon></template>
                </el-input>
                <p class="field-tip">{{ CLIENT_NEW_PASSWORD_RULE_HINT }}</p>

                <el-button class="submit-btn" type="primary" native-type="submit" :loading="loading">立即注册</el-button>
              </form>

              <p class="panel-footnote">{{ activeModeMeta.footnote }}</p>
            </div>
          </transition>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.client-auth-page {
  position: relative;
  min-height: 100dvh;
  overflow: hidden;
  background: #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.bg-shape {
  position: absolute;
  pointer-events: none;
  filter: blur(88px);
  z-index: 0;
}

.bg-shape--primary {
  width: 58vw;
  height: 58vw;
  top: -16%;
  left: -18%;
  border-radius: 50%;
  background: rgba(13, 148, 136, 0.08);
}

.bg-shape--secondary {
  width: 46vw;
  height: 46vw;
  right: -10%;
  bottom: -10%;
  border-radius: 50%;
  background: rgba(59, 130, 246, 0.06);
}

.auth-shell {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 980px;
  min-height: 620px;
  background: #ffffff;
  border-radius: 32px;
  box-shadow:
    0 24px 48px rgba(15, 23, 42, 0.08),
    0 2px 6px rgba(15, 23, 42, 0.04);
  overflow: hidden;
  display: flex;
}

.brand-panel {
  position: relative;
  overflow: hidden;
  flex: 1;
  padding: 44px 40px 32px;
  background: linear-gradient(135deg, #f0fdfa 0%, #f8fafc 100%);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 28px;
}

.brand-panel__decor {
  position: absolute;
  border-radius: 999px;
  pointer-events: none;
}

.brand-panel__decor--large {
  width: 280px;
  height: 280px;
  top: -88px;
  right: -92px;
  background: rgba(13, 148, 136, 0.05);
  border: 1px solid rgba(13, 148, 136, 0.08);
}

.brand-panel__decor--small {
  width: 180px;
  height: 180px;
  left: -54px;
  bottom: 10%;
  background: rgba(15, 118, 110, 0.04);
}

.brand-panel__header,
.brand-panel__content,
.brand-footer {
  position: relative;
  z-index: 1;
}

.brand-panel__header {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.brand-tag {
  display: inline-flex;
  width: fit-content;
  padding: 6px 14px;
  border-radius: 10px;
  background: rgba(13, 148, 136, 0.2);
  color: #0f172a;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.brand-panel__eyebrow {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #0f766e;
}

.brand-panel__content {
  display: flex;
  flex-direction: column;
  gap: 24px;
  flex: 1;
}

.brand-copy {
  max-width: 380px;
}

.brand-title {
  margin: 0;
  font-size: 42px;
  line-height: 1.2;
  letter-spacing: -0.03em;
  color: #0f172a;
}

.brand-desc {
  margin: 20px 0 0;
  font-size: 15px;
  line-height: 1.8;
  color: #475569;
}

.brand-preview {
  position: relative;
  min-height: 208px;
}

.brand-preview__stack {
  position: absolute;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 18px 36px rgba(15, 23, 42, 0.09);
}

.brand-preview__stack--back {
  inset: 18px 54px 18px 66px;
  opacity: 0.5;
  transform: rotate(7deg);
}

.brand-preview__stack--middle {
  inset: 22px 34px 10px 48px;
  opacity: 0.64;
  transform: rotate(-5deg);
}

.brand-preview__stack--front {
  inset: 0 0 0 0;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: rgba(255, 255, 255, 0.96);
}

.brand-preview__row,
.brand-preview__metrics {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.brand-preview__badge,
.brand-preview__metrics span {
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
}

.brand-preview__badge {
  background: rgba(15, 23, 42, 0.92);
  color: #f8fafc;
}

.brand-preview__badge--soft {
  background: rgba(15, 118, 110, 0.12);
  color: #0f766e;
}

.brand-preview__title {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.5;
  color: #0f172a;
}

.brand-preview__desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: #475569;
}

.brand-preview__lines {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.brand-preview__line {
  display: block;
  width: 100%;
  height: 10px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(15, 23, 42, 0.08), rgba(13, 148, 136, 0.32));
}

.brand-preview__line--long {
  width: 92%;
}

.brand-preview__line--short {
  width: 64%;
}

.brand-preview__metrics span {
  background: rgba(241, 245, 249, 0.92);
  color: #334155;
}

.brand-feature-list {
  display: grid;
  gap: 14px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.brand-feature-item {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.brand-feature-item__dot {
  width: 12px;
  height: 12px;
  margin-top: 7px;
  border-radius: 999px;
  background: linear-gradient(135deg, #14b8a6, #0f766e);
  box-shadow: 0 0 0 6px rgba(20, 184, 166, 0.12);
}

.brand-feature-item strong {
  display: block;
  font-size: 15px;
  color: #0f172a;
}

.brand-feature-item p {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: #475569;
}

.brand-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
  color: #64748b;
}

.brand-footer__link {
  color: inherit;
  text-decoration: none;
}

.form-panel {
  flex: 1.08;
  padding: 44px 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
}

.form-panel__inner {
  width: 100%;
  max-width: 368px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.mode-switch {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  background: #f1f5f9;
  border-radius: 16px;
  padding: 5px;
}

.mode-switch__thumb {
  position: absolute;
  top: 5px;
  left: 5px;
  width: calc((100% - 10px - 8px) / 3);
  height: calc(100% - 10px);
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.05);
  transform: translateX(calc(var(--mode-index, 0) * 100%));
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 0;
}

.mode-switch button {
  position: relative;
  z-index: 1;
  height: 44px;
  border-radius: 12px;
  border: 0;
  background: transparent;
  color: #475569;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.22s ease;
}

.mode-switch button:hover,
.mode-switch button.active {
  color: #0f172a;
}

.panel-stage {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-header__eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #0f766e;
  text-transform: uppercase;
}

.form-header h2 {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.form-header__subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: #64748b;
}

.register-channel {
  border-radius: 16px;
  background: rgba(241, 245, 249, 0.72);
  padding: 14px 16px;
}

.register-channel__tag {
  display: inline-flex;
  width: fit-content;
  border-radius: 999px;
  background: rgba(13, 148, 136, 0.12);
  color: #0f766e;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 700;
}

.register-channel__desc {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: #64748b;
}

.auth-input :deep(.el-input__wrapper),
.auth-select :deep(.el-select__wrapper),
.auth-select :deep(.el-tree-select__wrapper) {
  min-height: 52px;
  border-radius: 14px;
  background: #f8fafc;
  border: 1px solid transparent;
  box-shadow: none !important;
  padding-inline: 16px;
  transition:
    background-color 0.22s ease,
    border-color 0.22s ease,
    box-shadow 0.22s ease;
}

.auth-input :deep(.el-input__wrapper:hover),
.auth-select :deep(.el-select__wrapper:hover),
.auth-select :deep(.el-tree-select__wrapper:hover) {
  background: #f1f5f9;
}

.auth-input :deep(.el-input__wrapper.is-focus),
.auth-select :deep(.el-select__wrapper.is-focused),
.auth-select :deep(.el-tree-select__wrapper.is-focused),
.auth-select :deep(.el-select__wrapper.is-focus),
.auth-select :deep(.el-tree-select__wrapper.is-focus) {
  background: #ffffff;
  border-color: #0d9488;
  box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.1) !important;
}

.captcha-row {
  display: grid;
  grid-template-columns: 1fr 132px;
  gap: 12px;
}

.captcha-row--verification {
  align-items: stretch;
}

.captcha-box {
  border: 1px dashed #dbe4ee;
  border-radius: 14px;
  background: #f8fafc;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  color: #475569;
  transition:
    transform 0.22s ease,
    background-color 0.22s ease,
    border-color 0.22s ease;
}

.captcha-box:hover:not(:disabled) {
  transform: translateY(-1px);
  background: #f1f5f9;
  border-color: rgba(13, 148, 136, 0.3);
}

.captcha-box:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.captcha-box img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 13px;
}

.field-tip {
  margin: -6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: #64748b;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.inline-help {
  margin-right: auto;
  font-size: 12px;
  color: #64748b;
}

.link-btn {
  font-size: 13px;
  color: #64748b;
  text-decoration: none;
  transition: color 0.22s ease;
}

.link-btn:hover {
  color: #0d9488;
}

.verification-button {
  min-height: 52px;
  border-radius: 14px;
  font-weight: 600;
}

.submit-btn {
  margin-top: 8px;
  height: 52px;
  border-radius: 14px;
  font-weight: 600;
  background-color: #0f766e !important;
  border: none !important;
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    background-color 0.22s ease;
}

.submit-btn:hover:not(.is-disabled):not(.is-loading) {
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgba(13, 148, 136, 0.22);
}

.submit-btn:active:not(.is-disabled):not(.is-loading) {
  transform: translateY(0);
}

.panel-footnote {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: #64748b;
}

.auth-panel-enter-active,
.auth-panel-leave-active {
  transition:
    opacity 0.24s ease,
    transform 0.24s ease;
}

.auth-panel-enter-from,
.auth-panel-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@keyframes shellEnter {
  from {
    opacity: 0;
    transform: translateY(24px) scale(0.985);
  }

  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes sectionEnter {
  from {
    opacity: 0;
    transform: translateY(18px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes backdropFloat {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
  }

  50% {
    transform: translate3d(0, 12px, 0);
  }
}

@keyframes haloPulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.88;
  }

  50% {
    transform: scale(1.05);
    opacity: 0.56;
  }
}

@keyframes cardFloat {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
  }

  50% {
    transform: translate3d(0, -8px, 0);
  }
}

@media (max-width: 1024px) {
  .auth-shell {
    flex-direction: column;
    min-height: auto;
  }

  .brand-panel {
    padding: 36px 24px 28px;
  }

  .form-panel {
    padding: 36px 24px 40px;
  }

  .form-panel__inner {
    max-width: 640px;
  }

  .brand-footer {
    display: none;
  }
}

@media (max-width: 768px) {
  .client-auth-page {
    padding: 16px;
  }

  .brand-panel,
  .form-panel {
    padding-inline: 20px;
  }

  .brand-title {
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
    border: 0;
  }

  .brand-panel {
    padding: max(20px, env(safe-area-inset-top)) 18px 18px;
  }

  .brand-preview {
    min-height: 196px;
  }

  .form-panel {
    padding: 22px 18px calc(24px + env(safe-area-inset-bottom));
  }

  .mode-switch__thumb {
    top: 4px;
    left: 4px;
    width: calc((100% - 8px - 8px) / 3);
    height: calc(100% - 8px);
  }

  .mode-switch button {
    height: 44px;
    font-size: 13px;
  }

  .captcha-row,
  .captcha-row--verification {
    grid-template-columns: 1fr;
  }

  .captcha-box,
  .verification-button,
  .submit-btn {
    width: 100%;
  }
}

</style>
