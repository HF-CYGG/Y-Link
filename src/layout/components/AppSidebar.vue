<script setup lang="ts">
/**
 * 模块说明：src/layout/components/AppSidebar.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { computed } from 'vue'
import { useRoute } from 'vue-router'
import type { AppMenuItem } from '@/router/routes'
import { useAppStore } from '@/store'

interface Props {
  menuItems: AppMenuItem[]
}

const props = defineProps<Props>()
const route = useRoute()
const appStore = useAppStore()

/**
 * 将菜单按分组整理：
 * - 菜单分组信息全部来自路由 meta.menuGroup；
 * - 未配置分组的菜单自动归入“导航”。
 */
const groupedMenuItems = computed(() => {
  const groups = new Map<string, AppMenuItem[]>()

  props.menuItems.forEach((item) => {
    const groupName = item.group ?? '导航'
    const currentItems = groups.get(groupName) ?? []
    currentItems.push(item)
    groups.set(groupName, currentItems)
  })

  return Array.from(groups.entries()).map(([groupName, items]) => ({
    groupName,
    items,
  }))
})

/**
 * 当前高亮菜单：
 * - 优先使用路由 meta.activeMenu，兼容子页面归属父菜单的需求；
 * - 若未指定，则退回当前访问路径。
 */
const hasMenuPath = (items: AppMenuItem[], path: string): boolean => {
  return items.some((item) => {
    if (item.path === path) {
      return true
    }

    return item.children ? hasMenuPath(item.children, path) : false
  })
}

const activePath = computed(() => {
  if (hasMenuPath(props.menuItems, route.path)) {
    return route.path
  }

  const activeMenu = typeof route.meta.activeMenu === 'string' ? route.meta.activeMenu : ''
  return activeMenu || route.path
})

/**
 * 当前需要展开的父级菜单：
 * - 基于 matched 路由链推导，保证进入基础资料子页时侧边栏自动展开；
 * - 仅保留真实存在子菜单的路径。
 */
const openedMenuPaths = computed(() => {
  const parentMenuPathSet = new Set(
    props.menuItems.filter((item) => item.children?.length).map((item) => item.path),
  )

  return route.matched
    .map((item) => item.path)
    .filter((path) => path !== activePath.value && parentMenuPathSet.has(path))
})

/**
 * 侧栏壳层样式：
 * - phone：固定定位抽屉，跟随 store 控制开合；
 * - tablet：保留常驻侧栏，但缩窄宽度与信息密度；
 * - desktop：使用完整宽度的常驻侧栏。
 */
const sidebarClass = computed(() => {
  if (appStore.isPhone) {
    return [
      'fixed inset-y-0 left-0 z-40 w-[84vw] max-w-[296px] shadow-2xl transition-transform duration-300 ease-out',
      appStore.sidebarOpened ? 'translate-x-0' : '-translate-x-full',
    ]
  }

  if (appStore.isTablet) {
    return 'relative z-20 w-[228px]'
  }

  return 'relative z-20 w-64'
})

/**
 * 菜单点击处理：
 * - phone 模式下点击菜单后自动收起抽屉；
 * - tablet / desktop 模式保持常驻侧栏不受影响。
 */
const handleMenuSelect = () => {
  if (appStore.isPhone) {
    appStore.closeSidebar()
  }
}

/**
 * 底部设备文案：
 * - 让当前布局模式可见，便于在开发和验收阶段快速确认。
 */
const deviceLabel = computed(() => {
  if (appStore.isPhone) {
    return '手机布局'
  }

  if (appStore.isTablet) {
    return '平板布局'
  }

  return '桌面布局'
})
</script>

<template>
  <button
    v-if="appStore.shouldUseDrawerSidebar"
    aria-label="关闭导航遮罩"
    :class="[
      'fixed inset-0 z-30 bg-slate-950/45 transition-opacity duration-300',
      appStore.sidebarOpened ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
    ]"
    @click="appStore.closeSidebar"
  />

  <aside
    :class="[
      'app-sidebar flex flex-shrink-0 flex-col border-r border-slate-200/60 bg-white/95 backdrop-blur-md dark:border-white/5 dark:bg-[#141415]/95',
      sidebarClass,
    ]"
  >
    <div
      :class="[
        'flex h-16 items-center border-b border-slate-200/60 dark:border-white/5',
        appStore.isDesktop ? 'px-6' : 'px-4',
      ]"
    >
      <div class="text-xl font-bold text-brand dark:text-teal-400">Y-Link</div>
      <div v-if="!appStore.isPhone" class="ml-2 truncate text-xs text-slate-400 dark:text-slate-500">
        出库管理
      </div>
    </div>

    <div :class="['flex-1 overflow-y-auto', appStore.isDesktop ? 'px-3 py-4' : 'px-2.5 py-3']">
      <div v-for="group in groupedMenuItems" :key="group.groupName" class="mb-5 last:mb-0">
        <p
          :class="[
            'pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500',
            appStore.isDesktop ? 'px-3' : 'px-2',
          ]"
        >
          {{ group.groupName }}
        </p>

        <el-menu
          :key="group.groupName"
          :default-active="activePath"
          :default-openeds="openedMenuPaths"
          class="app-sidebar-menu border-none bg-transparent"
          :class="appStore.isTablet ? 'app-sidebar-menu--compact' : ''"
          router
          @select="handleMenuSelect"
        >
          <template v-for="menu in group.items" :key="menu.path">
            <el-sub-menu v-if="menu.children?.length" :index="menu.path">
              <template #title>
                <el-icon v-if="menu.icon"><component :is="menu.icon" /></el-icon>
                <span>{{ menu.title }}</span>
              </template>

              <el-menu-item v-for="child in menu.children" :key="child.path" :index="child.path">
                {{ child.title }}
              </el-menu-item>
            </el-sub-menu>

            <el-menu-item v-else :index="menu.path">
              <el-icon v-if="menu.icon"><component :is="menu.icon" /></el-icon>
              <template #title>{{ menu.title }}</template>
            </el-menu-item>
          </template>
        </el-menu>
      </div>
    </div>

    <div class="border-t border-slate-200/60 p-4 text-center text-xs text-slate-500 dark:border-white/5 dark:text-slate-400">
      {{ deviceLabel }}
    </div>
  </aside>
</template>

<style scoped>
/*
 * 侧边栏菜单透明化：
 * - 保留毛玻璃背景；
 * - 统一激活态与悬停态在明暗主题下的视觉反馈。
 */
:deep(.app-sidebar-menu) {
  background-color: transparent !important;
}

:deep(.app-sidebar-menu .el-menu) {
  background-color: transparent !important;
}

:deep(.app-sidebar-menu .el-sub-menu .el-menu) {
  background-color: transparent !important;
}

:deep(.app-sidebar-menu .el-menu-item),
:deep(.app-sidebar-menu .el-sub-menu__title) {
  min-height: 44px;
  border-radius: 12px;
}

:deep(.app-sidebar-menu .el-sub-menu .el-menu-item) {
  background-color: transparent !important;
}

:deep(.app-sidebar-menu--compact .el-menu-item),
:deep(.app-sidebar-menu--compact .el-sub-menu__title) {
  min-height: 40px;
  padding-left: 12px !important;
  padding-right: 12px !important;
  font-size: 13px;
}

:deep(.app-sidebar-menu .el-menu-item:hover),
:deep(.app-sidebar-menu .el-sub-menu__title:hover) {
  background-color: rgba(0, 91, 82, 0.05) !important;
}

.dark :deep(.app-sidebar-menu .el-menu-item:hover),
.dark :deep(.app-sidebar-menu .el-sub-menu__title:hover) {
  background-color: rgba(255, 255, 255, 0.06) !important;
}

:deep(.app-sidebar-menu .el-menu-item.is-active) {
  background-color: rgba(0, 91, 82, 0.1) !important;
  border-right: 3px solid var(--el-color-primary);
  color: var(--el-color-primary) !important;
  font-weight: 600;
}

.dark :deep(.app-sidebar-menu .el-menu-item.is-active) {
  background-color: rgba(77, 140, 133, 0.2) !important;
  border-right: 3px solid #7be0d5;
  color: #7be0d5 !important;
}
</style>
