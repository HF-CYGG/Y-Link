import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'

interface RouteBoundWorkbenchOptions<T extends string> {
  fallbackTab: T
  routeNameToTab: Partial<Record<string, T>>
  tabToPath: Record<T, string>
  tabToComponent: Record<T, Component>
}

// 把“路由名 -> 当前标签 -> 当前组件 -> 切换跳转路径”的公共模式收口成组合式函数。
// 三个工作台只需要提供映射关系，不再重复编写 useRoute/useRouter/computed/push 逻辑。
export const useRouteBoundWorkbenchTab = <T extends string>(options: RouteBoundWorkbenchOptions<T>) => {
  const route = useRoute()
  const router = useRouter()

  const activeTab = computed<T>(() => {
    const routeName = typeof route.name === 'string' ? route.name : ''
    return options.routeNameToTab[routeName] ?? options.fallbackTab
  })

  const activeComponent = computed(() => {
    return options.tabToComponent[activeTab.value]
  })

  const handleTabChange = (value: string | number) => {
    const candidateTab = String(value) as T
    const nextTab = options.tabToPath[candidateTab] ? candidateTab : options.fallbackTab
    void router.push(options.tabToPath[nextTab])
  }

  return {
    activeTab,
    activeComponent,
    handleTabChange,
  }
}
