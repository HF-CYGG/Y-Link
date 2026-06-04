<script setup lang="ts">
import dayjs from 'dayjs'

import { computed, reactive } from 'vue'
import type {
  NotificationPresenceSnapshot,
  NotificationPresenceUser,
  NotificationRuleRecord,
} from '@/api/modules/notification'
import { testNotificationRuleSend } from '@/api/modules/notification'
import { extractErrorMessage } from '@/utils/error'
import { showCriticalErrorDialog } from '@/utils/error-dialog'

import { showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const props = defineProps<{
  rules: NotificationRuleRecord[]
  presenceSnapshot: NotificationPresenceSnapshot | null
  offlineWindowSeconds: number
  managementUsers: NotificationPresenceUser[]
  loading: boolean
  saving: boolean
  canUpdateConfigs: boolean
  presenceLoading: boolean
}>()

const emit = defineEmits<{
  (event: 'refresh-presence'): void
  (event: 'update-offline-window-seconds', value: number): void
}>()

type TestChannel = 'email' | 'feishu'
type TestFeedback = {
  status: 'testing' | 'success' | 'error'
  message: string
  updatedAt: number
}

const eventLabelMap: Record<NotificationRuleRecord['eventType'], string> = {
  o2o_preorder_created: '新预订单',
  customer_service_client_message_created: '新客服消息',
}

const hasManagementUsers = computed(() => props.managementUsers.length > 0)
const adminAndOperatorUsers = computed(() => props.managementUsers.filter((user) => user.role !== 'supplier'))
const supplierUsers = computed(() => props.managementUsers.filter((user) => user.role === 'supplier'))
const testingState = reactive<Record<string, boolean>>({})
const testFeedbackState = reactive<Record<string, TestFeedback>>({})
const OFFLINE_WINDOW_OPTIONS = [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600]

const handleOfflineWindowChange = (value: string | number | boolean | undefined) => {
  const seconds = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(seconds)) {
    return
  }
  emit('update-offline-window-seconds', seconds)
}

const buildTestKey = (ruleId: string, channel: TestChannel) => {
  return `${ruleId}:${channel}`
}

const isRuleTesting = (ruleId: string, channel: TestChannel) => {
  return testingState[buildTestKey(String(ruleId ?? '').trim(), channel)] === true
}

const setTestFeedback = (ruleId: string, channel: TestChannel, status: TestFeedback['status'], message: string) => {
  testFeedbackState[buildTestKey(ruleId, channel)] = {
    status,
    message,
    updatedAt: Date.now(),
  }
}

const getTestFeedback = (ruleId: string, channel: TestChannel) => {
  return testFeedbackState[buildTestKey(String(ruleId ?? '').trim(), channel)] ?? null
}

const getTestBlockedReason = (rule: NotificationRuleRecord, channel: TestChannel) => {
  if (props.loading) {
    return '当前分区仍在加载，请稍后重试'
  }
  if (props.saving) {
    return '配置保存进行中，请稍后重试'
  }
  if (!props.canUpdateConfigs) {
    return '当前账号没有系统配置修改权限，无法执行测试发送'
  }
  if (channel === 'email' && !rule.emailEnabled) {
    return '请先勾选邮箱外发渠道，再执行测试'
  }
  if (channel === 'feishu' && !rule.feishuEnabled) {
    return '请先勾选飞书外发渠道，再执行测试'
  }
  if (channel === 'feishu' && !rule.feishuWebhookUrl?.trim()) {
    return '请先填写飞书 Webhook 地址'
  }
  return ''
}

const buildRuleDraft = (rule: NotificationRuleRecord) => {
  return {
    id: String(rule.id ?? '').trim(),
    enabled: Boolean(rule.enabled),
    recipientUserIds: (rule.recipientUserIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean),
    emailRecipientAdminUserIds: (rule.emailRecipientAdminUserIds ?? [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
    emailRecipientSupplierUserIds: (rule.emailRecipientSupplierUserIds ?? [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
    emailEnabled: Boolean(rule.emailEnabled),
    feishuEnabled: Boolean(rule.feishuEnabled),
    externalTriggerMode: rule.externalTriggerMode,
    watchedUserIds: (rule.watchedUserIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean),
    feishuWebhookUrl: String(rule.feishuWebhookUrl ?? '').trim(),
    feishuSignSecret: String(rule.feishuSignSecret ?? '').trim(),
    emailSubjectPrefix: String(rule.emailSubjectPrefix ?? '').trim() || '[Y-Link]',
  }
}

const handleTestSend = async (rule: NotificationRuleRecord, channel: TestChannel) => {
  const ruleId = String(rule.id ?? '').trim()
  const blockReason = getTestBlockedReason(rule, channel)
  if (blockReason) {
    setTestFeedback(ruleId, channel, 'error', blockReason)
    showAppWarning(blockReason)
    return
  }

  const key = buildTestKey(ruleId, channel)
  if (testingState[key]) {
    const text = channel === 'feishu' ? '飞书测试发送中，请稍候' : '邮箱测试发送中，请稍候'
    setTestFeedback(ruleId, channel, 'testing', text)
    showAppInfo(text)
    return
  }

  const testingMessage = channel === 'feishu' ? '正在测试飞书连接，请稍候…' : '正在测试邮箱发送，请稍候…'
  testingState[key] = true
  setTestFeedback(ruleId, channel, 'testing', testingMessage)
  showAppInfo(testingMessage)

  try {
    const result = await testNotificationRuleSend({
      ruleId,
      channel,
      draft: buildRuleDraft(rule),
    })
    if (result.success) {
      const successMessage = result.message || '测试发送成功'
      setTestFeedback(ruleId, channel, 'success', successMessage)
      showAppSuccess(successMessage)
      return
    }
    const failureText = result.failures
      .slice(0, 3)
      .map((item) => `${item.target}: ${item.reason}`)
      .join('；')
    const warningMessage = failureText ? `${result.message}；${failureText}` : (result.message || '测试发送失败')
    setTestFeedback(ruleId, channel, 'error', warningMessage)
    showAppWarning(warningMessage)
  } catch (error) {
    const errorMessage = extractErrorMessage(error, '测试发送失败，请稍后重试')
    setTestFeedback(ruleId, channel, 'error', errorMessage)
    void showCriticalErrorDialog(error, {
      title: channel === 'feishu' ? '飞书测试失败' : '邮箱测试失败',
      fallback: '测试发送失败，请稍后重试',
      operation: channel === 'feishu' ? '测试飞书通知' : '测试邮箱通知',
    })
  } finally {
    testingState[key] = false
  }
}
</script>

<template>
  <div class="config-stage__panel grid gap-6">
    <div class="apple-card p-5 sm:p-6 xl:p-7">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">通知规则</h2>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            站内通知始终生成；邮箱、飞书按离线触发条件外发。
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-500 dark:text-slate-400">离线窗口</span>
          <el-select
            :model-value="offlineWindowSeconds"
            style="width: 132px"
            size="small"
            :disabled="loading || saving || !canUpdateConfigs"
            @change="handleOfflineWindowChange"
          >
            <el-option
              v-for="seconds in OFFLINE_WINDOW_OPTIONS"
              :key="seconds"
              :label="`${seconds} 秒`"
              :value="seconds"
            />
          </el-select>
        </div>
      </div>

      <div class="el-form el-form--default el-form--label-top notification-rules-form">
        <div class="grid gap-4">
        <article
          v-for="rule in rules"
          :key="rule.id"
          class="rounded-2xl border border-slate-200/70 bg-slate-50/50 p-4 dark:border-white/10 dark:bg-slate-900/40"
        >
          <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-slate-800 dark:text-slate-100">{{ rule.ruleName }}</div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                事件：{{ eventLabelMap[rule.eventType] }}｜更新时间：{{ dayjs(rule.updatedAt).format('YYYY-MM-DD HH:mm:ss') }}
              </div>
            </div>
            <el-switch
              v-model="rule.enabled"
              :disabled="loading || saving || !canUpdateConfigs"
              inline-prompt
              active-text="启用"
              inactive-text="停用"
            />
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            <el-form-item class="!mb-0" label="站内通知接收账号">
              <el-select
                v-model="rule.recipientUserIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                filterable
                placeholder="留空表示全部管理端账号"
                :disabled="loading || saving || !canUpdateConfigs || !hasManagementUsers"
                class="w-full"
              >
                <el-option
                  v-for="user in managementUsers"
                  :key="user.userId"
                  :label="`${user.displayName}(${user.username})`"
                  :value="user.userId"
                />
              </el-select>
            </el-form-item>

            <el-form-item class="!mb-0" label="管理端邮箱接收账号（admin/operator）">
              <el-select
                v-model="rule.emailRecipientAdminUserIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                filterable
                placeholder="选择管理端邮箱接收账号"
                :disabled="loading || saving || !canUpdateConfigs || !hasManagementUsers || !rule.emailEnabled"
                class="w-full"
              >
                <el-option
                  v-for="user in adminAndOperatorUsers"
                  :key="user.userId"
                  :label="`${user.displayName}(${user.username})`"
                  :value="user.userId"
                />
              </el-select>
            </el-form-item>

            <el-form-item class="!mb-0" label="供货端邮箱接收账号（supplier）">
              <el-select
                v-model="rule.emailRecipientSupplierUserIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                filterable
                placeholder="选择供货端邮箱接收账号"
                :disabled="loading || saving || !canUpdateConfigs || !hasManagementUsers || !rule.emailEnabled"
                class="w-full"
              >
                <el-option
                  v-for="user in supplierUsers"
                  :key="user.userId"
                  :label="`${user.displayName}(${user.username})`"
                  :value="user.userId"
                />
              </el-select>
            </el-form-item>

            <el-form-item class="!mb-0" label="外发渠道">
              <div class="flex w-full gap-4">
                <el-checkbox v-model="rule.emailEnabled" :disabled="loading || saving || !canUpdateConfigs">邮箱</el-checkbox>
                <el-checkbox v-model="rule.feishuEnabled" :disabled="loading || saving || !canUpdateConfigs">飞书</el-checkbox>
              </div>
            </el-form-item>

            <el-form-item class="!mb-0 lg:col-span-2" label="外发时机">
              <el-radio-group v-model="rule.externalTriggerMode" :disabled="loading || saving || !canUpdateConfigs">
                <el-radio value="all_management_offline">管理端人员全部离线时发送</el-radio>
                <el-radio value="watched_accounts_offline">指定账号全部离线时发送</el-radio>
              </el-radio-group>
            </el-form-item>

            <el-form-item
              v-if="rule.externalTriggerMode === 'watched_accounts_offline'"
              class="!mb-0 lg:col-span-2"
              label="离线监测账号"
            >
              <el-select
                v-model="rule.watchedUserIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                filterable
                placeholder="请至少选择一个监测账号"
                :disabled="loading || saving || !canUpdateConfigs || !hasManagementUsers"
                class="w-full"
              >
                <el-option
                  v-for="user in managementUsers"
                  :key="user.userId"
                  :label="`${user.displayName}(${user.username})`"
                  :value="user.userId"
                />
              </el-select>
            </el-form-item>

            <el-form-item class="!mb-0" label="邮件主题前缀">
              <el-input
                v-model.trim="rule.emailSubjectPrefix"
                maxlength="128"
                show-word-limit
                placeholder="例如 [Y-Link]"
                :disabled="loading || saving || !canUpdateConfigs || !rule.emailEnabled"
              />
            </el-form-item>

            <el-form-item class="!mb-0" label="飞书 Webhook">
              <el-input
                v-model.trim="rule.feishuWebhookUrl"
                maxlength="500"
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                :disabled="loading || saving || !canUpdateConfigs || !rule.feishuEnabled"
              />
            </el-form-item>

            <el-form-item class="!mb-0" label="飞书签名密钥（可选）">
              <form class="w-full" autocomplete="off" @submit.prevent>
                <el-input
                  v-model.trim="rule.feishuSignSecret"
                  maxlength="256"
                  show-password
                  autocomplete="off"
                  :name="`feishu-sign-secret-${rule.id}`"
                  placeholder="未启用签名可留空，已配置可保留占位符"
                  :disabled="loading || saving || !canUpdateConfigs || !rule.feishuEnabled"
                />
              </form>
            </el-form-item>

            <div class="lg:col-span-2 flex flex-wrap gap-3">
              <el-button
                plain
                :loading="isRuleTesting(rule.id, 'email')"
                :disabled="isRuleTesting(rule.id, 'email') || isRuleTesting(rule.id, 'feishu')"
                @click="handleTestSend(rule, 'email')"
              >
                测试邮箱
              </el-button>
              <el-button
                plain
                :loading="isRuleTesting(rule.id, 'feishu')"
                :disabled="isRuleTesting(rule.id, 'email') || isRuleTesting(rule.id, 'feishu')"
                @click="handleTestSend(rule, 'feishu')"
              >
                测试飞书
              </el-button>
            </div>

            <div class="lg:col-span-2 grid gap-1 text-xs text-slate-500 dark:text-slate-400">
              <div v-if="getTestFeedback(rule.id, 'email')" class="break-all">
                <span class="mr-2">邮箱：</span>
                <span :class="{
                  'text-emerald-600': getTestFeedback(rule.id, 'email')?.status === 'success',
                  'text-rose-600': getTestFeedback(rule.id, 'email')?.status === 'error',
                  'text-slate-500': getTestFeedback(rule.id, 'email')?.status === 'testing',
                }">
                  {{ getTestFeedback(rule.id, 'email')?.message }}
                </span>
              </div>
              <div v-if="getTestFeedback(rule.id, 'feishu')" class="break-all">
                <span class="mr-2">飞书：</span>
                <span :class="{
                  'text-emerald-600': getTestFeedback(rule.id, 'feishu')?.status === 'success',
                  'text-rose-600': getTestFeedback(rule.id, 'feishu')?.status === 'error',
                  'text-slate-500': getTestFeedback(rule.id, 'feishu')?.status === 'testing',
                }">
                  {{ getTestFeedback(rule.id, 'feishu')?.message }}
                </span>
              </div>
            </div>
          </div>
        </article>
        </div>
      </div>
    </div>

    <div class="apple-card p-5 sm:p-6 xl:p-7">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">在线状态快照</h2>
        <el-button plain size="small" :loading="presenceLoading" :disabled="loading" @click="emit('refresh-presence')">
          刷新状态
        </el-button>
      </div>
      <el-table :data="managementUsers" stripe size="small" max-height="280" empty-text="暂无管理端账号">
        <el-table-column prop="displayName" label="账号" min-width="180">
          <template #default="{ row }">
            <div class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{{ row.displayName }}</div>
            <div class="truncate text-xs text-slate-500 dark:text-slate-400">{{ row.username }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="role" label="角色" width="120" />
        <el-table-column label="在线状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.isOnline ? 'success' : 'info'" effect="light">{{ row.isOnline ? '在线' : '离线' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="activeSessionCount" label="活跃会话" width="110" />
        <el-table-column label="最后活跃" min-width="180">
          <template #default="{ row }">
            {{ row.lastAccessAt ? dayjs(row.lastAccessAt).format('YYYY-MM-DD HH:mm:ss') : '-' }}
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
