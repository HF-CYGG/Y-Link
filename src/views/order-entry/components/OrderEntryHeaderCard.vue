<script setup lang="ts">
import type { OrderHeaderForm } from '../types'

/**
 * 主单信息卡片：
 * - 仅负责展示客户名称与整单备注输入；
 * - 所有数据仍由页面 composable 持有，组件只负责渲染。
 */
defineProps<{
  model: OrderHeaderForm
  isPhone: boolean
}>()
</script>

<template>
  <div class="apple-card p-4">
    <div class="mb-4 flex items-center rounded-md border-l-4 border-brand bg-slate-50 px-3 py-2 dark:border-teal-400 dark:bg-[#1f1f21]">
      <span class="ml-2 font-medium text-slate-800 dark:text-slate-100">主单信息</span>
    </div>
    <el-form :model="model" :label-width="isPhone ? '80px' : '88px'">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
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
