<script setup lang="ts">
/**
 * 模块说明：src/rescue/DatabaseRescueView.vue
 * 文件职责：在普通应用不可达时，以一次性救援凭证展示任务状态并执行受控 SQLite 回退。
 * 实现逻辑：
 * - 只使用同源 fetch + Bearer 凭证，不加载普通鉴权 Store、系统配置或业务 API；
 * - 从当前标签页 sessionStorage 预填尚未过期的凭证，也允许用户手动粘贴；
 * - 回退严格依赖后端 allowedActions，先获取 nonce，再以同一 Idempotency-Key 提交，不自动重试未知网络结果。
 * 维护说明：不得在此页增加任意 SQL、文件路径或数据库连接参数输入，也不得把凭证写入 URL 或日志。
 */

import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import {
  RescueApiError,
  beginRescueRollback,
  getRescueStatus,
  prepareRescueRollback,
  type RescueRollbackPreparation,
  type RescueStatus,
} from './rescue-api'
import {
  clearStoredRescueCredential,
  readStoredRescueCredential,
  type RescueCredential,
} from './rescue-session-storage'

const storedCredential = ref<RescueCredential | null>(null)
const credentialInput = ref('')
const status = ref<RescueStatus | null>(null)
const loadingStatus = ref(false)
const preparingRollback = ref(false)
const startingRollback = ref(false)
const errorMessage = ref('')
const rollbackPreparation = ref<RescueRollbackPreparation | null>(null)
const rollbackIdempotencyKey = ref('')
const rollbackOutcome = ref('')

const canPrepareRollback = computed(() => status.value?.allowedActions.includes('prepare_rollback') === true)
const canResumeRollback = computed(() => status.value?.allowedActions.includes('resume_rollback') === true)
const hasCredential = computed(() => credentialInput.value.trim().length > 0)

const getSessionStorage = () => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

const formatTime = (value?: string) => {
  if (!value) return '-'
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(timestamp) : value
}

const toUserMessage = (error: unknown, fallback: string) => {
  if (error instanceof RescueApiError) {
    return error.reason === 'RESCUE_SECURE_TRANSPORT_REQUIRED'
      ? '救援入口需要可信 HTTPS 或容器本地 CLI 连接。'
      : error.message
  }
  return fallback
}

const refreshStatus = async () => {
  if (!hasCredential.value) {
    errorMessage.value = '请输入救援凭证后再查询状态。'
    return
  }
  loadingStatus.value = true
  errorMessage.value = ''
  try {
    status.value = await getRescueStatus(credentialInput.value.trim())
  } catch (error) {
    status.value = null
    errorMessage.value = toUserMessage(error, '无法读取救援状态，请确认凭证和连接后重试。')
  } finally {
    loadingStatus.value = false
  }
}

const prepareRollback = async () => {
  if (!canPrepareRollback.value || !hasCredential.value) {
    return
  }
  preparingRollback.value = true
  rollbackOutcome.value = ''
  errorMessage.value = ''
  try {
    rollbackPreparation.value = await prepareRescueRollback(credentialInput.value.trim())
    rollbackIdempotencyKey.value = crypto.randomUUID()
    rollbackOutcome.value = '回退已准备。请确认后提交；凭证、nonce 与操作键均不会显示在页面或 URL 中。'
    await refreshStatus()
  } catch (error) {
    errorMessage.value = toUserMessage(error, '无法准备受控回退，请刷新状态。')
  } finally {
    preparingRollback.value = false
  }
}

const submitRollback = async () => {
  if (!rollbackPreparation.value || !rollbackIdempotencyKey.value || !hasCredential.value) {
    return
  }
  startingRollback.value = true
  rollbackOutcome.value = ''
  errorMessage.value = ''
  try {
    const accepted = await beginRescueRollback(
      credentialInput.value.trim(),
      rollbackPreparation.value.nonce,
      rollbackIdempotencyKey.value,
    )
    rollbackOutcome.value = `已受理回退操作（阶段：${accepted.phase}）。服务重启后的前 90 秒仍可能不可达，请随后使用“刷新状态”确认，不能据此误判已恢复。`
    await refreshStatus()
  } catch (error) {
    errorMessage.value = toUserMessage(error, '回退请求状态未知，请先刷新状态；页面不会自动用新 nonce 发起第二次回退。')
  } finally {
    startingRollback.value = false
  }
}

const copyCredential = async () => {
  if (!hasCredential.value || !navigator.clipboard) {
    ElMessage.warning('当前浏览器不支持安全复制，请在可信 HTTPS 页面手动保存。')
    return
  }
  try {
    await navigator.clipboard.writeText(credentialInput.value.trim())
    ElMessage.success('救援凭证已复制到剪贴板。')
  } catch {
    ElMessage.error('复制失败，请在可信 HTTPS 页面手动保存。')
  }
}

const downloadCredential = () => {
  const current = storedCredential.value
  if (!current || current.credential !== credentialInput.value.trim()) {
    ElMessage.warning('只有当前标签页自动取得的凭证可以导出。')
    return
  }
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `database-rescue-${current.taskId}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const clearCredential = () => {
  const storage = getSessionStorage()
  if (storage) clearStoredRescueCredential(storage)
  storedCredential.value = null
  credentialInput.value = ''
  status.value = null
  rollbackPreparation.value = null
  rollbackIdempotencyKey.value = ''
  rollbackOutcome.value = ''
  errorMessage.value = ''
}

onMounted(() => {
  const storage = getSessionStorage()
  if (storage) {
    storedCredential.value = readStoredRescueCredential(storage)
    credentialInput.value = storedCredential.value?.credential ?? ''
  }
  if (credentialInput.value) void refreshStatus()
})
</script>

<template>
  <el-config-provider :locale="zhCn">
    <main class="rescue-shell">
      <div class="rescue-container">
      <section class="rescue-card">
        <div class="rescue-header">
          <div>
            <h1 class="rescue-title">数据库救援</h1>
            <p class="rescue-description">
              此页面独立于普通登录和业务应用。它只接受一次性救援凭证，并且只提供后端明确许可的受控回退操作。
            </p>
          </div>
          <el-tag type="danger" effect="dark">受控应急入口</el-tag>
        </div>

        <el-alert
          class="rescue-credential"
          title="请使用可信 HTTPS 或容器本地 CLI"
          type="warning"
          :closable="false"
          show-icon
          description="普通 HTTP 的局域网访问可以继续使用迁移功能，但不能签发或使用救援凭证。此页不提供任意 SQL、文件路径或数据库连接输入。"
        />

        <el-form class="rescue-credential" label-position="top">
          <el-form-item label="救援凭证">
            <el-input
              v-model="credentialInput"
              type="password"
              show-password
              autocomplete="off"
              placeholder="粘贴一次性救援凭证"
            />
          </el-form-item>
        </el-form>

        <div class="rescue-actions">
          <el-button type="primary" :loading="loadingStatus" :disabled="!hasCredential" @click="refreshStatus">刷新状态</el-button>
          <el-button :disabled="!hasCredential" @click="copyCredential">复制凭证</el-button>
          <el-button :disabled="!storedCredential" @click="downloadCredential">保存凭证文件</el-button>
          <el-button plain :disabled="!hasCredential" @click="clearCredential">清除本页凭证</el-button>
        </div>

        <el-alert v-if="errorMessage" class="rescue-credential" :title="errorMessage" type="error" :closable="false" show-icon />
      </section>

      <section v-if="status" class="rescue-card">
        <h2 class="rescue-title">当前救援状态</h2>
        <div class="rescue-grid">
          <div><div class="rescue-label">任务 ID</div><div class="rescue-value">{{ status.taskId }}</div></div>
          <div><div class="rescue-label">状态</div><div class="rescue-value">{{ status.status }}</div></div>
          <div><div class="rescue-label">稳定原因</div><div class="rescue-value">{{ status.reason }}</div></div>
          <div><div class="rescue-label">后端许可操作</div><div class="rescue-value">{{ status.allowedActions.length ? status.allowedActions.join('、') : '当前无许可操作' }}</div></div>
        </div>

        <div v-if="status.recovery" class="rescue-phase">
          <p>恢复阶段：{{ status.recovery.phase }}</p>
          <p>操作 ID：{{ status.recovery.operationId }}</p>
          <p>重启尝试：{{ status.recovery.restartAttempts }}</p>
        </div>

        <el-alert
          v-if="rollbackOutcome"
          class="rescue-credential"
          :title="rollbackOutcome"
          type="info"
          :closable="false"
          show-icon
        />

        <div class="rescue-actions">
          <el-button v-if="canPrepareRollback" type="danger" :loading="preparingRollback" @click="prepareRollback">准备回退到源 SQLite</el-button>
          <el-button
            v-if="rollbackPreparation && (canPrepareRollback || canResumeRollback)"
            type="danger"
            plain
            :loading="startingRollback"
            @click="submitRollback"
          >
            确认执行已准备回退
          </el-button>
        </div>
        <p class="rescue-small">
          没有后端 allowedActions 时，此页不会推测可以回退。网络中断后不会自动重发；请刷新状态确认是否已受理。
          {{ rollbackPreparation ? `已准备凭证有效至：${formatTime(rollbackPreparation.expiresAt)}。` : '' }}
        </p>
      </section>
      </div>
    </main>
  </el-config-provider>
</template>
