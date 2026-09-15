<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/NotificationEventDetailContent.vue
 * 文件职责：展示单个通知事件的处理详情，包括最终结果、外发明细、按轮次分组的规则命中与外发执行记录、终态失败留痕。
 * 实现逻辑：
 * - 由通知事件面板在展开行（桌面表格）或卡片展开（手机/平板）时复用，避免两套详情模板口径不一致；
 * - 外发目标与失败原因均为后端脱敏后的值，本组件只负责展示，不做二次拼接；
 * - “规则命中”只表示规则匹配与站内通知生成，外发结果以外发执行记录与外发明细为准。
 * 维护说明：
 * - 新增外发渠道时需同步补充渠道计数展示；
 * - 详情数据为只读快照，不在本组件内触发任何写操作。
 */

import dayjs from 'dayjs'
import type { NotificationEventLogDetail } from '@/api/modules/audit'

defineProps<{
  loading: boolean
  error: string
  detail: NotificationEventLogDetail | null
}>()

const formatTime = (value: string | null | undefined) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-')

const DISPATCH_STATUS_META: Record<string, { label: string; type: 'success' | 'danger' | 'warning' | 'info' }> = {
  sent: { label: '已发送', type: 'success' },
  failed: { label: '发送失败', type: 'danger' },
  processing: { label: '发送中', type: 'warning' },
  pending: { label: '待发送', type: 'info' },
}

const TRIGGER_MODE_LABELS: Record<string, string> = {
  all_management_offline: '全部管理端离线时外发',
  watched_accounts_offline: '指定账号离线时外发',
}

const getDispatchStatusMeta = (status: string) => DISPATCH_STATUS_META[status] ?? { label: status, type: 'info' as const }

const formatRuleDispatch = (dispatch: NonNullable<NotificationEventLogDetail['processingAttempts'][number]['rules'][number]['dispatch']>) => {
  if (dispatch.skipped === 'trigger_mode_blocked') {
    return '未满足外发时机，本轮未外发'
  }
  const parts = [
    `邮件 成功 ${dispatch.emailSent} / 失败 ${dispatch.emailFailed}${dispatch.emailAlreadySent ? ` / 此前已发 ${dispatch.emailAlreadySent}` : ''}`,
    `飞书 成功 ${dispatch.feishuSent} / 失败 ${dispatch.feishuFailed}${dispatch.feishuAlreadySent ? ` / 此前已发 ${dispatch.feishuAlreadySent}` : ''}`,
  ]
  return parts.join('；')
}
</script>

<template>
  <div class="min-w-0 px-2 py-3 text-sm text-slate-600 dark:text-slate-300">
    <div v-if="loading" class="py-4 text-center text-xs text-slate-400">处理详情加载中...</div>
    <div v-else-if="error" class="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{{ error }}</div>
    <div v-else-if="detail" class="flex min-w-0 flex-col gap-3">
      <div class="grid gap-2 rounded-2xl bg-slate-50 p-3 text-xs sm:grid-cols-2 xl:grid-cols-4 dark:bg-white/5">
        <div class="min-w-0"><span class="text-slate-400">最终结果：</span>{{ detail.event.resultLabel }}</div>
        <div class="min-w-0"><span class="text-slate-400">处理失败次数：</span>{{ detail.event.attemptCount }} / {{ detail.event.maxAttempts }}</div>
        <div class="min-w-0"><span class="text-slate-400">站内接收人数：</span>{{ detail.event.inboxRecipientCount }}</div>
        <div class="min-w-0"><span class="text-slate-400">处理完成时间：</span>{{ formatTime(detail.event.processedAt) }}</div>
        <div v-if="detail.event.nextAttemptAt" class="min-w-0"><span class="text-slate-400">下次重试：</span>{{ formatTime(detail.event.nextAttemptAt) }}</div>
        <div v-if="detail.event.errorMessage" class="min-w-0 break-words sm:col-span-2 xl:col-span-4">
          <span class="text-slate-400">事件错误：</span><span class="text-rose-600 dark:text-rose-300">{{ detail.event.errorMessage }}</span>
        </div>
      </div>

      <section class="min-w-0">
        <p class="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">外发明细</p>
        <div v-if="!detail.dispatches.length" class="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400 dark:border-white/10">
          本事件没有邮件或飞书外发记录（仅站内通知或未满足外发时机）。
        </div>
        <div v-else class="flex min-w-0 flex-col gap-2">
          <div
            v-for="dispatch in detail.dispatches"
            :key="dispatch.id"
            class="grid min-w-0 gap-1 rounded-xl border border-slate-100 px-3 py-2 text-xs sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-start dark:border-white/10"
          >
            <div class="font-medium text-slate-700 dark:text-slate-200">{{ dispatch.channelLabel }}</div>
            <div class="min-w-0 break-all">
              <p>{{ dispatch.target || '-' }}</p>
              <p class="mt-1 text-slate-400">
                失败次数 {{ dispatch.attemptCount }} / {{ dispatch.maxAttempts }}
                <span v-if="dispatch.responseCode !== null">；响应码 {{ dispatch.responseCode }}</span>
                ；最近尝试 {{ formatTime(dispatch.lastAttemptAt) }}
                <span v-if="dispatch.sentAt">；发送时间 {{ formatTime(dispatch.sentAt) }}</span>
              </p>
              <p v-if="dispatch.errorMessage" class="mt-1 break-words text-rose-600 dark:text-rose-300">失败原因：{{ dispatch.errorMessage }}</p>
            </div>
            <div>
              <el-tag size="small" :type="getDispatchStatusMeta(dispatch.status).type" effect="light">{{ getDispatchStatusMeta(dispatch.status).label }}</el-tag>
            </div>
          </div>
        </div>
      </section>

      <section class="min-w-0">
        <p class="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">处理阶段（按处理轮次）</p>
        <div v-if="!detail.processingAttempts.length" class="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400 dark:border-white/10">
          暂无规则命中记录（事件可能尚未处理，或没有启用的通知规则）。
        </div>
        <div v-else class="flex min-w-0 flex-col gap-2">
          <div
            v-for="attempt in detail.processingAttempts"
            :key="attempt.attemptNo"
            class="min-w-0 rounded-xl border border-slate-100 px-3 py-2 text-xs dark:border-white/10"
          >
            <p class="font-medium text-slate-700 dark:text-slate-200">第 {{ attempt.attemptNo }} 轮处理 · {{ formatTime(attempt.occurredAt) }}</p>
            <ul class="mt-1 space-y-1">
              <li v-for="rule in attempt.rules" :key="`${attempt.attemptNo}:${rule.ruleId}`" class="min-w-0 break-words">
                <span class="text-slate-700 dark:text-slate-200">{{ rule.ruleName || rule.ruleCode || `规则 ${rule.ruleId}` }}</span>
                <span class="text-slate-400">
                  ：规则命中，站内接收 {{ rule.recipientCount }} 人
                  <template v-if="rule.externalTriggerMode">，{{ TRIGGER_MODE_LABELS[rule.externalTriggerMode] ?? rule.externalTriggerMode }}</template>
                </span>
                <div v-if="rule.dispatch" class="mt-0.5 flex flex-wrap items-center gap-2">
                  <el-tag size="small" :type="rule.dispatch.resultStatus === 'failed' ? 'danger' : 'success'" effect="plain">
                    {{ rule.dispatch.resultStatus === 'failed' ? '外发有失败' : '外发执行完成' }}
                  </el-tag>
                  <span>{{ formatRuleDispatch(rule.dispatch) }}</span>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section v-if="detail.failureAudits.length" class="min-w-0">
        <p class="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">终态失败记录</p>
        <ul class="space-y-1 text-xs">
          <li v-for="audit in detail.failureAudits" :key="audit.id" class="break-words text-rose-600 dark:text-rose-300">
            {{ formatTime(audit.createdAt) }}：已失败 {{ audit.attemptCount }} 次，{{ audit.errorMessage || '未记录失败原因' }}
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
