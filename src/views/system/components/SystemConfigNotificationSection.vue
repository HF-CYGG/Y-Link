<script setup lang="ts">
import dayjs from 'dayjs'
import { computed } from 'vue'
import type {
  NotificationPresenceSnapshot,
  NotificationPresenceUser,
  NotificationRuleRecord,
} from '@/api/modules/notification'

const props = defineProps<{
  rules: NotificationRuleRecord[]
  presenceSnapshot: NotificationPresenceSnapshot | null
  managementUsers: NotificationPresenceUser[]
  loading: boolean
  saving: boolean
  canUpdateConfigs: boolean
  presenceLoading: boolean
}>()

const emit = defineEmits<{
  (event: 'refresh-presence'): void
}>()

const eventLabelMap: Record<NotificationRuleRecord['eventType'], string> = {
  o2o_preorder_created: '新预订单',
  customer_service_client_message_created: '新客服消息',
}

const hasManagementUsers = computed(() => props.managementUsers.length > 0)
</script>

<template>
  <div class="config-stage__panel grid gap-6">
    <div class="apple-card p-5 sm:p-6 xl:p-7">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">通知规则</h2>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            站内通知始终生成，邮箱/飞书按离线触发条件外发。
          </p>
        </div>
        <el-tag type="info" effect="plain">离线窗口 {{ presenceSnapshot?.onlineWindowSeconds ?? 120 }} 秒</el-tag>
      </div>

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
                事件：{{ eventLabelMap[rule.eventType] }} | 更新时间：{{ dayjs(rule.updatedAt).format('YYYY-MM-DD HH:mm:ss') }}
              </div>
            </div>
            <el-switch v-model="rule.enabled" :disabled="loading || saving || !canUpdateConfigs" inline-prompt active-text="启用" inactive-text="停用" />
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

            <el-form-item v-if="rule.externalTriggerMode === 'watched_accounts_offline'" class="!mb-0 lg:col-span-2" label="离线监测账号">
              <el-select
                v-model="rule.watchedUserIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                filterable
                placeholder="请选择至少一个监测账号"
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
          </div>
        </article>
      </div>
    </div>

    <div class="apple-card p-5 sm:p-6 xl:p-7">
      <div class="mb-4 flex items-center justify-between gap-3">
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">在线状态快照</h2>
        <el-button plain size="small" :loading="presenceLoading" :disabled="loading" @click="emit('refresh-presence')">刷新状态</el-button>
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
