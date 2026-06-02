<script setup lang="ts">
/**
 * 模块说明：src/views/order-entry/components/OrderEntrySummaryCard.vue
 * 文件职责：负责开单页底部汇总卡片，集中展示商品行数、总数量、总金额以及提交动作入口。
 * 实现逻辑：
 * - 组件只负责汇总数据展示与按钮交互透传，不直接参与订单提交流程；
 * - 汇总口径保持和明细编辑区一致，确保桌面端、移动端与最终提交参数看到的是同一份结果。
 * 维护说明：
 * - 若后续增加优惠、运费或税额等字段，需要同步检查汇总展示与提交前校验提示；
 * - 提交按钮的可用态应继续由父层统一控制，避免本组件私自加入业务判断。
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
