/**
 * 模块说明：src/composables/useDataChangeRefresh.ts
 * 文件职责：让被 KeepAlive 缓存的页面在其他页面改动过商品、部门等基础数据后，及时静默刷新对应数据。
 * 实现逻辑：
 * - 记录本页最近一次“已同步”的数据版本，页面停用期间发生的变更在下次激活时触发 refresh；
 * - 页面激活期间收到的变更同样立即刷新：请求层信号不携带来源，其他页面的慢写请求可能在用户切回后才返回，
 *   不能据“当前处于激活状态”认定是本页自身操作而跳过；本页自身写操作因此会多一次静默刷新，换取不漏刷；
 * - 刷新严格串行：同一时刻只跑一次 refresh，完成后若期间又出现新版本就继续补刷，
 *   避免连续写入触发的并发刷新以“先发后到”的旧响应覆盖新数据、或让已同步版本倒退；
 * - 首次挂载紧随的激活版本未变，不会额外请求；
 * - 只有刷新明确成功才推进已同步版本：refresh 抛错或返回 false 时停止补刷并保留待刷新状态，后续变更或下次激活继续重试。
 * 维护说明：
 * - refresh 只负责重新拉取选项或列表，不要在其中重置用户的筛选、分页和已填写内容；
 * - 内部吞掉错误、只弹提示的加载函数必须在失败时返回 false，否则失败会被当作已同步而不再重试；
 * - 未被 KeepAlive 缓存的组件每次进入都会重新挂载，无需接入。
 */

import { onActivated, onDeactivated, watch } from 'vue'
import { dataChangeVersions, type DataChangeDomain } from '@/utils/data-change-signal'

export const useDataChangeRefresh = (domains: DataChangeDomain[], refresh: () => unknown) => {
  const readVersions = () => domains.map((domain) => dataChangeVersions[domain])
  const isSynced = (versions: number[]) => versions.every((version, index) => version === syncedVersions[index])
  let syncedVersions = readVersions()
  let active = true
  let refreshing = false

  const refreshIfStale = async () => {
    // 已有刷新在跑时不再并发发起；它结束后会重新比对版本，期间的新变更由那一轮补刷。
    if (refreshing) {
      return
    }
    refreshing = true
    try {
      // 停用后不再补刷，剩余变更留到下次激活处理，避免后台页持续请求。
      while (active) {
        const targetVersions = readVersions()
        if (isSynced(targetVersions)) {
          return
        }
        let succeeded = false
        try {
          succeeded = (await refresh()) !== false
        } catch {
          succeeded = false
        }
        // 网络临时失败时不能推进版本，否则不会再重试，例如开单页商品候选会停在未就绪状态。
        if (!succeeded) {
          return
        }
        syncedVersions = targetVersions
      }
    } finally {
      refreshing = false
    }
  }

  watch(readVersions, () => {
    if (active) {
      void refreshIfStale()
    }
  })

  onDeactivated(() => {
    active = false
  })

  onActivated(() => {
    active = true
    void refreshIfStale()
  })
}
