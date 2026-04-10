/**
 * 模块说明：src/api/index.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

/**
 * API 聚合出口：
 * 统一导出模块化接口，降低调用方的导入复杂度。
 */
export * as authApi from '@/api/modules/auth'
export * as systemApi from '@/api/modules/system'
export * as systemConfigApi from '@/api/modules/system-config'
export * as productApi from '@/api/modules/product'
export * as orderApi from '@/api/modules/order'
export * as tagApi from '@/api/modules/tag'
export * as dashboardApi from '@/api/modules/dashboard'
export * as userApi from '@/api/modules/user'
export * as auditApi from '@/api/modules/audit'
export * as clientAuthApi from '@/api/modules/client-auth'
export * as o2oApi from '@/api/modules/o2o'
export * as dataMaintenanceApi from '@/api/modules/data-maintenance'
