<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationRunSection.vue
 * 文件职责：承载数据库迁移助手中的“执行迁移并核验结果”步骤区。
 * 实现逻辑：
 * - 父页面保留任务执行、详情刷新和权限控制；
 * - 本组件只负责展示任务表格、进度和详情信息。
 * 维护说明：任务详情字段若扩展，优先在此补齐渲染，不要把表格和详情块重新塞回父页面。
 */

import type { SQLiteToMySqlTaskRecord } from '@/api/modules/data-maintenance'

defineProps<{
  hasEnteredStepFlow: boolean
  activeStepKey: 'precheck' | 'create' | 'run' | 'switch'
  taskList: SQLiteToMySqlTaskRecord[]
  selectedTask: SQLiteToMySqlTaskRecord | null
  canOperateMigration: boolean
  taskRunningId: string
  selectedTaskProgressPercent: number
  hasSucceededTask: boolean
  formatDateTime: (value?: string | null) => string
  getTaskStatusLabel: (status: SQLiteToMySqlTaskRecord['status']) => string
  getTaskStatusTagType: (status: SQLiteToMySqlTaskRecord['status']) => string
  getTaskReadStateLabel: (readState: SQLiteToMySqlTaskRecord['readState']) => string
  getTaskReadStateTagType: (readState: SQLiteToMySqlTaskRecord['readState']) => string
}>()

const emit = defineEmits<{
  (event: 'select-task', task: SQLiteToMySqlTaskRecord): void
  (event: 'run-task', task: SQLiteToMySqlTaskRecord): void
}>()
</script>

<template>
  <section v-if="hasEnteredStepFlow && activeStepKey === 'run'" class="apple-card space-y-5 p-5 sm:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">第 3 步：执行迁移并核验结果</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          先执行任务，再确认进度、导入行数和迁后校验结果。只有成功任务才会解锁最后一步的切换动作。
        </p>
      </div>
      <div class="text-sm text-slate-500 dark:text-slate-400">
        共 {{ taskList.length }} 条任务记录
      </div>
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(340px,0.9fr)]">
      <div class="min-w-0">
        <el-table native-scrollbar
          :data="taskList"
          stripe
          border
          table-layout="auto"
          empty-text="暂无迁移任务"
          @row-click="emit('select-task', $event)"
        >
          <el-table-column label="任务 ID" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="font-mono text-xs">{{ row.id }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="getTaskStatusTagType(row.status)" effect="light">
                {{ getTaskStatusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="文件状态" width="110" align="center">
            <template #default="{ row }">
              <el-tag :type="getTaskReadStateTagType(row.readState)" effect="light">
                {{ getTaskReadStateLabel(row.readState) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="当前阶段" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ row.progress.currentStage || '-' }}</template>
          </el-table-column>
          <el-table-column label="目标库" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.target.host }}:{{ row.target.port }}/{{ row.target.database }}</template>
          </el-table-column>
          <el-table-column label="更新时间" min-width="168">
            <template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" min-width="180" fixed="right">
            <template #default="{ row }">
              <div class="flex flex-wrap gap-2">
                <el-button
                  size="small"
                  type="primary"
                  :loading="taskRunningId === row.id"
                  :disabled="!canOperateMigration || row.readState === 'corrupted' || row.status === 'running' || row.status === 'succeeded'"
                  @click.stop="emit('run-task', row)"
                >
                  执行
                </el-button>
                <el-button size="small" @click.stop="emit('select-task', row)">详情</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-slate-900/20">
        <template v-if="selectedTask">
          <div class="border-b border-slate-200/80 pb-4 dark:border-white/10">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">任务详情</h3>
                <div class="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">{{ selectedTask.id }}</div>
              </div>
              <el-tag :type="getTaskStatusTagType(selectedTask.status)" effect="light">
                {{ getTaskStatusLabel(selectedTask.status) }}
              </el-tag>
            </div>
          </div>

          <div class="mt-4 space-y-4">
            <el-alert
              v-if="selectedTask.readState === 'corrupted'"
              title="当前任务文件已损坏"
              type="error"
              :closable="false"
              show-icon
              :description="`系统当前展示的是占位记录。文件：${selectedTask.recordFilePath || selectedTask.recordFileName || '-'}；原因：${selectedTask.recordErrorMessage || selectedTask.errorMessage || '未知错误'}`"
            />

            <el-progress
              :percentage="selectedTaskProgressPercent"
              :status="selectedTask.status === 'failed' ? 'exception' : selectedTask.status === 'succeeded' ? 'success' : undefined"
            />

            <el-descriptions :column="1" border>
              <el-descriptions-item label="当前阶段">
                {{ selectedTask.progress.currentStage || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="SQLite 源路径">
                {{ selectedTask.source.sqlitePath }}
              </el-descriptions-item>
              <el-descriptions-item label="目标 MySQL">
                {{ selectedTask.target.host }}:{{ selectedTask.target.port }}/{{ selectedTask.target.database }}
              </el-descriptions-item>
              <el-descriptions-item label="创建时间">
                {{ formatDateTime(selectedTask.createdAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="开始时间">
                {{ formatDateTime(selectedTask.startedAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="完成时间">
                {{ formatDateTime(selectedTask.finishedAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="备注">
                {{ selectedTask.note || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="执行选项">
                <div class="flex flex-wrap gap-2">
                  <el-tag :type="selectedTask.options.initializeSchema ? 'success' : 'info'" effect="light">
                    {{ selectedTask.options.initializeSchema ? '初始化表结构' : '不初始化表结构' }}
                  </el-tag>
                  <el-tag :type="selectedTask.options.clearTargetBeforeImport ? 'warning' : 'info'" effect="light">
                    {{ selectedTask.options.clearTargetBeforeImport ? '导入前清空目标表' : '保留目标表原数据' }}
                  </el-tag>
                  <el-tag :type="selectedTask.options.createSqliteBackup ? 'success' : 'info'" effect="light">
                    {{ selectedTask.options.createSqliteBackup ? '执行前备份 SQLite' : '不创建 SQLite 备份' }}
                  </el-tag>
                  <el-tag :type="selectedTask.options.switchAfterSuccess ? 'warning' : 'info'" effect="light">
                    {{ selectedTask.options.switchAfterSuccess ? '成功后自动切换' : '成功后不自动切换' }}
                  </el-tag>
                </div>
              </el-descriptions-item>
              <el-descriptions-item label="SQLite 备份文件">
                {{ selectedTask.backupFile?.filePath || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="JSON 快照文件">
                {{ selectedTask.jsonSnapshotFile?.filePath || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="失败原因">
                {{ selectedTask.errorMessage || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="任务文件状态">
                <el-tag :type="getTaskReadStateTagType(selectedTask.readState)" effect="light">
                  {{ getTaskReadStateLabel(selectedTask.readState) }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="任务文件路径">
                {{ selectedTask.recordFilePath || '-' }}
              </el-descriptions-item>
            </el-descriptions>

            <div class="space-y-2">
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">迁移表结果</div>
              <el-table native-scrollbar :data="selectedTask.result?.importedTables || selectedTask.progress.tableResults" size="small" border empty-text="暂无表级结果">
                <el-table-column label="表名" prop="tableName" min-width="150" show-overflow-tooltip />
                <el-table-column label="行数" prop="rowCount" width="100" align="right" />
              </el-table>
            </div>

            <el-alert
              v-if="selectedTask.result"
              :title="`共导入 ${selectedTask.result.importedRows} 行数据，运行时覆盖状态：${selectedTask.result.runtimeOverrideApplied ? '已写入 MySQL 运行时覆盖，重启后端服务后生效' : '未自动写入运行时覆盖'}`"
              :type="selectedTask.status === 'succeeded' ? 'success' : 'info'"
              :closable="false"
              show-icon
            />

            <div v-if="selectedTask.result?.validation" class="space-y-2">
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">迁后校验结果</div>
              <el-alert
                :title="selectedTask.result.validation.passed ? '迁后关键数据校验通过' : '迁后关键数据校验未通过'"
                :description="`源库 ${selectedTask.result.validation.sourceTotalRows} 行，目标库 ${selectedTask.result.validation.targetTotalRows} 行；校验时间：${formatDateTime(selectedTask.result.validation.checkedAt)}`"
                :type="selectedTask.result.validation.passed ? 'success' : 'error'"
                :closable="false"
                show-icon
              />
              <el-table native-scrollbar :data="selectedTask.result.validation.items" size="small" border max-height="240">
                <el-table-column label="表名" prop="tableName" min-width="150" show-overflow-tooltip />
                <el-table-column label="源行数" prop="sourceRowCount" width="96" align="right" />
                <el-table-column label="目标行数" prop="targetRowCount" width="96" align="right" />
                <el-table-column label="关键表" width="88" align="center">
                  <template #default="{ row }">
                    <el-tag :type="row.blocking ? 'danger' : 'info'" effect="light">
                      {{ row.blocking ? '是' : '否' }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="结果" width="88" align="center">
                  <template #default="{ row }">
                    <el-tag :type="row.matched ? 'success' : 'danger'" effect="light">
                      {{ row.matched ? '一致' : '异常' }}
                    </el-tag>
                  </template>
                </el-table-column>
              </el-table>
            </div>

            <el-alert
              v-if="hasSucceededTask"
              title="已解锁最后一步"
              type="success"
              :closable="false"
              show-icon
              description="至少存在一条成功任务，可以进入第 4 步写入切换配置，或根据结果决定回退。"
            />
          </div>
        </template>
        <el-empty v-else description="点击左侧任务行后，可在这里查看迁移详情" />
      </div>
    </div>
  </section>
</template>
