/**
 * 模块说明：src/utils/permission.ts
 * 文件职责：提供前端统一权限提示能力，确保菜单、路由、按钮越权时的反馈口径一致。
 * 实现逻辑：
 * - 通过常量沉淀统一提示文案“权限不足”，避免页面各自维护不同文案导致用户困惑；
 * - 对外暴露便捷函数，页面层可在动作拦截处直接调用，减少重复样板代码；
 * - 支持可选上下文后缀，用于极少数需要补充场景说明的提示，不改变主口径。
 */
import { ElMessage } from 'element-plus'

/**
 * 统一越权提示主文案：
 * - 根据权限矩阵治理要求，所有越权场景均以该文案作为首要反馈；
 * - 统一后便于用户形成稳定预期，也便于后续国际化收敛。
 */
export const PERMISSION_DENIED_MESSAGE = '权限不足'

/**
 * 触发统一越权提示：
 * - 默认直接提示“权限不足”；
 * - 允许追加简短上下文，适配需要区分“访问页面”与“执行动作”的场景。
 */
export const showPermissionDenied = (context?: string) => {
  const normalizedContext = typeof context === 'string' ? context.trim() : ''
  const message = normalizedContext ? `${PERMISSION_DENIED_MESSAGE}（${normalizedContext}）` : PERMISSION_DENIED_MESSAGE
  ElMessage.warning(message)
}

