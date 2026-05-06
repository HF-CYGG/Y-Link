<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigVerificationSection.vue
 * 文件职责：承载系统配置页中的验证码平台配置分区展示。
 * 实现逻辑：
 * - 父页面保留权限校验、测试发送和保存提交；
 * - 本组件聚合短信/邮箱两块表单，避免主页面同时承载两套近似结构。
 * 维护说明：若新增验证码渠道，建议继续沿用本组件的“卡片 + 共用字段”组织方式扩展。
 */

defineProps<{
  verificationForm: {
    mobile: {
      enabled: boolean
      httpMethod: 'POST' | 'GET'
      apiUrl: string
      headersTemplate: string
      bodyTemplate: string
      successMatch: string
    }
    email: {
      enabled: boolean
      httpMethod: 'POST' | 'GET'
      apiUrl: string
      headersTemplate: string
      bodyTemplate: string
      successMatch: string
    }
  }
  canUpdateConfigs: boolean
  canTestVerificationProviders: boolean
  loading: boolean
  saving: boolean
  testSendingChannel: 'mobile' | 'email' | ''
  getVerificationUpdatedAtLabel: (channel: 'mobile' | 'email') => string
}>()

const emit = defineEmits<{
  (event: 'test-send', channel: 'mobile' | 'email'): void
}>()
</script>

<template>
  <div class="config-stage__panel space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">验证码平台配置</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          管理客户端注册与找回密码所需的短信、邮箱验证码发送平台。支持模板变量：
          <span v-pre class="font-mono">{{target}}</span>、
          <span v-pre class="font-mono">{{code}}</span>、
          <span v-pre class="font-mono">{{scene}}</span>、
          <span v-pre class="font-mono">{{ip}}</span>。
        </p>
      </div>
      <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        保存后立即生效
      </span>
    </div>

    <el-alert
      title="模板填写说明"
      type="info"
      :closable="false"
      show-icon
      description="请求头模板需填写合法 JSON；请求体模板会原样发送给目标平台。若配置成功关键字，系统会在第三方返回文本中匹配该内容来判断发送成功。客户端找回密码仅在手机与邮箱验证码平台同时启用时开放。"
    />

    <div class="grid gap-6 xl:grid-cols-2">
      <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5 dark:border-white/10 dark:bg-slate-900/30">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">短信验证码平台</h3>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">用于手机号注册、手机号找回密码。</p>
          </div>
          <div class="flex items-center gap-3">
            <el-button
              size="small"
              :loading="testSendingChannel === 'mobile'"
              :disabled="!canTestVerificationProviders || loading || saving"
              @click="emit('test-send', 'mobile')"
            >
              发送测试短信
            </el-button>
            <el-switch v-model="verificationForm.mobile.enabled" :disabled="!canUpdateConfigs || loading" />
          </div>
        </div>

        <div class="grid gap-4">
          <div class="grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">请求方法</div>
              <el-select v-model="verificationForm.mobile.httpMethod" :disabled="!canUpdateConfigs || loading">
                <el-option label="POST" value="POST" />
                <el-option label="GET" value="GET" />
              </el-select>
            </div>
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">API 地址</div>
              <el-input v-model="verificationForm.mobile.apiUrl" :disabled="!canUpdateConfigs || loading" placeholder="https://example.com/send-sms" clearable />
            </div>
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">请求头模板（JSON）</div>
            <el-input
              v-model="verificationForm.mobile.headersTemplate"
              type="textarea"
              :rows="4"
              :disabled="!canUpdateConfigs || loading"
              placeholder='{"Content-Type":"application/json","Authorization":"Bearer xxx"}'
            />
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">请求体模板</div>
            <el-input
              v-model="verificationForm.mobile.bodyTemplate"
              type="textarea"
              :rows="6"
              :disabled="!canUpdateConfigs || loading"
              placeholder='{"mobile":"{{target}}","code":"{{code}}","scene":"{{scene}}"}'
            />
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">成功关键字（可选）</div>
            <el-input
              v-model="verificationForm.mobile.successMatch"
              :disabled="!canUpdateConfigs || loading"
              placeholder="如：success"
              clearable
            />
          </div>
        </div>

        <div class="mt-5 border-t border-slate-200/80 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
          最近更新时间：{{ getVerificationUpdatedAtLabel('mobile') }}
        </div>
      </div>

      <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-5 dark:border-white/10 dark:bg-slate-900/30">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">邮箱验证码平台</h3>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">用于邮箱注册、邮箱找回密码。</p>
          </div>
          <div class="flex items-center gap-3">
            <el-button
              size="small"
              :loading="testSendingChannel === 'email'"
              :disabled="!canTestVerificationProviders || loading || saving"
              @click="emit('test-send', 'email')"
            >
              发送测试邮件
            </el-button>
            <el-switch v-model="verificationForm.email.enabled" :disabled="!canUpdateConfigs || loading" />
          </div>
        </div>

        <div class="grid gap-4">
          <div class="grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">请求方法</div>
              <el-select v-model="verificationForm.email.httpMethod" :disabled="!canUpdateConfigs || loading">
                <el-option label="POST" value="POST" />
                <el-option label="GET" value="GET" />
              </el-select>
            </div>
            <div class="space-y-2">
              <div class="text-sm text-slate-600 dark:text-slate-300">API 地址</div>
              <el-input v-model="verificationForm.email.apiUrl" :disabled="!canUpdateConfigs || loading" placeholder="https://example.com/send-mail" clearable />
            </div>
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">请求头模板（JSON）</div>
            <el-input
              v-model="verificationForm.email.headersTemplate"
              type="textarea"
              :rows="4"
              :disabled="!canUpdateConfigs || loading"
              placeholder='{"Content-Type":"application/json","Authorization":"Bearer xxx"}'
            />
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">请求体模板</div>
            <el-input
              v-model="verificationForm.email.bodyTemplate"
              type="textarea"
              :rows="6"
              :disabled="!canUpdateConfigs || loading"
              placeholder='{"email":"{{target}}","subject":"Y-Link 验证码","content":"您的验证码为 {{code}}"}'
            />
          </div>

          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">成功关键字（可选）</div>
            <el-input
              v-model="verificationForm.email.successMatch"
              :disabled="!canUpdateConfigs || loading"
              placeholder="如：accepted"
              clearable
            />
          </div>
        </div>

        <div class="mt-5 border-t border-slate-200/80 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
          最近更新时间：{{ getVerificationUpdatedAtLabel('email') }}
        </div>
      </div>
    </div>
  </div>
</template>
