/**
 * 模块说明：src/api/index.ts
 * 文件职责：作为前端 API 模块的聚合出口，统一导出认证、系统、商品、订单等分域接口集合。
 * 实现逻辑：
 * - 把各业务域 API 模块以命名空间形式集中导出，降低调用方逐文件维护导入路径的成本；
 * - 保持 API 分层目录清晰的同时，对页面层提供稳定的顶层访问入口；
 * - 当 API 模块内部迁移或重组时，可通过该文件维持对外接口路径不变。
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
export * as reportApi from '@/api/modules/report'
export * as clientAuthApi from '@/api/modules/client-auth'
export * as o2oApi from '@/api/modules/o2o'
export * as dataMaintenanceApi from '@/api/modules/data-maintenance'
export * as customerServiceFeedbackApi from '@/api/modules/customer-service-feedback'
export * as notificationApi from '@/api/modules/notification'
