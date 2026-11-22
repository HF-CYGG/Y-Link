/** 局部加载系统配置与供货页签，导入失败留在当前面板，重试只重建异步子组件。 */
import { defineAsyncComponent, defineComponent, h, onBeforeUnmount, onErrorCaptured, ref, type Component, type VNode } from 'vue'
import { ElButton } from 'element-plus/es/components/button/index.mjs'

export const defineRetryablePanel = (load: () => Promise<{ default: Component }>) => defineComponent({
  inheritAttrs: false,
  emits: ['panel-mounted'],
  setup(_, { attrs, emit, slots }) {
    const attempt = ref(0)
    let disposed = false
    let loadedPanel: Component | undefined
    let loadError: Error | undefined
    onBeforeUnmount(() => { disposed = true })
    onErrorCaptured((error) => {
      // 仅隔离这一份模块导入，业务组件的渲染和事件错误继续走原路由边界。
      if (error === loadError) return false
    })

    const component = defineAsyncComponent({
      suspensible: false,
      delay: 0,
      loadingComponent: defineComponent({
        inheritAttrs: false,
        setup: () => () => h('p', { class: ['py-6 text-center text-sm', attrs.class], role: 'status' }, '正在加载面板…'),
      }),
      errorComponent: defineComponent({
        inheritAttrs: false,
        setup: () => () => h('div', { class: ['space-y-3 py-6 text-center', attrs.class], role: 'alert' }, [
          h('p', '面板加载失败'),
          h(ElButton, { onClick: () => { attempt.value += 1 } }, { default: () => '重试' }),
        ]),
      }),
      loader: async () => {
        try {
          loadedPanel = (await load()).default
          return loadedPanel
        } catch (cause) {
          if (disposed) return () => null
          loadError = new Error('面板加载失败', { cause })
          throw loadError
        }
      },
    })

    return () => h(component, {
      ...attrs,
      key: attempt.value,
      onVnodeMounted: (vnode: VNode) => {
        if (vnode.type === loadedPanel) emit('panel-mounted')
      },
    }, slots)
  },
})
