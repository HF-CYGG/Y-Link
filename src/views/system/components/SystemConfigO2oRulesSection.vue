<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigO2oRulesSection.vue
 * 文件职责：渲染系统配置页中的 O2O 规则配置表单。
 * 实现逻辑：
 * - 父页面负责加载、保存和审计接口调用，本组件只承载规则字段输入；
 * - 规则字段覆盖超时取消、限购、客户端改单次数、店铺营业时段、取货地址和商城公告；
 * - 商城公告允许保存为空，客户端据此隐藏公告区域。
 * 维护说明：
 * - 新增 O2O 公开配置时优先在此处补齐输入控件，并同步 system-config API 类型。
 */

import { PassiveNumberInput } from '@/components/common'
import { DEFAULT_STORE_PICKUP_ADDRESS, type StoreBusinessPeriod } from '@/utils/store-business-hours'

defineProps<{
  o2oForm: {
    autoCancelEnabled: boolean
    autoCancelHours: number
    limitEnabled: boolean
    limitQty: number
    clientPreorderUpdateLimit: number
    storeBusinessHoursText: string
    businessPeriods: StoreBusinessPeriod[] | null
    storePickupAddress: string
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
      <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-white/10 dark:text-slate-400">
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
        <div class="text-sm text-slate-600 dark:text-slate-300">店铺营业时段</div>
        <template v-if="o2oForm.businessPeriods">
          <div
            v-for="(period, index) in o2oForm.businessPeriods"
            :key="index"
            class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 sm:max-w-lg"
          >
            <el-time-picker
              v-model="period.open"
              :aria-label="`第 ${index + 1} 段开始时间`"
              placeholder="开始时间"
              format="HH:mm"
              value-format="HH:mm"
              :clearable="false"
              :disabled="!canUpdateConfigs || loading"
              class="!w-full !min-w-0"
            />
            <el-time-picker
              v-model="period.close"
              :aria-label="`第 ${index + 1} 段结束时间`"
              placeholder="结束时间"
              format="HH:mm"
              value-format="HH:mm"
              :clearable="false"
              :disabled="!canUpdateConfigs || loading"
              class="!w-full !min-w-0"
            />
            <el-button
              :aria-label="`移除第 ${index + 1} 段`"
              :disabled="!canUpdateConfigs || loading || o2oForm.businessPeriods.length === 1"
              @click="o2oForm.businessPeriods?.splice(index, 1)"
            >移除</el-button>
          </div>
          <el-button :disabled="!canUpdateConfigs || loading" @click="o2oForm.businessPeriods?.push({ open: '', close: '' })">
            添加时段
          </el-button>
          <p class="text-xs leading-5 text-slate-400">每段至少 30 分钟，可首尾相接，保存时按开始时间排列。</p>
        </template>
        <template v-else>
          <p class="break-words text-sm text-slate-600 dark:text-slate-300">当前营业说明：{{ o2oForm.storeBusinessHoursText }}</p>
          <el-button
            :disabled="!canUpdateConfigs || loading"
            @click="o2oForm.businessPeriods = [{ open: '', close: '' }]"
          >设置新时段</el-button>
        </template>
      </div>

      <div class="space-y-2 md:col-span-2">
        <div class="text-sm text-slate-600 dark:text-slate-300">取货地址</div>
        <el-input
          v-model="o2oForm.storePickupAddress"
          aria-label="取货地址"
          maxlength="100"
          show-word-limit
          :disabled="!canUpdateConfigs || loading"
          :placeholder="`留空使用${DEFAULT_STORE_PICKUP_ADDRESS}`"
        />
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
