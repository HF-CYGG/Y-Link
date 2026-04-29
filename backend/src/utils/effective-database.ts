/**
 * 模块说明：backend/src/utils/effective-database.ts
 * 文件职责：统一构造“当前实际生效数据库”与“运行时覆盖文件状态”摘要，供健康检查、迁移治理页与启动日志复用。
 * 实现逻辑：
 * 1. “当前实际生效数据库”只看当前进程启动时已经装载进 `env` 的结果，确保口径等于真实连接中的数据库。
 * 2. “运行时覆盖状态”同时比较“当前进程启动时加载的覆盖”与“磁盘上当前覆盖文件”，识别“已写入但未重启生效”等过渡态。
 * 3. 面向页面和脚本统一输出中文可读摘要，避免各处重复拼接数据库说明文案而出现歧义。
 * 维护说明：
 * - 若调整 `env.ts` 的数据库加载优先级，必须同步校验本文件判断逻辑。
 * - 若运行时覆盖文件结构新增字段，可在这里集中补充展示摘要，不要散落到多个页面和脚本中各自处理。
 */

import {
  DATABASE_MIGRATION_ASSISTANT_NAME,
  DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT,
  DATABASE_MIGRATION_RESTART_EFFECT_TEXT,
} from '../constants/database-migration-copy.js'
import { resolveSqliteDatabasePath } from '../config/database-bootstrap.js'
import { env, envLoadContext } from '../config/env.js'

type RuntimeOverrideDisplay = {
  updatedAt?: string
  config?: {
    DB_TYPE: 'sqlite' | 'mysql'
  } | null
} | null

export interface EffectiveDatabaseSummary {
  dbType: 'sqlite' | 'mysql'
  displayName: string
  summary: string
  source: 'environment' | 'runtime_override'
  sourceLabel: string
  description: string
}

export interface RuntimeOverrideStatusSummary {
  hasOverrideFile: boolean
  loadedByCurrentProcess: boolean
  pendingRestart: boolean
  statusLabel: string
  description: string
}

/**
 * 统一判断“当前进程启动时是否真的装载了运行时覆盖”：
 * - 只能以 `envLoadContext.runtimeDatabaseOverrideLoaded` 为准；
 * - 不能只看当前磁盘上是否存在覆盖文件，因为文件可能是运行中后来写入的，尚未被当前进程采纳。
 */
function isRuntimeOverrideLoadedByCurrentProcess(): boolean {
  return Boolean(envLoadContext.runtimeDatabaseOverrideLoaded && envLoadContext.runtimeDatabaseOverride)
}

/**
 * 比较“当前进程已加载的覆盖”与“磁盘上当前覆盖文件”是否一致：
 * - 一致：说明当前展示的覆盖文件就是本进程正在使用的那份；
 * - 不一致：通常表示有人刚写入/清理了覆盖文件，但后端还没有重启。
 */
function isCurrentOverrideFileAlignedWithRunningProcess(activeOverride: RuntimeOverrideDisplay): boolean {
  const loadedOverride = envLoadContext.runtimeDatabaseOverride
  if (!loadedOverride) {
    return !activeOverride?.config
  }
  if (!activeOverride?.config) {
    return false
  }
  return loadedOverride.updatedAt === activeOverride.updatedAt && loadedOverride.dbType === activeOverride.config.DB_TYPE
}

/**
 * 构造“当前实际生效数据库”摘要：
 * - 真实数据库类型与连接目标一律来自当前进程已加载的 `env`；
 * - 若管理员刚写入覆盖文件但还没重启，这里仍明确显示当前旧数据库，避免把“计划切换”误看成“已经切换”。
 */
export function buildEffectiveDatabaseSummary(activeOverride: RuntimeOverrideDisplay): EffectiveDatabaseSummary {
  const dbType = env.DB_TYPE
  const loadedByCurrentProcess = isRuntimeOverrideLoadedByCurrentProcess()
  const hasOverrideFile = Boolean(activeOverride?.config)
  const overrideFileAligned = isCurrentOverrideFileAlignedWithRunningProcess(activeOverride)
  const summary = dbType === 'mysql'
    ? `${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`
    : resolveSqliteDatabasePath()

  let sourceLabel = `默认环境配置（APP_PROFILE：${envLoadContext.requestedProfile ?? env.APP_PROFILE}）`
  if (envLoadContext.requestedEnvFile) {
    sourceLabel = `默认环境配置（ENV_FILE：${envLoadContext.requestedEnvFile}）`
  }
  if (loadedByCurrentProcess && envLoadContext.runtimeDatabaseOverride) {
    sourceLabel = `运行时覆盖配置（启动时已加载，更新时间：${envLoadContext.runtimeDatabaseOverride.updatedAt}）`
  }

  let description = '当前服务按默认环境配置使用 SQLite，适合先完成预检再迁移到 MySQL。'
  if (dbType === 'mysql') {
    description = loadedByCurrentProcess
      ? '当前服务已经按运行时覆盖配置连接到 MySQL，可继续核对连接信息或在异常时执行回退。'
      : '当前服务按默认环境配置连接到 MySQL，一般不需要再次执行 SQLite -> MySQL 迁移。'
  } else if (loadedByCurrentProcess) {
    description = '当前服务已经按运行时覆盖配置回退到 SQLite，可继续检查数据后决定是否再次迁移。'
  }

  if (hasOverrideFile && !loadedByCurrentProcess) {
    description = `已检测到新的运行时覆盖文件，但当前进程尚未重启，当前仍实际运行在 ${dbType === 'mysql' ? 'MySQL' : 'SQLite'}。`
  } else if (loadedByCurrentProcess && !overrideFileAligned) {
    description = `当前进程仍按启动时已加载的运行时覆盖运行，但磁盘上的覆盖文件已发生变化；需重启后端后才会切换到新配置。`
  }

  return {
    dbType,
    displayName: dbType === 'mysql' ? 'MySQL' : 'SQLite',
    summary,
    source: loadedByCurrentProcess ? 'runtime_override' : 'environment',
    sourceLabel,
    description,
  }
}

/**
 * 构造“运行时覆盖状态”摘要：
 * - 专门回答“覆盖文件有没有写入、当前进程有没有吃到、是否还差一次重启”；
 * - 与“当前实际生效数据库”拆开后，页面与脚本都能同时讲清楚“现在在用什么”和“下次重启会不会变”。
 */
export function buildRuntimeOverrideStatusSummary(activeOverride: RuntimeOverrideDisplay): RuntimeOverrideStatusSummary {
  const hasOverrideFile = Boolean(activeOverride?.config)
  const loadedByCurrentProcess = isRuntimeOverrideLoadedByCurrentProcess()
  const overrideFileAligned = isCurrentOverrideFileAlignedWithRunningProcess(activeOverride)
  const pendingRestart = hasOverrideFile ? !loadedByCurrentProcess || !overrideFileAligned : loadedByCurrentProcess

  if (!hasOverrideFile && !loadedByCurrentProcess) {
    return {
      hasOverrideFile,
      loadedByCurrentProcess,
      pendingRestart,
      statusLabel: '未启用运行时覆盖',
      description: '当前没有数据库运行时覆盖文件，服务完全按默认环境配置运行。',
    }
  }

  if (hasOverrideFile && loadedByCurrentProcess && overrideFileAligned) {
    return {
      hasOverrideFile,
      loadedByCurrentProcess,
      pendingRestart,
      statusLabel: '运行时覆盖已生效',
      description: '当前进程启动时已装载这份运行时覆盖文件，页面展示的覆盖目标就是当前真实连接目标。',
    }
  }

  if (hasOverrideFile && !loadedByCurrentProcess) {
    return {
      hasOverrideFile,
      loadedByCurrentProcess,
      pendingRestart,
      statusLabel: '已写入运行时覆盖，等待重启生效',
      description: '覆盖文件已经落盘，但当前进程尚未重启，因此仍在按默认环境配置运行旧数据库。',
    }
  }

  if (hasOverrideFile) {
    return {
      hasOverrideFile,
      loadedByCurrentProcess,
      pendingRestart,
      statusLabel: '覆盖文件已更新，等待重启切换到新配置',
      description: '当前进程仍使用启动时加载的旧覆盖配置，而磁盘上的覆盖文件已经被改写；需重启后端后才会切换到新目标。',
    }
  }

  return {
    hasOverrideFile,
    loadedByCurrentProcess,
    pendingRestart,
    statusLabel: '覆盖文件已清理，等待重启回到默认环境',
    description: '当前进程仍按启动时加载的运行时覆盖运行，但磁盘上的覆盖文件已被清理；重启后端后会回到默认环境配置。',
  }
}

/**
 * 面向小白用户给出下一步动作建议：
 * - 若当前存在“覆盖文件已写入但未生效”的过渡态，优先提示重启，不让用户继续误判当前数据库；
 * - 其余场景再根据当前实际数据库类型给出迁移或核对建议。
 */
export function buildBeginnerGuide(
  effectiveDatabase: EffectiveDatabaseSummary,
  runtimeOverrideStatus: RuntimeOverrideStatusSummary,
): {
  headline: string
  recommendedAction: string
  nextStep: string
  riskTip: string
} {
  if (runtimeOverrideStatus.pendingRestart) {
    return {
      headline: '已检测到数据库切换过渡态',
      recommendedAction: `如果你刚执行了切换、回退或清空覆盖，请先重启后端，再回到${DATABASE_MIGRATION_ASSISTANT_NAME}确认“当前实际生效数据库”是否变化。`,
      nextStep: '重启前不要把覆盖文件内容当成当前真实连接结果；应始终以“当前实际生效数据库”为准。',
      riskTip: `只写入覆盖文件不会立刻切换数据库。${DATABASE_MIGRATION_RESTART_EFFECT_TEXT}`,
    }
  }

  if (effectiveDatabase.dbType === 'mysql') {
    return {
      headline: '当前系统已经运行在 MySQL',
      recommendedAction: '通常无需重复执行 SQLite -> MySQL 迁移，建议先确认当前连接信息是否符合预期。',
      nextStep: '如果只是想核对状态，请查看下方当前运行状态；如果发现目标库不对，再使用回退或重新创建迁移任务。',
      riskTip: '重复迁移或误切换可能覆盖目标库原有数据，执行前请先确认是否真的需要再次迁移。',
    }
  }

  return {
    headline: '当前系统仍在使用 SQLite',
    recommendedAction: '建议先填写目标 MySQL 信息并执行预检，确认连接与权限无误后再创建迁移任务。',
    nextStep: `按“${DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT}”的顺序操作最安全。`,
    riskTip: '不要跳过预检，也不要先手工改配置文件；迁移前请确认 SQLite 备份与 JSON 快照都已保留。',
  }
}
