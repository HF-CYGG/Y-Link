<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigO2oRulesSection.vue
 * 文件职责：承载系统配置页中的线上预订规则配置分区展示。
 * 实现逻辑：
 * - 父页面保留配置同步与保存；
 * - 本组件只负责渲染 O2O 规则表单，减少主页面在标签页切换时的视觉噪音。
 * 维护说明：若新增线上预订规则字段，优先在这里补齐输入控件与说明文案。
 */

defineProps<{
  o2oForm: {
    autoCancelEnabled: boolean
    autoCancelHours: number
    limitEnabled: boolean
    limitQty: number
    clientPreorderUpdateLimit: number
  }
  canUpdateConfigs: boolean
  loading: boolean
  o2oUpdatedAtLabel: string
}>()
</script>

<template>
  <div class="config-stage__panel space-y-4">
    <div class="mb-5 flex items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-white/5">
      <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">线上预订规则</h2>
      <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        默认值：24小时 / 5件 / 3次
      </span>
    </div>
    <div class="grid gap-4 md:grid-cols-2">
      <div class="space-y-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">超时自动取消</div>
        <el-switch v-model="o2oForm.autoCancelEnabled" :disabled="!canUpdateConfigs || loading" />
      </div>
      <div class="space-y-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">超时取消时长（小时）</div>
        <el-input-number
          v-model="o2oForm.autoCancelHours"
          :min="1"
          :max="168"
          :controls="false"
          :disabled="!canUpdateConfigs || loading"
          class="!w-full"
        />
      </div>
      <div class="space-y-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">全局限购开关</div>
        <el-switch v-model="o2oForm.limitEnabled" :disabled="!canUpdateConfigs || loading" />
      </div>
      <div class="space-y-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">默认限购数量</div>
        <el-input-number
          v-model="o2oForm.limitQty"
          :min="1"
          :max="999"
          :controls="false"
          :disabled="!canUpdateConfigs || loading"
          class="!w-full"
        />
      </div>
      <div class="space-y-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">客户端改单次数上限</div>
        <el-input-number
          v-model="o2oForm.clientPreorderUpdateLimit"
          :min="1"
          :max="999"
          :controls="false"
          :disabled="!canUpdateConfigs || loading"
          class="!w-full"
        />
      </div>
    </div>
    <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
      最近更新时间：{{ o2oUpdatedAtLabel }}
    </div>
  </div>
</template>
