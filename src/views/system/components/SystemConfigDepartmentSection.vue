<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigDepartmentSection.vue
 * 文件职责：承载系统配置页中的客户端部门树维护分区展示。
 * 实现逻辑：
 * - 父页面保留节点增删改、拖拽结果保存与合法性校验；
 * - 本组件只负责渲染部门树、快捷操作按钮和右侧预览区。
 * 维护说明：若部门配置新增说明或操作入口，优先在这里补齐，避免主页面继续膨胀。
 */

import dayjs from 'dayjs'
import type { ClientDepartmentConfigRecord, ClientDepartmentTreeNode } from '@/api/modules/system-config'

defineProps<{
  serialForm: {
    clientDepartmentTree: ClientDepartmentTreeNode[]
  }
  canUpdateConfigs: boolean
  loading: boolean
  saving: boolean
  selectedDepartmentNode: ClientDepartmentTreeNode | null
  clientDepartmentPreviewOptions: string[]
  clientDepartmentConfig: ClientDepartmentConfigRecord | null
  getDepartmentPathLabel: (targetId: string) => string
  handleAllowDepartmentDrop: (_draggingNode: unknown, _dropNode: unknown, type: 'prev' | 'inner' | 'next') => boolean
}>()

const emit = defineEmits<{
  (event: 'add-root'): void
  (event: 'add-child', node?: ClientDepartmentTreeNode): void
  (event: 'edit', node: ClientDepartmentTreeNode): void
  (event: 'delete', node: ClientDepartmentTreeNode): void
  (event: 'node-click', node: ClientDepartmentTreeNode): void
}>()
</script>

<template>
  <div class="config-stage__panel space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">部门配置</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          维护客户端可选部门树，支持子部门编排。客户端注册、资料编辑和后台用户编辑会从树中提取可选项。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <el-button size="small" :disabled="!canUpdateConfigs || loading || saving" @click="emit('add-root')">新增一级部门</el-button>
        <el-button size="small" :disabled="!canUpdateConfigs || loading || saving" @click="emit('add-child')">
          新增子部门
        </el-button>
      </div>
    </div>
    <el-alert
      title="填写规范"
      type="info"
      :closable="false"
      show-icon
      description="可通过拖拽调整部门层级与排序。部门名称最多 32 个字符，部门节点总数不超过 50 个，且全局不能重名。"
    />
    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div class="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-white/10 dark:bg-slate-900/20">
        <el-tree
          :data="serialForm.clientDepartmentTree"
          node-key="id"
          default-expand-all
          draggable
          :expand-on-click-node="false"
          :allow-drop="handleAllowDepartmentDrop"
          @node-click="emit('node-click', $event)"
        >
          <template #default="{ data }">
            <div class="flex w-full items-center justify-between gap-2 py-1">
              <span class="truncate text-sm text-slate-700 dark:text-slate-200">{{ getDepartmentPathLabel(data.id) || data.label }}</span>
              <div class="flex items-center gap-1">
                <el-button
                  size="small"
                  text
                  :disabled="!canUpdateConfigs || loading || saving"
                  @click.stop="emit('add-child', data)"
                >
                  子级
                </el-button>
                <el-button
                  size="small"
                  text
                  :disabled="!canUpdateConfigs || loading || saving"
                  @click.stop="emit('edit', data)"
                >
                  编辑
                </el-button>
                <el-button
                  size="small"
                  text
                  type="danger"
                  :disabled="!canUpdateConfigs || loading || saving"
                  @click.stop="emit('delete', data)"
                >
                  删除
                </el-button>
              </div>
            </div>
          </template>
        </el-tree>
      </div>
      <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 text-sm dark:border-white/10 dark:bg-slate-900/30">
        <div class="mb-2 font-medium text-slate-700 dark:text-slate-200">当前预览</div>
        <div class="mb-3 text-xs text-slate-500 dark:text-slate-400">
          当前选择：{{ selectedDepartmentNode?.label || '未选择节点' }}
        </div>
        <div class="flex flex-wrap gap-2">
          <el-tag
            v-for="department in clientDepartmentPreviewOptions"
            :key="department"
            type="info"
            effect="light"
          >
            {{ department }}
          </el-tag>
          <span v-if="clientDepartmentPreviewOptions.length === 0" class="text-xs text-slate-400">
            暂无部门选项
          </span>
        </div>
      </div>
    </div>
    <div class="border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
      最近更新时间：{{ clientDepartmentConfig?.updatedAt ? dayjs(clientDepartmentConfig.updatedAt).format('YYYY-MM-DD HH:mm:ss') : '-' }}
    </div>
  </div>
</template>
