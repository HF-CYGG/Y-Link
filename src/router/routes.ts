/**
 * 模块说明：src/router/routes.ts
 * 文件职责：统一维护管理端与客户端的路由、菜单、快捷入口和权限元信息，本次继续细化客户端高频相邻页的预热顺序并收缩过度预加载。
 * 实现逻辑：
 * - 所有业务页面都通过 routeViewLoaders 做懒加载，保证路由、预热和权限入口保持同源；
 * - 产品中心共享工作台仍然由两个历史路由承接，但预热目标会按双入口互相补齐，确保壳层拆包后标签切换依旧平滑；
 * - 客户端路由的 preloadTargets 改为围绕真实相邻页面配置，把“最可能下一跳”排在前面，并减少低频页面顺手预热。
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
 * - hideClientBottomNav 用于会话页、详情页等沉浸式客户端页面主动收起底部导航。
 */
export interface AppRouteMeta extends RouteMeta {
  title: string
  icon?: ElementPlusIconName
  menu?: boolean
  menuOrder?: number
  menuGroup?: string
  menuStandalone?: boolean
  menuHighlight?: 'spotlight'
  clientNav?: boolean
  clientNavOrder?: number
  activeMenu?: string
  shortcut?: AppShortcutMeta
  requiresAuth?: boolean
  guestOnly?: boolean
  requiresClientAuth?: boolean
  clientGuestOnly?: boolean
  hideClientBottomNav?: boolean
  requiredPermissions?: PermissionCode[]
  requiredAnyPermissions?: PermissionCode[]
  allowedRoles?: UserRole[]
  keepAlive?: boolean
  preloadTargets?: AppRouteName[]
  deferPreloadOnColdStart?: boolean
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
  standalone?: boolean
  highlight?: 'spotlight'
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
      // 工作台仅预热最邻近的高频业务页：
      // - 出库开单与出库单列表是首页最常见下一跳；
      // - 产品中心、用户中心属于次级治理链路，继续在这里预热会额外拉起共享壳层子包，
      //   登录后与 Dashboard 首屏渲染争抢网络，得不偿失。
      preloadTargets: ['order-entry', 'order-list'],
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
    path: 'reports',
    name: 'reports',
    component: routeViewLoaders.reports,
    meta: {
      title: '报表中心',
      icon: 'DataAnalysis',
      menuGroup: '业务操作',
      menuOrder: 34,
      requiredPermissions: ['reports:view'],
      allowedRoles: ['admin', 'operator'],
      shortcut: {
        title: '报表中心',
        description: '查看库存、销售与出库流水并导出表格',
        order: 24,
        colorClass: 'text-brand dark:text-teal-300',
        bgClass: 'bg-brand/10 dark:bg-brand/20',
      },
      keepAlive: true,
      preloadTargets: ['order-list'],
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
          // 线上展示入口命中后，除了预热后续核销链路，也要把基础信息标签对应子包补齐，
          // 避免共享壳层拆包后，用户切回“基础信息”时再次等待子页面分包下载。
          preloadTargets: ['products', 'o2o-console-verify'],
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
    path: 'system/customer-service',
    name: 'system-customer-service',
    component: routeViewLoaders['system-customer-service'],
    meta: {
      title: '客服工作台',
      icon: 'Setting',
      menuOrder: 37,
      menuGroup: '业务操作',
      activeMenu: '/system/customer-service',
      // 客服工作台应与后端路由权限保持一致，避免只有客服权限的账号被前端菜单误挡住。
      requiredPermissions: ['customer_service:view'],
      keepAlive: true,
      preloadTargets: ['system-client-users'],
      deferPreloadOnColdStart: true,
    },
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
          // 系统治理页首次进入时优先让当前页先稳定显示：
          // - 系统配置原本会顺手预热数据库迁移与用户中心，冷启动时会把多个重模块一起拉起；
          // - 这里改为仅保留更轻量的治理链路，并结合 deferPreloadOnColdStart 避免首次进入时抢占带宽。
          preloadTargets: ['system-audit-logs'],
          deferPreloadOnColdStart: true,
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
          preloadTargets: ['system-audit-logs'],
          deferPreloadOnColdStart: true,
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
          preloadTargets: ['system-client-users'],
          deferPreloadOnColdStart: true,
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
          deferPreloadOnColdStart: true,
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
          deferPreloadOnColdStart: true,
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
          // 商城主入口优先预热“购物车 -> 订单列表”：
          // - 加购后去购物车是最高频下一跳；
          // - 订单列表是次高频回访入口；
          // - “我的”页改为按需再预热，避免首页冷启动顺手拉起过多非关键页面。
          preloadTargets: ['client-cart', 'client-orders'],
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
          // 订单列表优先照顾“详情查看”，其次才是回商城继续下单。
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
          // 购物车下一跳几乎总是结算，回商城作为补充链路保留在第二优先级。
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
          // 结算成功后会直接跳订单详情，因此先预热详情，再补列表页。
          preloadTargets: ['client-order-detail', 'client-orders'],
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
          // “我的”页进入反馈中心的频率高于回订单列表，因此先预热反馈页。
          preloadTargets: ['client-feedback', 'client-orders'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'feedback',
        name: 'client-feedback',
        component: routeViewLoaders['client-feedback'],
        meta: {
          title: '反馈会话',
          menu: false,
          requiresClientAuth: true,
          hideClientBottomNav: true,
          keepAlive: true,
          // 反馈会话页的高频下一跳是“新建反馈”和“进入详情”，返回个人页放在兜底位。
          preloadTargets: ['client-feedback-create', 'client-feedback-detail', 'client-profile'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'feedback/create',
        name: 'client-feedback-create',
        component: routeViewLoaders['client-feedback-create'],
        meta: {
          title: '新建反馈',
          menu: false,
          requiresClientAuth: true,
          hideClientBottomNav: true,
          // 新建成功后通常直达反馈详情，返回列表则作为第二落点预热。
          preloadTargets: ['client-feedback-detail', 'client-feedback'],
        } satisfies AppRouteMeta,
      },
      {
        path: 'feedback/:id',
        name: 'client-feedback-detail',
        component: routeViewLoaders['client-feedback-detail'],
        meta: {
          title: '反馈单详情',
          menu: false,
          requiresClientAuth: true,
          hideClientBottomNav: true,
          // 详情页返回主要回到会话列表，个人页仅作为后续兜底入口。
          preloadTargets: ['client-feedback', 'client-profile'],
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
          // 订单详情的主回退页是订单列表，避免顺手拉起更多低频页面。
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
    const nestedChildren = children.filter((item) => !item.standalone)
    const standaloneChildren = children.filter((item) => item.standalone)

    /**
     * 父级自动隐藏策略：
     * - 当父节点声明了子路由，但当前用户对所有子节点都无访问权限时，父级不再降级成“空壳可点菜单”；
     * - 避免出现点击父级后立即触发路由守卫拦截的割裂体验。
     */
    if (hasConfiguredChildren && nestedChildren.length === 0 && standaloneChildren.length === 0) {
      return
    }

    const currentMenuItem: AppMenuItem = {
      title: record.meta.title,
      // 父级菜单若已存在可访问子页，则直接指向首个可访问子页，
      // 避免先命中父级 redirect 再跳子页，放大系统治理冷启动等待感。
      path: nestedChildren.length > 0 ? nestedChildren[0].path : fullPath,
      icon: record.meta.icon,
      group: record.meta.menuGroup,
      highlight: record.meta.menuHighlight,
      standalone: record.meta.menuStandalone,
      children: nestedChildren.length > 0 ? nestedChildren : undefined,
    }

    /**
     * 独立导航自身也必须产出菜单项：
     * - 之前仅把 standalone 子节点从父分组里剥离，但没有把它自己写入 collectedItems；
     * - 结果就是“路由配置存在、权限也通过”，最终侧栏仍拿不到客服工作台这一项。
     */
    collectedItems.push(currentMenuItem)

    /**
     * 允许个别子页脱离父级分组，直接作为独立导航入口：
     * - 典型场景是高频工作台需要单独突出展示；
     * - 路由路径与权限仍然复用原有业务模块，不引入第二套路由真源。
     */
    if (standaloneChildren.length > 0) {
      collectedItems.push(...standaloneChildren)
    }
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
