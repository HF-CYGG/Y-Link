<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigO2oRulesSection.vue
 * 文件职责：渲染系统配置页中的 O2O 规则配置表单。
 * 实现逻辑：
 * - 父页面负责加载、保存和审计接口调用，本组件只承载规则字段输入；
 * - 规则字段覆盖超时取消、限购、客户端改单次数、店铺营业时间和商城公告；
 * - 商城公告允许保存为空，客户端据此隐藏公告区域。
 * 维护说明：
 * - 新增 O2O 公开配置时优先在此处补齐输入控件，并同步 system-config API 类型。
 */

import { PassiveNumberInput } from '@/components/common'

defineProps<{
  o2oForm: {
    autoCancelEnabled: boolean
    autoCancelHours: number
    limitEnabled: boolean
    limitQty: number
    clientPreorderUpdateLimit: number
    storeBusinessHoursText: string
    mallAnnouncementText: string
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
        <PassiveNumberInput
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
        <PassiveNumberInput
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
        <PassiveNumberInput
          v-model="o2oForm.clientPreorderUpdateLimit"
          :min="1"
          :max="999"
          :controls="false"
          :disabled="!canUpdateConfigs || loading"
          class="!w-full"
        />
      </div>

      <div class="space-y-2 md:col-span-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">店铺营业时间</div>
        <el-input
          v-model="o2oForm.storeBusinessHoursText"
          maxlength="100"
          show-word-limit
          :disabled="!canUpdateConfigs || loading"
          placeholder="例如：9:30 - 21:30"
        />
        <p class="text-xs leading-5 text-slate-400">该文案会展示在客户端商城首页和订单详情取货时段。</p>
      </div>

      <div class="space-y-2 md:col-span-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">商城公告</div>
        <el-input
          v-model="o2oForm.mallAnnouncementText"
          type="textarea"
          :rows="3"
          resize="vertical"
          maxlength="500"
          show-word-limit
          :disabled="!canUpdateConfigs || loading"
          placeholder="留空后客户端隐藏公告块"
        />
        <p class="text-xs leading-5 text-slate-400">公告会展示在客户端商城首页；保存为空时不显示公告区域。</p>
      </div>
    </div>

    <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
      最近更新时间：{{ o2oUpdatedAtLabel }}
    </div>
  </div>
</template>
