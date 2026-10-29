<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationAutomaticLogPanel.vue
 * 文件职责：以终端风格时间线展示一键自动迁移的运行日志与表级导入记录。
 * 实现逻辑：
 * - 后端任务只持久化当前进展一行文案，本组件在轮询期间记录每次“状态 + 进展”变化，时间取后端 updatedAt；
 * - 刷新页面后从当前进展重新开始记录，不推测已经错过的历史阶段；
 * - 表级结果直接取任务 progress.tableResults 或最终导入结果，按导入顺序列出行数；
 * - 新日志到达时，仅当用户停留在底部才自动滚动，避免打断向上翻看。
 * 维护说明：
 * - 若后端后续提供持久化事件流，应改为直接渲染后端事件，删除这里的本地累积逻辑；
 * - 本组件只展示脱敏的进展文案与表名行数，不得渲染连接凭据或文件路径。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { DatabaseMigrationTaskStatus, SQLiteToMySqlTaskRecord } from '@/api/modules/data-maintenance'

type LogLevel = 'info' | 'success' | 'warning' | 'error'
type LogEntry = { key: string; time: string; level: LogLevel; text: string }

const props = defineProps<{
  task: SQLiteToMySqlTaskRecord | null
}>()

const MAX_LOG_ENTRIES = 200
const entries = ref<LogEntry[]>([])
const logViewport = ref<HTMLElement | null>(null)
const activeView = ref<'log' | 'tables'>('log')

const levelOfStatus = (status: DatabaseMigrationTaskStatus): LogLevel => {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'rolled_back' || status === 'restart_pending') return 'warning'
  return 'info'
}

const levelLabels: Record<LogLevel, string> = { info: 'INFO', success: 'DONE', warning: 'WARN', error: 'FAIL' }

const formatClock = (value: string) => {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? '--:--:--' : time.toLocaleTimeString('zh-CN', { hour12: false })
}

const isNearBottom = () => {
  const element = logViewport.value
  return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 24
}

watch(
  () => [props.task?.id, props.task?.status, props.task?.progress?.currentStage, props.task?.updatedAt] as const,
  ([taskId, status, stage, updatedAt], previous) => {
    if (!taskId || !status) {
      entries.value = []
      return
    }
    if (previous?.[0] !== taskId) {
      entries.value = []
    }
    const text = stage || '后端未返回进展说明'
    const key = `${status}|${text}`
    if (entries.value.at(-1)?.key === key) return
    const stickToBottom = isNearBottom()
    entries.value = [...entries.value, { key, time: updatedAt ?? '', level: levelOfStatus(status), text }].slice(-MAX_LOG_ENTRIES)
    if (stickToBottom) {
      void nextTick(() => {
        if (logViewport.value) logViewport.value.scrollTop = logViewport.value.scrollHeight
      })
    }
  },
  { immediate: true },
)

const tableRows = computed(() => props.task?.result?.importedTables ?? props.task?.progress?.tableResults ?? [])
const totalImportedRows = computed(() => tableRows.value.reduce((total, item) => total + item.rowCount, 0))
</script>

<template>
  <section
    v-if="task"
    class="overflow-hidden rounded-xl border border-slate-200/80 dark:border-white/10"
    data-testid="migration-run-log"
  >
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 bg-slate-50 px-4 py-2.5 dark:border-white/10 dark:bg-white/[0.03]">
      <h3 class="text-sm font-semibold text-slate-700 dark:text-slate-200">运行日志</h3>
      <el-radio-group v-model="activeView" size="small">
        <el-radio-button value="log">进展时间线</el-radio-button>
        <el-radio-button value="tables">表级导入（{{ tableRows.length }}）</el-radio-button>
      </el-radio-group>
    </div>

    <div
      v-show="activeView === 'log'"
      ref="logViewport"
      class="log-terminal max-h-56 overflow-auto bg-slate-900 px-4 py-3 font-mono text-xs leading-6 dark:bg-black/60"
      role="log"
      aria-live="polite"
    >
      <p v-for="entry in entries" :key="`${entry.key}-${entry.time}`" class="flex gap-3">
        <span class="shrink-0 text-slate-500">{{ formatClock(entry.time) }}</span>
        <span class="w-9 shrink-0 font-semibold" :class="`log-level--${entry.level}`">{{ levelLabels[entry.level] }}</span>
        <span class="min-w-0 break-all">{{ entry.text }}</span>
      </p>
      <p class="mt-1 text-[11px] text-slate-500">
        仅记录本次打开页面后观察到的进展变化；刷新页面会从当前进展重新记录。
      </p>
    </div>

    <div v-show="activeView === 'tables'" class="max-h-56 overflow-auto px-4 py-3">
      <template v-if="tableRows.length">
        <p class="mb-2 text-xs text-slate-500 dark:text-slate-400">
          已导入 {{ tableRows.length }} 张表，共 {{ totalImportedRows }} 行
        </p>
        <div class="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          <div
            v-for="row in tableRows"
            :key="row.tableName"
            class="flex items-center justify-between gap-3 border-b border-dashed border-slate-200 py-1 text-xs dark:border-white/10"
          >
            <span class="min-w-0 truncate font-mono text-slate-700 dark:text-slate-200" :title="row.tableName">{{ row.tableName }}</span>
            <span class="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{{ row.rowCount }} 行</span>
          </div>
        </div>
      </template>
      <p v-else class="py-4 text-center text-xs text-slate-500 dark:text-slate-400">进入导入阶段后，这里会逐表列出导入行数。</p>
    </div>
  </section>
</template>

<style scoped>
/* 终端配色只在本组件使用，写在 scoped 样式中避免新增 Tailwind 全局原子类、撑大首屏 CSS。 */
.log-terminal {
  color: rgb(226 232 240);
}

.log-level--info {
  color: rgb(125 211 252);
}

.log-level--success {
  color: rgb(110 231 183);
}

.log-level--warning {
  color: rgb(252 211 77);
}

.log-level--error {
  color: rgb(253 164 175);
}
</style>
