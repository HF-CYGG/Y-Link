/**
 * 模块说明：F:/Y-Link/src/icons/element-plus.ts
 * 文件职责：Element Plus 图标白名单注册文件。
 * 实现逻辑：集中维护可用图标集合并按需注册，控制包体积。
 * 维护说明：新增图标时同步更新白名单。
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
  Picture,
  Check,
  Delete,
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
  Picture,
  Check,
  Delete,
} as const

/**
 * 图标名称类型：
 * - 供路由 meta、快捷入口配置等场景复用；
 * - 限制仅能使用白名单中的图标键，避免出现运行时缺失。
 */
export type ElementPlusIconName = keyof typeof elementPlusIconWhitelist
