<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationFailurePanel.vue
 * 文件职责：在一键自动迁移失败或回退后，展示归类后的失败诊断、数据安全状态、针对性建议与原始报错。
 * 实现逻辑：
 * - 诊断由 database-migration-failure.ts 纯函数给出，本组件只负责分级配色与排版；
 * - 先给结论（数据是否安全、失败类别与白话说明），再给建议，原始报错默认折叠，未识别原因时自动展开；
 * - 系统仍处于只读时使用最高警示级别，并明确提示不要再次发起迁移；
 * - “复制排查信息”交给父页面拼装脱敏文本，本组件不接触剪贴板与连接凭据。
 * 维护说明：新增失败类别时先在 database-migration-failure.ts 补规则与验证脚本用例，再按需调整这里的展示。
 */
import { computed, ref, watch } from 'vue'
import type { SQLiteToMySqlTaskRecord } from '@/api/modules/data-maintenance'
import { diagnoseAutomaticMigrationFailure } from '../database-migration-failure'

const props = defineProps<{
  task: SQLiteToMySqlTaskRecord
}>()

const emit = defineEmits<{
  (event: 'copy-diagnostic'): void
}>()

const diagnosis = computed(() => diagnoseAutomaticMigrationFailure(props.task))
const rawExpanded = ref(false)

watch(() => [props.task.id, diagnosis.value.category] as const, () => {
  rawExpanded.value = diagnosis.value.category === 'unknown'
}, { immediate: true })

const tone = computed(() => {
  if (diagnosis.value.dataSafety === 'read_only') return 'critical'
  return props.task.status === 'rolled_back' || diagnosis.value.category === 'cancelled' ? 'warning' : 'danger'
})

const safetyText = computed(() => {
  if (diagnosis.value.dataSafety === 'safe') return '原 SQLite 数据未受影响，系统已恢复正常读写。'
  if (diagnosis.value.dataSafety === 'read_only') return '系统仍处于只读维护，业务暂时无法写入，需要人工处理。'
  return '无法从任务记录确认恢复情况，请以顶部“运行概况”中的当前数据库为准。'
})

const formatTime = (value?: string) => {
  if (!value) return '-'
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN', { hour12: false })
}

const elapsedText = computed(() => {
  const { startedAt, finishedAt, updatedAt } = props.task
  if (!startedAt) return ''
  const seconds = Math.max(0, Math.round((Date.parse(finishedAt ?? updatedAt) - Date.parse(startedAt)) / 1000))
  if (!Number.isFinite(seconds)) return ''
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
})
</script>

<template>
  <section
    class="failure-panel"
    :class="`failure-panel--${tone}`"
    role="alert"
    data-testid="migration-failure-panel"
    :data-failure-category="diagnosis.category"
  >
    <div class="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-5">
      <div class="flex min-w-0 items-start gap-3">
        <span class="failure-badge" aria-hidden="true">!</span>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="failure-title text-base font-semibold">{{ diagnosis.title }}</h3>
            <el-tag :type="tone === 'warning' ? 'warning' : 'danger'" effect="light" size="small" round>
              {{ diagnosis.categoryLabel }}
            </el-tag>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            结束于 {{ formatTime(task.finishedAt ?? task.updatedAt) }}<template v-if="elapsedText"> · 用时 {{ elapsedText }}</template>
            · 任务 <span class="font-mono">{{ task.id }}</span>
          </p>
        </div>
      </div>
      <el-button size="small" @click="emit('copy-diagnostic')">复制排查信息</el-button>
    </div>

    <div class="space-y-4 px-4 py-4 sm:px-5">
      <p class="safety-line" :class="`safety-line--${diagnosis.dataSafety}`">
        <span class="safety-dot" aria-hidden="true" />
        {{ safetyText }}
      </p>

      <div>
        <p class="text-sm leading-6 text-slate-700 dark:text-slate-200">{{ diagnosis.summary }}</p>
        <div v-if="diagnosis.affectedTable || diagnosis.affectedColumn" class="mt-2 flex flex-wrap gap-2">
          <el-tag v-if="diagnosis.affectedTable" type="info" effect="plain" size="small">
            涉及表 <span class="font-mono">{{ diagnosis.affectedTable }}</span>
          </el-tag>
          <el-tag v-if="diagnosis.affectedColumn" type="info" effect="plain" size="small">
            涉及列 <span class="font-mono">{{ diagnosis.affectedColumn }}</span>
          </el-tag>
        </div>
      </div>

      <div v-if="task.rollbackResult" class="failure-subcard">
        <p class="text-xs font-medium text-slate-500 dark:text-slate-400">自动回退结果</p>
        <p class="mt-1 text-sm text-slate-700 dark:text-slate-200">{{ task.rollbackResult.message }}</p>
        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          回退时间 {{ formatTime(task.rollbackResult.rolledBackAt) }} · MySQL 启动尝试 {{ task.rollbackResult.mysqlStartupAttempts }} 次
        </p>
      </div>

      <div>
        <p class="text-xs font-medium text-slate-600 dark:text-slate-300">建议这样处理</p>
        <ol class="failure-steps mt-2 space-y-1.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
          <li v-for="(item, index) in diagnosis.suggestions" :key="index">{{ item }}</li>
        </ol>
      </div>

      <div v-if="diagnosis.rawMessage" class="failure-subcard">
        <div class="flex items-center justify-between gap-3">
          <p class="text-xs font-medium text-slate-500 dark:text-slate-400">原始报错</p>
          <el-button link type="primary" size="small" @click="rawExpanded = !rawExpanded">
            {{ rawExpanded ? '收起' : '展开' }}
          </el-button>
        </div>
        <pre v-if="rawExpanded" class="failure-raw mt-2">{{ diagnosis.rawMessage }}</pre>
        <p v-else class="mt-1 truncate font-mono text-xs text-slate-500 dark:text-slate-400" :title="diagnosis.rawMessage">
          {{ diagnosis.rawMessage }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 分级配色只在本组件使用，写在 scoped 样式中，避免新增 Tailwind 全局原子类撑大首屏 CSS。 */
.failure-panel {
  --failure-accent: 225 29 72;
  --failure-border: 254 205 211;
  --failure-bg: 255 241 242;
  overflow: hidden;
  border: 1px solid rgb(var(--failure-border));
  border-radius: 0.75rem;
  background-color: rgb(var(--failure-bg) / 0.7);
}

.failure-panel--warning {
  --failure-accent: 217 119 6;
  --failure-border: 253 230 138;
  --failure-bg: 255 251 235;
}

.failure-panel--critical {
  border-width: 2px;
  --failure-border: 251 113 133;
}

.failure-badge {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 9999px;
  background-color: rgb(var(--failure-accent));
  color: #fff;
  font-weight: 700;
}

.failure-title {
  color: rgb(var(--failure-accent));
}

.safety-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
}

.safety-dot {
  flex-shrink: 0;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  background-color: currentColor;
}

.safety-line--safe {
  background-color: rgb(209 250 229 / 0.7);
  color: rgb(4 120 87);
}

.safety-line--read_only {
  background-color: rgb(225 29 72);
  color: #fff;
}

.safety-line--unknown {
  background-color: rgb(241 245 249);
  color: rgb(71 85 105);
}

.failure-subcard {
  border-radius: 0.5rem;
  background-color: rgb(255 255 255 / 0.75);
  padding: 0.625rem 0.75rem;
}

.failure-steps {
  list-style: decimal;
  padding-left: 1.25rem;
}

.failure-raw {
  max-height: 12rem;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.75rem;
  line-height: 1.25rem;
  color: rgb(var(--failure-accent));
}

.dark .failure-panel {
  --failure-accent: 253 164 175;
  --failure-border: 136 19 55;
  --failure-bg: 76 5 25;
  background-color: rgb(var(--failure-bg) / 0.25);
}

.dark .failure-panel--warning {
  --failure-accent: 252 211 77;
  --failure-border: 120 53 15;
  --failure-bg: 69 26 3;
}

.dark .failure-panel--critical {
  --failure-border: 225 29 72;
}

.dark .failure-badge {
  color: rgb(15 23 42);
}

.dark .failure-subcard {
  background-color: rgb(0 0 0 / 0.25);
}

.dark .safety-line--safe {
  background-color: rgb(6 78 59 / 0.4);
  color: rgb(110 231 183);
}

.dark .safety-line--unknown {
  background-color: rgb(255 255 255 / 0.06);
  color: rgb(148 163 184);
}
</style>
