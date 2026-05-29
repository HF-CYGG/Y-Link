<!--
  模块说明：F:/Y-Link/src/layout/components/AppSidebar.vue
  文件职责：管理端侧边导航壳组件，负责把“可见菜单 + 分组结构 + 当前高亮 + 设备形态”统一渲染为稳定导航区。
  实现逻辑：接收父层按权限过滤后的 menuItems，按 `highlight/group` 规则拆分重点入口与常规分组；结合 `route.path`、`route.meta.activeMenu`、`route.matched` 计算当前激活项与默认展开项；根据 appStore 的 phone/tablet/desktop 状态切换抽屉式或常驻式侧栏布局。
  维护说明：若调整路由 meta 字段（如 `activeMenu`、`menuGroup`、`menuHighlight`）或菜单生成策略（`buildAppMenuItems`），需同步回归三类场景：权限裁剪后的菜单可见性、移动端抽屉开合与遮罩行为、spotlight 与常规分组不重复展示。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { APP_META } from '@/constants/app-meta'
import type { AppMenuItem } from '@/router/routes'
import { useAppStore } from '@/store'
import pinia from '@/store/pinia'

interface Props {
  menuItems: AppMenuItem[]
}

const props = defineProps<Props>()
const route = useRoute()
const appStore = useAppStore(pinia)

/**
 * 需要被单独突出的工作台入口：
 * - 由路由 meta.menuHighlight 驱动，不在侧栏里再手写业务常量；
 * - 当前用于把客服工作台从系统治理分组中单独提炼出来。
 */
const spotlightMenuItems = computed(() => {
  return props.menuItems.filter((item) => item.highlight === 'spotlight')
})

/**
 * 将常规菜单按分组整理：
 * - 菜单分组信息全部来自路由 meta.menuGroup；
 * - 已被单独突出的入口不再重复渲染到普通分组中。
 * - 未配置分组的菜单自动归入“导航”。
 */
const groupedMenuItems = computed(() => {
  const groups = new Map<string, AppMenuItem[]>()

  props.menuItems
    .filter((item) => item.highlight !== 'spotlight')
    .forEach((item) => {
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
      <div v-if="spotlightMenuItems.length" class="mb-5">
        <p
          :class="[
            'pb-2 text-xs font-semibold uppercase tracking-[0.18em] text-brand/75 dark:text-teal-300/80',
            appStore.isDesktop ? 'px-3' : 'px-2',
          ]"
        >
          重点工作台
        </p>

        <div class="space-y-2">
          <router-link
            v-for="menu in spotlightMenuItems"
            :key="menu.path"
            :to="menu.path"
            class="app-sidebar__spotlight-item"
            :class="activePath === menu.path ? 'is-active' : ''"
            @click="handleMenuSelect"
          >
            <div class="flex items-start gap-3">
              <span class="app-sidebar__spotlight-icon">
                <el-icon v-if="menu.icon"><component :is="menu.icon" /></el-icon>
                <span v-else>客</span>
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-semibold">{{ menu.title }}</p>
                <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-300">优先处理反馈会话、Issue 字段和客服回复。</p>
              </div>
            </div>
          </router-link>
        </div>
      </div>

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
          :collapse-transition="false"
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

    <div class="border-t border-slate-200/60 p-4 dark:border-white/5">
      <div class="app-sidebar__build-signature">
        <div class="app-sidebar__build-row">
          <span class="app-sidebar__build-badge">{{ APP_META.version }}</span>
          <span class="app-sidebar__device-pill">{{ deviceLabel }}</span>
        </div>
        <div class="app-sidebar__build-row app-sidebar__build-row--secondary">
          <span class="app-sidebar__build-author">{{ APP_META.developer }}</span>
          <a
            class="app-sidebar__repo-link"
            :href="APP_META.repositoryUrl"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub 仓库"
          >
            <svg class="app-sidebar__repo-icon" aria-hidden="true">
              <use href="/icons.svg#github-icon"></use>
            </svg>
            {{ APP_META.repositoryLabel }}
          </a>
        </div>
      </div>
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
  position: relative;
  overflow: hidden;
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
  background-color: #2f5f5a !important;
  border-right: 3px solid #b8fff5;
  color: #ffffff !important;
}

/*
 * 重点工作台卡片：
 * - 用更强的底色和图标壳强调高频入口；
 * - 激活态保持与主品牌色一致，避免和普通菜单混淆。
 */
.app-sidebar__spotlight-item {
  display: block;
  border: 1px solid rgba(15, 118, 110, 0.14);
  border-radius: 20px;
  background:
    linear-gradient(180deg, rgba(240, 253, 250, 0.98), rgba(255, 255, 255, 0.96));
  box-shadow: 0 14px 30px -28px rgba(15, 23, 42, 0.4);
  color: rgb(15 23 42);
  padding: 0.9rem 0.95rem;
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    border-color 0.18s ease;
}

.app-sidebar__spotlight-item:hover {
  border-color: rgba(15, 118, 110, 0.3);
  box-shadow: 0 18px 36px -28px rgba(15, 118, 110, 0.28);
  transform: translateY(-1px);
}

.app-sidebar__spotlight-item.is-active {
  border-color: rgba(15, 118, 110, 0.44);
  box-shadow: 0 22px 42px -30px rgba(15, 118, 110, 0.34);
}

.app-sidebar__spotlight-icon {
  display: inline-flex;
  height: 2.25rem;
  width: 2.25rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  background: rgb(15 118 110);
  color: rgb(240 253 250);
  font-size: 0.95rem;
  font-weight: 700;
}

.dark .app-sidebar__spotlight-item {
  border-color: rgba(45, 212, 191, 0.18);
  background:
    linear-gradient(180deg, rgba(23, 37, 37, 0.96), rgba(20, 20, 21, 0.98));
  box-shadow: 0 16px 30px -24px rgba(0, 0, 0, 0.45);
  color: rgb(241 245 249);
}

.dark .app-sidebar__spotlight-item:hover,
.dark .app-sidebar__spotlight-item.is-active {
  border-color: rgba(94, 234, 212, 0.28);
  box-shadow: 0 18px 34px -22px rgba(13, 148, 136, 0.28);
}

.dark .app-sidebar__spotlight-icon {
  background: rgb(17 94 89);
  color: rgb(240 253 250);
}

/* 侧栏切页时抑制子菜单箭头过渡抖动，避免出现右侧短暂残影。 */
:deep(.app-sidebar-menu .el-sub-menu__icon-arrow) {
  transition: none !important;
}

.app-sidebar__build-signature {
  display: flex;
  flex-direction: column;
  gap: 0.62rem;
  max-width: 100%;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(248, 250, 252, 0.78));
  box-shadow:
    0 16px 34px -28px rgba(15, 23, 42, 0.48),
    inset 0 1px 0 rgba(255, 255, 255, 0.86);
  padding: 0.78rem 0.86rem;
  backdrop-filter: blur(18px);
}

.app-sidebar__build-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-width: 0;
  gap: 0.75rem;
}

.app-sidebar__build-row--secondary {
  padding-top: 0.62rem;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.app-sidebar__build-badge {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  border-radius: 9999px;
  background: #0f766e;
  color: #f0fdfa;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  padding: 0.38rem 0.64rem;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.app-sidebar__device-pill {
  min-width: 0;
  color: #64748b;
  font-size: 0.68rem;
  font-weight: 600;
  line-height: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-sidebar__build-author {
  min-width: 0;
  color: #475569;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-sidebar__repo-link {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  flex: 0 0 auto;
  color: #0f766e;
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.2;
  text-decoration: none;
  word-break: break-word;
}

.app-sidebar__repo-icon {
  width: 0.9rem;
  height: 0.9rem;
  flex: 0 0 auto;
}

.app-sidebar__repo-link:hover {
  text-decoration: underline;
}

.dark .app-sidebar__build-signature {
  border-color: rgba(255, 255, 255, 0.08);
  background:
    linear-gradient(180deg, rgba(24, 24, 27, 0.9), rgba(15, 23, 42, 0.82));
  box-shadow:
    0 16px 34px -26px rgba(0, 0, 0, 0.72),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.dark .app-sidebar__build-badge {
  background: #115e59;
  color: #f0fdfa;
}

.dark .app-sidebar__build-row--secondary {
  border-top-color: rgba(255, 255, 255, 0.08);
}

.dark .app-sidebar__device-pill {
  color: #94a3b8;
}

.dark .app-sidebar__build-author {
  color: #e2e8f0;
}

.dark .app-sidebar__repo-link {
  color: #5eead4;
}

.dark .app-sidebar__repo-icon {
  filter: invert(1);
}
</style>
