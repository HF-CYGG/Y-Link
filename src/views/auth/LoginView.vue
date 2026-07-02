<script setup lang="ts">
/**
 * 模块说明：src/views/auth/LoginView.vue
 * 文件职责：负责管理端登录、验证码补录与登录后安全提示展示，并保证登录成功后的跳转优先级高于装饰动画与预热任务。
 * 实现逻辑：
 * - 先执行表单校验，再按需携带图形验证码发起登录；
 * - 风控触发后固定展示安全提示，并按需拉取验证码，避免用户只看到一闪而过的错误消息；
 * - 登录成功后仅投递非阻塞预热任务，先保证真正的页面跳转立即发生；
 * - 登录页视觉层采用了融合 Apple / Microsoft Fluent 设计美学的动态几何流体背景，利用 CSS `transform` 硬件加速进行渲染，兼顾了高级视觉表现与主线程性能，避免了输入、点击延迟。
 * 维护说明：
 * - 动态几何图形的动画已使用 `will-change: transform` 并限定在 GPU 层面计算，若后续要叠加更多层，请注意内存与合成层数量，不要使用耗费 CPU 的 `background-position` 或 `box-shadow` 动画；
 * - 验证码展示必须继续使用图片 data URL，避免改回 `v-html` 注入 SVG。
 */


import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Lock, User, Right, Key } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { resolveDefaultManagementRedirect, resolveSafeRedirect } from '@/router'
import { useAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { getAdminCaptcha } from '@/api/modules/auth'
import { APP_META } from '@/constants/app-meta'
import { extractErrorMessage, normalizeRequestError } from '@/utils/error'


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
  captchaSvg: '',
  expiresInSeconds: 0,
})

const rules: FormRules = {
  username:[{ required: true, message: '请输入账号', trigger: 'blur' }],
  password:[{ required: true, message: '请输入密码', trigger: 'blur' }],
}

const submitButtonLabel = computed(() => {
  if (submitPhase.value === 'submitting') return '验证中...'
  if (submitPhase.value === 'success') return '进入系统'
  return '继续'
})

// 安全说明：验证码后端返回的是 SVG 字符串，
// 这里转为 data URL 图片渲染，避免通过 v-html 直接把 SVG 片段注入 DOM。
const captchaImageSrc = computed(() => (
  captchaState.captchaSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captchaState.captchaSvg)}`
    : ''
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

const handleSubmit = async () => {
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

    submitPhase.value = 'success'
    securityHint.value = ''
    captchaVisible.value = false
    captchaState.captchaId = ''
    captchaState.captchaSvg = ''
    form.captcha = ''
    showAppSuccess(`欢迎回来，${result.user.displayName}`)
    if (result.securityReminder) {
      ElMessageBox.alert(result.securityReminder, '安全提醒', {
        type: 'warning',
        confirmButtonText: '我知道了',
      }).catch(() => undefined)
    }
    const redirectPath = ref(
      typeof route.query.redirect === 'string'
        ? resolveSafeRedirect(route.query.redirect, result.user)
        : resolveDefaultManagementRedirect(result.user),
    )

    // 登录成功后仅投递非阻塞预热任务，不等待其完成，优先保证真正的页面跳转立即发生。
    authStore.warmupPostLoginEntry(redirectPath.value).catch(() => undefined)
    await router.replace(redirectPath.value)
  } catch (error) {
    submitPhase.value = 'idle'
    const normalizedError = normalizeRequestError(error, '登录失败，请稍后重试')
    const message = normalizedError.message
    applySecurityHintFromMessage(message)
    if (normalizedError.status === 428 || /验证码/.test(message)) {
      await ensureCaptchaVisible()
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
            <h2 class="form-title">登录</h2>
            <p class="form-subtitle">请输入您的访问凭证</p>
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

:global(.dark) .login-page {
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

:global(.dark) .geo-blob {
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

:global(.dark) .glass-overlay {
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

:global(.dark) .login-shell {
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

:global(.dark) .visual-panel {
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

:global(.dark) .brand-chip {
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

:global(.dark) .mockup-card {
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

:global(.dark) .sk-line {
  opacity: 0.3;
}

.sk-light {
  opacity: 0.08;
}

:global(.dark) .sk-light {
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

:global(.dark) .geo-input :deep(.el-input__wrapper) {
  background-color: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.geo-input :deep(.el-input__wrapper:hover) {
  background-color: rgba(255, 255, 255, 0.8);
  border-color: rgba(255, 255, 255, 0.9);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04) !important;
}

:global(.dark) .geo-input :deep(.el-input__wrapper:hover) {
  background-color: rgba(0, 0, 0, 0.45);
  border-color: rgba(255, 255, 255, 0.15);
}

.geo-input :deep(.el-input__wrapper.is-focus) {
  background-color: #ffffff;
  border-color: #0d9488;
  box-shadow: 0 0 0 1px #0d9488, 0 4px 14px rgba(13, 148, 136, 0.1) !important;
}

:global(.dark) .geo-input :deep(.el-input__wrapper.is-focus) {
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

:global(.dark) .captcha-image {
  background: rgba(0, 0, 0, 0.2);
  border-color: rgba(255, 255, 255, 0.05);
}

.captcha-image:hover {
  background: rgba(255, 255, 255, 0.6);
  border-color: rgba(255, 255, 255, 0.9);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
}

:global(.dark) .captcha-image:hover {
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
  .geo-blob {
    animation: none !important;
  }
  
  .form-title,
  .form-subtitle,
  .geo-input-1,
  .geo-input-2,
  .geo-submit {
    animation: none !important;
  }

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
