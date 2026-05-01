<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationSwitchSection.vue
 * 文件职责：承载数据库迁移助手中的“切换到 MySQL 或回退 SQLite”步骤区。
 * 实现逻辑：
 * - 父页面保留切换、回退、清空覆盖的高风险动作实现；
 * - 本组件只负责展示当前运行状态和最终操作入口。
 * 维护说明：切换类动作始终属于高风险操作，扩展时优先保持状态展示与按钮分区清晰可见。
 */

import type { DatabaseRuntimeOverrideStateResult, SQLiteToMySqlTaskRecord } from '@/api/modules/data-maintenance'

defineProps<{
  hasEnteredStepFlow: boolean
  activeStepKey: 'precheck' | 'create' | 'run' | 'switch'
  hasPreparedMysqlSwitch: boolean
  activeRuntimeModeLabel: string
  runtimeState: DatabaseRuntimeOverrideStateResult | null
  runtimeOverrideStatus: DatabaseRuntimeOverrideStateResult['runtimeOverrideStatus'] | null
  selectedSucceededTask: SQLiteToMySqlTaskRecord | null
  switchingTaskId: string
  rollbackLoading: boolean
  clearOverrideLoading: boolean
  canOperateMigration: boolean
  pageLoading: boolean
  formatDateTime: (value?: string | null) => string
  getRuntimeModeTagType: () => 'info' | 'success' | 'warning'
}>()

const emit = defineEmits<{
  (event: 'switch-task', task: SQLiteToMySqlTaskRecord): void
  (event: 'rollback'): void
  (event: 'clear-override'): void
}>()
</script>

<template>
  <section v-if="hasEnteredStepFlow && activeStepKey === 'switch'" class="apple-card space-y-5 p-5 sm:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">第 4 步：切换到 MySQL 或回退 SQLite</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          只有成功任务才建议执行切换。无论写入的是切换配置、回退配置还是清空覆盖，都应把“写入运行时覆盖”和“重启后端服务”视为同一次变更动作。
        </p>
      </div>
      <el-tag :type="hasPreparedMysqlSwitch ? 'success' : 'warning'" effect="light">
        {{ hasPreparedMysqlSwitch ? '已写入 MySQL 相关配置' : '等待最终操作' }}
      </el-tag>
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.95fr)]">
      <div class="space-y-4">
        <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-slate-900/20">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">当前运行状态</h3>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                这里同时展示“当前进程实际连接的数据库”和“运行时覆盖文件的状态”，避免把待重启状态误判为已经生效。
              </p>
            </div>
            <el-tag :type="getRuntimeModeTagType()" effect="light">
              {{ activeRuntimeModeLabel }}
            </el-tag>
          </div>

          <div class="mt-4">
            <el-descriptions :column="2" border>
              <el-descriptions-item label="实际生效数据库">
                {{ runtimeState?.effectiveDatabase?.displayName || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="当前建议动作">
                {{ runtimeState?.beginnerGuide?.recommendedAction || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="覆盖文件路径">
                {{ runtimeState?.filePath || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="覆盖文件状态">
                {{ runtimeOverrideStatus?.statusLabel || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="当前模式来源">
                {{ runtimeState?.effectiveDatabase?.sourceLabel || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="覆盖更新时间">
                {{ formatDateTime(runtimeState?.activeOverride?.updatedAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="来源任务">
                {{ runtimeState?.activeOverride?.sourceTaskId || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="切换原因">
                {{ runtimeState?.activeOverride?.reason || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="执行人">
                {{ runtimeState?.activeOverride?.updatedBy?.displayName || runtimeState?.activeOverride?.updatedBy?.username || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="可回退 SQLite">
                {{ runtimeState?.activeOverride?.rollbackConfig?.SQLITE_DB_PATH || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="覆盖目标库">
                <template v-if="runtimeState?.activeOverride?.config?.DB_TYPE === 'mysql'">
                  {{ runtimeState.activeOverride.config.DB_HOST }}:{{ runtimeState.activeOverride.config.DB_PORT }} /
                  {{ runtimeState.activeOverride.config.DB_NAME }}
                </template>
                <template v-else>
                  {{ runtimeState?.activeOverride?.config?.SQLITE_DB_PATH || '-' }}
                </template>
              </el-descriptions-item>
            </el-descriptions>
          </div>

          <div class="mt-4 space-y-3">
            <el-alert
              :title="runtimeOverrideStatus?.statusLabel || '运行时覆盖状态'"
              type="info"
              :closable="false"
              show-icon
              :description="runtimeOverrideStatus?.description || '正在读取运行时覆盖状态...'"
            />
            <el-alert
              title="重启提示"
              type="warning"
              :closable="false"
              show-icon
              description="写入数据库运行时覆盖后，仍需重启后端服务才会真正生效；若只写入配置但未重启，页面会继续显示待重启提醒。"
            />
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="rounded-2xl border border-slate-200/80 bg-white p-4 dark:border-white/10 dark:bg-slate-950/30">
          <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">最终操作面板</h3>
          <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            优先确认已选任务是否成功、迁后校验是否正常，再执行切换。若验证异常，可直接写入回退配置恢复到 SQLite。
          </p>

          <div class="mt-4 rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-900/40">
            <p class="text-xs text-slate-400">当前用于切换的任务</p>
            <p class="mt-1 break-all text-sm font-medium text-slate-700 dark:text-slate-200">
              {{ selectedSucceededTask?.id || '请先在第 3 步选中一条成功任务' }}
            </p>
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            <el-button
              type="success"
              :loading="switchingTaskId === selectedSucceededTask?.id"
              :disabled="!canOperateMigration || !selectedSucceededTask"
              @click="selectedSucceededTask && emit('switch-task', selectedSucceededTask)"
            >
              切换到所选成功任务
            </el-button>
            <el-button
              type="warning"
              :loading="rollbackLoading"
              :disabled="!canOperateMigration || pageLoading"
              @click="emit('rollback')"
            >
              回退到 SQLite
            </el-button>
            <el-button
              type="danger"
              plain
              :loading="clearOverrideLoading"
              :disabled="!canOperateMigration || pageLoading"
              @click="emit('clear-override')"
            >
              清空运行时覆盖
            </el-button>
          </div>

          <el-alert
            v-if="!selectedSucceededTask"
            class="mt-4"
            title="还没有可切换的成功任务"
            type="warning"
            :closable="false"
            show-icon
            description="请先回到第 3 步执行任务，并确认至少一条任务迁移成功后，再执行切换到 MySQL。"
          />
        </div>
      </div>
    </div>
  </section>
</template>
