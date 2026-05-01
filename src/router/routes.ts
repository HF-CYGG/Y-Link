/**
 * 模块说明：src/router/routes.ts
 * 文件职责：统一维护管理端与客户端的路由、菜单、快捷入口和权限元信息，本次新增系统治理下的数据库迁移助手页面入口。
 * 实现逻辑：
 * - 所有业务页面都通过 routeViewLoaders 做懒加载，保证路由、预热和权限入口保持同源；
 * - 系统治理分组下新增数据库迁移助手子路由，并把预热目标同步纳入系统配置页；
 * - 菜单、快捷入口和首个可访问路由仍然完全由本文件派生，避免出现多份配置源。
 * 维护说明：新增或调整业务页面时，需要同步检查路由名称、权限码、菜单顺序和预热目标是否一致。
 */

import type { RouteMeta, RouteRecordRaw } from 'vue-router'
import type { ElementPlusIconName } from '@/icons/element-plus'
import type { PermissionCode, UserRole, UserSafeProfile } from '@/api/modules/auth'
import { routeViewLoaders, type AppRouteName } from '@/router/route-performance'

/**
 * 快捷入口配置：
 * - 所有工作台快捷卡片均从路由 meta 派生；
 * - 允许为快捷入口覆写文案、跳转路径与视觉样式，但仍然依附于路由本身。
 */
export interface AppShortcutMeta {
  title?: string
  description?: string
  icon?: ElementPlusIconName
  order?: number
  path?: string
  colorClass?: string
  bgClass?: string
}

/**
 * 路由扩展元信息：
 * - title 负责浏览器标题与菜单文案；
 * - menu / menuOrder / menuGroup 用于派生侧边栏结构；
 * - shortcut 用于派生工作台快捷入口；
 * - activeMenu 用于需要时指定菜单高亮归属；
 * - requiresAuth / guestOnly / requiredPermissions 用于管理端权限点路由守卫。
 * - requiresClientAuth / clientGuestOnly 用于客户端 H5 的登录态路由守卫。
 */
export interface AppRouteMeta extends RouteMeta {
  title: string
  icon?: ElementPlusIconName
  menu?: boolean
  menuOrder?: number
  menuGroup?: string
  clientNav?: boolean
  clientNavOrder?: number
  activeMenu?: string
  shortcut?: AppShortcutMeta
  requiresAuth?: boolean
  guestOnly?: boolean
  requiresClientAuth?: boolean
  clientGuestOnly?: boolean
  requiredPermissions?: PermissionCode[]
  requiredAnyPermissions?: PermissionCode[]
  allowedRoles?: UserRole[]
  keepAlive?: boolean
  preloadTargets?: AppRouteName[]
  viewKey?: string
  suppressGlobalLoadingBar?: boolean
}

/**
 * 侧边栏菜单项：
 * - 统一由路由配置派生，避免布局层再维护一份菜单常量；
 * - children 保留子菜单结构，满足基础资料等分组页面展示。
 */
export interface AppMenuItem {
  title: string
  path: string
  icon?: ElementPlusIconName
  group?: string
  children?: AppMenuItem[]
}

/**
 * 工作台快捷入口：
 * - path 与 icon 均来自路由配置或路由 meta.shortcut 覆写；
 * - 供 Dashboard 直接渲染，不再维护独立 quickActions 常量。
 */
export interface DashboardShortcutItem {
  title: string
  description?: string
  path: string
  icon?: ElementPlusIconName
  colorClass: string
  bgClass: string
}

/**
 * 客户端导航项：
 * - 与管理端菜单同样由路由元信息派生；
 * - 仅用于客户端底部导航，不参与管理端侧栏渲染。
 */
export interface ClientNavigationItem {
  title: string
  path: string
  children?: ClientNavigationItem[]
}

interface AppRouteRecord {
  path: string
  name?: AppRouteName
  component?: RouteRecordRaw['component']
  redirect?: RouteRecordRaw['redirect']
  meta: AppRouteMeta
  children?: AppRouteRecord[]
}

/**
 * 业务页路由：
 * - 此处是布局内页面的唯一真源；
 * - 菜单、快捷入口、标题与权限均从这里派生。
 */
const layoutChildren: AppRouteRecord[] = [
  {
    path: 'dashboard',
    name: 'dashboard',
    component: routeViewLoaders.dashboard,
    meta: {
      title: '工作台',
      icon: 'Odometer',
      menuGroup: '业务操作',
      menuOrder: 10,
      requiredPermissions: ['dashboard:view'],
      allowedRoles: ['admin', 'operator'],
      keepAlive: true,
      preloadTargets: ['order-entry', 'order-list', 'products', 'system-users'],
    },
  },
  {
    path: 'order-entry',
    name: 'order-entry',
    component: routeViewLoaders['order-entry'],
    meta: {
      title: '出库开单',
      icon: 'DocumentAdd',
      menuGroup: '业务操作',
      menuOrder: 20,
      requiredPermissions: ['orders:create'],
      allowedRoles: ['admin', 'operator'],
      shortcut: {
        title: '新增开单',
        description: '快速录入新的出库单据',
        order: 10,
        colorClass: 'text-brand dark:text-teal-300',
        bgClass: 'bg-brand/10 dark:bg-brand/20',
      },
      keepAlive: true,
      preloadTargets: ['order-list', 'products'],
    },
  },
  {
    path: 'order-list',
    name: 'order-list',
    component: routeViewLoaders['order-list'],
    meta: {
      title: '出库单列表',
      icon: 'List',
      menuGroup: '业务操作',
      menuOrder: 30,
      requiredPermissions: ['orders:view'],
      allowedRoles: ['admin', 'operator'],
      shortcut: {
        title: '出库单列表',
        description: '查看历史开单记录与单据详情',
        order: 20,
        colorClass: 'text-secondary dark:text-slate-200',
        bgClass: 'bg-secondary/10 dark:bg-secondary/20',
      },
      keepAlive: true,
      preloadTargets: ['order-entry'],
    },
  },
  {
    path: 'supplier-delivery',
    name: 'supplier-delivery',
    component: routeViewLoaders['supplier-delivery'],
    meta: {
      title: '供货工作台',
      icon: 'DocumentAdd',
      menuGroup: '供货管理',
      menuOrder: 10,
      requiredPermissions: ['inbound:create'],
      allowedRoles: ['supplier'],
      keepAlive: true,
      viewKey: 'supplier-workbench',
      suppressGlobalLoadingBar: true,
    },
  },
  {
    path: 'supplier-history',
    name: 'supplier-history',
    component: routeViewLoaders['supplier-history'],
    meta: {
      title: '供货工作台',
      icon: 'List',
      menu: false,
      menuGroup: '供货管理',
      menuOrder: 20,
      activeMenu: '/supplier-delivery',
      requiredPermissions: ['inbound:view'],
      allowedRoles: ['supplier'],
      keepAlive: true,
      viewKey: 'supplier-workbench',
      suppressGlobalLoadingBar: true,
    },
  },
  {
    path: 'inbound-scan',
    name: 'inbound-scan',
    component: routeViewLoaders['inbound-scan'],
    meta: {
      title: '扫码入库',
      icon: 'Search',
      menuGroup: '业务操作',
      menuOrder: 35,
      requiredPermissions: ['inbound:verify'],
      allowedRoles: ['admin', 'operator'],
      keepAlive: true,
    },
  },
  {
    path: 'inbound-manage',
    name: 'o2o-console-inbound',
    component: routeViewLoaders['o2o-console-inbound'],
    meta: {
      title: '入库管理',
      icon: 'Box',
      menuGroup: '业务操作',
      menuOrder: 36,
      requiredAnyPermissions: ['inbound:view', 'inbound:verify'],
      allowedRoles: ['admin', 'operator'],
      keepAlive: true,
    },
  },
  {
    path: 'base-data',
    name: 'base-data',
    redirect: '/base-data/products',
    meta: {
      title: '基础资料',
      icon: 'Setting',
      menuGroup: '基础资料',
      menuOrder: 40,
      requiredAnyPermissions: ['products:view', 'tags:view'],
      allowedRoles: ['admin', 'operator'],
      shortcut: {
        title: '基础资料',
        description: '维护产品与标签等基础信息',
        order: 30,
        path: '/base-data/products',
        colorClass: 'text-brand dark:text-teal-300',
        bgClass: 'bg-brand/10 dark:bg-brand/20',
      },
    },
    children: [
      {
        path: 'products',
        name: 'products',
        component: routeViewLoaders.products,
        meta: {
          title: '产品中心',
          menuOrder: 10,
          activeMenu: '/base-data',
          requiredPermissions: ['products:view'],
          keepAlive: true,
          viewKey: 'product-center',
          suppressGlobalLoadingBar: true,
          preloadTargets: ['tags', 'o2o-console-products'],
        },
      },
      {
        path: 'tags',
        name: 'tags',
        component: routeViewLoaders.tags,
        meta: {
          title: '标签管理',
          menuOrder: 20,
          activeMenu: '/base-data',
          requiredPermissions: ['tags:view'],
          keepAlive: true,
        },
      },
    ],
  },
  {
    path: 'o2o-console',
    name: 'o2o-console',
    redirect: '/o2o-console/orders',
    meta: {
      title: '线上预订',
      icon: 'Shop',
      menuGroup: '业务操作',
      menuOrder: 35,
      requiredAnyPermissions: ['products:view', 'orders:view'],
      // 线上预订仅面向管理端与操作员，供货方账号禁止访问
      allowedRoles: ['admin', 'operator'],
      shortcut: {
        title: '线上预订',
        description: '维护线上商品并处理预订单查询、核销',
        order: 25,
        path: '/o2o-console/orders',
        icon: 'Shop',
        colorClass: 'text-brand dark:text-teal-300',
        bgClass: 'bg-brand/10 dark:bg-brand/20',
      },
    },
    children: [
      {
        path: 'products',
        name: 'o2o-console-products',
        component: routeViewLoaders['o2o-console-products'],
        meta: {
          title: '产品中心',
          menu: false,
          menuOrder: 10,
          activeMenu: '/base-data/products',
          requiredPermissions: ['products:view'],
          keepAlive: true,
          viewKey: 'product-center',
          suppressGlobalLoadingBar: true,
          preloadTargets: ['o2o-console-verify'],
        },
      },
      {
        path: 'orders',
        name: 'o2o-console-orders',
        component: routeViewLoaders['o2o-console-orders'],
        meta: {
          title: '订单查询',
          menuOrder: 20,
          activeMenu: '/o2o-console',
          requiredPermissions: ['orders:view'],
          keepAlive: true,
          preloadTargets: ['o2o-console-verify'],
        },
      },
      {
        path: 'verify',
        name: 'o2o-console-verify',
        component: routeViewLoaders['o2o-console-verify'],
        meta: {
          title: '预订单核销',
          menuOrder: 30,
          activeMenu: '/o2o-console',
          requiredPermissions: ['orders:view'],
          keepAlive: true,
          preloadTargets: ['o2o-console-inbound'],
        },
      },
      {
        path: 'inbound',
        redirect: '/inbound-manage',
        meta: {
          title: '入库管理',
          menu: false,
          menuOrder: 40,
          activeMenu: '/inbound-manage',
          requiredAnyPermissions: ['inbound:view', 'inbound:verify'],
          keepAlive: true,
        },
      },
    ],
  },
  {
    path: 'system',
    name: 'system',
    redirect: '/system/configs',
    meta: {
      title: '系统治理',
      icon: 'UserFilled',
      menuGroup: '系统管理',
      menuOrder: 50,
      requiredAnyPermissions: ['system_configs:view', 'db_migration:view', 'users:view', 'audit_logs:view'],
      allowedRoles: ['admin', 'operator'],
      shortcut: {
        title: '系统配置',
        description: '维护双流水参数与审计留痕',
        order: 40,
        path: '/system/configs',
        icon: 'Setting',
        colorClass: 'text-brand dark:text-teal-300',
        bgClass: 'bg-brand/10 dark:bg-brand/20',
      },
    },
    children: [
      {
        path: 'configs',
        name: 'system-configs',
        component: routeViewLoaders['system-configs'],
        meta: {
          title: '系统配置',
          menuOrder: 10,
          activeMenu: '/system',
          requiredPermissions: ['system_configs:view'],
          keepAlive: true,
          preloadTargets: ['system-db-migration', 'system-users', 'system-client-users'],
        },
      },
      {
        path: 'db-migration',
        name: 'system-db-migration',
        component: routeViewLoaders['system-db-migration'],
        meta: {
          title: '数据库迁移助手',
          menuOrder: 15,
          activeMenu: '/system',
          requiredPermissions: ['db_migration:view'],
          shortcut: {
            title: '数据库迁移',
            description: '进入数据库迁移助手，完成预检、迁移、切换与回退',
            order: 27,
            path: '/system/db-migration',
            icon: 'Refresh',
            colorClass: 'text-secondary dark:text-slate-200',
            bgClass: 'bg-secondary/10 dark:bg-secondary/20',
          },
          keepAlive: true,
          preloadTargets: ['system-configs', 'system-audit-logs'],
        },
      },
      {
        path: 'users',
        name: 'system-users',
        component: routeViewLoaders['system-users'],
        meta: {
          title: '用户中心',
          menuOrder: 20,
          activeMenu: '/system',
          requiredPermissions: ['users:view'],
          keepAlive: true,
          viewKey: 'user-center',
          suppressGlobalLoadingBar: true,
          preloadTargets: ['system-client-users', 'system-audit-logs'],
        },
      },
      {
        path: 'client-users',
        name: 'system-client-users',
        component: routeViewLoaders['system-client-users'],
        meta: {
          title: '用户中心',
          menu: false,
          menuOrder: 30,
          activeMenu: '/system/users',
          requiredPermissions: ['users:view'],
          keepAlive: true,
          viewKey: 'user-center',
          suppressGlobalLoadingBar: true,
          preloadTargets: ['system-audit-logs'],
        },
      },
      {
        path: 'audit-logs',
        name: 'system-audit-logs',
        component: routeViewLoaders['system-audit-logs'],
        meta: {
          title: '审计日志',
          menuOrder: 40,
          activeMenu: '/system',
          requiredPermissions: ['audit_logs:view'],
          keepAlive: true,
        },
      },
    ],
  },
]

/**
 * 最终路由表：
 * - 根路由统一挂载布局组件；
 * - 登录页独立于主布局之外；
 * - 404 页面独立于主布局之外，避免错误页继承业务壳层。
 */
export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: routeViewLoaders.login,
    meta: {
      title: '登录',
      menu: false,
      guestOnly: true,
    } satisfies AppRouteMeta,
  },
  {
    path: '/client/login',
    name: 'client-login',
    component: routeViewLoaders['client-login'],
    meta: {
      title: '客户端登录',
      menu: false,
      clientGuestOnly: true,
    } satisfies AppRouteMeta,
  },
  {
    path: '/client/forgot-password',
    name: 'client-forgot-password',
    component: routeViewLoaders['client-forgot-password'],
    meta: {
      title: '找回密码',
      menu: false,
      clientGuestOnly: true,
    } satisfies AppRouteMeta,
  },
  {
    path: '/client',
    component: routeViewLoaders['client-layout'],
    redirect: '/client/mall',
    meta: {
      title: '客户端入口',
      menu: false,
      requiresClientAuth: true,
    } satisfies AppRouteMeta,
    children: [
      {
        path: 'mall',
        name: 'client-mall',
        component: routeViewLoaders['client-mall'],
        meta: {
          title: '商品大厅',
          menu: false,
          clientNav: true,
          clientNavOrder: 10,
          requiresClientAuth: true,
          keepAlive: true,
          preloadTargets: ['client-orders', 'client-cart', 'client-profile'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'orders',
        name: 'client-orders',
        component: routeViewLoaders['client-orders'],
        meta: {
          title: '我的订单',
          menu: false,
          clientNav: true,
          clientNavOrder: 20,
          requiresClientAuth: true,
          keepAlive: true,
          preloadTargets: ['client-order-detail', 'client-mall'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'cart',
        name: 'client-cart',
        component: routeViewLoaders['client-cart'],
        meta: {
          title: '购物车',
          menu: false,
          requiresClientAuth: true,
          keepAlive: true,
          preloadTargets: ['client-checkout', 'client-mall'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'checkout',
        name: 'client-checkout',
        component: routeViewLoaders['client-checkout'],
        meta: {
          title: '确认订单',
          menu: false,
          requiresClientAuth: true,
          preloadTargets: ['client-orders', 'client-order-detail'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'profile',
        name: 'client-profile',
        component: routeViewLoaders['client-profile'],
        meta: {
          title: '我的',
          menu: false,
          clientNav: true,
          clientNavOrder: 30,
          requiresClientAuth: true,
          keepAlive: true,
          preloadTargets: ['client-orders'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'orders/:id',
        name: 'client-order-detail',
        component: routeViewLoaders['client-order-detail'],
        meta: {
          title: '订单详情',
          menu: false,
          requiresClientAuth: true,
          preloadTargets: ['client-orders'],
        } satisfies AppRouteMeta,
      },
    ],
  },
  {
    path: '/',
    component: routeViewLoaders.appLayout,
    redirect: '/dashboard',
    meta: {
      title: '应用布局',
      menu: false,
      requiresAuth: true,
    } satisfies AppRouteMeta,
    children: layoutChildren as RouteRecordRaw[],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: routeViewLoaders['not-found'],
    meta: {
      title: '页面不存在',
      menu: false,
    } satisfies AppRouteMeta,
  },
]

/**
 * 将子路由 path 解析为绝对路径：
 * - 兼容 '/foo' 与 'foo/bar' 两类写法；
 * - 保证菜单与快捷入口派生时得到稳定的完整路径。
 */
const resolveRoutePath = (parentPath: string, routePath: string): string => {
  if (routePath.startsWith('/')) {
    return routePath
  }

  const normalizedParent = parentPath === '/' ? '' : parentPath.replace(/\/$/, '')
  return `${normalizedParent}/${routePath}`
}

/**
 * 按菜单顺序排序：
 * - 未配置 menuOrder 的路由自动落到后面；
 * - 保证菜单与快捷入口在不同页面中呈现顺序一致。
 */
const sortByMenuOrder = <T extends { meta: AppRouteMeta }>(records: T[]): T[] => {
  return [...records].sort((prev, next) => {
    return (prev.meta.menuOrder ?? Number.MAX_SAFE_INTEGER) - (next.meta.menuOrder ?? Number.MAX_SAFE_INTEGER)
  })
}

/**
 * 当前用户是否可访问某条路由：
 * - 优先按 requiredPermissions / requiredAnyPermissions 做细粒度权限点校验；
 * - allowedRoles 仅作为兼容兜底，避免历史配置立即失效。
 */
export const canAccessRoute = (
  meta: Pick<AppRouteMeta, 'requiredPermissions' | 'requiredAnyPermissions' | 'allowedRoles'>,
  user?: Pick<UserSafeProfile, 'role' | 'permissions'> | null,
) => {
  const permissionSet = new Set(user?.permissions ?? [])

  if (meta.requiredPermissions?.length) {
    const hasAllPermissions = meta.requiredPermissions.every((permission) => permissionSet.has(permission))
    if (!hasAllPermissions) {
      return false
    }
  }

  if (meta.requiredAnyPermissions?.length) {
    const hasAnyPermission = meta.requiredAnyPermissions.some((permission) => permissionSet.has(permission))
    if (!hasAnyPermission) {
      return false
    }
  }

  if (meta.allowedRoles?.length) {
    return Boolean(user?.role && meta.allowedRoles.includes(user.role))
  }

  return true
}

/**
 * 派生侧边栏菜单树：
 * - 仅使用 menu !== false 的路由；
 * - 会基于当前角色过滤无权限菜单项；
 * - 父级路由保留子节点结构，用于渲染展开菜单。
 */
const deriveMenuItems = (records: AppRouteRecord[], user?: Pick<UserSafeProfile, 'role' | 'permissions'> | null, parentPath = '/'): AppMenuItem[] => {
  const collectedItems: AppMenuItem[] = []

  sortByMenuOrder(records).forEach((record) => {
    if (record.meta.menu === false || !canAccessRoute(record.meta, user)) {
      return
    }

    const fullPath = resolveRoutePath(parentPath, record.path)
    const hasConfiguredChildren = Boolean(record.children?.length)
    const children = record.children ? deriveMenuItems(record.children, user, fullPath) : []

    /**
     * 父级自动隐藏策略：
     * - 当父节点声明了子路由，但当前用户对所有子节点都无访问权限时，父级不再降级成“空壳可点菜单”；
     * - 避免出现点击父级后立即触发路由守卫拦截的割裂体验。
     */
    if (hasConfiguredChildren && children.length === 0) {
      return
    }

    collectedItems.push({
      title: record.meta.title,
      path: fullPath,
      icon: record.meta.icon,
      group: record.meta.menuGroup,
      children: children.length > 0 ? children : undefined,
    })
  })

  return collectedItems
}

const canAccessClientRoute = (
  meta: Pick<AppRouteMeta, 'requiresClientAuth' | 'clientGuestOnly'>,
  context: { isAuthenticated: boolean },
) => {
  if (meta.requiresClientAuth && !context.isAuthenticated) {
    return false
  }

  if (meta.clientGuestOnly && context.isAuthenticated) {
    return false
  }

  return true
}

const sortByClientNavOrder = <T extends { meta?: RouteMeta }>(records: T[]) => {
  return [...records].sort((prev, next) => {
    const prevMeta = (prev.meta ?? {}) as AppRouteMeta
    const nextMeta = (next.meta ?? {}) as AppRouteMeta
    const prevOrder = prevMeta.clientNavOrder ?? prevMeta.menuOrder ?? Number.MAX_SAFE_INTEGER
    const nextOrder = nextMeta.clientNavOrder ?? nextMeta.menuOrder ?? Number.MAX_SAFE_INTEGER
    return prevOrder - nextOrder
  })
}

const deriveClientNavigationItems = (
  records: RouteRecordRaw[],
  context: { isAuthenticated: boolean },
  parentPath: string,
): ClientNavigationItem[] => {
  const collectedItems: ClientNavigationItem[] = []

  sortByClientNavOrder(records).forEach((record) => {
    if (typeof record.path !== 'string') {
      return
    }

    const meta = (record.meta ?? {}) as AppRouteMeta
    if (!canAccessClientRoute(meta, context)) {
      return
    }

    const fullPath = resolveRoutePath(parentPath, record.path)
    const childRecords = Array.isArray(record.children) ? record.children : []
    const children = childRecords.length ? deriveClientNavigationItems(childRecords, context, fullPath) : []
    const hasConfiguredChildren = childRecords.length > 0
    const includeSelf = meta.clientNav === true

    if (hasConfiguredChildren && children.length === 0) {
      return
    }

    if (!includeSelf && children.length === 0) {
      return
    }

    collectedItems.push({
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : fullPath,
      path: fullPath,
      children: children.length > 0 ? children : undefined,
    })
  })

  return collectedItems
}

/**
 * 派生工作台快捷入口：
 * - 仅消费配置了 shortcut 的顶层业务路由；
 * - 同时按当前角色过滤无权限入口，避免普通用户看到管理员卡片。
 */
const deriveShortcutItems = (
  records: AppRouteRecord[],
  user?: Pick<UserSafeProfile, 'role' | 'permissions'> | null,
  parentPath = '/',
): DashboardShortcutItem[] => {
  /**
   * 递归收集快捷入口：
   * - 既支持顶层业务路由，也支持系统治理等子路由自行声明快捷入口；
   * - 让“数据库迁移助手”这类深层页面也能直接出现在工作台，减少菜单查找成本。
   */
  const collectedEntries: Array<{ order: number; item: DashboardShortcutItem }> = []

  const collectFromRecords = (sourceRecords: AppRouteRecord[], currentParentPath: string) => {
    sortByMenuOrder(sourceRecords)
      .filter((record) => canAccessRoute(record.meta, user))
      .forEach((record) => {
        const fullPath = resolveRoutePath(currentParentPath, record.path)
        const shortcut = record.meta.shortcut
        if (shortcut) {
          collectedEntries.push({
            order: shortcut.order ?? record.meta.menuOrder ?? Number.MAX_SAFE_INTEGER,
            item: {
              title: shortcut.title ?? record.meta.title,
              description: shortcut.description,
              path: shortcut.path ?? fullPath,
              icon: shortcut.icon ?? record.meta.icon,
              colorClass: shortcut.colorClass ?? 'text-brand dark:text-teal-300',
              bgClass: shortcut.bgClass ?? 'bg-brand/10 dark:bg-brand/20',
            },
          })
        }

        if (record.children?.length) {
          collectFromRecords(record.children, fullPath)
        }
      })
  }

  collectFromRecords(records, parentPath)

  const sortedEntries = [...collectedEntries].sort((prev, next) => prev.order - next.order)
  return sortedEntries.map((entry) => entry.item)
}

/**
 * 布局菜单与快捷入口导出函数：
 * - AppLayout 与 Dashboard 根据当前用户角色动态获取；
 * - 确保“路由 = 菜单 = 快捷入口 = 权限”始终同源。
 */
export const buildAppMenuItems = (user?: Pick<UserSafeProfile, 'role' | 'permissions'> | null) => deriveMenuItems(layoutChildren, user)
export const buildDashboardShortcutItems = (user?: Pick<UserSafeProfile, 'role' | 'permissions'> | null) =>
  deriveShortcutItems(layoutChildren, user)
export const buildClientNavigationItems = (context: { isAuthenticated: boolean }): ClientNavigationItem[] => {
  const clientRootRoute = routes.find((record) => record.path === '/client')
  const clientChildren = Array.isArray(clientRootRoute?.children) ? clientRootRoute.children : []
  return deriveClientNavigationItems(clientChildren, context, '/client')
}

/**
 * 解析“首个可访问管理端路由”：
 * - 按菜单顺序遍历，确保回退目标稳定、可预期；
 * - 优先返回首个可访问子路由，避免父路由 redirect 指向无权限页面导致循环告警；
 * - 仅返回菜单可见页面，保证回退后用户能在侧栏找到当前位置。
 */
const findFirstAccessibleManagementPath = (
  records: AppRouteRecord[],
  user?: Pick<UserSafeProfile, 'role' | 'permissions'> | null,
  parentPath = '/',
): string | null => {
  const sortedRecords = sortByMenuOrder(records)
  for (const record of sortedRecords) {
    if (!canAccessRoute(record.meta, user)) {
      continue
    }

    const fullPath = resolveRoutePath(parentPath, record.path)
    if (record.children?.length) {
      const firstAccessibleChildPath = findFirstAccessibleManagementPath(record.children, user, fullPath)
      if (firstAccessibleChildPath) {
        return firstAccessibleChildPath
      }
    }

    if (record.meta.menu !== false) {
      return fullPath
    }
  }

  return null
}

export const resolveFirstAccessibleManagementPath = (user?: Pick<UserSafeProfile, 'role' | 'permissions'> | null) => {
  return findFirstAccessibleManagementPath(layoutChildren, user)
}
