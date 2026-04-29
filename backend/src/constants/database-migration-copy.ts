/**
 * 文件说明：数据库迁移文案常量。
 * 文件职责：统一收口后端服务、运行时状态摘要与自动验证脚本共用的数据库迁移提示文案，避免同一动作在不同模块出现不同说法。
 * 实现逻辑：
 * 1. 将“数据库迁移助手”设为数据库治理功能的标准名称，便于脚本、服务与页面对齐理解。
 * 2. 将“写入运行时覆盖后，需要重启后端服务才会生效”设为核心风险提示，集中复用到切换、回退和状态提醒。
 * 3. 将推荐闭环与默认原因抽成常量，降低后续服务逻辑、审计文案与验证脚本同步维护的成本。
 */

/**
 * 后端统一使用的数据库迁移能力名称。
 */
export const DATABASE_MIGRATION_ASSISTANT_NAME = '数据库迁移助手'

/**
 * 推荐执行闭环：
 * - 用于运行时指导文案；
 * - 也作为自动验证脚本的口径基准。
 */
export const DATABASE_MIGRATION_RECOMMENDED_FLOW_TEXT =
  '执行预检 -> 创建迁移任务 -> 执行迁移 -> 写入运行时覆盖 -> 重启后端服务 -> 回到数据库迁移助手确认当前实际生效数据库'

/**
 * 重启生效提示：
 * - 任何写入运行时覆盖的动作都应提示该说明；
 * - 保证“写入成功”与“已经生效”不会被混淆。
 */
export const DATABASE_MIGRATION_RESTART_EFFECT_TEXT = '写入运行时覆盖后，需要重启后端服务才会生效。'

/**
 * MySQL 切换默认原因：
 * - 供页面未填写原因时写入审计日志；
 * - 与前端提示保持一致，便于后续检索。
 */
export const DATABASE_MIGRATION_SWITCH_REASON_DEFAULT = '数据库迁移助手写入 MySQL 运行时覆盖'

/**
 * SQLite 回退默认原因：
 * - 与切换动作保持对称；
 * - 避免历史审计记录中出现多套表达。
 */
export const DATABASE_MIGRATION_ROLLBACK_REASON_DEFAULT = '数据库迁移助手写入 SQLite 运行时覆盖'

/**
 * 迁移成功且已自动写入运行时覆盖后的阶段提示。
 */
export const DATABASE_MIGRATION_SUCCESS_STAGE_WITH_SWITCH =
  '迁移成功，已写入数据库运行时覆盖；重启后端服务后生效'

/**
 * 迁移成功但尚未切换时的阶段提示。
 */
export const DATABASE_MIGRATION_SUCCESS_STAGE_PENDING_SWITCH =
  '迁移成功，请先核对结果，再写入运行时覆盖并重启后端服务'
