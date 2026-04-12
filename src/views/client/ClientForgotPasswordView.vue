<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientForgotPasswordView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getClientCaptcha } from '@/api/modules/client-auth'
import { useClientAuthStore } from '@/store'
import { extractErrorMessage } from '@/utils/error'

const router = useRouter()
const clientAuthStore = useClientAuthStore()

const step = ref<1 | 2>(1)
const submitting = ref(false)
const captchaLoading = ref(false)
const resetToken = ref('')
const securityHint = ref('')

const captcha = reactive({
  captchaId: '',
  captchaSvg: '',
})

const verifyForm = reactive({
  mobile: '',
  captchaCode: '',
})

const resetForm = reactive({
  newPassword: '',
  confirmPassword: '',
})

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

const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleVerify = async () => {
  if (!/^1\d{10}$/.test(verifyForm.mobile.trim())) {
    ElMessage.warning('请输入正确的手机号')
    return
  }
  if (!verifyForm.captchaCode.trim()) {
    ElMessage.warning('请输入图形验证码')
    return
  }

  submitting.value = true
  try {
    const result = await clientAuthStore.requestPasswordResetToken({
      mobile: verifyForm.mobile.trim(),
      captchaId: captcha.captchaId,
      captchaCode: verifyForm.captchaCode.trim(),
    })
    resetToken.value = result.resetToken
    step.value = 2
    ElMessage.success('身份校验通过，请设置新密码')
  } catch (error) {
    const message = extractErrorMessage(error, '身份校验失败，请稍后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
    verifyForm.captchaCode = ''
    await refreshCaptcha()
  } finally {
    submitting.value = false
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleReset = async () => {
  if (resetForm.newPassword.trim().length < 6) {
    ElMessage.warning('新密码至少 6 位')
    return
  }
  if (resetForm.newPassword !== resetForm.confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }

  submitting.value = true
  try {
    await clientAuthStore.confirmPasswordReset({
      mobile: verifyForm.mobile.trim(),
      resetToken: resetToken.value,
      newPassword: resetForm.newPassword,
    })
    ElMessage.success('密码已重置，请重新登录')
    await router.replace('/client/login')
  } catch (error) {
    const message = extractErrorMessage(error, '重置密码失败，请稍后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message)
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await refreshCaptcha()
})
</script>

<template>
  <div class="min-h-[100dvh] bg-slate-50 px-4 py-8">
    <div class="mx-auto max-w-md rounded-[2rem] bg-white p-6 shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
      <div class="mb-6">
        <p class="text-2xl font-semibold text-slate-900">找回密码</p>
        <p class="mt-2 text-sm text-slate-500">先完成身份验证，再设置新的登录密码</p>
      </div>

      <el-alert
        v-if="securityHint"
        class="mb-4"
        type="warning"
        :closable="false"
        show-icon
        :title="securityHint"
      />

      <div class="mb-6 flex items-center gap-3 text-sm">
        <span class="rounded-full px-3 py-1" :class="step === 1 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'">
          1. 身份验证
        </span>
        <span class="rounded-full px-3 py-1" :class="step === 2 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'">
          2. 重置密码
        </span>
      </div>

      <form v-if="step === 1" class="space-y-4" @submit.prevent="handleVerify">
        <input v-model.trim="verifyForm.mobile" class="client-input" placeholder="请输入注册手机号" />
        <div class="grid grid-cols-[1fr_auto] gap-3">
          <input v-model.trim="verifyForm.captchaCode" class="client-input" placeholder="图形验证码" />
          <button type="button" class="captcha-box" :disabled="captchaLoading" @click="refreshCaptcha">
            <span v-if="captchaLoading" class="text-xs text-slate-400">加载中</span>
            <span v-else v-html="captcha.captchaSvg" />
          </button>
        </div>
        <button class="client-submit" type="submit" :disabled="submitting">
          {{ submitting ? '校验中...' : '下一步' }}
        </button>
      </form>

      <form v-else class="space-y-4" @submit.prevent="handleReset">
        <input v-model="resetForm.newPassword" class="client-input" type="password" placeholder="请输入新密码" />
        <input v-model="resetForm.confirmPassword" class="client-input" type="password" placeholder="请再次输入新密码" />
        <button class="client-submit" type="submit" :disabled="submitting">
          {{ submitting ? '提交中...' : '确认重置密码' }}
        </button>
      </form>

      <button type="button" class="mt-4 text-sm font-medium text-brand" @click="router.replace('/client/login')">
        返回客户端登录
      </button>
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
</style>
