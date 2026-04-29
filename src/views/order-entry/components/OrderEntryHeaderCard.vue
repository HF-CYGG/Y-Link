<script setup lang="ts">
/**
 * 模块说明：src/views/order-entry/components/OrderEntryHeaderCard.vue
 * 文件职责：负责渲染出库开单页的主单信息录入区域，包括订单类型、客户信息与部门单专属字段。
 * 实现逻辑：
 * 1. 订单类型始终由父层表单驱动，本组件只负责展示与输入；
 * 2. “是否有出库单 / 是否系统申请”属于部门单专属概念，散客单场景不再展示，避免误导；
 * 3. 当切回部门单时，继续展示这两项开关，由父层联动业务规则。
 */


import { InfoFilled } from '@element-plus/icons-vue'
import type { OrderHeaderForm } from '../types'

/**
 * 主单信息卡片：
 * - 负责渲染订单类型、申请属性与客户信息输入；
 * - 所有数据仍由页面 composable 持有，组件只负责渲染。
 */
defineProps<{
  model: OrderHeaderForm
  isPhone: boolean
}>()
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
          <el-input
            v-model="model.customerDepartmentName"
            maxlength="128"
            :placeholder="model.orderType === 'department' ? '必填：客户部门名称' : '选填：散客可留空'"
          />
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
