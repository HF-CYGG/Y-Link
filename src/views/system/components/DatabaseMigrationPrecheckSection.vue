<script setup lang="ts">
/**
 * 模块说明：src/views/system/components/DatabaseMigrationPrecheckSection.vue
 * 文件职责：承载数据库迁移助手中的“预检目标 MySQL”步骤区。
 * 实现逻辑：
 * - 父页面保留预检请求、目标参数校验与结果落盘；
 * - 本组件只负责展示表单、预检结果和问题说明。
 * 维护说明：预检结果字段若调整，优先同步这里的展示块，再回看父页面的状态计算。
 */

import type { DatabaseMigrationIssue, DatabaseMigrationTableStat, SQLiteToMySqlPrecheckResult } from '@/api/modules/data-maintenance'

type MigrationFormState = {
  target: {
    host: string
    port: number
    user: string
    password: string
    database: string
    dbSync?: boolean
  }
  allowTargetWithData: boolean
  initializeSchema: boolean
  clearTargetBeforeImport: boolean
  switchAfterSuccess: boolean
  createSqliteBackup: boolean
  note: string
}

defineProps<{
  hasEnteredStepFlow: boolean
  activeStepKey: 'precheck' | 'create' | 'run' | 'switch'
  pageLoading: boolean
  precheckLoading: boolean
  precheckResult: SQLiteToMySqlPrecheckResult | null
  migrationForm: MigrationFormState
  formatDateTime: (value?: string | null) => string
  formatTableSummary: (tables: DatabaseMigrationTableStat[]) => string
  getIssueTagType: (level: DatabaseMigrationIssue['level']) => string
  getIssuePlainLanguage: (issue: DatabaseMigrationIssue) => string
}>()

const emit = defineEmits<{
  (event: 'precheck'): void
}>()
</script>

<template>
  <section v-if="hasEnteredStepFlow && activeStepKey === 'precheck'" class="apple-card space-y-5 p-5 sm:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4 dark:border-white/5">
      <div>
        <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">第 1 步：填写目标 MySQL 并执行预检</h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          先用真实目标库信息做预检。只有预检通过后，系统才会解锁任务创建与执行区。
        </p>
      </div>
      <el-tag v-if="precheckResult" :type="precheckResult.canProceed ? 'success' : 'danger'" effect="light">
        {{ precheckResult.canProceed ? '预检通过' : '存在阻断问题' }}
      </el-tag>
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div class="space-y-5">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2 sm:col-span-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">主机地址</div>
            <el-input v-model="migrationForm.target.host" placeholder="例如：127.0.0.1 或 mysql.internal" />
          </div>
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">端口</div>
            <el-input-number v-model="migrationForm.target.port" :min="1" :max="65535" :controls="false" class="!w-full" />
          </div>
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">用户名</div>
            <el-input v-model="migrationForm.target.user" placeholder="请输入 MySQL 用户名" />
          </div>
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">密码</div>
            <el-input v-model="migrationForm.target.password" type="password" show-password placeholder="请输入 MySQL 密码" />
          </div>
          <div class="space-y-2">
            <div class="text-sm text-slate-600 dark:text-slate-300">数据库名</div>
            <el-input v-model="migrationForm.target.database" placeholder="请输入目标库名称" />
          </div>
        </div>

        <div class="grid gap-3 rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-slate-900/20">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">允许目标库已有业务数据</div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">若目标 MySQL 中已有业务表数据，预检会转为高风险提示</div>
            </div>
            <el-switch v-model="migrationForm.allowTargetWithData" />
          </div>
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">初始化目标表结构</div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">推荐开启，让后端按实体结构初始化目标 MySQL</div>
            </div>
            <el-switch v-model="migrationForm.initializeSchema" />
          </div>
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">导入前清空目标业务表</div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">仅在确认目标库可覆盖时开启，避免残留旧数据</div>
            </div>
            <el-switch v-model="migrationForm.clearTargetBeforeImport" />
          </div>
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">执行前创建 SQLite 物理备份</div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">该项为固定开启，用于与 JSON 快照组成双重备份，保障回退安全</div>
            </div>
            <el-switch v-model="migrationForm.createSqliteBackup" disabled />
          </div>
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">迁移成功后自动切换到 MySQL</div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">写入切换配置后，仍需重启后端服务才会真正生效</div>
            </div>
            <el-switch v-model="migrationForm.switchAfterSuccess" />
          </div>
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">目标库启用 Schema 同步</div>
              <div class="mt-1 text-xs text-slate-500 dark:text-slate-400">仅在你明确知道该环境允许自动同步结构时再开启</div>
            </div>
            <el-switch v-model="migrationForm.target.dbSync" />
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-sm text-slate-600 dark:text-slate-300">迁移备注</div>
          <el-input
            v-model="migrationForm.note"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="例如：测试环境切换到 4 月份新建 MySQL，用于验证订单与商品数据"
          />
        </div>

        <div class="flex flex-wrap gap-2">
          <el-button type="primary" :loading="precheckLoading" :disabled="pageLoading" @click="emit('precheck')">
            执行预检
          </el-button>
        </div>
      </div>

      <div class="space-y-4">
        <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-white/10 dark:bg-slate-900/20">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="text-base font-semibold text-slate-800 dark:text-slate-100">最近一次预检结果</h3>
              <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                预检会同时校验 SQLite 源文件、MySQL 连通性、目标业务表状态与当前运行时覆盖风险。
              </p>
            </div>
            <el-tag v-if="precheckResult" :type="precheckResult.canProceed ? 'success' : 'danger'" effect="light">
              {{ precheckResult.canProceed ? '允许继续' : '需先处理问题' }}
            </el-tag>
          </div>

          <div v-if="precheckResult" class="mt-4 space-y-4">
            <el-descriptions :column="2" border>
              <el-descriptions-item label="预检时间">
                {{ formatDateTime(precheckResult.checkedAt) }}
              </el-descriptions-item>
              <el-descriptions-item label="SQLite 文件存在">
                {{ precheckResult.source.sqliteFileExists ? '是' : '否' }}
              </el-descriptions-item>
              <el-descriptions-item label="SQLite 路径">
                {{ precheckResult.source.sqlitePath }}
              </el-descriptions-item>
              <el-descriptions-item label="SQLite 文件大小">
                {{ precheckResult.source.sqliteFileSizeBytes }} Bytes
              </el-descriptions-item>
              <el-descriptions-item label="SQLite 数据量">
                {{ formatTableSummary(precheckResult.source.tables) }}
              </el-descriptions-item>
              <el-descriptions-item label="MySQL 连通性">
                {{ precheckResult.target.reachable ? '可连接' : '不可连接' }}
              </el-descriptions-item>
              <el-descriptions-item label="MySQL 版本">
                {{ precheckResult.target.version || '-' }}
              </el-descriptions-item>
              <el-descriptions-item label="目标库">
                {{ precheckResult.target.host }}:{{ precheckResult.target.port }} / {{ precheckResult.target.database }}
              </el-descriptions-item>
              <el-descriptions-item label="数据库已存在">
                {{ precheckResult.target.databaseExists ? '是' : '否' }}
              </el-descriptions-item>
              <el-descriptions-item label="目标表结构状态">
                {{
                  precheckResult.target.schemaReady
                    ? '已齐全'
                    : precheckResult.target.needsSchemaInitialization
                      ? '缺表，可由迁移任务初始化'
                      : '待确认'
                }}
              </el-descriptions-item>
              <el-descriptions-item label="目标业务表">
                {{ formatTableSummary(precheckResult.target.existingAppTables) }}
              </el-descriptions-item>
            </el-descriptions>

            <div class="space-y-2">
              <div class="text-sm font-medium text-slate-700 dark:text-slate-200">预检问题</div>
              <div class="flex flex-wrap gap-2">
                <el-tag
                  v-for="issue in precheckResult.issues"
                  :key="`${issue.level}-${issue.code}-${issue.message}`"
                  :type="getIssueTagType(issue.level)"
                  effect="light"
                >
                  {{ issue.code }}
                </el-tag>
                <span v-if="precheckResult.issues.length === 0" class="text-sm text-slate-500 dark:text-slate-400">
                  未发现额外风险项
                </span>
              </div>
              <div
                v-if="precheckResult.source.missingTables.length || precheckResult.target.missingAppTables.length"
                class="grid gap-3 md:grid-cols-2"
              >
                <el-alert
                  v-if="precheckResult.source.missingTables.length"
                  :title="`SQLite 缺少业务表：${precheckResult.source.missingTables.join('、')}`"
                  type="error"
                  :closable="false"
                  show-icon
                />
                <el-alert
                  v-if="precheckResult.target.missingAppTables.length"
                  :title="`目标 MySQL 缺少业务表：${precheckResult.target.missingAppTables.join('、')}`"
                  :type="precheckResult.target.schemaReady ? 'success' : 'info'"
                  :closable="false"
                  show-icon
                />
              </div>
              <div class="space-y-2">
                <el-alert
                  v-for="issue in precheckResult.issues"
                  :key="`${issue.code}-${issue.message}`"
                  :title="issue.message"
                  :description="getIssuePlainLanguage(issue)"
                  :type="issue.level === 'error' ? 'error' : issue.level === 'warning' ? 'warning' : 'info'"
                  :closable="false"
                  show-icon
                />
              </div>
            </div>
          </div>

          <el-empty v-else description="尚未执行预检，请先填写目标 MySQL 信息并点击“执行预检”" />
        </div>
      </div>
    </div>
  </section>
</template>
