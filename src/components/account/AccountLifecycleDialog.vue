<script setup lang="ts">
/**
 * 模块说明：src/components/account/AccountLifecycleDialog.vue
 * 文件职责：为管理端与客户端账号域复用同一套生命周期详情、阻断原因和高风险确认交互。
 * 实现逻辑：
 * - 服务端预检结果决定操作是否可提交，前端不自行推导业务关联；
 * - 注销、恢复共用原因输入，永久删除额外要求逐字确认账号与服务端密码；
 * - 密码仅存在当前弹窗局部状态，关闭即清空，不进入日志、列表或持久 Store。
 * 维护说明：两域 API 与服务必须继续隔离；本组件只共享 DTO 和确认体验，不承载请求路径。
 */
import { computed, reactive, watch } from 'vue'
import type {
  AccountLifecycleAction,
  AccountLifecycleFields,
  AccountLifecyclePreview,
  AccountLifecycleReasonPayload,
  AccountPermanentDeletePayload,
} from '../../../packages/shared-types/src/index'

const props = defineProps<{
  modelValue: boolean
  action: AccountLifecycleAction
  accountLabel: string
  preview: AccountLifecyclePreview | null
  lifecycle: AccountLifecycleFields | null
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [payload: AccountLifecycleReasonPayload | AccountPermanentDeletePayload]
}>()

const form = reactive({ reason: '', confirmAccount: '', permanentDeletePassword: '' })

const actionLabel = computed(() => ({
  deactivate: '注销账号',
  restore: '恢复账号',
  permanent_delete: '永久删除账号',
}[props.action]))

const allowedByPreview = computed(() => {
  if (!props.preview) return false
  if (props.action === 'deactivate') return props.preview.canDeactivate
  if (props.action === 'restore') return props.preview.canRestore
  return props.preview.canPermanentDelete
})

const referenceEntries = computed(() => Object.entries(props.preview?.referenceSummary ?? {})
  .filter(([, count]) => Number(count) > 0))

const canSubmit = computed(() => {
  if (!allowedByPreview.value || form.reason.trim().length < 2) return false
  if (props.action !== 'permanent_delete') return true
  return form.confirmAccount === props.accountLabel && form.permanentDeletePassword.length > 0
})

const resetSensitiveState = () => {
  form.reason = ''
  form.confirmAccount = ''
  form.permanentDeletePassword = ''
}

watch(() => props.modelValue, (visible) => {
  if (!visible) resetSensitiveState()
})
watch(() => props.action, resetSensitiveState)

const close = () => emit('update:modelValue', false)

const submit = () => {
  if (!canSubmit.value) return
  const reason = form.reason.trim()
  if (props.action === 'permanent_delete') {
    emit('confirm', {
      reason,
      confirmAccount: form.confirmAccount,
      permanentDeletePassword: form.permanentDeletePassword,
    })
    return
  }
  emit('confirm', { reason })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="actionLabel"
    width="min(92vw, 620px)"
    destroy-on-close
    :close-on-click-modal="!loading"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetSensitiveState"
  >
    <div class="flex flex-col gap-4">
      <el-alert
        :title="action === 'permanent_delete' ? '永久删除不可恢复，且只允许零关键业务关联的已注销账号。' : '操作结果以服务端实时预检与事务内复检为准。'"
        :type="action === 'permanent_delete' ? 'error' : 'warning'"
        :closable="false"
        show-icon
      />

      <el-descriptions :column="1" border>
        <el-descriptions-item label="账号">{{ accountLabel || '-' }}</el-descriptions-item>
        <el-descriptions-item label="账号状态">{{ lifecycle?.accountState || preview?.accountState || '-' }}</el-descriptions-item>
        <el-descriptions-item label="注销时间">
          {{ lifecycle?.deactivatedAt ? new Date(lifecycle.deactivatedAt).toLocaleString() : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="注销原因">{{ lifecycle?.deactivationReason || '-' }}</el-descriptions-item>
        <el-descriptions-item label="注销操作者">
          {{ lifecycle?.deactivatedByDisplayName || lifecycle?.deactivatedByUsername || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="最近恢复">
          {{ lifecycle?.restoredAt ? new Date(lifecycle.restoredAt).toLocaleString() : '-' }}
        </el-descriptions-item>
      </el-descriptions>

      <div v-if="preview?.blockers.length" class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <div class="mb-2 font-medium">当前阻断原因</div>
        <ul class="list-disc space-y-1 pl-5">
          <li v-for="blocker in preview.blockers" :key="blocker.code">
            {{ blocker.message }}（{{ blocker.count }}）
          </li>
        </ul>
      </div>
      <div
        v-else-if="preview && !allowedByPreview"
        class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
      >
        当前状态或关键业务关联不满足该操作条件，请完成处理后重新预检。
      </div>

      <div v-if="referenceEntries.length" class="rounded-xl bg-slate-50 p-3 text-sm text-slate-600 dark:bg-white/5 dark:text-slate-300">
        <div class="mb-2 font-medium">关联摘要</div>
        <div class="grid gap-1 sm:grid-cols-2">
          <span v-for="[key, count] in referenceEntries" :key="key">{{ key }}：{{ count }}</span>
        </div>
      </div>

      <el-form label-position="top">
        <el-form-item :label="`${actionLabel}原因`" required>
          <el-input
            v-model="form.reason"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="请填写至少 2 个字符，原因将进入不可变生命周期事件"
          />
        </el-form-item>
        <template v-if="action === 'permanent_delete'">
          <el-form-item label="逐字确认账号" required>
            <el-input v-model="form.confirmAccount" :placeholder="`请输入：${accountLabel}`" autocomplete="off" />
          </el-form-item>
          <el-form-item label="永久删除密码" required>
            <el-input
              v-model="form.permanentDeletePassword"
              type="password"
              show-password
              autocomplete="new-password"
              placeholder="由服务端校验，不会写入日志"
            />
          </el-form-item>
        </template>
      </el-form>
    </div>

    <template #footer>
      <el-button :disabled="loading" @click="close">取消</el-button>
      <el-button
        :type="action === 'permanent_delete' ? 'danger' : 'primary'"
        :loading="loading"
        :disabled="!canSubmit"
        @click="submit"
      >
        确认{{ actionLabel }}
      </el-button>
    </template>
  </el-dialog>
</template>
