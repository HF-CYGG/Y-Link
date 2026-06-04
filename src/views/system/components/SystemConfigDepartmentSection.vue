<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/SystemConfigDepartmentSection.vue
 * 文件职责：承载系统配置页中的客户端部门树维护分区。
 * 实现逻辑：
 * - 使用 Element Plus Tree 展示真实层级，节点内只显示当前层级名称；
 * - 选中节点后在右侧面板集中展示完整路径、子部门数量和增删改操作；
 * - 节点新增、编辑、删除、拖拽排序和最终保存仍由父页面统一处理。
 * 维护说明：本组件只负责交互布局，不直接写入配置接口；调整业务校验时应优先修改父页面的树校验逻辑。
 */

import dayjs from 'dayjs'
import type { ClientDepartmentConfigRecord, ClientDepartmentTreeNode } from '@/api/modules/system-config'
import SystemConfigStaffDirectorySection from './SystemConfigStaffDirectorySection.vue'

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
  handleDepartmentNodeDrop: () => void
}>()

const emit = defineEmits<{
  (event: 'add-root'): void
  (event: 'add-child', node?: ClientDepartmentTreeNode): void
  (event: 'edit', node: ClientDepartmentTreeNode): void
  (event: 'delete', node: ClientDepartmentTreeNode): void
  (event: 'node-click', node: ClientDepartmentTreeNode): void
}>()

const treeProps = {
  children: 'children',
  label: 'label',
}
</script>

<template>
  <div class="config-stage__panel space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">部门配置</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          维护客户端可选部门树，支持多级部门编排。客户端注册、资料编辑和后台用户编辑会从树中提取可选项。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <el-button size="small" :disabled="!canUpdateConfigs || loading || saving" @click="emit('add-root')">新增一级部门</el-button>
      </div>
    </div>

    <el-alert
      title="填写规范"
      type="info"
      :closable="false"
      show-icon
      description="可通过拖拽调整部门层级与排序。部门名称最多 32 个字符，部门节点总数不超过 3000 个；同一父级下不能出现相同部门名称。"
    />

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div class="department-tree-shell rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-white/10 dark:bg-slate-900/20">
        <el-empty
          v-if="serialForm.clientDepartmentTree.length === 0"
          description="暂无部门节点"
          :image-size="96"
        >
          <el-button
            v-if="canUpdateConfigs"
            type="primary"
            size="small"
            :disabled="loading || saving"
            @click="emit('add-root')"
          >
            新增一级部门
          </el-button>
        </el-empty>
        <el-tree
          v-else
          class="department-tree"
          :data="serialForm.clientDepartmentTree"
          :props="treeProps"
          node-key="id"
          default-expand-all
          highlight-current
          :current-node-key="selectedDepartmentNode?.id"
          :draggable="canUpdateConfigs && !loading && !saving"
          :expand-on-click-node="true"
          :allow-drop="handleAllowDepartmentDrop"
          @node-click="emit('node-click', $event)"
          @node-drop="handleDepartmentNodeDrop"
        />
      </div>

      <aside class="department-selection-panel rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 text-sm dark:border-white/10 dark:bg-slate-900/30">
        <div class="mb-3">
          <div class="font-medium text-slate-700 dark:text-slate-200">当前选择</div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ selectedDepartmentNode ? '可在这里维护选中部门' : '请先在左侧树中选择一个部门节点' }}
          </p>
        </div>

        <div v-if="selectedDepartmentNode" class="department-selected-card">
          <dl class="space-y-3">
            <div>
              <dt>节点名称</dt>
              <dd>{{ selectedDepartmentNode.label }}</dd>
            </div>
            <div>
              <dt>完整路径</dt>
              <dd>{{ getDepartmentPathLabel(selectedDepartmentNode.id) || selectedDepartmentNode.label }}</dd>
            </div>
            <div>
              <dt>子部门数量</dt>
              <dd>{{ selectedDepartmentNode.children.length }} 个</dd>
            </div>
          </dl>
          <div class="department-action-grid mt-4 grid grid-cols-3 gap-2">
            <el-button
              size="small"
              :disabled="!canUpdateConfigs || loading || saving"
              @click="emit('add-child', selectedDepartmentNode)"
            >
              新增子级
            </el-button>
            <el-button
              size="small"
              :disabled="!canUpdateConfigs || loading || saving"
              @click="emit('edit', selectedDepartmentNode)"
            >
              编辑
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :disabled="!canUpdateConfigs || loading || saving"
              @click="emit('delete', selectedDepartmentNode)"
            >
              删除
            </el-button>
          </div>
        </div>
        <div v-else class="department-selected-empty">
          <span>未选择节点</span>
        </div>

        <div class="mt-4 border-t border-slate-200/70 pt-4 dark:border-white/10">
          <div class="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">全部可选部门</div>
          <div class="department-preview-tags">
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
      </aside>
    </div>

    <div class="border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-white/5 dark:text-slate-500">
      最近更新时间：{{ clientDepartmentConfig?.updatedAt ? dayjs(clientDepartmentConfig.updatedAt).format('YYYY-MM-DD HH:mm:ss') : '-' }}
    </div>

    <SystemConfigStaffDirectorySection :can-update-configs="canUpdateConfigs" :loading="loading || saving" />
  </div>
</template>

<style scoped>
.department-tree-shell {
  min-width: 0;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}

.department-tree {
  min-width: 280px;
  --el-tree-node-hover-bg-color: #f1f5f9;
}

.department-tree :deep(.el-tree-node__content) {
  box-sizing: border-box;
  height: auto;
  min-height: 38px;
  padding-block: 4px;
  border-radius: 8px;
}

.department-tree :deep(.el-tree-node__label) {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.45;
  color: #334155;
  font-size: 14px;
}

.department-tree :deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: #eef2f7;
}

.department-tree :deep(.el-tree-node.is-current > .el-tree-node__content .el-tree-node__label) {
  color: #075e59;
  font-weight: 700;
}

.department-tree :deep(.el-tree-node__expand-icon) {
  color: #94a3b8;
}

.department-selection-panel {
  min-width: 0;
}

.department-selected-card {
  border-radius: 14px;
  background: #fff;
  padding: 14px;
  box-shadow: inset 0 0 0 1px rgba(226, 232, 240, 0.9);
}

.department-selected-card dt {
  color: #94a3b8;
  font-size: 12px;
}

.department-selected-card dd {
  margin-top: 3px;
  color: #0f172a;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.department-selected-empty {
  display: flex;
  min-height: 120px;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  border: 1px dashed #cbd5e1;
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.72);
}

.department-preview-tags {
  display: flex;
  max-height: 260px;
  flex-wrap: wrap;
  gap: 8px;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}

.dark .department-tree {
  --el-tree-node-hover-bg-color: rgba(15, 23, 42, 0.78);
}

.dark .department-tree :deep(.el-tree-node__label) {
  color: #cbd5e1;
}

.dark .department-tree :deep(.el-tree-node.is-current > .el-tree-node__content) {
  background: rgba(20, 184, 166, 0.14);
}

.dark .department-tree :deep(.el-tree-node.is-current > .el-tree-node__content .el-tree-node__label) {
  color: #5eead4;
}

.dark .department-selected-card {
  background: rgba(15, 23, 42, 0.68);
  box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.18);
}

.dark .department-selected-card dd {
  color: #f8fafc;
}

.dark .department-selected-empty {
  border-color: rgba(148, 163, 184, 0.3);
  background: rgba(15, 23, 42, 0.48);
}

@media (max-width: 640px) {
  .department-tree-shell,
  .department-selection-panel {
    padding: 12px;
  }

  .department-tree {
    min-width: 0;
  }

  .department-tree :deep(.el-tree-node__content) {
    min-height: 40px;
  }

  .department-action-grid {
    grid-template-columns: 1fr;
  }

  .department-preview-tags {
    max-height: 180px;
  }
}
</style>
