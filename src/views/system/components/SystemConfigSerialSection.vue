<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigSerialSection.vue
 * 文件职责：按正式出库系统编号、出库业务单号、O2O 预订单号三类独立命名空间展示编号配置。
 * 实现逻辑：system/preorder 仅允许管理员在服务端安全规则下提高当前号；business 完全只读，避免把永久占用号误当作可回收流水。
 * 维护说明：固定前缀、六位宽度和并发安全规则均由后端校验，本组件只承载明确的管理操作入口。
 */

import type { OrderIdentifierConfigs, OrderIdentifierKind } from '@/api/modules/system-config'
import { PassiveNumberInput } from '@/components/common'

type EditableIdentifierKind = 'system' | 'preorder'

defineProps<{
  config: OrderIdentifierConfigs | null
  form: Record<EditableIdentifierKind, Record<'department' | 'walkin', { current: number }>>
  canUpdateConfigs: boolean
  loading: boolean
  getUpdatedAtLabel: (kind: OrderIdentifierKind, orderType: 'department' | 'walkin') => string
}>()

const ORDER_TYPE_LABELS = { department: '部门单', walkin: '散客单' } as const
const SECTION_META: Array<{ kind: OrderIdentifierKind; title: string; description: string; editable: boolean }> = [
  { kind: 'system', title: '正式出库系统编号', description: 'OUT-D / OUT-W 六位流水，仅用于管理员技术追溯。', editable: true },
  { kind: 'business', title: '出库业务单号', description: 'hyyzjd / hyyz 永久占用；仅管理员明确回收且原订单物理删除时才可复用。', editable: false },
  { kind: 'preorder', title: 'O2O 预订单号', description: 'PRE-D / PRE-W 六位流水，供核销台与客户端订单识别。', editable: true },
]
</script>

<template>
  <div class="grid gap-6 xl:grid-cols-3">
    <section v-for="section in SECTION_META" :key="section.kind" class="apple-card flex flex-col p-5 sm:p-6">
      <div class="border-b border-slate-100 pb-4 dark:border-white/5">
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">{{ section.title }}</h2>
        <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{{ section.description }}</p>
      </div>

      <div class="mt-4 space-y-4">
        <div v-for="orderType in ['department', 'walkin'] as const" :key="orderType" class="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ ORDER_TYPE_LABELS[orderType] }}</span>
            <code class="rounded bg-white px-2 py-1 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              {{ config?.[section.kind][orderType].prefix || '-' }}
            </code>
          </div>
          <p class="mt-2 text-xs text-slate-500">
            起始号 {{ config?.[section.kind][orderType].start ?? '-' }} · 位宽 {{ config?.[section.kind][orderType].width ?? '-' }}
          </p>
          <el-form-item v-if="section.editable" :prop="`${section.kind}.${orderType}.current`" class="mb-0 mt-3">
            <template #label><span class="field-label">当前号 <span class="field-label__help">只能按后端安全规则提高</span></span></template>
            <PassiveNumberInput
              v-model="form[section.kind as EditableIdentifierKind][orderType].current"
              :min="0"
              :step="1"
              :controls="false"
              :disabled="!canUpdateConfigs || loading"
              class="w-full"
            />
          </el-form-item>
          <p v-else class="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">当前号：{{ config?.[section.kind][orderType].current ?? '-' }}</p>
          <p class="mt-2 text-xs text-slate-400">最近更新：{{ getUpdatedAtLabel(section.kind, orderType) }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
