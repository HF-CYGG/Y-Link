


























































<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientAuthView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getClientCaptcha } from '@/api/modules/client-auth'
import { useClientAuthStore } from '@/store'

type AuthTab = 'login' | 'register'

interface ClientCaptchaState {
  captchaId: string
  captchaSvg: string
}

const router = useRouter()
const route = useRoute()
const clientAuthStore = useClientAuthStore()

const activeTab = ref<AuthTab>('login')
const loading = ref(false)
const captchaLoading = ref(false)
const captcha = reactive<ClientCaptchaState>({
  captchaId: '',
  captchaSvg: '',
})

const loginForm = reactive({
  mobile: '',
  password: '',
  captchaCode: '',
})

const registerForm = reactive({
  mobile: '',
  password: '',
  realName: '',
  departmentName: '',
  captchaCode: '',
})
const successTip = ref('')

/**
 * 登录后安全回跳：
 * - 优先回到原本准备访问的客户端页面；
 * - 若 query 缺失则落到客户端商品大厅。
 */
const redirectPath = computed(() => {
  const raw = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/client/mall'
})

const applyRegisterRedirectState = () => {
  const registeredMobile = typeof route.query.mobile === 'string' ? route.query.mobile.trim() : ''
  const nextTab = route.query.tab === 'register' ? 'register' : 'login'

  activeTab.value = nextTab
  successTip.value = typeof route.query.notice === 'string' ? route.query.notice : ''

  if (registeredMobile) {
    loginForm.mobile = registeredMobile
  }
}

const handleGoLogin = () => {
  activeTab.value = 'login'
}

/**
 * 拉取图形验证码：
 * - 当前项目未配置短信通道时，客户端依赖图形验证码完成防刷；
 * - 登录与注册复用同一验证码区域，降低页面复杂度。
 */
const refreshCaptcha = async () => {
  captchaLoading.value = true
  try {
    const result = await getClientCaptcha()
    captcha.captchaId = result.captchaId
    captcha.captchaSvg = result.captchaSvg
  } finally {
    captchaLoading.value = false
  }
}

const validateMobile = (mobile: string) => {
  return /^1\d{10}$/.test(mobile.trim())
}

const validatePassword = (password: string) => {
  return password.trim().length >= 6
}

const handleLogin = async () => {
  if (!validateMobile(loginForm.mobile)) {
    ElMessage.warning('请输入正确的手机号')
    return
  }
  if (!validatePassword(loginForm.password)) {
    ElMessage.warning('密码至少 6 位')
    return
  }
  if (!captcha.captchaId || !loginForm.captchaCode.trim()) {
    ElMessage.warning('请输入图形验证码')
    return
  }

  loading.value = true
  try {
    await clientAuthStore.login({
      mobile: loginForm.mobile.trim(),
      password: loginForm.password,
      captchaId: captcha.captchaId,
      captchaCode: loginForm.captchaCode.trim(),
    })
    ElMessage.success('登录成功')
    await router.replace(redirectPath.value)
  } catch (_error) {
    ElMessage.error('登录失败，请检查手机号、密码和验证码后重试')
    await refreshCaptcha()
    loginForm.captchaCode = ''
  } finally {
    loading.value = false
  }
}

const handleRegister = async () => {
  if (!registerForm.realName.trim()) {
    ElMessage.warning('请输入姓名')
    return
  }
  if (!validateMobile(registerForm.mobile)) {
    ElMessage.warning('请输入正确的手机号')
    return
  }
  if (!validatePassword(registerForm.password)) {
    ElMessage.warning('密码至少 6 位')
    return
  }
  if (!captcha.captchaId || !registerForm.captchaCode.trim()) {
    ElMessage.warning('请输入图形验证码')
    return
  }

  loading.value = true
  try {
    await clientAuthStore.register({
      mobile: registerForm.mobile.trim(),
      password: registerForm.password,
      realName: registerForm.realName.trim(),
      departmentName: registerForm.departmentName.trim() || undefined,
      captchaId: captcha.captchaId,
      captchaCode: registerForm.captchaCode.trim(),
    })
    ElMessage.success('注册成功，请使用账号密码登录')
    await refreshCaptcha()
    registerForm.captchaCode = ''
    activeTab.value = 'login'
    successTip.value = '账号已创建成功，请完成登录后进入商品大厅。'
    await router.replace({
      path: '/client/login',
      query: {
        tab: 'login',
        mobile: registerForm.mobile.trim(),
        notice: successTip.value,
      },
    })
  } catch (_error) {
    ElMessage.error('注册失败，请检查信息后重试')
    await refreshCaptcha()
    registerForm.captchaCode = ''
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (clientAuthStore.isAuthenticated) {
    await router.replace('/client/mall')
    return
  }
  applyRegisterRedirectState()
  await refreshCaptcha()
})

watch(
  () => route.fullPath,
  () => {
    applyRegisterRedirectState()
  },
)
</script>

<template>
  <div class="client-auth-page px-4 py-8">
    <div class="mx-auto max-w-5xl">
      <div class="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1.05fr)_24rem]">
        <section class="client-brand-panel">
          <div class="client-brand-badge">Y-Link CLIENT</div>
          <div class="mt-5 max-w-xl">
            <p class="text-4xl font-semibold tracking-[0.04em] text-slate-950 md:text-5xl">校园预订，一步完成</p>
            <p class="mt-4 text-base leading-8 text-slate-600 md:text-lg">
              在线查看库存、提交预订单、到店出示二维码核销。把“能不能订、还剩多少、什么时候来取”一次讲清楚。
            </p>
          </div>

          <div class="client-feature-grid mt-8">
            <article class="client-feature-card">
              <p class="client-feature-label">实时库存</p>
              <p class="client-feature-value">剩余库存 / 已预订</p>
            </article>
            <article class="client-feature-card">
              <p class="client-feature-label">订单闭环</p>
              <p class="client-feature-value">下单后可直接查看核销码</p>
            </article>
            <article class="client-feature-card">
              <p class="client-feature-label">领取流程</p>
              <p class="client-feature-value">线下扫码核销后自动完成出库</p>
            </article>
          </div>

          <div class="client-brand-footer mt-auto">
            <div>
              <p class="text-sm text-slate-400">建议使用方式</p>
              <p class="mt-1 text-sm leading-7 text-slate-600">首次使用先注册账号，注册成功后返回登录页完成登录，再进入商品大厅下单。</p>
            </div>
          </div>
        </section>

        <section class="client-auth-card">
          <div class="mb-5">
            <p class="text-2xl font-semibold text-slate-950">欢迎使用客户端</p>
            <p class="mt-2 text-sm leading-6 text-slate-500">支持账号登录、图形验证码校验与密码找回。</p>
          </div>

          <div v-if="successTip" class="client-success-banner">
            <div class="space-y-3">
              <p>{{ successTip }}</p>
              <button type="button" class="client-success-action" @click="handleGoLogin">立即去登录</button>
            </div>
          </div>

          <div class="mb-6 flex rounded-full bg-slate-100 p-1">
            <button
              type="button"
              class="flex-1 rounded-full px-4 py-2.5 text-sm font-medium transition"
              :class="activeTab === 'login' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500'"
              @click="activeTab = 'login'"
            >
              登录
            </button>
            <button
              type="button"
              class="flex-1 rounded-full px-4 py-2.5 text-sm font-medium transition"
              :class="activeTab === 'register' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500'"
              @click="activeTab = 'register'"
            >
              注册
            </button>
          </div>

          <Transition name="auth-panel" mode="out-in">
            <form v-if="activeTab === 'login'" key="login-form" class="space-y-4" @submit.prevent="handleLogin">
              <label class="client-field">
                <span class="client-field-label">手机号</span>
                <input v-model.trim="loginForm.mobile" class="client-input" placeholder="请输入登录手机号" />
              </label>
              <label class="client-field">
                <span class="client-field-label">密码</span>
                <input v-model="loginForm.password" class="client-input" type="password" placeholder="请输入登录密码" />
              </label>
              <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8.75rem]">
                <label class="client-field">
                  <span class="client-field-label">图形验证码</span>
                  <input v-model.trim="loginForm.captchaCode" class="client-input" placeholder="请输入验证码" />
                </label>
                <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha">
                  <div class="captcha-box-inner">
                    <span v-if="captchaLoading" class="text-xs text-slate-400">加载中</span>
                    <span v-else v-html="captcha.captchaSvg" />
                  </div>
                  <span class="captcha-box-tip">{{ captchaLoading ? '正在刷新...' : '点击换一张' }}</span>
                </button>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-slate-400">注册后请回到此处登录</span>
                <router-link class="font-medium text-brand" to="/client/forgot-password">忘记密码</router-link>
              </div>
              <button class="client-submit" type="submit" :disabled="loading">
                {{ loading ? '登录中...' : '登录并进入商品大厅' }}
              </button>
            </form>

            <form v-else key="register-form" class="space-y-4" @submit.prevent="handleRegister">
              <label class="client-field">
                <span class="client-field-label">姓名</span>
                <input v-model.trim="registerForm.realName" class="client-input" placeholder="请输入姓名" />
              </label>
              <label class="client-field">
                <span class="client-field-label">部门</span>
                <input v-model.trim="registerForm.departmentName" class="client-input" placeholder="请输入部门（选填）" />
              </label>
              <label class="client-field">
                <span class="client-field-label">手机号</span>
                <input v-model.trim="registerForm.mobile" class="client-input" placeholder="请输入注册手机号" />
              </label>
              <label class="client-field">
                <span class="client-field-label">密码</span>
                <input v-model="registerForm.password" class="client-input" type="password" placeholder="请设置至少 6 位密码" />
              </label>
              <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8.75rem]">
                <label class="client-field">
                  <span class="client-field-label">图形验证码</span>
                  <input v-model.trim="registerForm.captchaCode" class="client-input" placeholder="请输入验证码" />
                </label>
                <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha">
                  <div class="captcha-box-inner">
                    <span v-if="captchaLoading" class="text-xs text-slate-400">加载中</span>
                    <span v-else v-html="captcha.captchaSvg" />
                  </div>
                  <span class="captcha-box-tip">{{ captchaLoading ? '正在刷新...' : '点击换一张' }}</span>
                </button>
              </div>
              <button class="client-submit client-submit-register" type="submit" :disabled="loading">
                {{ loading ? '注册中...' : '注册账号并回到登录' }}
              </button>
            </form>
          </Transition>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.client-auth-page {
  min-height: 100vh;
  background:
    radial-gradient(circle at top, rgba(44, 196, 196, 0.18), transparent 34%),
    radial-gradient(circle at bottom right, rgba(15, 23, 42, 0.08), transparent 32%),
    linear-gradient(180deg, #f8fbfd 0%, #eef4f7 100%);
}

.client-brand-panel {
  display: flex;
  min-height: 42rem;
  flex-direction: column;
  border-radius: 2rem;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.96) 0%, rgba(240, 249, 255, 0.92) 100%);
  padding: 2rem;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.08);
}

.client-brand-badge {
  display: inline-flex;
  width: fit-content;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.06);
  padding: 0.5rem 0.9rem;
  color: rgb(30 41 59);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.client-feature-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(1, minmax(0, 1fr));
}

.client-feature-card {
  border-radius: 1.5rem;
  background: rgba(255, 255, 255, 0.85);
  padding: 1.1rem 1.2rem;
  box-shadow: inset 0 0 0 1px rgba(226, 232, 240, 0.9);
}

.client-feature-label {
  color: rgb(100 116 139);
  font-size: 0.78rem;
}

.client-feature-value {
  margin-top: 0.35rem;
  color: rgb(15 23 42);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.6;
}

.client-brand-footer {
  border-top: 1px solid rgba(226, 232, 240, 0.9);
  padding-top: 1.25rem;
}

.client-auth-card {
  align-self: center;
  border-radius: 2rem;
  background: rgba(255, 255, 255, 0.96);
  padding: 2rem;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(12px);
}

.client-success-banner {
  margin-bottom: 1rem;
  border-radius: 1.25rem;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(20, 184, 166, 0.12));
  padding: 0.95rem 1rem;
  color: rgb(17 94 89);
  font-size: 0.92rem;
  line-height: 1.6;
}

.client-success-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.8rem;
  border-radius: 999px;
  background: linear-gradient(135deg, rgb(13 148 136), rgb(6 182 212));
  padding: 0 1.2rem;
  color: white;
  font-size: 0.92rem;
  font-weight: 600;
  box-shadow: 0 12px 24px rgba(13, 148, 136, 0.18);
}

.client-field {
  display: block;
}

.client-field-label {
  margin-bottom: 0.55rem;
  display: inline-block;
  color: rgb(71 85 105);
  font-size: 0.82rem;
  font-weight: 600;
}

.client-input {
  width: 100%;
  border-radius: 1rem;
  border: 1px solid rgb(226 232 240);
  background: rgb(248 250 252 / 0.95);
  padding: 1rem 1rem;
  color: rgb(15 23 42);
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.client-input:focus {
  border-color: rgb(20 184 166);
  box-shadow: 0 0 0 4px rgb(20 184 166 / 0.12);
}

.captcha-box {
  min-width: 8.75rem;
  border-radius: 1rem;
  border: 1px solid rgb(226 232 240);
  background: white;
  padding: 0.65rem 0.75rem;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.35rem;
  min-height: 5.15rem;
}

.captcha-box-inner {
  min-height: 2.6rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.captcha-box-tip {
  display: block;
  text-align: center;
  color: rgb(71 85 105);
  font-size: 0.74rem;
  line-height: 1.2;
}

.client-submit {
  width: 100%;
  border-radius: 999px;
  background: linear-gradient(135deg, rgb(15 23 42), rgb(30 41 59));
  padding: 1rem 1rem;
  color: white;
  font-weight: 600;
  box-shadow: 0 16px 30px rgba(15, 23, 42, 0.18);
}

.client-submit-register {
  background: linear-gradient(135deg, rgb(13 148 136), rgb(6 182 212));
}

.client-submit:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.auth-panel-enter-active,
.auth-panel-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.auth-panel-enter-from,
.auth-panel-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (min-width: 768px) {
  .client-feature-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
