/*
 * 文件说明：
 * 该文件用于封装“路由绑定型工作台标签切换”公共能力。
 * 调用方只需要提供路由名、标签名、跳转路径和承载组件之间的映射关系，
 * 即可复用当前激活标签计算、当前展示组件计算以及标签切换跳转逻辑。
 */
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'

// 统一约束共享工作台所需的四类映射配置，确保页面侧只声明业务差异。
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

  // 关键流程一：
  // 根据当前路由名称反推出应该高亮的标签。
  // 当路由名称未命中映射表时，回退到默认标签，保证工作台始终可用。
  const activeTab = computed<T>(() => {
    const routeName = typeof route.name === 'string' ? route.name : ''
    return options.routeNameToTab[routeName] ?? options.fallbackTab
  })

  // 关键流程二：
  // 根据当前激活标签选择实际渲染的业务组件，让统一工作台外壳承载不同页面内容。
  const activeComponent = computed(() => {
    return options.tabToComponent[activeTab.value]
  })

  // 关键流程三：
  // 标签切换时，先把组件事件值归一化为约定的标签类型，再映射到目标路由路径。
  // 如果传入了未知标签，则兜底跳回默认标签，避免错误值导致空白页或跳转异常。
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
