/**
 * 模块说明：src/composables/useDataChangeRefresh.ts
 * 文件职责：让被 KeepAlive 缓存的页面在重新激活时，若期间其他页面改动过商品、部门等基础数据，就静默刷新对应数据。
 * 实现逻辑：
 * - 记录本页最近一次“已同步”的数据版本，页面停用期间发生的变更在下次激活时触发 refresh；
 * - 页面处于激活状态时发生的变更只可能来自本页自己的写操作（本页已自行刷新），此时只同步基线，避免切回时重复加载；
 * - 首次挂载紧随的激活版本未变，不会额外请求；
 * - 只有刷新明确成功才推进已同步版本：refresh 抛错或返回 false 时保留待刷新状态，下次激活继续重试。
 * 维护说明：
 * - refresh 只负责重新拉取选项或列表，不要在其中重置用户的筛选、分页和已填写内容；
 * - 内部吞掉错误、只弹提示的加载函数必须在失败时返回 false，否则失败会被当作已同步而不再重试；
 * - 未被 KeepAlive 缓存的组件每次进入都会重新挂载，无需接入。
 */

import { onActivated, onDeactivated, watch } from 'vue'
import { dataChangeVersions, type DataChangeDomain } from '@/utils/data-change-signal'

export const useDataChangeRefresh = (domains: DataChangeDomain[], refresh: () => unknown) => {
  const readVersions = () => domains.map((domain) => dataChangeVersions[domain])
  let syncedVersions = readVersions()
  let active = true

  watch(readVersions, (nextVersions) => {
    if (active) {
      syncedVersions = nextVersions
    }
  })

  onDeactivated(() => {
    active = false
  })

  onActivated(() => {
    active = true
    const currentVersions = readVersions()
    if (currentVersions.every((version, index) => version === syncedVersions[index])) {
      return
    }
    // 网络临时失败时不能推进版本，否则切回页面也不会再重试，例如开单页商品候选会停在未就绪状态。
    void Promise.resolve()
      .then(() => refresh())
      .then((result) => {
        if (result !== false) {
          syncedVersions = currentVersions
        }
      })
      .catch(() => undefined)
  })
}
