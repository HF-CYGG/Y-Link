<script setup lang="ts">
/**
 * 模块说明：src/views/order-entry/components/OrderEntryHeaderCard.vue
 * 文件职责：负责渲染出库开单页的主单信息录入区域，包括订单类型、客户信息与部门单专属字段。
 * 实现逻辑：
 * 1. 订单类型始终由父层表单驱动，本组件只负责展示与输入；
 * 2. “是否有出库单 / 是否系统申请”属于部门单专属概念，散客单场景不再展示，避免误导；
 * 3. 当切回部门单时，继续展示这两项开关，由父层联动业务规则；
 * 4. “客户部门”为可搜索、可选择、可手动录入的组合输入：选项来自系统部门配置，按完整路径展示与搜索，
 *    手动录入的名称只作为当前订单的部门快照，不会写入系统配置；散客单时禁用。
 * 维护说明：
 * - 选项加载、节点推导与提交兜底都在 `useOrderEntryForm` 中完成，本组件不直接请求接口；
 * - 加载失败、配置为空时只做提示，不能阻断手动录入。
 */


import { computed } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import type { OrderDepartmentOption } from '@/api/modules/order'
import type { OrderHeaderForm } from '../types'

/**
 * 主单信息卡片：
 * - 负责渲染订单类型、申请属性与客户信息输入；
 * - 所有数据仍由页面 composable 持有，组件只负责渲染。
 */
const props = defineProps<{
  model: OrderHeaderForm
  isPhone: boolean
  departmentOptions: OrderDepartmentOption[]
  departmentOptionsLoading: boolean
  departmentOptionsLoadFailed: boolean
}>()

const isDepartmentOrder = computed(() => props.model.orderType === 'department')

/**
 * 下拉选项按完整路径去重：
 * - 路径是订单实际保存的部门快照，也是展示与搜索文本（已包含节点名称）；
 * - 标签含 `-` 时不同节点可能拼出相同路径，去重后由父层按“唯一命中”规则决定是否携带节点。
 */
const departmentPathOptions = computed(() => {
  const seen = new Set<string>()
  return props.departmentOptions.filter((option) => {
    if (seen.has(option.path)) return false
    seen.add(option.path)
    return true
  })
})

/** 部门输入下方的状态提示：仅部门单展示，按加载失败 > 配置为空 > 未匹配配置的优先级。 */
const departmentHint = computed(() => {
  if (!isDepartmentOrder.value || props.departmentOptionsLoading) return ''
  if (props.departmentOptionsLoadFailed) return '部门选项加载失败，可直接手动填写'
  if (!props.departmentOptions.length) return '系统暂无部门配置，可直接手动填写'
  if (props.model.customerDepartmentName.trim() && !props.model.customerDepartmentNodeId) {
    return '未匹配系统部门，将按手动填写保存，不会写入系统配置'
  }
  return ''
})
</script>

<template>
  <div class="apple-card p-3 sm:p-4 xl:p-5">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5 dark:border-white/10 dark:bg-[#1f1f21]">
      <span class="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
        <span class="inline-block h-2 w-2 rounded-full bg-brand" />
        <span>主单信息</span>
      </span>
      <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span class="rounded-full bg-white px-2.5 py-1 dark:bg-white/10">支持临时离页草稿保留</span>
        <span class="rounded-full bg-white px-2.5 py-1 dark:bg-white/10">建议先录客户，再录明细</span>
      </div>
    </div>
    <el-form :model="model" label-width="120px" class="flex-1" :class="{ 'px-2': isPhone }">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <el-form-item label="订单类型" class="mb-0">
          <el-radio-group v-model="model.orderType">
            <el-radio-button label="散客单" value="walkin" />
            <el-radio-button label="部门单" value="department" />
          </el-radio-group>
        </el-form-item>
        <el-form-item label="出单人" class="mb-0">
          <el-input v-model="model.issuerName" maxlength="64" placeholder="必填：出单人姓名" />
        </el-form-item>
        <el-form-item v-if="model.orderType === 'department'" class="mb-0">
          <template #label>
            <div class="flex items-center gap-1">
              是否有出库单
              <el-tooltip content="用于标记客户是否携带已走完学校财务流程的出库凭单来取货" placement="top">
                <el-icon class="text-slate-400"><InfoFilled /></el-icon>
              </el-tooltip>
            </div>
          </template>
          <el-switch v-model="model.hasCustomerOrder" />
        </el-form-item>
        <el-form-item v-if="model.orderType === 'department'" class="mb-0">
          <template #label>
            <div class="flex items-center gap-1">
              是否系统申请
              <el-tooltip content="用于标记该笔出库是否已在学校/企业系统内完成审批申请" placement="top">
                <el-icon class="text-slate-400"><InfoFilled /></el-icon>
              </el-tooltip>
            </div>
          </template>
          <el-switch v-model="model.isSystemApplied" />
        </el-form-item>
        <el-form-item v-else class="mb-0">
          <template #label>
            <div class="flex items-center gap-1">
              出库单说明
              <el-tooltip content="散客单不需要正式出库单，也不需要填写财务/系统申请状态" placement="top">
                <el-icon class="text-slate-400"><InfoFilled /></el-icon>
              </el-tooltip>
            </div>
          </template>
          <div class="w-full rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
            当前为散客单，无需维护正式出库单相关状态。
          </div>
        </el-form-item>
        <el-form-item label="客户部门" class="mb-0">
          <el-select
            v-model="model.customerDepartmentName"
            class="w-full"
            filterable
            allow-create
            default-first-option
            clearable
            :disabled="!isDepartmentOrder"
            :loading="departmentOptionsLoading"
            :placeholder="isDepartmentOrder ? '必填：搜索选择或直接输入客户部门' : '散客单无需填写'"
            no-data-text="暂无部门配置，可直接输入"
          >
            <el-option
              v-for="option in departmentPathOptions"
              :key="option.path"
              :label="option.path"
              :value="option.path"
            />
          </el-select>
          <p v-if="departmentHint" class="mt-1 w-full text-xs text-slate-500 dark:text-slate-400">
            {{ departmentHint }}
          </p>
        </el-form-item>
        <el-form-item label="客户名称" class="mb-0">
          <el-input v-model="model.customerName" maxlength="64" placeholder="选填：客户名称" />
        </el-form-item>
        <el-form-item label="整单备注" class="mb-0">
          <el-input v-model="model.remark" maxlength="255" placeholder="选填：整单备注" />
        </el-form-item>
      </div>
    </el-form>
  </div>
</template>
