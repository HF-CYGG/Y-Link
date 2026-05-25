/**
 * 模块说明：F:/Y-Link/src/api/index.ts
 * 文件职责：前端 API 聚合出口文件。
 * 实现逻辑：统一导出各业务 API 模块，降低页面层导入路径复杂度。
 * 维护说明：新增 API 模块时在此处补充导出并保持命名一致。
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
export * as customerServiceFeedbackApi from '@/api/modules/customer-service-feedback'
