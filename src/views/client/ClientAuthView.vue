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

interface AuthModeTabOption {
  mode: AuthMode
  label: string
  eyebrow: string
  title: string
  subtitle: string
  footnote: string
}

interface RegisterTypeOption {
  value: ClientAccountType
  label: string
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

const registerTypeOptions: RegisterTypeOption[] = [
  { value: 'personal', label: '个人注册' },
  { value: 'department', label: '部门注册' },
]

const brandFeatureItems: BrandFeatureItem[] = [
  {
    title: '库存同步',
    description: '提交前即时确认库存状态，避免下单后才发现名额已满。',
  },
  {
    title: '在线锁单',
    description: '完成认证后即可进入商品大厅，在线预约后自动进入订单流程。',
  },
  {
    title: '部门协同',
    description: '支持部门账号实名接入，满足组织统一预约与对账场景。',
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
const registerTypeIndex = computed(() => Math.max(registerTypeOptions.findIndex((item) => item.value === registerAccountType.value), 0))
const registerModeHintText = computed(() => {
  if (isDepartmentRegister.value) {
    return hasRegisterDepartmentTree.value
      ? '请选择系统已配置的部门目录，确保部门账号后续协同与对账口径一致。'
      : '当前尚未导入部门树，请手动填写所属部门名称。'
  }
  return '个人账号默认按散客流程下单，无需填写部门信息。'
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
    <div class="client-auth-backdrop" aria-hidden="true">
      <span class="backdrop-orb backdrop-orb--mint"></span>
      <span class="backdrop-orb backdrop-orb--slate"></span>
      <span class="backdrop-grid"></span>
    </div>
    <main class="auth-shell">
      <section class="brand-panel">
        <div class="brand-panel__header">
          <div class="brand-chip-group">
            <span class="brand-chip">Y-LINK CLIENT</span>
            <span class="brand-chip brand-chip--soft">在线预约</span>
          </div>
          <p class="brand-panel__eyebrow">企业级文创预约入口</p>
        </div>

        <div class="brand-panel__content">
          <div class="brand-copy">
            <h1 class="brand-title">野辙文创预约<br>双入口工作台</h1> 
            <p class="brand-desc">
              面向个人与部门统一提供在线登录、实名注册、验证码校验与库存预约入口，让用户在一个首屏里完成接入与下单准备。
            </p>
          </div>

          <div class="brand-showcase" aria-hidden="true">
            <div class="brand-showcase__halo brand-showcase__halo--large"></div>
            <div class="brand-showcase__halo brand-showcase__halo--small"></div>
            <div class="showcase-card showcase-card--back"></div>
            <div class="showcase-card showcase-card--middle"></div>
            <div class="showcase-card showcase-card--front">
              <div class="showcase-card__header">
                <span class="showcase-card__badge">实时锁单</span>
                <span class="showcase-card__status">在线可用</span>
              </div>
              <div class="showcase-card__title">库存、身份与预约状态同步呈现</div>
              <p class="showcase-card__desc">登录后直接进入商品大厅，注册流程保持实名校验与验证码风控。</p>
              <div class="showcase-card__bars">
                <span class="showcase-card__bar showcase-card__bar--1"></span>
                <span class="showcase-card__bar showcase-card__bar--2"></span>
                <span class="showcase-card__bar showcase-card__bar--3"></span>
                <span class="showcase-card__bar showcase-card__bar--4"></span>
              </div>
              <div class="showcase-card__metrics">
                <span>个人接入</span>
                <span>部门协同</span>
                <span>验证码守卫</span>
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
          <div>{{ APP_META.version }}</div>
          <a :href="APP_META.repositoryUrl" target="_blank" rel="noopener noreferrer">{{ APP_META.repositoryLabel }}</a>
          <div>{{ APP_META.copyright }}</div>
        </div>
      </section>

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
                <el-input v-model="loginForm.account" placeholder="用户名 / 手机号 / 邮箱" size="large" clearable>
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
                <p v-if="loginCaptchaVisible" class="field-tip">{{ captchaHintText }}</p>
                <div class="form-actions">
                  <span class="inline-help">登录后可直接进入商品大厅查看库存与订单状态。</span>
                  <router-link v-if="forgotPasswordAvailable" to="/client/forgot-password" class="link-btn">忘记密码</router-link>
                </div>
                <el-button class="submit-btn" type="primary" native-type="submit" :loading="loading">进入商品大厅</el-button>
              </form>

              <form v-else class="form-body" @submit.prevent="handleRegister">
                <div class="register-type-switch" :style="{ '--register-index': `${registerTypeIndex}` }">
                  <span class="register-type-switch__thumb" aria-hidden="true"></span>
                  <button
                    v-for="item in registerTypeOptions"
                    :key="item.value"
                    :class="{ active: registerAccountType === item.value }"
                    type="button"
                    @click="registerAccountType = item.value"
                  >
                    {{ item.label }}
                  </button>
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
                <p class="field-tip">{{ registerModeHintText }}</p>

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
                <p class="field-tip">{{ registerVerificationHintText }}</p>

                <div v-if="registerUsesVerificationCode" class="captcha-row captcha-row--verification">
                  <el-input v-model="registerForm.verificationCode" placeholder="手机 / 邮箱验证码" size="large" clearable>
                    <template #prefix><el-icon><Message /></el-icon></template>
                  </el-input>
                  <el-button
                    class="verification-button"
                    :disabled="verificationSending || registerVerificationCountdown > 0"
                    @click="handleSendRegisterVerificationCode"
                  >
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
  background:
    radial-gradient(circle at top left, rgba(45, 212, 191, 0.16), transparent 32%),
    linear-gradient(180deg, #f8fbfb 0%, #eef4f7 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}

.client-auth-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.backdrop-orb,
.backdrop-grid {
  position: absolute;
}

.backdrop-orb {
  border-radius: 999px;
  filter: blur(10px);
  opacity: 0.72;
  animation: backdropFloat 12s ease-in-out infinite;
}

.backdrop-orb--mint {
  width: 360px;
  height: 360px;
  top: -96px;
  left: -72px;
  background: radial-gradient(circle, rgba(45, 212, 191, 0.22) 0%, rgba(45, 212, 191, 0) 72%);
}

.backdrop-orb--slate {
  width: 420px;
  height: 420px;
  right: -140px;
  bottom: -140px;
  background: radial-gradient(circle, rgba(148, 163, 184, 0.2) 0%, rgba(148, 163, 184, 0) 72%);
  animation-delay: -5s;
}

.backdrop-grid {
  inset: 0;
  background-image:
    linear-gradient(rgba(15, 23, 42, 0.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(15, 23, 42, 0.028) 1px, transparent 1px);
  background-size: 80px 80px;
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.32), transparent 92%);
}

.auth-shell {
  position: relative;
  z-index: 1;
  width: min(1080px, 100%);
  min-height: min(760px, calc(100dvh - 56px));
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 32px;
  box-shadow:
    0 28px 70px rgba(15, 23, 42, 0.14),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(14px);
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(360px, 43%) minmax(0, 1fr);
  animation: shellEnter 0.72s cubic-bezier(0.22, 1, 0.36, 1);
}

.brand-panel {
  position: relative;
  overflow: hidden;
  padding: 42px 36px 34px;
  background:
    radial-gradient(circle at 18% 20%, rgba(255, 255, 255, 0.82), transparent 22%),
    linear-gradient(145deg, #dff8f2 0%, #edf4f8 42%, #f8fafc 100%);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 28px;
  animation: sectionEnter 0.82s cubic-bezier(0.22, 1, 0.36, 1);
}

.brand-panel::before,
.brand-panel::after {
  content: '';
  position: absolute;
  border-radius: 999px;
  pointer-events: none;
}

.brand-panel::before {
  width: 360px;
  height: 360px;
  top: -180px;
  right: -120px;
  background: radial-gradient(circle, rgba(13, 148, 136, 0.16) 0%, rgba(13, 148, 136, 0) 72%);
}

.brand-panel::after {
  width: 280px;
  height: 280px;
  left: -120px;
  bottom: -120px;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.86) 0%, rgba(255, 255, 255, 0) 72%);
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
  gap: 12px;
}

.brand-chip-group {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.brand-chip {
  width: fit-content;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.92);
  color: #f8fafc;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.brand-chip--soft {
  background: rgba(255, 255, 255, 0.72);
  color: #0f172a;
  box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.3);
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
  max-width: 420px;
}

.brand-title {
  margin: 0;
  font-size: clamp(2.6rem, 4vw, 4.35rem);
  line-height: 1.06;
  letter-spacing: -0.04em;
  color: #0f172a;
}

.brand-desc {
  margin: 18px 0 0;
  font-size: 16px;
  line-height: 1.8;
  color: #475569;
}

.brand-showcase {
  position: relative;
  min-height: 240px;
  margin-top: 2px;
}

.brand-showcase__halo {
  position: absolute;
  border-radius: 999px;
  filter: blur(6px);
  animation: haloPulse 9s ease-in-out infinite;
}

.brand-showcase__halo--large {
  width: 220px;
  height: 220px;
  top: -8px;
  left: 8px;
  background: radial-gradient(circle, rgba(45, 212, 191, 0.2) 0%, rgba(45, 212, 191, 0) 76%);
}

.brand-showcase__halo--small {
  width: 150px;
  height: 150px;
  right: 18px;
  bottom: 12px;
  background: radial-gradient(circle, rgba(15, 23, 42, 0.12) 0%, rgba(15, 23, 42, 0) 76%);
  animation-delay: -3s;
}

.showcase-card {
  position: absolute;
  inset: auto;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.84);
  border: 1px solid rgba(255, 255, 255, 0.78);
  box-shadow: 0 24px 48px rgba(15, 23, 42, 0.14);
}

.showcase-card--back {
  width: 58%;
  height: 78%;
  right: 8%;
  top: 6%;
  opacity: 0.4;
  transform: rotate(9deg);
}

.showcase-card--middle {
  width: 66%;
  height: 84%;
  left: 12%;
  bottom: 4%;
  opacity: 0.52;
  transform: rotate(-6deg);
}

.showcase-card--front {
  inset: 0 12px 0 0;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: rgba(255, 255, 255, 0.96);
  animation: cardFloat 8s ease-in-out infinite;
}

.showcase-card__header,
.showcase-card__metrics {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.showcase-card__badge,
.showcase-card__status,
.showcase-card__metrics span {
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
}

.showcase-card__badge {
  background: rgba(15, 23, 42, 0.94);
  color: #f8fafc;
}

.showcase-card__status {
  background: rgba(20, 184, 166, 0.12);
  color: #0f766e;
}

.showcase-card__title {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.5;
  color: #0f172a;
}

.showcase-card__desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: #475569;
}

.showcase-card__bars {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: end;
  gap: 10px;
  min-height: 78px;
}

.showcase-card__bar {
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.16), rgba(13, 148, 136, 0.8));
}

.showcase-card__bar--1 {
  height: 44px;
}

.showcase-card__bar--2 {
  height: 70px;
}

.showcase-card__bar--3 {
  height: 56px;
}

.showcase-card__bar--4 {
  height: 82px;
}

.showcase-card__metrics span {
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
  gap: 8px;
  font-size: 14px;
  color: #64748b;
}

.brand-footer a {
  color: inherit;
  text-decoration: none;
}

.form-panel {
  padding: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 0.96) 100%);
  animation: sectionEnter 0.94s cubic-bezier(0.22, 1, 0.36, 1);
}

.form-panel__inner {
  width: min(100%, 500px);
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.mode-switch {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  background: rgba(226, 232, 240, 0.76);
  border-radius: 18px;
  padding: 6px;
  isolation: isolate;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
}

.mode-switch__thumb {
  position: absolute;
  top: 6px;
  left: 6px;
  width: calc((100% - 12px - 12px) / 3);
  height: calc(100% - 12px);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow:
    0 10px 24px rgba(15, 23, 42, 0.08),
    0 1px 2px rgba(15, 23, 42, 0.08);
  transform: translateX(calc(var(--mode-index, 0) * 100%));
  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 0;
}

.mode-switch button,
.register-type-switch button {
  position: relative;
  z-index: 1;
  height: 46px;
  border-radius: 14px;
  border: 0;
  background: transparent;
  color: #475569;
  font-weight: 700;
  cursor: pointer;
  transition:
    color 0.22s ease,
    transform 0.22s ease,
    opacity 0.22s ease;
}

.mode-switch button:hover,
.register-type-switch button:hover {
  color: #0f172a;
}

.mode-switch button.active,
.register-type-switch button.active {
  color: #0f172a;
}

.register-type-switch {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  background: rgba(241, 245, 249, 0.92);
  border-radius: 16px;
  padding: 6px;
  isolation: isolate;
}

.register-type-switch__thumb {
  position: absolute;
  top: 6px;
  left: 6px;
  width: calc((100% - 12px - 6px) / 2);
  height: calc(100% - 12px);
  border-radius: 12px;
  background: #ffffff;
  box-shadow:
    0 8px 20px rgba(15, 23, 42, 0.06),
    0 1px 2px rgba(15, 23, 42, 0.06);
  transform: translateX(calc(var(--register-index, 0) * 100%));
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 0;
}

.panel-stage {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.form-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-header {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-header__eyebrow {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #0f766e;
  text-transform: uppercase;
}

.form-header h2 {
  margin: 0;
  font-size: clamp(2rem, 3vw, 3rem);
  line-height: 1.1;
  letter-spacing: -0.04em;
  color: #0f172a;
}

.form-header__subtitle {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
  color: #64748b;
}

.form-body :deep(.el-input__wrapper),
.form-body :deep(.el-select__wrapper) {
  min-height: 52px;
  border-radius: 18px;
  padding-inline: 16px;
  box-shadow:
    0 0 0 1px rgba(203, 213, 225, 0.92) inset,
    0 1px 2px rgba(15, 23, 42, 0.04);
  transition:
    box-shadow 0.24s ease,
    transform 0.24s ease,
    background-color 0.24s ease;
}

.form-body :deep(.el-input__wrapper.is-focus),
.form-body :deep(.el-select__wrapper.is-focused),
.form-body :deep(.el-select__wrapper.is-focus) {
  box-shadow:
    0 0 0 2px rgba(20, 184, 166, 0.16),
    0 0 0 1px rgba(13, 148, 136, 0.72) inset,
    0 14px 24px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}

.form-body :deep(.el-input__wrapper:hover),
.form-body :deep(.el-select__wrapper:hover) {
  box-shadow:
    0 0 0 1px rgba(148, 163, 184, 0.98) inset,
    0 10px 20px rgba(15, 23, 42, 0.05);
}

.captcha-row {
  display: grid;
  grid-template-columns: 1fr 168px;
  gap: 10px;
}

.captcha-row--verification {
  align-items: stretch;
}

.captcha-box {
  border: 1px solid rgba(203, 213, 225, 0.92);
  border-radius: 18px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 52px;
  color: #475569;
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    border-color 0.22s ease;
}

.captcha-box:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: rgba(13, 148, 136, 0.34);
  box-shadow: 0 14px 24px rgba(15, 23, 42, 0.08);
}

.captcha-box:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.captcha-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 17px;
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
  gap: 12px;
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
  color: #0d9488;
  text-decoration: none;
  transition:
    color 0.22s ease,
    transform 0.22s ease;
}

.link-btn:hover {
  color: #0f766e;
  transform: translateX(2px);
}

.verification-button {
  min-height: 52px;
  border-radius: 18px;
  font-weight: 700;
}

.submit-btn {
  margin-top: 6px;
  height: 54px;
  border-radius: 999px;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: 0 18px 28px rgba(13, 148, 136, 0.18);
  transition:
    transform 0.22s ease,
    box-shadow 0.22s ease,
    filter 0.22s ease;
}

.submit-btn:hover:not(.is-disabled):not(.is-loading) {
  transform: translateY(-1px);
  box-shadow: 0 22px 34px rgba(13, 148, 136, 0.24);
}

.submit-btn:active:not(.is-disabled):not(.is-loading) {
  transform: translateY(0);
  filter: brightness(0.98);
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
    grid-template-columns: 1fr;
    min-height: auto;
  }

  .brand-panel {
    padding: 28px 24px;
    gap: 24px;
  }

  .form-panel {
    padding: 28px 24px 32px;
  }

  .form-panel__inner {
    width: min(100%, 640px);
  }

  .brand-showcase {
    min-height: 220px;
  }
}

@media (max-width: 768px) {
  .client-auth-page {
    padding: 16px;
  }

  .auth-shell {
    border-radius: 28px;
  }

  .brand-panel,
  .form-panel {
    padding-inline: 20px;
  }

  .showcase-card--front {
    inset: 0;
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

  .brand-panel__content {
    gap: 20px;
  }

  .brand-showcase {
    min-height: 200px;
  }

  .form-panel {
    padding: 22px 18px calc(24px + env(safe-area-inset-bottom));
  }

  .mode-switch,
  .register-type-switch {
    gap: 4px;
    padding: 4px;
  }

  .mode-switch__thumb {
    top: 4px;
    left: 4px;
    width: calc((100% - 8px - 8px) / 3);
    height: calc(100% - 8px);
  }

  .register-type-switch__thumb {
    top: 4px;
    left: 4px;
    width: calc((100% - 8px - 4px) / 2);
    height: calc(100% - 8px);
  }

  .mode-switch button,
  .register-type-switch button {
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

@media (prefers-reduced-motion: reduce) {
  .client-auth-page *,
  .client-auth-page *::before,
  .client-auth-page *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  .auth-shell,
  .brand-panel,
  .form-panel,
  .showcase-card--front,
  .backdrop-orb,
  .brand-showcase__halo {
    transform: none !important;
  }
}
</style>
