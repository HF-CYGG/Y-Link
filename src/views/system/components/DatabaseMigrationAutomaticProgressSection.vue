<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationAutomaticProgressSection.vue
 * 文件职责：展示一键自动迁移的六个后端编排阶段与受控救援入口。
 * 实现逻辑：
 * - 进行中按后端 stage 标记阶段；任务与实际 MySQL 运行态共同确认完成后，六阶段全部标为完成；
 * - 成功终态显示“迁移已完成”，重启等待、验收中和失败不会提前显示完成；
 * - 仅当 allowedActions 明确允许时展示救援入口，不沿用普通页面回退假设；
 * - 恢复状态只展示阶段、操作标识和重启次数，不展示数据库路径或连接凭据。
 * 维护说明：新增阶段或救援动作时，须先同步 API 契约，再在本组件显式映射。
 */

import { computed } from 'vue'
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
</script>

<template>
  <section v-if="task" class="mt-5 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-slate-900/20">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">自动迁移进度</h3>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">任务 {{ task.id }} · {{ statusLabels[task.status] }}</p>
      </div>
      <el-tag :type="progressTagType" effect="light">
        {{ progressLabel }}
      </el-tag>
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

    <div class="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      <div
        v-for="(phase, index) in phaseCards"
        :key="phase.key"
        :data-phase-state="phaseState(index)"
        class="rounded-xl border p-3"
        :class="phaseState(index) === 'complete'
          ? 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-900/70 dark:bg-emerald-950/20'
          : phaseState(index) === 'active'
            ? 'border-amber-300 bg-amber-50/80 dark:border-amber-900/70 dark:bg-amber-950/20'
            : 'border-slate-200 bg-white/70 dark:border-white/10 dark:bg-slate-950/20'"
      >
        <div class="flex items-center justify-between gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
          <span>{{ index + 1 }}. {{ phase.title }}</span>
          <span v-if="phaseState(index) === 'complete'" class="text-xs text-emerald-700 dark:text-emerald-400">已完成</span>
        </div>
        <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ phase.description }}</div>
      </div>
    </div>

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

    <div v-if="canOpenRescue" class="mt-4 flex flex-wrap items-center gap-3">
      <el-button type="danger" plain @click="emit('open-rescue')">
        {{ hasCurrentTabRescueCredential ? '进入独立救援页' : '打开独立救援页并输入凭证' }}
      </el-button>
      <span class="text-xs text-slate-500 dark:text-slate-400">后端已许可：{{ task.allowedActions?.join('、') }}</span>
    </div>
  </section>
</template>
