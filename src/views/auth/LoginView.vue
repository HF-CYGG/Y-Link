<script setup lang="ts">
/**
 * 模块说明：src/views/auth/LoginView.vue
 * 文件职责：负责管理端登录、验证码补录、两步验证第二步与登录后安全提示展示，并保证登录成功后的跳转优先级高于装饰动画与预热任务。
 * 实现逻辑：
 * - 先执行表单校验，再按需携带图形验证码发起登录；
 * - 账号已开启两步验证时，第一步只拿到短期票据，表单切换为动态码 / 恢复码输入，票据过期或失效时回到第一步重新输入密码；
 * - 风控触发后固定展示安全提示，并按需拉取验证码，避免用户只看到一闪而过的错误消息；
 * - 登录成功后仅投递非阻塞预热任务，先保证真正的页面跳转立即发生；
 * - 登录页视觉层采用了融合 Apple / Microsoft Fluent 设计美学的动态几何流体背景，利用 CSS `transform` 硬件加速进行渲染，兼顾了高级视觉表现与主线程性能，避免了输入、点击延迟。
 * 维护说明：
 * - 动态几何图形的动画已使用 `will-change: transform` 并限定在 GPU 层面计算，若后续要叠加更多层，请注意内存与合成层数量，不要使用耗费 CPU 的 `background-position` 或 `box-shadow` 动画；
 * - 验证码展示必须继续使用图片 data URL，避免改回 `v-html` 注入 SVG；
 * - 第二步是否回到第一步只看服务端原因码 `ADMIN_MFA_TICKET_EXPIRED`，不要按提示文案判断。
 */


import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Lock, User, Right, Key } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { resolveDefaultManagementRedirect, resolveSafeRedirect } from '@/router'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { ADMIN_MFA_TICKET_EXPIRED_REASON, getAdminCaptcha, type LoginResult } from '@/api/modules/auth'
import { APP_META } from '@/constants/app-meta'
import { extractErrorMessage, extractRequestErrorReason, normalizeRequestError } from '@/utils/error'


import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const form = reactive({
  username: '',
  password: '',
  captcha: '',
})

const formRef = ref<FormInstance>()
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore(pinia)

const submitPhase = ref<'idle' | 'submitting' | 'success'>('idle')
const securityHint = ref('')
const captchaVisible = ref(false)
const captchaLoading = ref(false)
const captchaState = reactive({
  captchaId: '',
  captchaImage: '',
  captchaSvg: '',
  expiresInSeconds: 0,
})

const rules: FormRules = {
  username:[{ required: true, message: '请输入账号', trigger: 'blur' }],
  password:[{ required: true, message: '请输入密码', trigger: 'blur' }],
}

// 两步验证第二步：票据只保存在内存，刷新页面即回到第一步。
const mfaChallenge = ref<{ ticket: string } | null>(null)
const mfaMode = ref<'totp' | 'recovery'>('totp')
const mfaForm = reactive({
  code: '',
  recoveryCode: '',
})

const submitButtonLabel = computed(() => {
  if (submitPhase.value === 'submitting') return '验证中...'
  if (submitPhase.value === 'success') return '进入系统'
  return mfaChallenge.value ? '验证并登录' : '继续'
})

const formTitle = computed(() => (mfaChallenge.value ? '两步验证' : '登录'))
const formSubtitle = computed(() => {
  if (!mfaChallenge.value) return '请输入您的访问凭证'
  return mfaMode.value === 'totp' ? '请输入身份验证器应用中的 6 位动态码' : '请输入一个未使用过的恢复码'
})

// 安全说明：验证码后端返回的是 SVG 字符串，
// 这里转为 data URL 图片渲染，避免通过 v-html 直接把 SVG 片段注入 DOM。
const captchaImageSrc = computed(() => (
  captchaState.captchaImage || (captchaState.captchaSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captchaState.captchaSvg)}`
    : '')
))

// 当后端风控触发限流/锁定时，把提示固定显示在表单顶部，
// 避免用户只看到一闪而过的消息后不知道当前该等多久。
const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
}

const refreshCaptcha = async () => {
  captchaLoading.value = true
  try {
    const result = await getAdminCaptcha()
    captchaState.captchaId = result.captchaId
    captchaState.captchaImage = result.captchaImage ?? ''
    captchaState.captchaSvg = result.captchaSvg
    captchaState.expiresInSeconds = result.expiresInSeconds
    form.captcha = ''
  } catch (error) {
    showAppError(extractErrorMessage(error, '验证码加载失败，请稍后重试'))
  } finally {
    captchaLoading.value = false
  }
}

const ensureCaptchaVisible = async () => {
  captchaVisible.value = true
  if (!captchaState.captchaId) {
    await refreshCaptcha()
  }
}

onMounted(() => {
  const root = document.documentElement
  root.classList.add('route-login')
  delete root.dataset.themeTransition
  delete root.dataset.themeTransitionMode
  root.style.removeProperty('--theme-transition-origin-x')
  root.style.removeProperty('--theme-transition-origin-y')
  root.style.removeProperty('--theme-transition-duration')
  root.style.removeProperty('--theme-transition-easing')
})

onBeforeUnmount(() => {
  document.documentElement.classList.remove('route-login')
})

const resetCaptchaState = () => {
  captchaVisible.value = false
  captchaState.captchaId = ''
  captchaState.captchaImage = ''
  captchaState.captchaSvg = ''
  form.captcha = ''
}

const resetMfaChallenge = () => {
  mfaChallenge.value = null
  mfaMode.value = 'totp'
  mfaForm.code = ''
  mfaForm.recoveryCode = ''
}

const toggleMfaMode = () => {
  mfaMode.value = mfaMode.value === 'totp' ? 'recovery' : 'totp'
  mfaForm.code = ''
  mfaForm.recoveryCode = ''
}

/**
 * 登录成功收尾：普通登录与两步验证第二步共用。
 * 先投递跳转，再处理安全提醒；恢复码登录后提醒剩余数量，引导及时重新生成。
 */
const finishLogin = async (result: LoginResult) => {
  submitPhase.value = 'success'
  securityHint.value = ''
  resetCaptchaState()
  resetMfaChallenge()
  showAppSuccess(`欢迎回来，${result.user.displayName}`)
  if (result.securityReminder) {
    ElMessageBox.alert(result.securityReminder, '安全提醒', {
      type: 'warning',
      confirmButtonText: '我知道了',
    }).catch(() => undefined)
  }
  if (typeof result.recoveryCodesRemaining === 'number') {
    ElMessageBox.alert(
      `本次使用了一个恢复码，还剩 ${result.recoveryCodesRemaining} 个。建议进入系统后在右上角账号菜单的“两步验证”中重新生成恢复码。`,
      '恢复码提醒',
      {
        type: 'warning',
        confirmButtonText: '我知道了',
      },
    ).catch(() => undefined)
  }
  const redirectPath = ref(
    typeof route.query.redirect === 'string'
      ? resolveSafeRedirect(route.query.redirect, result.user)
      : resolveDefaultManagementRedirect(result.user),
  )

  // 登录成功后仅投递非阻塞预热任务，不等待其完成，优先保证真正的页面跳转立即发生。
  authStore.warmupPostLoginEntry(redirectPath.value).catch(() => undefined)
  await router.replace(redirectPath.value)
}

/**
 * 两步验证第二步：
 * - 动态码与恢复码二选一提交；
 * - 票据过期、次数用尽、账号安全设置变化或账号被锁定时回到第一步，其余错误留在本步清空输入重试。
 */
const handleMfaSubmit = async (ticket: string) => {
  const code = mfaForm.code.replace(/\s/g, '')
  const recoveryCode = mfaForm.recoveryCode.trim()
  if (mfaMode.value === 'totp' && !/^\d{6}$/.test(code)) {
    showAppWarning('请输入 6 位数字动态码')
    return
  }
  if (mfaMode.value === 'recovery' && !recoveryCode) {
    showAppWarning('请输入恢复码')
    return
  }

  submitPhase.value = 'submitting'
  try {
    const result = await authStore.completeMfaLogin({
      mfaTicket: ticket,
      ...(mfaMode.value === 'totp' ? { code } : { recoveryCode }),
    })
    await finishLogin(result)
  } catch (error) {
    submitPhase.value = 'idle'
    const normalizedError = normalizeRequestError(error, '验证失败，请稍后重试')
    applySecurityHintFromMessage(normalizedError.message)
    if (extractRequestErrorReason(error) === ADMIN_MFA_TICKET_EXPIRED_REASON || normalizedError.status === 429) {
      resetMfaChallenge()
    } else {
      mfaForm.code = ''
      mfaForm.recoveryCode = ''
    }
    showAppError(normalizedError.message)
  }
}

const handleSubmit = async () => {
  // 第二步只有一个输入框，回车会同时触发表单隐式提交与 keyup.enter；进行中的提交必须拦截，
  // 否则同一票据被并发提交两次，后到的请求会因票据已被取走而把页面错误地退回第一步。
  if (submitPhase.value !== 'idle') return
  if (mfaChallenge.value) {
    await handleMfaSubmit(mfaChallenge.value.ticket)
    return
  }
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (captchaVisible.value && !form.captcha.trim()) {
    showAppWarning('请输入图形验证码')
    return
  }

  submitPhase.value = 'submitting'

  try {
    const result = await authStore.login({
      username: form.username,
      password: form.password,
      captchaId: captchaVisible.value ? captchaState.captchaId : undefined,
      captchaCode: captchaVisible.value ? form.captcha : undefined,
    })

    // 已开启两步验证：密码正确，进入第二步；密码不再需要，尽早从表单内存中清除。
    if (result.mfaRequired) {
      submitPhase.value = 'idle'
      securityHint.value = ''
      resetCaptchaState()
      form.password = ''
      mfaMode.value = 'totp'
      mfaForm.code = ''
      mfaForm.recoveryCode = ''
      mfaChallenge.value = { ticket: result.mfaTicket }
      return
    }

    await finishLogin(result)
  } catch (error) {
    submitPhase.value = 'idle'
    const normalizedError = normalizeRequestError(error, '登录失败，请稍后重试')
    const message = normalizedError.message
    applySecurityHintFromMessage(message)
    if (normalizedError.status === 428 || /验证码/.test(message)) {
      // 服务端验证码为一次性票据，答错后原票据即作废；已显示时必须换一张新图。
      const captchaAlreadyVisible = captchaVisible.value && Boolean(captchaState.captchaId)
      await ensureCaptchaVisible()
      if (captchaAlreadyVisible) {
        await refreshCaptcha()
      }
    } else if (captchaVisible.value) {
      await refreshCaptcha()
    }
    showAppError(message)
  }
}
</script>

<template>
  <div class="login-page">
    <!-- 动态几何背景层 (Fluent / Apple Aesthetic) -->
    <div class="geo-animation-layer" aria-hidden="true">
      <div class="geo-blob blob-1"></div>
      <div class="geo-blob blob-2"></div>
      <div class="geo-blob blob-3"></div>
    </div>
    <!-- 整体毛玻璃遮罩层 -->
    <div class="glass-overlay" aria-hidden="true"></div>

    <main class="login-shell glass-panel">
      <aside class="visual-panel">
        <div class="brand-top">
          <div class="brand-chip">Y-LINK</div>
          <span class="brand-subtitle">EQUIPMENT TRACK</span>
        </div>

        <div class="showcase-container">
          <div class="showcase-glow"></div>

          <div class="card-stack">
            <div class="mockup-card card-back"></div>
            <div class="mockup-card card-middle"></div>
            <div class="mockup-card card-front">
              <div class="sk-header">
                <div class="sk-avatar"></div>
                <div class="sk-title-group">
                  <div class="sk-line sk-w-60"></div>
                  <div class="sk-line sk-w-40 sk-light"></div>
                </div>
              </div>

              <div class="sk-chart">
                <div class="sk-bar" style="height: 40%"></div>
                <div class="sk-bar" style="height: 70%"></div>
                <div class="sk-bar" style="height: 50%"></div>
                <div class="sk-bar sk-bar-accent" style="height: 90%"></div>
                <div class="sk-bar" style="height: 60%"></div>
                <div class="sk-bar" style="height: 30%"></div>
              </div>

              <div class="sk-list">
                <div
                  v-for="index in 2"
                  :key="index"
                  class="sk-item"
                >
                  <div class="sk-box"></div>
                  <div class="sk-title-group">
                    <div class="sk-line sk-w-80"></div>
                    <div class="sk-line sk-w-50 sk-light"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="brand-bottom">
          <div class="brand-bottom__version">{{ APP_META.version }}</div>
          <a
            class="brand-bottom__repo-link"
            :href="APP_META.repositoryUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg class="brand-bottom__repo-icon" aria-hidden="true">
              <use href="/icons.svg#github-icon"></use>
            </svg>
            {{ APP_META.repositoryLabel }}
          </a>
          <div class="brand-bottom__copyright">{{ APP_META.copyright }}</div>
        </div>
      </aside>

      <section class="form-panel">
        <div class="action-top"></div>

        <div class="form-content">
          <div class="form-header">
            <h2 class="form-title">{{ formTitle }}</h2>
            <p class="form-subtitle">{{ formSubtitle }}</p>
          </div>

          <el-alert
            v-if="securityHint"
            class="mb-4"
            type="warning"
            :closable="false"
            show-icon
            :title="securityHint"
          />

          <el-form
            ref="formRef"
            :model="form"
            :rules="rules"
            class="modern-form"
            autocomplete="off"
            @submit.prevent="handleSubmit"
          >
            <template v-if="mfaChallenge">
              <el-form-item class="geo-input-1">
                <el-input
                  v-if="mfaMode === 'totp'"
                  v-model.trim="mfaForm.code"
                  class="geo-input"
                  placeholder="6 位动态码"
                  :prefix-icon="Key"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength="7"
                  @keyup.enter="handleSubmit"
                />
                <el-input
                  v-else
                  v-model.trim="mfaForm.recoveryCode"
                  class="geo-input"
                  placeholder="恢复码，例如 ABCD-EFGH-JKLM"
                  :prefix-icon="Key"
                  autocomplete="off"
                  maxlength="20"
                  @keyup.enter="handleSubmit"
                />
              </el-form-item>
              <div class="mfa-switch-row">
                <el-button link type="primary" @click="toggleMfaMode">
                  {{ mfaMode === 'totp' ? '手机不在身边？使用恢复码' : '改用动态码' }}
                </el-button>
                <el-button link @click="resetMfaChallenge">返回重新登录</el-button>
              </div>
            </template>

            <template v-else>
              <el-form-item prop="username" class="geo-input-1">
                <el-input
                  v-model.trim="form.username"
                  class="geo-input"
                  placeholder="账号"
                  :prefix-icon="User"
                  autocomplete="username"
                  clearable
                  @keyup.enter="handleSubmit"
                />
              </el-form-item>

              <el-form-item prop="password" class="geo-input-2">
                <el-input
                  v-model="form.password"
                  class="geo-input"
                  type="password"
                  placeholder="密码"
                  show-password
                  :prefix-icon="Lock"
                  autocomplete="current-password"
                  @keyup.enter="handleSubmit"
                />
              </el-form-item>

              <el-form-item v-if="captchaVisible" class="geo-input-2">
                <div class="captcha-row">
                  <el-input
                    v-model.trim="form.captcha"
                    class="geo-input captcha-input"
                    placeholder="图形验证码"
                    :prefix-icon="Key"
                    autocomplete="off"
                    maxlength="8"
                    @keyup.enter="handleSubmit"
                  />
                  <button
                    class="captcha-image"
                    type="button"
                    :disabled="captchaLoading"
                    title="点击刷新验证码"
                    @click="refreshCaptcha"
                  >
                    <span v-if="captchaLoading">刷新中</span>
                    <img
                      v-else-if="captchaImageSrc"
                      :src="captchaImageSrc"
                      alt="图形验证码"
                      class="captcha-render-image"
                    />
                    <span v-else>刷新</span>
                  </button>
                </div>
              </el-form-item>
            </template>

            <el-button
              class="geo-submit group"
              :class="{ 'is-loading': submitPhase !== 'idle' }"
              :loading="submitPhase === 'submitting' || submitPhase === 'success'"
              @click="handleSubmit"
            >
              <span v-if="submitPhase === 'idle'" class="flex items-center">
                {{ submitButtonLabel }}
                <el-icon class="ml-2 transition-transform group-hover:translate-x-1"><Right /></el-icon>
              </span>
              <span v-else>{{ submitButtonLabel }}</span>
            </el-button>


          </el-form>
        </div>
      </section>

    </main>
  </div>
</template>

<style scoped>
.mfa-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -6px 0 18px;
}

.login-page {
  --bg-primary: #f5f5f7;
  --bg-panel: #ffffff;
  --text-main: #1d1d1f;
  --text-sub: #86868b;
  --accent: #0d9488;
  --accent-hover: #0f766e;
  --border-light: #e5e5ea;

  position: relative;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--bg-primary);
  padding: 24px;
  overflow: hidden;
  z-index: 0;
  isolation: isolate;
  transition: background-color 0.5s ease;
}

/*
 * 暗色覆盖写法约定：
 * - scoped 样式中 `:global(.dark) .x` 会被编译成裸 `.dark` 规则，直接作用到 html 根节点并泄漏到全站；
 * - 因此统一写成 `:global(.dark .login-page .x)`，并锚定本页根节点，避免与客户端登录页同名类互相影响。
 */
:global(.dark .login-page) {
  --bg-primary: #000000;
  --bg-panel: #111112;
  --text-main: #f5f5f7;
  --text-sub: #86868b;
  --accent: #14b8a6;
  --accent-hover: #0d9488;
  --border-light: #2c2c2e;
}

/* 动态几何背景层 (硬件加速流体动画 - Apple/Fluent 设计美学) */
.geo-animation-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  background-color: var(--bg-primary);
}

.geo-blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.45;
  will-change: transform;
  animation: blob-float 25s cubic-bezier(0.4, 0, 0.2, 1) infinite alternate;
}

:global(.dark .login-page .geo-blob) {
  opacity: 0.3;
  filter: blur(120px);
}

.blob-1 {
  top: -10%;
  left: -10%;
  width: 55vw;
  height: 55vw;
  background: radial-gradient(circle, rgba(13, 148, 136, 0.6) 0%, rgba(13, 148, 136, 0) 70%);
  animation-duration: 25s;
  animation-delay: 0s;
}

.blob-2 {
  bottom: -20%;
  right: -10%;
  width: 65vw;
  height: 65vw;
  background: radial-gradient(circle, rgba(45, 212, 191, 0.5) 0%, rgba(45, 212, 191, 0) 70%);
  animation-duration: 22s;
  animation-delay: -5s;
  animation-direction: alternate-reverse;
}

.blob-3 {
  top: 30%;
  left: 20%;
  width: 45vw;
  height: 45vw;
  background: radial-gradient(circle, rgba(15, 118, 110, 0.45) 0%, rgba(15, 118, 110, 0) 70%);
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

:global(.dark .login-page .glass-overlay) {
  background: rgba(0, 0, 0, 0.05);
}

.login-shell {
  position: relative;
  z-index: 2;
  display: flex;
  width: 100%;
  max-width: 1000px;
  min-height: 600px;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(32px) saturate(180%);
  -webkit-backdrop-filter: blur(32px) saturate(180%);
  border-radius: 32px;
  overflow: hidden;
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.04),
    inset 0 0 0 1px rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.5);
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

:global(.dark .login-page .login-shell) {
  background: rgba(17, 17, 18, 0.75);
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.2),
    inset 0 0 0 1px rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.visual-panel {
  flex: 1.2;
  background: transparent;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 40px;
  border-right: 1px solid rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

:global(.dark .login-page .visual-panel) {
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}

.brand-top {
  display: flex;
  align-items: center;
  gap: 12px;
  z-index: 10;
}

.brand-chip {
  background: rgba(13, 148, 136, 0.12);
  color: #0f766e;
  border: 1px solid rgba(13, 148, 136, 0.2);
  padding: 4px 12px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
}

:global(.dark .login-page .brand-chip) {
  background: rgba(20, 184, 166, 0.15);
  color: #5eead4;
  border-color: rgba(20, 184, 166, 0.2);
}

.brand-subtitle {
  color: var(--text-sub);
  font-size: 12px;
  letter-spacing: 2px;
  font-weight: 600;
}

.showcase-container {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.showcase-glow {
  position: absolute;
  width: 300px;
  height: 300px;
  background: var(--accent);
  filter: blur(100px);
  opacity: 0.15;
  border-radius: 50%;
  transform: translateY(20px);
}

.card-stack {
  position: relative;
  width: 280px;
  height: 340px;
}

.mockup-card {
  position: absolute;
  inset: 0;
  background: var(--bg-panel);
  border-radius: 24px;
  border: 1px solid var(--border-light);
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.05);
  transition:
    transform var(--theme-transition-duration) var(--ylink-motion-ease),
    opacity var(--theme-transition-duration) var(--ylink-motion-ease),
    box-shadow var(--theme-transition-duration) var(--ylink-motion-ease);
}

:global(.dark .login-page .mockup-card) {
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
}

.card-back {
  transform: translateY(-30px) scale(0.9);
  opacity: 0.4;
  z-index: 1;
}

.card-middle {
  transform: translateY(-15px) scale(0.95);
  opacity: 0.7;
  z-index: 2;
}

.card-front {
  transform: translateY(0) scale(1);
  opacity: 1;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
}

.showcase-container:hover .card-back {
  transform: translateY(-45px) scale(0.9) rotate(-4deg);
  opacity: 0.6;
}

.showcase-container:hover .card-middle {
  transform: translateY(-20px) scale(0.95) rotate(2deg);
  opacity: 0.9;
}

.showcase-container:hover .card-front {
  transform: translateY(5px) scale(1.02);
  box-shadow: 0 30px 60px rgba(0, 0, 0, 0.08);
}

.sk-header {
  display: flex;
  align-items: center;
  gap: 16px;
}

.sk-avatar {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--border-light);
}

.sk-title-group {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sk-line {
  height: 8px;
  border-radius: 4px;
  background: var(--text-main);
  opacity: 0.15;
}

:global(.dark .login-page .sk-line) {
  opacity: 0.3;
}

.sk-light {
  opacity: 0.08;
}

:global(.dark .login-page .sk-light) {
  opacity: 0.15;
}

.sk-w-80 {
  width: 80%;
}

.sk-w-60 {
  width: 60%;
}

.sk-w-50 {
  width: 50%;
}

.sk-w-40 {
  width: 40%;
}

.sk-chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 60px;
  padding: 16px 0;
  border-top: 1px dashed var(--border-light);
  border-bottom: 1px dashed var(--border-light);
}

.sk-bar {
  flex: 1;
  border-radius: 4px;
  background: var(--border-light);
}

.sk-bar-accent {
  background: var(--accent);
}

.sk-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sk-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 16px;
  background: var(--bg-primary);
}

.sk-box {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--border-light);
}

.brand-bottom {
  z-index: 10;
  color: var(--text-sub);
}

.brand-bottom__version {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  line-height: 1.2;
}

.brand-bottom__repo-link {
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

.brand-bottom__repo-icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.brand-bottom__repo-link:hover {
  text-decoration: underline;
}

.brand-bottom__copyright {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  opacity: 0.9;
}

.form-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  padding: 40px;
}

.action-top {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 40px;
}

.form-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-width: 320px;
  margin: 0 auto;
  width: 100%;
}

.form-header {
  margin-bottom: 40px;
}

.form-title {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-main);
  margin: 0 0 8px;
  letter-spacing: -0.5px;
  animation: smoothFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.1s;
}

.form-subtitle {
  color: var(--text-sub);
  font-size: 15px;
  margin: 0;
  animation: smoothFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.15s;
}

/* 定义极丝滑的入场动画 */
@keyframes smoothFadeUp {
  0% {
    opacity: 0;
    transform: translateY(16px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 表单侧错落入场（Vercel / Linear 风格） */
.geo-input-1 {
  animation: smoothFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.25s;
}

.geo-input-2 {
  animation: smoothFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.3s;
}

.modern-form :deep(.el-form-item) {
  margin-bottom: 24px;
}

.geo-input :deep(.el-input__wrapper) {
  height: 52px;
  border-radius: 14px;
  background-color: rgba(255, 255, 255, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02) !important;
  padding: 0 16px;
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

:global(.dark .login-page .geo-input .el-input__wrapper) {
  background-color: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.geo-input :deep(.el-input__wrapper:hover) {
  background-color: rgba(255, 255, 255, 0.8);
  border-color: rgba(255, 255, 255, 0.9);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04) !important;
}

:global(.dark .login-page .geo-input .el-input__wrapper:hover) {
  background-color: rgba(0, 0, 0, 0.45);
  border-color: rgba(255, 255, 255, 0.15);
}

.geo-input :deep(.el-input__wrapper.is-focus) {
  background-color: #ffffff;
  border-color: #0d9488;
  box-shadow: 0 0 0 1px #0d9488, 0 4px 14px rgba(13, 148, 136, 0.1) !important;
}

:global(.dark .login-page .geo-input .el-input__wrapper.is-focus) {
  background-color: rgba(0, 0, 0, 0.6);
  border-color: #14b8a6;
  box-shadow: 0 0 0 1px #14b8a6, 0 4px 14px rgba(20, 184, 166, 0.15) !important;
}

.geo-input :deep(.el-input__inner) {
  color: var(--text-main);
  font-weight: 500;
  font-size: 15px;
}

.geo-input :deep(.el-input__prefix-inner) {
  font-size: 18px;
  color: var(--text-sub);
}

.geo-input :deep(.el-input__wrapper.is-focus .el-input__prefix-inner) {
  color: var(--accent);
}

.captcha-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px;
  gap: 10px;
  width: 100%;
}

.captcha-image {
  height: 52px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.5);
  color: var(--text-sub);
  cursor: pointer;
  overflow: hidden;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
  box-shadow: none;
}

:global(.dark .login-page .captcha-image) {
  background: rgba(0, 0, 0, 0.2);
  border-color: rgba(255, 255, 255, 0.05);
}

.captcha-image:hover {
  background: rgba(255, 255, 255, 0.6);
  border-color: rgba(255, 255, 255, 0.9);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
}

:global(.dark .login-page .captcha-image:hover) {
  background: rgba(0, 0, 0, 0.4);
}

.captcha-image:active {
  transform: scale(0.98);
}

.captcha-image:disabled {
  cursor: wait;
  opacity: 0.7;
  transform: none;
}

.captcha-render-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.geo-submit {
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
  transition: box-shadow 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) !important;
  animation: smoothFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.4s;
  z-index: 1;
}

.geo-submit::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: #14b8a6;
  transform-origin: left center;
  transform: scaleX(0);
  transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: -1;
  border-radius: inherit;
}

.geo-submit:hover::before {
  transform: scaleX(1);
}

.geo-submit:hover {
  background-color: #0f766e !important;
  box-shadow: 0 12px 24px rgba(13, 148, 136, 0.25) !important;
}

.geo-submit:active {
  transform: scale(0.98);
  box-shadow: 0 4px 12px rgba(13, 148, 136, 0.15) !important;
}

@media (prefers-reduced-motion: reduce) {
  .login-shell,
  .geo-blob,
  .form-title,
  .form-subtitle,
  [class*='geo-input-'],
  .geo-submit,
  .geo-input :deep(.el-input__wrapper.is-focus) {
    animation: none !important;
  }

  .geo-submit::after {
    display: none;
  }
}

@media (max-width: 900px) {
  .visual-panel {
    display: none;
  }
  .login-shell {
    min-height: auto;
    border-radius: 24px;
  }
}
</style>
