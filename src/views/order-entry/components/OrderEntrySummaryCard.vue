<script setup lang="ts">
/**
 * 模块说明：src/views/order-entry/components/OrderEntrySummaryCard.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


/**
 * 底部汇总卡片：
 * - 负责展示行数、总数量、总金额；
 * - 负责承接保存按钮点击并向父层抛出 submit 事件。
 */
defineProps<{
  rowCount: number
  totalQtyText: string
  totalAmountText: string
  isPhone: boolean
  isSaving: boolean
  productsLoading: boolean
}>()

const emit = defineEmits<{
  submit: []
}>()
</script>

<template>
  <div class="apple-card p-4">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap items-center gap-6 text-sm text-slate-700 dark:text-slate-300">
        <div class="flex items-center gap-2">
          <span class="text-slate-500 dark:text-slate-400">明细行数</span>
          <span class="font-medium text-slate-800 dark:text-slate-100">{{ rowCount }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-slate-500 dark:text-slate-400">总数量</span>
          <span class="font-medium text-slate-800 dark:text-slate-100">{{ totalQtyText }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-slate-500 dark:text-slate-400">总金额</span>
          <span class="text-lg font-bold text-red-500">¥{{ totalAmountText }}</span>
        </div>
      </div>
      <el-button
        type="primary"
        size="large"
        :class="['px-8', isPhone ? 'w-full' : '']"
        :loading="isSaving"
        :disabled="productsLoading"
        @click="emit('submit')"
      >
        保存出库单
      </el-button>
    </div>
  </div>
</template>
