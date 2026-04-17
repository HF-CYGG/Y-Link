<script setup lang="ts">
/**
 * 模块说明：src/views/auth/LoginView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

 
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue' 
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus' 
import { Lock, User, Right } from '@element-plus/icons-vue' 
import { useRoute, useRouter } from 'vue-router' 
import { resolveDefaultManagementRedirect, resolveSafeRedirect } from '@/router' 
import { useAuthStore } from '@/store' 
import { extractErrorMessage } from '@/utils/error' 

const form = reactive({ 
  username: '', 
  password: '', 
}) 

const formRef = ref<FormInstance>() 
const route = useRoute() 
const router = useRouter() 
const authStore = useAuthStore() 

const submitPhase = ref<'idle' | 'submitting' | 'success'>('idle') 
const securityHint = ref('') 

const rules: FormRules = { 
  username:[{ required: true, message: '请输入账号', trigger: 'blur' }], 
  password:[{ required: true, message: '请输入密码', trigger: 'blur' }], 
} 

const submitButtonLabel = computed(() => { 
  if (submitPhase.value === 'submitting') return '验证中...' 
  if (submitPhase.value === 'success') return '进入系统' 
  return '继续' 
}) 

// 当后端风控触发限流/锁定时，把提示固定显示在表单顶部，
// 避免用户只看到一闪而过的消息后不知道当前该等多久。
const applySecurityHintFromMessage = (message: string) => {
  securityHint.value = /频繁|锁定|稍后|重试/.test(message) ? message : ''
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

  submitPhase.value = 'submitting' 

  try { 
    const result = await authStore.login({ 
      username: form.username, 
      password: form.password, 
    }) 

    submitPhase.value = 'success' 
    ElMessage.success(`欢迎回来，${result.user.displayName}`) 
    if (result.securityReminder) {
      ElMessageBox.alert(result.securityReminder, '安全提醒', {
        type: 'warning',
        confirmButtonText: '我知道了',
      }).catch(() => undefined)
    }
    const redirectPath = ref(typeof route.query.redirect === 'string' ? resolveSafeRedirect(route.query.redirect, result.user) : resolveDefaultManagementRedirect(result.user))
    
    await authStore.warmupPostLoginEntry(redirectPath.value)
    await router.replace(redirectPath.value) 
  } catch (error) { 
    submitPhase.value = 'idle' 
    const message = extractErrorMessage(error, '登录失败，请稍后重试')
    applySecurityHintFromMessage(message)
    ElMessage.error(message) 
  } 
} 
</script> 

<template> 
  <div class="login-page"> 
    <div class="login-grid-layer" aria-hidden="true"></div>
    <div class="login-ambient-layer" aria-hidden="true"></div>
    <main class="login-shell"> 
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
          &copy; 2026 Y-Link System. 
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

/* 动感网格层（极客骨架） */
.login-grid-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(13, 148, 136, 0.075) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(13, 148, 136, 0.075) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(circle at center, black 48%, transparent 92%);
  -webkit-mask-image: radial-gradient(circle at center, black 48%, transparent 92%);
  animation: gridDrift 12s linear infinite;
  will-change: background-position;
}

:global(.dark) .login-grid-layer {
  background-image:
    linear-gradient(to right, rgba(20, 184, 166, 0.11) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(20, 184, 166, 0.11) 1px, transparent 1px);
}

.login-ambient-layer {
  position: absolute;
  width: 58vw;
  height: 58vh;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 0;
  pointer-events: none;
  background: radial-gradient(circle, rgba(13, 148, 136, 0.11) 0%, transparent 62%);
  filter: blur(80px);
  animation: ambientBreathe 10s ease-in-out infinite alternate;
  will-change: transform, opacity;
}

:global(.dark) .login-ambient-layer {
  background: radial-gradient(circle, rgba(20, 184, 166, 0.17) 0%, transparent 62%);
}

@keyframes gridDrift {
  0% {
    background-position: 0 0;
  }
  100% {
    background-position: -80px -80px;
  }
}

@keyframes ambientBreathe {
  0% {
    transform: translate(-50%, -50%) scale(0.9);
    opacity: 0.5;
  }
  100% {
    transform: translate(-50%, -50%) scale(1.2);
    opacity: 1;
  }
}

.login-shell { 
  position: relative;
  z-index: 2;
  display: flex; 
  width: 100%; 
  max-width: 1000px; 
  min-height: 600px; 
  background: var(--bg-panel); 
  border-radius: 32px; 
  overflow: hidden; 
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.04); 
  border: 1px solid var(--border-light); 
} 

:global(.dark) .login-shell { 
  box-shadow: none; 
} 

.visual-panel { 
  flex: 1.2; 
  background: var(--bg-primary); 
  position: relative; 
  display: flex; 
  flex-direction: column; 
  justify-content: space-between; 
  padding: 40px; 
  border-right: 1px solid var(--border-light); 
  overflow: hidden; 
} 

.brand-top { 
  display: flex; 
  align-items: center; 
  gap: 12px; 
  z-index: 10; 
} 

.brand-chip { 
  background: var(--text-main); 
  color: var(--bg-panel); 
  padding: 4px 12px; 
  border-radius: 8px; 
  font-size: 14px; 
  font-weight: 700; 
  letter-spacing: 1px; 
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
  transition: all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); 
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
  font-size: 12px; 
  color: var(--text-sub); 
  font-family: monospace; 
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
  border-radius: 16px; 
  background-color: var(--bg-primary); 
  border: 1px solid transparent; 
  box-shadow: none !important; 
  padding: 0 16px; 
  transition: all 0.2s ease; 
} 

.geo-input :deep(.el-input__wrapper:hover) { 
  background-color: var(--border-light); 
} 

.geo-input :deep(.el-input__wrapper.is-focus) { 
  background-color: var(--bg-panel); 
  border-color: var(--accent); 
  box-shadow: 0 0 0 1px #0d9488, 0 0 20px 0 rgba(13, 148, 136, 0.2) !important;
  animation: pulseGlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
} 

:global(.dark) .geo-input :deep(.el-input__wrapper.is-focus) { 
  box-shadow: 0 0 0 1px #14b8a6, 0 0 20px 0 rgba(20, 184, 166, 0.25) !important;
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

.geo-submit { 
  position: relative;
  overflow: hidden;
  width: 100%; 
  height: 52px; 
  border-radius: 16px !important; 
  background-color: var(--text-main) !important; 
  color: var(--bg-panel) !important; 
  border: none !important; 
  font-size: 16px !important; 
  font-weight: 600 !important; 
  margin-top: 16px; 
  transition: transform 0.1s, background-color 0.2s !important; 
  animation: smoothFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: 0.4s;
} 

.geo-submit:hover { 
  background-color: var(--accent) !important; 
  color: #fff !important; 
} 

.geo-submit::after {
  content: '';
  position: absolute;
  inset: -40% auto auto -45%;
  width: 42%;
  height: 180%;
  background: linear-gradient(110deg, transparent 0%, rgba(255, 255, 255, 0.26) 45%, transparent 100%);
  transform: translateX(-120%) rotate(8deg);
  transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}

.geo-submit:hover::after {
  transform: translateX(340%) rotate(8deg);
}

.geo-submit:active { 
  transform: scale(0.97); 
} 

@media (prefers-reduced-motion: reduce) {
  .login-grid-layer,
  .login-ambient-layer,
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

@keyframes pulseGlow {
  0%,
  100% {
    box-shadow: 0 0 0 1px #0d9488, 0 0 16px 0 rgba(13, 148, 136, 0.15);
  }
  50% {
    box-shadow: 0 0 0 1px #0d9488, 0 0 24px 2px rgba(13, 148, 136, 0.3);
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
