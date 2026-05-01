/**
 * 模块说明：src/composables/usePermissionAction.ts
 * 文件职责：提供前端统一权限动作门禁工具，收敛页面层散点的权限判断与越权提示逻辑。
 * 实现逻辑：
 * - 复用认证 store 的权限点判断能力，统一输出 `hasPermission / ensurePermission / runWithPermission` 三类常用接口；
 * - 页面层既可以继续声明只读型 computed，也可以在点击动作前统一拦截；
 * - 所有越权反馈统一走共享提示能力，避免页面继续手写不同文案或忘记提示。
 * 维护说明：
 * - 若后续需要支持“任一权限即可执行”“多个权限同时满足”等扩展，应优先在这里扩展，而不是让页面继续散点拼接判断。
 */
import { useAuthStore } from '@/store'
import type { PermissionCode } from '@/api/modules/auth'
import { showPermissionDenied } from '@/utils/permission'

/**
 * 统一权限动作工具：
 * - `hasPermission` 适合模板显隐与 computed；
 * - `ensurePermission` 适合点击前即时拦截；
 * - `runWithPermission` 适合把“校验 + 执行”收口到一处。
 */
export const usePermissionAction = () => {
  const authStore = useAuthStore()

  /**
   * 查询当前账号是否具备指定权限点：
   * - 作为页面层统一入口，避免继续直接散落依赖 store 实现细节；
   * - 后续若权限判断策略变化，可只在这里收口。
   */
  const hasPermission = (permissionCode: PermissionCode) => {
    return authStore.hasPermission(permissionCode)
  }

  /**
   * 执行前门禁：
   * - 无权限时统一弹出共享越权提示，并返回 false；
   * - 有权限时返回 true，供页面继续后续业务流程。
   */
  const ensurePermission = (permissionCode: PermissionCode, context?: string) => {
    if (hasPermission(permissionCode)) {
      return true
    }
    showPermissionDenied(context)
    return false
  }

  /**
   * 带权限门禁的动作执行器：
   * - 页面若希望把校验和动作完全收口到一个调用点，可直接使用；
   * - 返回值保持透传，便于继续串接异步流程。
   */
  const runWithPermission = async <T>(permissionCode: PermissionCode, executor: () => Promise<T> | T, context?: string) => {
    if (!ensurePermission(permissionCode, context)) {
      return undefined
    }
    return executor()
  }

  return {
    hasPermission,
    ensurePermission,
    runWithPermission,
  }
}
