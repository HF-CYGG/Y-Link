/**
 * 模块说明：src/icons/element-plus.ts
 * 文件职责：集中维护项目中实际使用的 Element Plus 图标映射与名称类型，供路由、菜单和页面配置共享引用。
 * 实现逻辑：
 * - 从 Element Plus 图标集中按需引入当前项目需要的图标，避免配置层直接分散依赖原始组件；
 * - 通过统一映射对象把“字符串图标名”与真实图标组件关联起来，便于路由元信息按名称配置图标；
 * - 对外导出图标名称类型，保证菜单、快捷入口等配置在编译期即可获得约束。
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
