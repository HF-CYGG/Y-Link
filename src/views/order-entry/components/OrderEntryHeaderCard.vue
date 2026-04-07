<script setup lang="ts">
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
    <el-form :model="model" :label-width="isPhone ? '80px' : '88px'">
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
        <el-form-item label="客户订单" class="mb-0">
          <el-switch v-model="model.hasCustomerOrder" />
        </el-form-item>
        <el-form-item label="系统申请" class="mb-0">
          <el-switch v-model="model.isSystemApplied" />
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
