/**
 * 文件用途：把一键自动迁移失败任务的原始报错归类为面向管理员的白话诊断。
 * 核心职责：根据任务状态、进展文案、失败原因与回退结果，给出失败类别、白话说明、数据安全状态与针对性处理建议。
 * 设计原因：后端 errorMessage 是原始异常文本（MySQL 错误码、Node 网络错误等），直接展示难以判断下一步动作；
 *   归类逻辑保持纯函数，便于脚本直接验证，不依赖组件或请求层。
 * 使用边界：只做展示层归类，不改变任务状态，也不推测后端未声明的可回退性；无法识别时回落为通用失败说明。
 */
import type { SQLiteToMySqlTaskRecord } from '@/api/modules/data-maintenance'

export type MigrationFailureCategory =
  | 'stuck_read_only'
  | 'cancelled'
  | 'mysql_startup_failed'
  | 'resume_exhausted'
  | 'target_unreachable'
  | 'target_auth_failed'
  | 'target_privilege_missing'
  | 'target_database_missing'
  | 'target_not_empty'
  | 'target_incompatible'
  | 'data_too_long'
  | 'data_duplicate'
  | 'disk_full'
  | 'connection_lost'
  | 'source_integrity'
  | 'validation_failed'
  | 'deployment_incomplete'
  | 'unknown'

/**
 * 数据安全状态：
 * - safe：已恢复 SQLite 正常写入或已完成回退，原数据未受影响；
 * - read_only：系统仍处于只读维护，必须人工处理后才能恢复写入；
 * - unknown：后端文案无法确认恢复情况，提示管理员以页面状态为准。
 */
export type MigrationDataSafety = 'safe' | 'read_only' | 'unknown'

export interface MigrationFailureDiagnosis {
  category: MigrationFailureCategory
  categoryLabel: string
  title: string
  summary: string
  dataSafety: MigrationDataSafety
  affectedTable: string
  affectedColumn: string
  rawMessage: string
  suggestions: string[]
}

type FailureRule = {
  category: MigrationFailureCategory
  label: string
  pattern: RegExp
  summary: string
  suggestions: string[]
}

const RETRY_SUGGESTION = '处理完成后在下方重新“测试连接”，通过后再次发起一键迁移；目标库若只残留上次失败任务创建的表，系统会自动认领并清理。'

/**
 * 归类规则按优先级排列：先识别“系统仍只读 / 管理员取消 / 启动失败 / 续跑耗尽”这类全局结局，
 * 再按原始报错识别目标库与数据问题，避免被报错正文中的通用关键词抢先命中。
 */
const FAILURE_RULES: FailureRule[] = [
  {
    category: 'stuck_read_only',
    label: '需人工处理',
    pattern: /保持只读|等待人工处理|未能解除只读|仍处于只读|锁文件已损坏|切换标记(存在但)?已损坏/,
    summary: '迁移失败后，系统未能自动恢复正常写入，目前仍处于只读维护。',
    suggestions: [
      '不要再次发起迁移，也不要手工删除迁移目录下的锁或标记文件。',
      '若本页进度区提供“独立救援页”入口，请按救援页提示执行受控回退；否则请联系运维结合后端日志处理。',
      '确认恢复正常写入后，再回到本页重新评估迁移。',
    ],
  },
  {
    category: 'cancelled',
    label: '已取消',
    pattern: /管理员取消|管理员紧急回退/,
    summary: '本次自动迁移已由管理员取消，并按受控流程回退到原 SQLite。',
    suggestions: ['确认取消原因已处理后，可重新测试连接并再次发起迁移。'],
  },
  {
    category: 'mysql_startup_failed',
    label: 'MySQL 启动失败',
    pattern: /MySQL 连续启动失败|启动后验收要求当前应用已连接 MySQL/,
    summary: '数据已导入，但切换到 MySQL 后应用连续启动失败，系统已自动回退到原 SQLite。',
    suggestions: [
      '检查 MySQL 服务日志、最大连接数（max_connections）与宿主机内存是否充足。',
      '确认应用容器到 MySQL 的网络在重启后仍然可达（Compose 中应填写服务名）。',
      RETRY_SUGGESTION,
    ],
  },
  {
    category: 'resume_exhausted',
    label: '进程多次中断',
    pattern: /连续中断|续跑限制|续跑次数已耗尽/,
    summary: '迁移进程在执行中多次意外退出，达到续跑上限后已停止并恢复 SQLite 正常写入。',
    suggestions: [
      '优先排查宿主机内存是否触发 OOM（如 journalctl -k 中的 Out of memory 记录）以及磁盘空间。',
      '在业务低峰、确保资源充足后再重新发起迁移。',
    ],
  },
  {
    category: 'target_auth_failed',
    label: '账号认证失败',
    pattern: /ER_ACCESS_DENIED_ERROR|Access denied for user|账号或密码/i,
    summary: '目标 MySQL 拒绝了当前账号的登录。',
    suggestions: [
      '核对用户名与密码，并确认该账号允许从 Y-Link 后端所在主机或容器登录（host 通配）。',
      RETRY_SUGGESTION,
    ],
  },
  {
    category: 'target_privilege_missing',
    label: '账号权限不足',
    pattern: /缺少自动迁移权限|command denied|ER_\w*ACCESS\w*|log_bin_trust_function_creators|\b1419\b|TRIGGER 权限/i,
    summary: '目标 MySQL 账号缺少建表、写入或触发器等迁移所需权限。',
    suggestions: [
      '为迁移账号授予目标库的 CREATE、ALTER、INDEX、INSERT、UPDATE、DELETE、SELECT、TRIGGER 等权限。',
      '若报错提到 1419，请在 MySQL 开启 log_bin_trust_function_creators。',
      RETRY_SUGGESTION,
    ],
  },
  {
    category: 'target_database_missing',
    label: '目标库不存在',
    pattern: /数据库不存在|Unknown database|ER_BAD_DB_ERROR/i,
    summary: '填写的目标数据库在 MySQL 中不存在。',
    suggestions: ['请由运维预先创建独立的 utf8mb4 空库，再重新测试连接。'],
  },
  {
    category: 'target_not_empty',
    label: '目标库非空',
    pattern: /只允许独立空库|不再为空|非本任务结构|当前已存在表/,
    summary: '目标库中存在不属于本次迁移的表，一键迁移只允许写入专用空库。',
    suggestions: [
      '新建一个专用空库并改填库名；不要在原库中手工删除业务表。',
      '重新测试连接，确认“满足迁移条件”后再发起迁移。',
    ],
  },
  {
    category: 'target_incompatible',
    label: '版本或字符集不符',
    pattern: /要求 MySQL 8\.0\.16|utf8mb4|ER_NOT_SUPPORTED/i,
    summary: '目标 MySQL 的版本或默认字符集不满足迁移要求（需 MySQL 8.0.16+ 且库默认 utf8mb4）。',
    suggestions: ['升级 MySQL 或重新创建 utf8mb4 字符集的空库后再试。'],
  },
  {
    category: 'target_unreachable',
    label: '无法连接目标库',
    pattern: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|getaddrinfo|connect ETIMEDOUT|无法连接/i,
    summary: 'Y-Link 后端无法连接到目标 MySQL。',
    suggestions: [
      '检查主机、端口、防火墙与 MySQL 服务状态；Docker 中 127.0.0.1 指向应用容器自身，请改填 MySQL 服务名。',
      RETRY_SUGGESTION,
    ],
  },
  {
    category: 'connection_lost',
    label: '连接中断',
    pattern: /PROTOCOL_CONNECTION_LOST|Lost connection|server has gone away|ECONNRESET|ER_NET_|EPIPE/i,
    summary: '迁移过程中与目标 MySQL 的连接意外中断。',
    suggestions: [
      '检查 MySQL 是否重启或被 OOM 终止，并适当调大 max_allowed_packet 与 wait_timeout。',
      RETRY_SUGGESTION,
    ],
  },
  {
    category: 'disk_full',
    label: '磁盘空间不足',
    pattern: /ENOSPC|No space left|disk (is )?full|ER_RECORD_FILE_FULL|The table .+ is full/i,
    summary: '生成快照或写入目标库时磁盘空间不足。',
    suggestions: [
      '清理 Y-Link 数据目录与 MySQL 数据盘空间，确保可容纳 SQLite 快照与完整业务数据。',
      RETRY_SUGGESTION,
    ],
  },
  {
    category: 'data_too_long',
    label: '数据超出列限制',
    pattern: /Data too long|ER_DATA_TOO_LONG|Incorrect string value|Out of range value|ER_TRUNCATED/i,
    summary: '部分源数据超出了目标 MySQL 列的长度、范围或字符集限制。',
    suggestions: [
      '记下下方的表名与原始报错，联系开发确认字段长度或补充迁移前的数据修正规则。',
      '若报错为 Incorrect string value，请确认目标库与连接均为 utf8mb4。',
    ],
  },
  {
    category: 'data_duplicate',
    label: '主键或唯一键冲突',
    pattern: /Duplicate entry|ER_DUP_ENTRY/i,
    summary: '导入时出现主键或唯一键重复，源数据或目标库存在重复记录。',
    suggestions: [
      '确认目标库为专用空库；若源数据本身重复，请记下表名与原始报错联系开发处理。',
      RETRY_SUGGESTION,
    ],
  },
  {
    category: 'source_integrity',
    label: '源数据完整性问题',
    pattern: /SQLite 一致性检查|外键完整性|主键游标|单主键游标/,
    summary: '当前 SQLite 源库存在一致性或结构问题，迁移在导入前被阻止。',
    suggestions: ['记下原始报错并联系开发修复源库数据后再迁移；修复前不要强行切换数据库。'],
  },
  {
    category: 'validation_failed',
    label: '迁后校验未通过',
    pattern: /校验未通过|强校验|字段结构与源实体不一致|未生成强校验结果/,
    summary: '数据已写入目标库，但迁后校验发现行数、结构或内容与源库不一致，已禁止切换。',
    suggestions: [
      '展开“高级 / 应急操作”查看任务详情中的逐表校验结果，定位不一致的表。',
      '确认迁移期间没有其他程序写入目标库后，再重新发起迁移。',
    ],
  },
  {
    category: 'deployment_incomplete',
    label: '部署产物不完整',
    pattern: /建表子进程不存在|不是受 onebox 重启守护/,
    summary: '当前部署缺少一键迁移所需的后端产物或重启守护。',
    suggestions: ['请按部署文档重新构建并以 onebox 方式部署后端，再使用一键迁移。'],
  },
]

// 表名取自后端统一包装的“表 xxx 导入失败 / 字段结构 …”文案，列名取自 MySQL 原始报错，二者分开避免把列误标为表。
const extractAffectedTable = (text: string) => {
  return text.match(/表\s*([A-Za-z0-9_]+)\s*(?:导入失败|字段结构|不满足|的主键)/)?.[1] ?? ''
}

const extractAffectedColumn = (text: string) => {
  return text.match(/for column\s+[`'"]?([A-Za-z0-9_]+)[`'"]?/i)?.[1] ?? ''
}

/**
 * 判断原数据安全状态：只依据后端写回的终态文案与回退结果，不做额外推测。
 */
const resolveDataSafety = (task: SQLiteToMySqlTaskRecord, category: MigrationFailureCategory): MigrationDataSafety => {
  if (category === 'stuck_read_only') return 'read_only'
  if (task.status === 'rolled_back' || task.rollbackResult) return 'safe'
  const stage = task.progress?.currentStage ?? ''
  if (/已恢复(正常写入|\s*SQLite)|SQLite 正常写入/.test(stage)) return 'safe'
  return 'unknown'
}

export const diagnoseAutomaticMigrationFailure = (task: SQLiteToMySqlTaskRecord): MigrationFailureDiagnosis => {
  const rawMessage = (task.errorMessage ?? '').trim()
  const stage = task.progress?.currentStage ?? ''
  const haystack = [stage, rawMessage, task.rollbackResult?.message ?? ''].join('\n')
  const rule = FAILURE_RULES.find((item) => item.pattern.test(haystack))
  const category = rule?.category ?? 'unknown'
  const isRolledBack = task.status === 'rolled_back'

  return {
    category,
    categoryLabel: rule?.label ?? (isRolledBack ? '已回退' : '未识别原因'),
    title: isRolledBack ? '迁移未完成，已回退到 SQLite' : '自动迁移失败',
    summary: rule?.summary ?? (isRolledBack
      ? '本次迁移未能完成切换，系统已回退到原 SQLite。'
      : '迁移过程中出现未归类的错误，请结合下方原始报错排查。'),
    dataSafety: resolveDataSafety(task, category),
    affectedTable: extractAffectedTable(rawMessage),
    affectedColumn: extractAffectedColumn(rawMessage),
    rawMessage,
    suggestions: rule?.suggestions ?? [
      '复制排查信息，结合后端日志定位具体原因。',
      RETRY_SUGGESTION,
    ],
  }
}
