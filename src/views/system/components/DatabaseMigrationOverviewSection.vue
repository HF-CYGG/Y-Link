<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationOverviewSection.vue
 * 文件职责：承载数据库迁移助手的首屏总览与进入步骤向导入口。
 * 实现逻辑：
 * - 父页面保留运行时状态获取与推荐步骤计算；
 * - 本组件只负责展示“当前数据库状态、系统建议动作和第一步入口”。
 * 维护说明：若总览卡片继续扩展，优先保持“状态确认 -> 建议动作 -> 进入向导”的信息顺序。
 */

import type { DatabaseRuntimeOverrideStateResult } from '@/api/modules/data-maintenance'

defineProps<{
  effectiveDatabaseSummary: DatabaseRuntimeOverrideStateResult['effectiveDatabase'] | null
  beginnerGuide: DatabaseRuntimeOverrideStateResult['beginnerGuide'] | null
  migrationRecommendationTag: 'success' | 'warning'
  migrationRecommendationLabel: string
  activeRuntimeModeLabel: string
  getRuntimeModeTagType: () => 'info' | 'success' | 'warning'
  pageLoading: boolean
}>()

const emit = defineEmits<{
  (event: 'enter-flow'): void
}>()
</script>

<template>
  <section class="apple-card space-y-5 p-5 sm:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">当前数据库状态总览</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          先确认系统当前真正连接的数据库，再决定是否进入数据库迁移助手，避免在错误环境中直接创建任务。
        </p>
      </div>
      <el-tag :type="migrationRecommendationTag" effect="light">
        {{ migrationRecommendationLabel }}
      </el-tag>
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
      <div class="rounded-3xl border border-slate-200/80 bg-slate-50/80 p-5 dark:border-white/10 dark:bg-slate-900/20">
        <p class="text-sm text-slate-500 dark:text-slate-400">当前实际生效数据库</p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <p class="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {{ effectiveDatabaseSummary?.displayName || '-' }}
          </p>
          <el-tag :type="getRuntimeModeTagType()" effect="light">
            {{ activeRuntimeModeLabel }}
          </el-tag>
        </div>
        <p class="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          {{ effectiveDatabaseSummary?.description || '正在读取当前数据库状态...' }}
        </p>
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div class="rounded-2xl bg-white px-4 py-3 dark:bg-slate-950/40">
            <p class="text-xs text-slate-400">当前连接摘要</p>
            <p class="mt-1 break-all text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ effectiveDatabaseSummary?.summary || '-' }}
            </p>
          </div>
          <div class="rounded-2xl bg-white px-4 py-3 dark:bg-slate-950/40">
            <p class="text-xs text-slate-400">配置来源</p>
            <p class="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ effectiveDatabaseSummary?.sourceLabel || '-' }}
            </p>
          </div>
        </div>
      </div>

      <div class="rounded-3xl border border-slate-200/80 bg-white p-5 dark:border-white/10 dark:bg-slate-950/30">
        <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">系统推荐动作</p>
        <div class="mt-3 space-y-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          <div class="rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-900/40">
            <p class="text-xs text-slate-400">当前情况</p>
            <p class="mt-1 font-medium text-slate-700 dark:text-slate-200">{{ beginnerGuide?.headline || '-' }}</p>
          </div>
          <div class="rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-900/40">
            <p class="text-xs text-slate-400">建议动作</p>
            <p class="mt-1">{{ beginnerGuide?.recommendedAction || '-' }}</p>
          </div>
          <div class="rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-900/40">
            <p class="text-xs text-slate-400">下一步提醒</p>
            <p class="mt-1">{{ beginnerGuide?.nextStep || '准备好目标 MySQL 信息后，再进入数据库迁移助手开始预检。' }}</p>
          </div>
          <div class="rounded-2xl bg-amber-50 px-4 py-3 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
            <p class="text-xs opacity-80">风险提醒</p>
            <p class="mt-1">{{ beginnerGuide?.riskTip || '数据库切换涉及运行环境，请先核对重启窗口与回退方案。' }}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="rounded-3xl border border-dashed border-slate-300/80 bg-slate-50/70 p-5 dark:border-white/10 dark:bg-slate-900/20">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-semibold text-slate-800 dark:text-slate-100">第一步入口</p>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
            从预检开始最安全。数据库迁移助手会在每一步完成后自动解锁下一块功能区。
          </p>
        </div>
        <el-button type="primary" :disabled="pageLoading" @click="emit('enter-flow')">
          进入第 1 步：预检目标 MySQL
        </el-button>
      </div>
    </div>
  </section>
</template>
