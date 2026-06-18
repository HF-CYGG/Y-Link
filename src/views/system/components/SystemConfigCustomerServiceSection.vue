<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigCustomerServiceSection.vue
 * 文件职责：承载系统配置页中的客服中心时间配置分区展示。
 * 实现逻辑：
 * - 父页面负责配置加载、快照比对与保存；
 * - 本组件只负责渲染客服在线时间表单和当前生效预览，降低主页面模板复杂度。
 * 维护说明：
 * - 若后续需要开放客服入口提示语、离线 FAQ 等更多字段，可继续在本组件扩展；
 * - 当前仅面向“客户端反馈页在线时间”这一用户可见配置做可视化维护。
 */

import { computed } from 'vue'

const props = defineProps<{
  customerServiceForm: {
    workdayStart: string
    workdayEnd: string
    workdayWeekdays: number[]
  }
  canUpdateConfigs: boolean
  loading: boolean
  customerServiceUpdatedAtLabel: string
}>()

const weekdayOptions = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 0 },
]

const workHoursPreview = computed(() => {
  const selectedWeekdays = weekdayOptions
    .filter((item) => props.customerServiceForm.workdayWeekdays.includes(item.value))
    .map((item) => item.label)
  if (!selectedWeekdays.length || !props.customerServiceForm.workdayStart || !props.customerServiceForm.workdayEnd) {
    return '请先补齐在线星期与开始/结束时间'
  }
  return `${selectedWeekdays.join('、')} ${props.customerServiceForm.workdayStart}-${props.customerServiceForm.workdayEnd}`
})
</script>

<template>
  <div class="config-stage__panel space-y-4">
    <div class="mb-5 flex items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-white/5">
      <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">客服中心</h2>
      <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        生效预览：{{ workHoursPreview }}
      </span>
    </div>
    <div class="grid gap-4 md:grid-cols-2">
      <div class="space-y-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">客服开始时间</div>
        <el-time-picker
          v-model="customerServiceForm.workdayStart"
          value-format="HH:mm"
          format="HH:mm"
          :clearable="false"
          :disabled="!canUpdateConfigs || loading"
          class="!w-full"
        />
      </div>
      <div class="space-y-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">客服结束时间</div>
        <el-time-picker
          v-model="customerServiceForm.workdayEnd"
          value-format="HH:mm"
          format="HH:mm"
          :clearable="false"
          :disabled="!canUpdateConfigs || loading"
          class="!w-full"
        />
      </div>
      <div class="space-y-2 md:col-span-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">客服在线星期</div>
        <el-checkbox-group v-model="customerServiceForm.workdayWeekdays" :disabled="!canUpdateConfigs || loading" class="flex flex-wrap gap-3">
          <el-checkbox v-for="item in weekdayOptions" :key="item.value" :value="item.value">
            {{ item.label }}
          </el-checkbox>
        </el-checkbox-group>
        <p class="text-xs leading-5 text-slate-400">
          这里配置的是客户端反馈页向用户展示的客服在线时间口径，保存后会同步影响反馈入口说明。
        </p>
      </div>
    </div>
    <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
      最近更新时间：{{ customerServiceUpdatedAtLabel }}
    </div>
  </div>
</template>
