<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationAutomaticProgressSection.vue
 * 文件职责：展示一键自动迁移的六个后端编排阶段与受控救援入口。
 * 实现逻辑：
 * - 进行中按后端 stage 标记阶段；任务与实际 MySQL 运行态共同确认完成后，六阶段全部标为完成；
 * - 成功终态显示“迁移已完成”，重启等待、验收中和失败不会提前显示完成；
 * - 仅当 allowedActions 明确允许时展示救援入口，不沿用普通页面回退假设；
 * - 恢复状态只展示阶段、操作标识和重启次数，不展示数据库路径或连接凭据；
 * - 六阶段以带序号圆点的横向步骤条呈现，宽屏单行排列，窄屏自动折成两到三列；
 * - 每个阶段标注已完成/进行中/失败/等待，仅对本页实时观察到起止的阶段显示耗时，不推测错过的历史；
 * - 等待重启与验收阶段给出“短暂断线属正常”的说明，轮询连不上后端时提示正在自动重连；
 * - 失败与回退的诊断展示交给 DatabaseMigrationFailurePanel，本组件只标出失败停在哪一步。
 * 维护说明：新增阶段或救援动作时，须先同步 API 契约，再在本组件显式映射。
 */

import { computed, ref, watch } from 'vue'
import type { DatabaseMigrationStage, DatabaseMigrationTaskStatus, SQLiteToMySqlTaskRecord } from '@/api/modules/data-maintenance'

const phaseCards: Array<{ key: DatabaseMigrationStage; title: string; description: string }> = [
  { key: 'freeze', title: '冻结写入', description: '进入受控只读窗口' },
  { key: 'precheck', title: '预检', description: '复核目标与迁移前提' },
  { key: 'snapshot', title: '快照', description: '建立 SQLite 与数据快照' },
  { key: 'import', title: '导入', description: '迁移业务数据到目标库' },
  { key: 'validate', title: '校验', description: '核对数据与结构结果' },
  { key: 'cutover', title: '切换', description: '受控重启并确认运行态' },
]

const props = defineProps<{
  task: SQLiteToMySqlTaskRecord | null
  completed: boolean
  hasCurrentTabRescueCredential: boolean
  serviceReachable?: boolean
  lastRefreshedAt?: string
}>()

const emit = defineEmits<{
  (event: 'open-rescue'): void
}>()

const activePhaseIndex = computed(() => {
  if (!props.task?.stage) return -1
  return phaseCards.findIndex((phase) => phase.key === props.task?.stage)
})

const statusLabels: Record<DatabaseMigrationTaskStatus, string> = {
  queued: '等待执行', prechecked: '预检通过', running: '迁移进行中',
  restart_pending: '等待重启', verifying: '切换验收中', succeeded: '任务已成功',
  failed: '迁移失败', rolled_back: '已回退 SQLite',
}
const progressLabel = computed(() => {
  if (props.completed) return '迁移已完成'
  if (props.task?.status === 'succeeded') return '等待确认运行状态'
  if (props.task && ['failed', 'rolled_back'].includes(props.task.status)) return statusLabels[props.task.status]
  const phase = phaseCards[activePhaseIndex.value]
  return phase ? `当前：${phase.title}` : '后端未返回分阶段状态'
})
const progressTagType = computed(() => props.completed ? 'success'
  : props.task?.status === 'failed' ? 'danger'
    : props.task?.status === 'rolled_back' ? 'info' : 'warning')
const phaseState = (index: number) => {
  if (props.completed || (activePhaseIndex.value >= 0 && index < activePhaseIndex.value)) return 'complete'
  if (index !== activePhaseIndex.value) return 'pending'
  return props.task && ['failed', 'rolled_back'].includes(props.task.status) ? 'stopped' : 'active'
}

const canOpenRescue = computed(() => {
  const actions = props.task?.allowedActions ?? []
  return actions.includes('prepare_rollback') || actions.includes('resume_rollback')
})

const isRunning = computed(() => Boolean(props.task)
  && ['queued', 'running', 'restart_pending', 'verifying'].includes(props.task!.status))
const isStopped = computed(() => Boolean(props.task) && ['failed', 'rolled_back'].includes(props.task!.status))

/**
 * 已用时：
 * - 以后端 startedAt 为起点，结束取 finishedAt，进行中取最近一次 updatedAt；
 * - 随轮询刷新，不额外起定时器，避免离页后仍占用计时资源。
 */
const elapsedText = computed(() => {
  const task = props.task
  if (!task?.startedAt) return ''
  const end = Date.parse(task.finishedAt ?? task.updatedAt)
  const seconds = Math.max(0, Math.round((end - Date.parse(task.startedAt)) / 1000))
  if (!Number.isFinite(seconds)) return ''
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`
})

/**
 * 表级导入进度：以后端已回填的表结果数 / 源库表数估算，仅在导入阶段展示；后续阶段由日志面板的表级页签查看。
 */
const tableProgress = computed(() => {
  const task = props.task
  const total = task?.precheck?.source?.tables?.length ?? 0
  const done = Math.min(task?.progress?.tableResults?.length ?? 0, total)
  if (!task || total === 0 || props.completed || task.stage !== 'import') return null
  return { done, total, percent: Math.round((done / total) * 100) }
})

/**
 * 阶段耗时：
 * - 记录本页实时观察到的“进入某阶段”时刻（取后端 updatedAt）；
 * - 只有起点与终点都是实时观察到的阶段才显示耗时，页面打开时已在进行的阶段不推测起点。
 */
const phaseStartedAt = ref<Partial<Record<DatabaseMigrationStage, string>>>({})
const phaseEndedAt = ref<Partial<Record<DatabaseMigrationStage, string>>>({})

watch(
  () => [props.task?.id, props.task?.stage, props.task?.status, props.task?.updatedAt] as const,
  ([taskId, stage, status, updatedAt], previous) => {
    if (!taskId || previous?.[0] !== taskId) {
      phaseStartedAt.value = {}
      phaseEndedAt.value = {}
      return
    }
    const previousStage = previous?.[1]
    if (stage && previousStage && stage !== previousStage && updatedAt) {
      phaseEndedAt.value = { ...phaseEndedAt.value, [previousStage]: updatedAt }
      phaseStartedAt.value = { ...phaseStartedAt.value, [stage]: updatedAt }
    }
    if (stage && status && ['succeeded', 'failed', 'rolled_back'].includes(status) && updatedAt && phaseStartedAt.value[stage]) {
      phaseEndedAt.value = { ...phaseEndedAt.value, [stage]: phaseEndedAt.value[stage] ?? updatedAt }
    }
  },
  { immediate: true },
)

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

const phaseCaption = (phase: DatabaseMigrationStage, index: number) => {
  const state = phaseState(index)
  if (state === 'stopped') return props.task?.status === 'rolled_back' ? '在此回退' : '失败于此'
  if (state === 'active') return '进行中'
  if (state === 'pending') return '等待'
  const startedAt = phaseStartedAt.value[phase]
  const endedAt = phaseEndedAt.value[phase]
  if (startedAt && endedAt) {
    const seconds = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)
    if (Number.isFinite(seconds) && seconds >= 0) return `用时 ${formatDuration(seconds)}`
  }
  return '已完成'
}

const statusHint = computed(() => {
  const status = props.task?.status
  if (status === 'queued') return '正在等待进入只读维护，期间请勿重复发起迁移。'
  if (status === 'restart_pending') return '后端正在受控重启以切换到 MySQL，重启期间页面可能短暂无法连接，会自动重连，请勿关闭页面或重复操作。'
  if (status === 'verifying') return 'MySQL 已启动，正在执行重启后全表验收；验收通过前不会显示迁移完成。'
  return ''
})

const formatClock = (value?: string) => {
  if (!value) return '-'
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <section v-if="task" class="rounded-xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-white/10 dark:bg-white/[0.03] sm:p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">自动迁移进度</h3>
        <p class="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">
          任务 <span class="font-mono">{{ task.id }}</span> · {{ statusLabels[task.status] }}
        </p>
      </div>
      <el-tag :type="progressTagType" effect="light" round>
        {{ progressLabel }}
      </el-tag>
    </div>

    <ol class="phase-list mt-4">
      <li
        v-for="(phase, index) in phaseCards"
        :key="phase.key"
        :data-phase-state="phaseState(index)"
        class="phase-card flex items-start gap-3 rounded-lg border px-3 py-2"
        :class="phaseState(index) === 'complete'
          ? 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-900/70 dark:bg-emerald-950/20'
          : phaseState(index) === 'active'
            ? 'border-amber-300 bg-amber-50/80 dark:border-amber-900/70 dark:bg-amber-950/20'
            : phaseState(index) === 'stopped'
              ? 'phase-card--stopped'
              : 'border-slate-200 bg-white dark:border-white/10 dark:bg-black/20'"
      >
        <span class="phase-dot" :class="`phase-dot--${phaseState(index)}`">
          {{ phaseState(index) === 'complete' ? '✓' : index + 1 }}
        </span>
        <div class="min-w-0">
          <div class="text-sm font-medium text-slate-800 dark:text-slate-100">{{ phase.title }}</div>
          <div class="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{{ phase.description }}</div>
          <div class="phase-caption" :class="`phase-caption--${phaseState(index)}`">{{ phaseCaption(phase.key, index) }}</div>
        </div>
      </li>
    </ol>

    <div
      v-if="!completed && !isStopped"
      class="mt-4 rounded-lg border border-slate-200/80 bg-white px-4 py-3 dark:border-white/10 dark:bg-black/20"
    >
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p class="flex min-w-0 items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <span class="live-dot" :class="{ 'live-dot--running': isRunning }" aria-hidden="true" />
          <span class="break-all">{{ task.progress?.currentStage || '等待后端返回进展' }}</span>
        </p>
        <span v-if="elapsedText" class="shrink-0 text-xs text-slate-500 dark:text-slate-400">已用时 {{ elapsedText }}</span>
      </div>
      <p v-if="statusHint" class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{{ statusHint }}</p>
      <p v-if="serviceReachable === false" class="reconnect-line mt-2" role="status">
        <span class="live-dot live-dot--running" aria-hidden="true" />
        暂时无法连接后端，正在每 2 秒自动重连<template v-if="lastRefreshedAt">；最后一次成功刷新 {{ formatClock(lastRefreshedAt) }}</template>
      </p>
      <div v-if="tableProgress" class="mt-3">
        <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>数据表导入</span>
          <span>{{ tableProgress.done }} / {{ tableProgress.total }} 张表 · {{ tableProgress.percent }}%</span>
        </div>
        <div class="progress-track mt-2">
          <div class="progress-fill bg-brand" :style="{ width: `${tableProgress.percent}%` }" />
        </div>
      </div>
    </div>

    <el-alert
      v-if="completed"
      class="mt-4"
      title="迁移已完成"
      type="success"
      :closable="false"
      show-icon
      description="数据已迁移至 MySQL，切换后的校验已通过。可以继续使用系统，或在高级 / 应急操作中查看任务与校验明细。"
    />

    <el-alert
      v-if="!task.stage && !completed"
      class="mt-4"
      title="兼容旧任务响应：未提供六阶段状态"
      type="info"
      :closable="false"
      show-icon
      description="请以任务状态和后端返回的详细结果为准；页面不会把旧响应推测为已完成切换或可回退。"
    />

    <el-alert
      v-if="task.recovery"
      class="mt-4"
      title="救援恢复进行中"
      type="warning"
      :closable="false"
      show-icon
      :description="`阶段：${task.recovery.phase}；操作：${task.recovery.operationId}；重启尝试：${task.recovery.restartAttempts}。重启后前 90 秒仍可能不可达，请继续查看状态，不要误报恢复成功。`"
    />

    <div v-if="canOpenRescue" class="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200/80 pt-4 dark:border-white/10">
      <el-button type="danger" plain @click="emit('open-rescue')">
        {{ hasCurrentTabRescueCredential ? '进入独立救援页' : '打开独立救援页并输入凭证' }}
      </el-button>
      <span class="text-xs text-slate-500 dark:text-slate-400">后端已许可：{{ task.allowedActions?.join('、') }}</span>
    </div>
  </section>
</template>

<style scoped>
/*
 * 本组件专用的状态色、步骤条栅格、脉冲点与进度条过渡写在 scoped 样式中，
 * 只进入路由分包 CSS，不新增 Tailwind 全局原子类，避免撑大首屏 CSS 预算。
 */
.phase-list {
  display: grid;
  gap: 0.5rem;
}

@media (min-width: 640px) {
  .phase-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 1280px) {
  .phase-list {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .phase-card {
    flex-direction: column;
    gap: 0.5rem;
  }
}

.phase-card--stopped {
  border-color: rgb(254 205 211);
  background-color: rgb(255 241 242 / 0.7);
}

.phase-dot {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  color: #fff;
}

.phase-dot--complete {
  background-color: rgb(16 185 129);
}

.phase-dot--active {
  background-color: rgb(245 158 11);
}

.phase-dot--stopped {
  background-color: rgb(244 63 94);
}

.phase-dot--pending {
  background-color: rgb(226 232 240);
  color: rgb(100 116 139);
}

.live-dot {
  position: relative;
  flex-shrink: 0;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  background-color: rgb(148 163 184);
}

.live-dot--running {
  background-color: rgb(245 158 11);
}

.live-dot--running::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-color: inherit;
  animation: live-dot-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
}

@keyframes live-dot-ping {
  75%,
  100% {
    transform: scale(2.2);
    opacity: 0;
  }
}

.progress-track {
  height: 0.375rem;
  overflow: hidden;
  border-radius: 9999px;
  background-color: rgb(226 232 240);
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  transition: width 0.5s ease;
}

.dark .phase-card--stopped {
  border-color: rgb(136 19 55 / 0.6);
  background-color: rgb(76 5 25 / 0.2);
}

.dark .phase-dot--pending {
  background-color: rgb(255 255 255 / 0.1);
  color: rgb(148 163 184);
}

.dark .progress-track {
  background-color: rgb(255 255 255 / 0.1);
}

.phase-caption {
  margin-top: 0.25rem;
  font-size: 11px;
  font-weight: 500;
  color: rgb(100 116 139);
}

.phase-caption--complete {
  color: rgb(4 120 87);
}

.phase-caption--active {
  color: rgb(180 83 9);
}

.phase-caption--stopped {
  color: rgb(190 18 60);
}

.reconnect-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.375rem;
  background-color: rgb(255 251 235);
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
  color: rgb(146 64 14);
}

.dark .phase-caption--complete {
  color: rgb(110 231 183);
}

.dark .phase-caption--active {
  color: rgb(252 211 77);
}

.dark .phase-caption--stopped {
  color: rgb(253 164 175);
}

.dark .reconnect-line {
  background-color: rgb(69 26 3 / 0.4);
  color: rgb(252 211 77);
}

@media (prefers-reduced-motion: reduce) {
  .live-dot--running::after {
    animation: none;
  }

  .progress-fill {
    transition: none;
  }
}
</style>
