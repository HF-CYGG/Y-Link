<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationStepFlowSection.vue
 * 文件职责：承载数据库迁移助手的步骤导航卡片区。
 * 实现逻辑：
 * - 父页面保留步骤完成态与解锁态的计算；
 * - 本组件只负责展示步骤卡片，并把点击事件回传给父页面处理。
 * 维护说明：若步骤卡片需要补充图标或摘要，优先在这里扩展，不要把判断逻辑重新放回父页面模板。
 */

type MigrationStepKey = 'precheck' | 'create' | 'run' | 'switch'

type MigrationStepCard = {
  key: MigrationStepKey
  order: string
  title: string
  description: string
  unlocked: boolean
  completed: boolean
  statusLabel: string
  tagType: 'success' | 'info' | 'warning'
}

defineProps<{
  hasEnteredStepFlow: boolean
  activeStepKey: MigrationStepKey
  stepFlowCards: MigrationStepCard[]
}>()

const emit = defineEmits<{
  (event: 'open-step', payload: { stepKey: MigrationStepKey; unlocked: boolean }): void
}>()
</script>

<template>
  <section v-if="hasEnteredStepFlow" class="apple-card space-y-4 p-5 sm:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">迁移步骤助手</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          仅开放已完成前置步骤后的功能区。你也可以点击已解锁步骤，回看或调整之前的操作；推荐顺序与自动脚本提示保持一致。
        </p>
      </div>
      <el-tag effect="light" type="info">
        当前步骤：{{ stepFlowCards.find((item) => item.key === activeStepKey)?.title || '-' }}
      </el-tag>
    </div>

    <div class="grid gap-3 lg:grid-cols-4">
      <button
        v-for="step in stepFlowCards"
        :key="step.key"
        type="button"
        class="rounded-3xl border p-4 text-left transition"
        :class="[
          step.unlocked
            ? activeStepKey === step.key
              ? 'border-blue-300 bg-blue-50/80 shadow-sm dark:border-blue-400/40 dark:bg-blue-500/10'
              : 'border-slate-200/80 bg-slate-50/80 hover:border-blue-200 hover:bg-blue-50/50 dark:border-white/10 dark:bg-slate-900/20'
            : 'cursor-not-allowed border-slate-200/60 bg-slate-100/70 opacity-65 dark:border-white/10 dark:bg-slate-900/10',
        ]"
        :disabled="!step.unlocked"
        @click="emit('open-step', { stepKey: step.key, unlocked: step.unlocked })"
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-xs font-semibold text-slate-400">{{ step.order }}</p>
            <p class="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ step.title }}</p>
          </div>
          <el-tag :type="step.tagType" effect="light">
            {{ step.statusLabel }}
          </el-tag>
        </div>
        <p class="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
          {{ step.description }}
        </p>
      </button>
    </div>
  </section>
</template>
