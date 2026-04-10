<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
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

/**
 * 登录后安全回跳：
 * - 优先回到原本准备访问的客户端页面；
 * - 若 query 缺失则落到客户端商品大厅。
 */
const redirectPath = computed(() => {
  const raw = typeof route.query.redirect === 'string' ? route.query.redirect : ''
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/client/mall'
})

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
    ElMessage.success('注册成功，已自动登录')
    await router.replace('/client/mall')
  } catch (_error) {
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
  await refreshCaptcha()
})
</script>

<template>
  <div class="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(44,196,196,0.18),_transparent_42%),linear-gradient(180deg,_#f8fbfd_0%,_#eef4f7_100%)] px-4 py-8">
    <div class="mx-auto max-w-md">
      <div class="mb-6 text-center">
        <p class="text-3xl font-semibold tracking-wide text-slate-900">Y-Link 客户端</p>
        <p class="mt-2 text-sm text-slate-500">线上预订、查看库存、出示核销码一站完成</p>
      </div>

      <div class="rounded-[2rem] bg-white p-6 shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
        <div class="mb-6 flex rounded-full bg-slate-100 p-1">
          <button
            type="button"
            class="flex-1 rounded-full px-4 py-2 text-sm font-medium transition"
            :class="activeTab === 'login' ? 'bg-slate-900 text-white' : 'text-slate-500'"
            @click="activeTab = 'login'"
          >
            登录
          </button>
          <button
            type="button"
            class="flex-1 rounded-full px-4 py-2 text-sm font-medium transition"
            :class="activeTab === 'register' ? 'bg-slate-900 text-white' : 'text-slate-500'"
            @click="activeTab = 'register'"
          >
            注册
          </button>
        </div>

        <form v-if="activeTab === 'login'" class="space-y-4" @submit.prevent="handleLogin">
          <input v-model.trim="loginForm.mobile" class="client-input" placeholder="请输入手机号" />
          <input v-model="loginForm.password" class="client-input" type="password" placeholder="请输入密码" />
          <div class="grid grid-cols-[1fr_auto] gap-3">
            <input v-model.trim="loginForm.captchaCode" class="client-input" placeholder="图形验证码" />
            <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha">
              <span v-if="captchaLoading" class="text-xs text-slate-400">加载中</span>
              <span v-else v-html="captcha.captchaSvg" />
            </button>
          </div>
          <div class="flex items-center justify-between text-sm">
            <span class="text-slate-400">首次使用可先注册账号</span>
            <router-link class="font-medium text-brand" to="/client/forgot-password">忘记密码</router-link>
          </div>
          <button class="client-submit" type="submit" :disabled="loading">
            {{ loading ? '登录中...' : '登录并进入商品大厅' }}
          </button>
        </form>

        <form v-else class="space-y-4" @submit.prevent="handleRegister">
          <input v-model.trim="registerForm.realName" class="client-input" placeholder="请输入姓名" />
          <input v-model.trim="registerForm.departmentName" class="client-input" placeholder="请输入部门（选填）" />
          <input v-model.trim="registerForm.mobile" class="client-input" placeholder="请输入手机号" />
          <input v-model="registerForm.password" class="client-input" type="password" placeholder="请设置密码" />
          <div class="grid grid-cols-[1fr_auto] gap-3">
            <input v-model.trim="registerForm.captchaCode" class="client-input" placeholder="图形验证码" />
            <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha">
              <span v-if="captchaLoading" class="text-xs text-slate-400">加载中</span>
              <span v-else v-html="captcha.captchaSvg" />
            </button>
          </div>
          <button class="client-submit" type="submit" :disabled="loading">
            {{ loading ? '注册中...' : '注册并立即使用' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.client-input {
  width: 100%;
  border-radius: 1rem;
  border: 1px solid rgb(226 232 240);
  background: rgb(248 250 252);
  padding: 0.95rem 1rem;
  color: rgb(15 23 42);
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.client-input:focus {
  border-color: rgb(20 184 166);
  box-shadow: 0 0 0 4px rgb(20 184 166 / 0.12);
}

.captcha-box {
  min-width: 7.5rem;
  border-radius: 1rem;
  border: 1px solid rgb(226 232 240);
  background: white;
  padding: 0 0.75rem;
}

.client-submit {
  width: 100%;
  border-radius: 999px;
  background: rgb(15 23 42);
  padding: 0.95rem 1rem;
  color: white;
  font-weight: 600;
}

.client-submit:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
</style>
