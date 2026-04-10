/**
 * 模块说明：src/icons/element-plus.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */

import {
  Box,
  DataAnalysis,
  Document,
  DocumentAdd,
  List,
  Money,
  More,
  Odometer,
  Plus,
  Refresh,
  Search,
  Setting,
  Shop,
  UserFilled,
  WarningFilled,
} from '@element-plus/icons-vue'

/**
 * Element Plus 图标白名单：
 * - 仅注册当前项目真实使用到的图标，避免一次性注入整包图标；
 * - 侧边栏、快捷入口和按钮统一通过该白名单共享图标名称。
 */
export const elementPlusIconWhitelist = {
  Box,
  DataAnalysis,
  Document,
  DocumentAdd,
  List,
  Money,
  More,
  Odometer,
  Plus,
  Refresh,
  Search,
  Setting,
  Shop,
  UserFilled,
  WarningFilled,
} as const

/**
 * 图标名称类型：
 * - 供路由 meta、快捷入口配置等场景复用；
 * - 限制仅能使用白名单中的图标键，避免出现运行时缺失。
 */
export type ElementPlusIconName = keyof typeof elementPlusIconWhitelist
