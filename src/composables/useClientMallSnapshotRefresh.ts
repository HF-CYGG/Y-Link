/**
 * 模块说明：src/composables/useClientMallSnapshotRefresh.ts
 * 文件职责：为购物车、结算页等非商城主页面提供“静默同步最新商品目录”的轻量刷新能力。
 * 实现逻辑：
 * - 复用 `useStableRequest` 统一治理旧请求取消，只保留最后一次目录刷新结果；
 * - 拉取到最新商品后，同时回写商品目录缓存与购物车库存快照，保证两个域口径一致；
 * - 整个刷新过程默认静默执行，不阻塞页面首屏交互，适合在购物车、结算等辅助页面后台预热。
 * 维护说明：
 * - 若后续商品目录接口拆分为“库存/价格/营销”多路接口，可继续在此处收敛并行刷新逻辑；
 * - 若调用方需要用户可见的错误提示，请在页面层消费返回值，不要在本文件内直接弹窗。
 */
import { ref } from 'vue'
import { getO2oMallProducts } from '@/api/modules/o2o'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientCartStore, useClientCatalogStore } from '@/store'
import pinia from '@/store/pinia'
import { normalizeRequestError, type AppRequestError } from '@/utils/error'

export const useClientMallSnapshotRefresh = () => {
  const clientCartStore = useClientCartStore(pinia)
  const clientCatalogStore = useClientCatalogStore(pinia)
  const { runLatest, cancel } = useStableRequest()
  const syncing = ref(false)

  /**
   * 静默刷新商城目录快照：
   * - 成功时同步更新目录缓存与购物车库存映射；
   * - 失败时返回归一化错误对象，由页面层自行决定是否展示；
   * - 不额外抛错，避免辅助刷新影响主流程。
   */
  const refreshMallSnapshot = async (): Promise<AppRequestError | null> => {
    let requestError: AppRequestError | null = null
    syncing.value = true
    await runLatest({
      executor: (signal) => getO2oMallProducts({ signal }),
      onSuccess: (products) => {
        clientCatalogStore.setProducts(products)
        clientCartStore.syncWithCatalog(products)
      },
      onError: (error) => {
        requestError = normalizeRequestError(error, '商品目录同步失败，请稍后重试')
      },
      onFinally: () => {
        syncing.value = false
      },
    })
    return requestError
  }

  return {
    syncing,
    refreshMallSnapshot,
    cancel,
  }
}
