<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigSerialSection.vue
 * 文件职责：承载系统配置页中的订单流水配置分区展示。
 * 实现逻辑：
 * - 父页面保留配置加载、保存与权限判断；
 * - 本组件只负责渲染部门单与散客单两组流水号表单，减少主页面模板长度。
 * 维护说明：若订单流水新增字段，优先在这里补齐展示，再回到父页面同步保存逻辑。
 */

import type { OrderSerialConfigRecord } from '@/api/modules/system-config'

defineProps<{
  configMap: Record<'department' | 'walkin', OrderSerialConfigRecord> | null
  departmentPreview: string
  walkinPreview: string
  serialForm: {
    department: {
      start: number
      current: number
      width: number
    }
    walkin: {
      start: number
      current: number
      width: number
    }
  }
  canUpdateConfigs: boolean
  loading: boolean
  getUpdatedAtLabel: (orderType: 'department' | 'walkin') => string
}>()
</script>

<template>
  <div class="config-stage__panel grid gap-6 lg:grid-cols-2">
    <div class="apple-card flex flex-col p-5 sm:p-6 xl:p-7">
      <div class="mb-5 flex items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-white/5">
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">部门订单流水</h2>
        <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          前缀：{{ configMap?.department.prefix || 'hyyzjd' }}
        </span>
      </div>
      <div class="grid flex-1 gap-5">
        <div class="rounded-xl border border-teal-200/60 bg-teal-50/50 p-4 text-teal-800 dark:border-teal-900/40 dark:bg-teal-900/10 dark:text-teal-300">
          <div class="text-xs font-medium opacity-80">订单编号示例（下一单）</div>
          <div class="mt-1.5 text-lg font-bold tracking-wide">{{ departmentPreview }}</div>
        </div>
        <div class="space-y-4">
          <el-form-item prop="department.start" class="!mb-0">
            <template #label>
              <span class="field-label">起始号 <span class="field-label__help">首次生效编号起点</span></span>
            </template>
            <el-input-number v-model="serialForm.department.start" :min="1" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
          <el-form-item prop="department.current" class="!mb-0">
            <template #label>
              <span class="field-label">当前号 <span class="field-label__help">系统自动维护，仅展示不可编辑</span></span>
            </template>
            <el-input :model-value="String(serialForm.department.current)" disabled class="!w-full" />
          </el-form-item>
          <el-form-item prop="department.width" class="!mb-0">
            <template #label>
              <span class="field-label">位宽 <span class="field-label__help">流水号补零位数（1-12）</span></span>
            </template>
            <el-input-number v-model="serialForm.department.width" :min="1" :max="12" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
        </div>
      </div>
      <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
        最近更新时间：{{ getUpdatedAtLabel('department') }}
      </div>
    </div>

    <div class="apple-card flex flex-col p-5 sm:p-6 xl:p-7">
      <div class="mb-5 flex items-center justify-between gap-2 border-b border-slate-100 pb-4 dark:border-white/5">
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">散客订单流水</h2>
        <span class="rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          前缀：{{ configMap?.walkin.prefix || 'hyyz' }}
        </span>
      </div>
      <div class="grid flex-1 gap-5">
        <div class="rounded-xl border border-sky-200/60 bg-sky-50/50 p-4 text-sky-800 dark:border-sky-900/40 dark:bg-sky-900/10 dark:text-sky-300">
          <div class="text-xs font-medium opacity-80">订单编号示例（下一单）</div>
          <div class="mt-1.5 text-lg font-bold tracking-wide">{{ walkinPreview }}</div>
        </div>
        <div class="space-y-4">
          <el-form-item prop="walkin.start" class="!mb-0">
            <template #label>
              <span class="field-label">起始号 <span class="field-label__help">首次生效编号起点</span></span>
            </template>
            <el-input-number v-model="serialForm.walkin.start" :min="1" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
          <el-form-item prop="walkin.current" class="!mb-0">
            <template #label>
              <span class="field-label">当前号 <span class="field-label__help">系统自动维护，仅展示不可编辑</span></span>
            </template>
            <el-input :model-value="String(serialForm.walkin.current)" disabled class="!w-full" />
          </el-form-item>
          <el-form-item prop="walkin.width" class="!mb-0">
            <template #label>
              <span class="field-label">位宽 <span class="field-label__help">流水号补零位数（1-12）</span></span>
            </template>
            <el-input-number v-model="serialForm.walkin.width" :min="1" :max="12" :step="1" :controls="false" :disabled="!canUpdateConfigs || loading" class="!w-full" />
          </el-form-item>
        </div>
      </div>
      <div class="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
        最近更新时间：{{ getUpdatedAtLabel('walkin') }}
      </div>
    </div>
  </div>
</template>
