


























































<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientAuthView.vue
 * 文件职责：客户端登录/注册总入口，负责账号登录、注册、验证码刷新与登录后回跳。
 * 维护说明：当前页面已切换为 Split-Card 一体化布局，视觉可继续调整，但登录/注册/验证码链路需保持可用。
 */

import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Key, Lock, OfficeBuilding, Phone, User } from '@element-plus/icons-vue'
import { getClientCaptcha } from '@/api/modules/client-auth'
import { useClientAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

type AuthMode = 'login' | 'register'

interface ClientCaptchaState {
  captchaId: string
  captchaSvg: string
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
const successTip = ref('')
const securityHint = ref('')
const formBlockRef = ref<HTMLElement | null>(null)
const formWrapperHeight = ref('auto')
const formAnimating = ref(false)
const captcha = reactive<ClientCaptchaState>({
  captchaId: '',
  captchaSvg: '',
})

const loginForm = reactive({
  phone: '',
  password: '',
  captcha: '',
})

const registerForm = reactive({
  name: '',
  department: '',
  phone: '',
  password: '',
  captcha: '',
})

// 登录成功后优先跳回用户原本准备访问的客户端页面，否则进入商品大厅。
const redirectPath = computed(() => {
  const raw = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/client/mall'
})

const syncWrapperHeight = (heightMode: 'auto' | 'measured' = 'auto') => {
  if (!formBlockRef.value) {
    return
  }
  formWrapperHeight.value = heightMode === 'auto' ? 'auto' : `${formBlockRef.value.offsetHeight}px`
}

const switchMode = async (nextMode: AuthMode) => {
  if (activeMode.value === nextMode || formAnimating.value) {
    return
  }

  const currentHeight = formBlockRef.value?.offsetHeight ?? 0
  if (currentHeight > 0) {
    formWrapperHeight.value = `${currentHeight}px`
  }

  formAnimating.value = true
  activeMode.value = nextMode
  await nextTick()

  const nextHeight = formBlockRef.value?.offsetHeight ?? currentHeight
  requestAnimationFrame(() => {
    formWrapperHeight.value = `${nextHeight}px`
  })

  globalThis.window?.setTimeout(() => {
    formAnimating.value = false
    formWrapperHeight.value = 'auto'
  }, 520)
}

const applyRouteState = () => {
  const registeredMobile = typeof route.query.mobile === 'string' ? route.query.mobile.trim() : ''
  activeMode.value = route.query.tab === 'register' ? 'register' : 'login'
  successTip.value = typeof route.query.notice === 'string' ? route.query.notice : ''

  if (registeredMobile) {
    loginForm.phone = registeredMobile
  }
}

// 当前项目尚未接入短信验证码，因此登录与注册都依赖图形验证码完成防刷。
const refreshCaptcha = async () => {
  captchaLoading.value = true
  try {
    const result = await getClientCaptcha()
    captcha.captchaId = result.captchaId
    captcha.captchaSvg = result.captchaSvg
    ElMessage.success('已刷新验证码')
  } finally {
    captchaLoading.value = false
  }
}

const validateMobile = (mobile: string) => /^1\d{10}$/.test(mobile.trim())
const validatePassword = (password: string) => password.trim().length >= 6

const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
}

const handleLogin = async () => {
  if (!validateMobile(loginForm.phone)) {
    ElMessage.warning('请输入正确的手机号')
    return
  }
  if (!validatePassword(loginForm.password)) {
    ElMessage.warning('密码至少 6 位')
    return
  }
  if (!captcha.captchaId || !loginForm.captcha.trim()) {
    ElMessage.warning('请输入图形验证码')
    return
  }

  isLoading.value = true
  try {
    await clientAuthStore.login({
      mobile: loginForm.phone.trim(),
      password: loginForm.password,
      captchaId: captcha.captchaId,
      captchaCode: loginForm.captcha.trim(),
    })
    ElMessage.success('登录成功，欢迎来到 Y-Link 客户端')
    await router.replace(redirectPath.value)
  } catch (error) {
    const message = extractErrorMessage(error, '登录失败，请检查手机号、密码和验证码后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
    console.warn('客户端登录失败。', error)
    loginForm.captcha = ''
    await refreshCaptcha()
  } finally {
    isLoading.value = false
  }
}

const handleRegister = async () => {
  if (!registerForm.name.trim()) {
    ElMessage.warning('请填写真实姓名')
    return
  }
  if (!validateMobile(registerForm.phone)) {
    ElMessage.warning('请输入正确的手机号')
    return
  }
  if (!validatePassword(registerForm.password)) {
    ElMessage.warning('密码至少 6 位')
    return
  }
  if (!captcha.captchaId || !registerForm.captcha.trim()) {
    ElMessage.warning('请输入图形验证码')
    return
  }

  isLoading.value = true
  try {
    await clientAuthStore.register({
      mobile: registerForm.phone.trim(),
      password: registerForm.password,
      realName: registerForm.name.trim(),
      departmentName: registerForm.department.trim() || undefined,
      captchaId: captcha.captchaId,
      captchaCode: registerForm.captcha.trim(),
    })
    ElMessage.success('注册成功，请登录')
    activeMode.value = 'login'
    loginForm.phone = registerForm.phone.trim()
    loginForm.password = ''
    loginForm.captcha = ''
    successTip.value = '账号已创建成功，请使用手机号与密码登录。'
    registerForm.captcha = ''
    await refreshCaptcha()
    await router.replace({
      path: '/client/login',
      query: {
        tab: 'login',
        mobile: registerForm.phone.trim(),
        notice: successTip.value,
      },
    })
  } catch (error) {
    const message = extractErrorMessage(error, '注册失败，请检查信息后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
    console.warn('客户端注册失败。', error)
    registerForm.captcha = ''
    await refreshCaptcha()
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
  await refreshCaptcha()
  await nextTick()
  syncWrapperHeight()
})

watch(
  () => route.fullPath,
  () => {
    applyRouteState()
  },
)

watch(successTip, async () => {
  await nextTick()
  syncWrapperHeight('measured')
  requestAnimationFrame(() => {
    syncWrapperHeight()
  })
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
          <h1 class="brand-title">校园文创<br />极简预订。</h1>
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

          <div class="form-wrapper" :style="{ height: formWrapperHeight }">
            <transition name="fade-slide">
              <div v-if="activeMode === 'login'" ref="formBlockRef" key="login" class="form-block">
                <h2 class="block-title">欢迎回来</h2>
                <p class="block-subtitle">请输入手机号与密码登录客户端</p>

                <el-form @submit.prevent="handleLogin" class="space-y-4 mt-6">
                  <el-input v-model="loginForm.phone" placeholder="手机号" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><Phone /></el-icon>
                    </template>
                  </el-input>

                  <el-input v-model="loginForm.password" placeholder="密码" type="password" class="geo-input" size="large" show-password>
                    <template #prefix>
                      <el-icon class="input-icon"><Lock /></el-icon>
                    </template>
                  </el-input>

                  <div class="captcha-row">
                    <el-input v-model="loginForm.captcha" placeholder="图形验证码" class="geo-input flex-1" size="large" clearable>
                      <template #prefix>
                        <el-icon class="input-icon"><Key /></el-icon>
                      </template>
                    </el-input>

                    <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha">
                      <span v-if="captchaLoading" class="captcha-loading">刷新中</span>
                      <span v-else class="captcha-render" v-html="captcha.captchaSvg" />
                    </button>
                  </div>

                  <div class="flex justify-end mt-2">
                    <router-link to="/client/forgot-password" class="forgot-link">忘记密码？</router-link>
                  </div>

                  <el-button class="submit-btn" :loading="isLoading" @click="handleLogin">进入商品大厅</el-button>
                </el-form>
              </div>

              <div v-else ref="formBlockRef" key="register" class="form-block">
                <h2 class="block-title">创建账号</h2>
                <p class="block-subtitle">只需几步，开启极速预订体验</p>

                <el-form @submit.prevent="handleRegister" class="space-y-4 mt-6">
                  <el-input v-model="registerForm.name" placeholder="真实姓名" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><User /></el-icon>
                    </template>
                  </el-input>

                  <el-input v-model="registerForm.department" placeholder="所属部门 (选填)" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><OfficeBuilding /></el-icon>
                    </template>
                  </el-input>

                  <el-input v-model="registerForm.phone" placeholder="手机号" class="geo-input" size="large" clearable>
                    <template #prefix>
                      <el-icon class="input-icon"><Phone /></el-icon>
                    </template>
                  </el-input>

                  <el-input v-model="registerForm.password" placeholder="设置至少 6 位密码" type="password" class="geo-input" size="large" show-password>
                    <template #prefix>
                      <el-icon class="input-icon"><Lock /></el-icon>
                    </template>
                  </el-input>

                  <div class="captcha-row">
                    <el-input v-model="registerForm.captcha" placeholder="图形验证码" class="geo-input flex-1" size="large" clearable>
                      <template #prefix>
                        <el-icon class="input-icon"><Key /></el-icon>
                      </template>
                    </el-input>

                    <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha">
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
  transition: height 0.52s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: height;
  position: relative;
}

.form-block {
  width: 100%;
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
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
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

.block-title {
  font-size: 26px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 6px;
  letter-spacing: -0.5px;
}

.block-subtitle {
  font-size: 13px;
  color: #64748b;
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

.forgot-link {
  font-size: 13px;
  color: #64748b;
  text-decoration: none;
  transition: color 0.2s;
}

.forgot-link:hover {
  color: #0d9488;
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

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 0.34s ease, transform 0.42s cubic-bezier(0.22, 1, 0.36, 1), filter 0.34s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateX(18px) scale(0.985);
  filter: blur(4px);
}

.fade-slide-enter-active {
  position: relative;
  z-index: 2;
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(-12px) scale(0.992);
  filter: blur(6px);
}

.fade-slide-leave-active {
  position: absolute;
  inset: 0;
  z-index: 1;
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
