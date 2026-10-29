/** 文件职责：验证一键自动迁移失败诊断的归类、数据安全判定、表/列提取与兜底说明，防止原始报错被误归类或误报“数据安全”。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const source = fs.readFileSync('src/views/system/database-migration-failure.ts', 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const module = { exports: {} }
new Function('require', 'module', 'exports', code)(() => ({}), module, module.exports)
const { diagnoseAutomaticMigrationFailure } = module.exports

const base = {
  id: 'automatic-demo',
  mode: 'automatic',
  status: 'failed',
  stage: 'import',
  readState: 'healthy',
  progress: { currentStage: '自动迁移失败，已恢复正常写入', tableResults: [] },
}
const diagnose = (over, options) => diagnoseAutomaticMigrationFailure({ ...base, ...over, progress: { ...base.progress, ...(over.progress ?? {}) } }, options)

const cases = [
  [{ errorMessage: "表 sys_audit_log 导入失败（第 3 批）：Data too long for column 'user_agent' at row 1" }, 'data_too_long'],
  [{ errorMessage: "Access denied for user 'ylink'@'172.18.0.3' (using password: YES)" }, 'target_auth_failed'],
  [{ errorMessage: 'connect ECONNREFUSED 127.0.0.1:3306' }, 'target_unreachable'],
  [{ errorMessage: '目标 MySQL 账号缺少自动迁移权限：TRIGGER、ALTER' }, 'target_privilege_missing'],
  [{ errorMessage: '一键自动迁移只允许独立空库，当前已存在表：orders' }, 'target_not_empty'],
  [{ errorMessage: '目标 MySQL 数据库不存在，请由运维预先创建独立空库' }, 'target_database_missing'],
  [{ errorMessage: '一键自动迁移要求 MySQL 8.0.16+，当前版本为 5.7.44' }, 'target_incompatible'],
  [{ errorMessage: "Duplicate entry '12' for key 'PRIMARY'" }, 'data_duplicate'],
  [{ errorMessage: 'ENOSPC: no space left on device, write' }, 'disk_full'],
  [{ errorMessage: 'Connection lost: The server closed the connection. PROTOCOL_CONNECTION_LOST' }, 'connection_lost'],
  [{ errorMessage: '迁后关键数据校验未通过，已禁止切换到目标 MySQL' }, 'validation_failed'],
  [{ errorMessage: 'SQLite 源库存在 3 条外键完整性异常' }, 'source_integrity'],
  [{ errorMessage: '自动迁移进程连续中断，已达到最多两次续跑限制', progress: { currentStage: '自动续跑次数已耗尽，已恢复 SQLite 正常写入' } }, 'resume_exhausted'],
  [{ errorMessage: 'boom', progress: { currentStage: '自动迁移已由管理员取消，正在执行紧急回退' } }, 'cancelled'],
]
for (const [over, category] of cases) {
  const result = diagnose(over)
  assert.equal(result.category, category, `${over.errorMessage} 应归类为 ${category}，实际 ${result.category}`)
  assert.ok(result.suggestions.length > 0, `${category} 必须给出处理建议`)
  assert.ok(result.summary && result.categoryLabel, `${category} 必须给出白话说明与类别名`)
}

// 表名取自后端包装文案，列名取自 MySQL 原始报错，二者不能混用。
const tooLong = diagnose(cases[0][0])
assert.equal(tooLong.affectedTable, 'sys_audit_log')
assert.equal(tooLong.affectedColumn, 'user_agent')
assert.equal(diagnose({ errorMessage: "Data too long for column 'note' at row 1" }).affectedTable, '', '无表名包装时不得把列名当表名')

// 系统仍只读优先于报错正文中的其它关键词，且数据安全判定为 read_only。
const stuck = diagnose({
  errorMessage: 'connect ECONNREFUSED 10.0.0.2:3306',
  progress: { currentStage: '自动迁移失败，切换持久化撤销未完成，系统保持只读等待人工处理' },
})
assert.equal(stuck.category, 'stuck_read_only')
assert.equal(stuck.dataSafety, 'read_only')
assert.ok(stuck.suggestions.some((item) => item.includes('不要再次发起迁移')))

// 后端在解除只读维护之前就写入“已恢复正常写入”，清理失败也不会修正文案：
// 数据安全只认任务停止后由健康检查确认的维护状态，未确认时不得仅凭文案判定为安全。
const restoredText = { errorMessage: "Data too long for column 'note' at row 1" }
assert.equal(diagnose(restoredText).dataSafety, 'unknown', '未确认维护状态时不得因“已恢复正常写入”文案判定安全')
assert.equal(diagnose(restoredText, { maintenanceReadOnly: null }).dataSafety, 'unknown')
assert.equal(diagnose(restoredText, { maintenanceReadOnly: false }).dataSafety, 'safe')
const cleanupFailed = diagnose(restoredText, { maintenanceReadOnly: true })
assert.equal(cleanupFailed.dataSafety, 'read_only', '清理失败、维护仍只读时必须判定为只读')
assert.equal(cleanupFailed.category, 'data_too_long', '确认只读不应吞掉原始失败类别')
assert.ok(cleanupFailed.suggestions[0].includes('不要再次发起迁移'), '确认只读时先给出只读处置步骤')
assert.ok(!cleanupFailed.suggestions.some((item) => item.includes('再次发起一键迁移')), '确认只读时不得建议重新发起迁移')
// 后端明确声明保持只读时，即使健康检查暂未确认也判定为只读。
assert.equal(diagnose({ progress: { currentStage: '自动迁移失败，切换持久化撤销未完成，系统保持只读等待人工处理' } }, { maintenanceReadOnly: false }).dataSafety, 'read_only')

const rolledBackTask = {
  status: 'rolled_back',
  errorMessage: undefined,
  progress: { currentStage: 'MySQL 连续启动失败，已自动回退 SQLite 并通过启动自检' },
  rollbackResult: { rolledBackAt: '2026-10-29T12:00:00Z', sourceSqlitePath: '-', mysqlStartupAttempts: 3, message: '已自动恢复原 SQLite 运行时覆盖并完成启动自检' },
}
const rolledBack = diagnose(rolledBackTask, { maintenanceReadOnly: false })
assert.equal(rolledBack.category, 'mysql_startup_failed')
assert.equal(rolledBack.dataSafety, 'safe')
assert.equal(diagnose(rolledBackTask).dataSafety, 'unknown', '回退结果同样需要维护状态确认后才判定安全')
assert.equal(rolledBack.title, '迁移未完成，已回退到 SQLite')
assert.equal(rolledBack.rawMessage, '')

const unknown = diagnose({ errorMessage: '某个从未见过的异常', progress: { currentStage: '迁移执行失败' } })
assert.equal(unknown.category, 'unknown')
assert.ok(unknown.suggestions.length >= 2, '未识别原因仍需给出排查与重试建议')

// 页面只能采信任务停止之后由健康检查确认的维护状态，不得使用 Store 初始默认值。
const viewSource = fs.readFileSync('src/views/system/DatabaseMigrationView.vue', 'utf8')
assert.match(viewSource, /databaseMaintenanceStore\.lastConfirmedAt > automaticTaskStopObservedAt\.value/)
assert.match(viewSource, /maintenance-read-only="stoppedTaskMaintenanceReadOnly"/)
const storeSource = fs.readFileSync('src/store/modules/database-maintenance.ts', 'utf8')
assert.match(storeSource, /lastConfirmedAt\.value = lastSuccessfulPollAt/, '维护 Store 必须只在健康检查明确返回时更新确认时间')

console.log(`[verify:db-migration-failure-diagnosis] ${cases.length} 类失败归类、只读优先级、停止后维护确认的数据安全判定与表/列提取通过`)
