/**
 * 文件职责：管理自动迁移主卡片的连接测试结果，不创建任务或修改运行时数据库配置。
 * 实现逻辑：复用预检与稳定请求通道；连接参数变化、离页或后发请求会使旧结果失效。
 */
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import {
  precheckSQLiteToMySqlMigration,
  type MySqlMigrationTarget,
  type SQLiteToMySqlPrecheckResult,
} from '@/api/modules/data-maintenance'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'

export const useDatabaseMigrationConnectionTest = (
  getTarget: () => MySqlMigrationTarget,
  onInvalidate: () => void,
) => {
  const request = useStableRequest()
  const loading = ref(false)
  const result = ref<SQLiteToMySqlPrecheckResult | null>(null)
  const error = ref('')
  const invalidate = () => {
    request.cancel()
    loading.value = false
    result.value = null
    error.value = ''
    onInvalidate()
  }
  watch(getTarget, invalidate, { deep: true, flush: 'sync' })
  onDeactivated(invalidate)
  onBeforeUnmount(invalidate)

  const title = computed(() => {
    if (loading.value) return '正在测试连接并检查迁移条件…'
    if (error.value) return '连接测试未完成'
    if (!result.value) return ''
    if (!result.value.target.reachable) return '连接失败，请检查 MySQL 配置'
    return result.value.canProceed ? '连接成功，迁移预检通过' : '连接成功，但尚不满足迁移条件'
  })
  const alertType = computed(() => {
    if (loading.value) return 'info'
    if (error.value || !result.value?.target.reachable) return 'error'
    return result.value.canProceed ? 'success' : 'warning'
  })
  const testConnection = async (): Promise<SQLiteToMySqlPrecheckResult | null> => {
    loading.value = true
    result.value = null
    error.value = ''
    let accepted: SQLiteToMySqlPrecheckResult | null = null
    await request.runLatest({
      executor: (signal) => precheckSQLiteToMySqlMigration({
        target: getTarget(),
        allowTargetWithData: false,
      }, { signal }),
      onSuccess: (response) => {
        result.value = response
        accepted = response
      },
      onError: (cause) => {
        error.value = extractErrorMessage(cause, '连接测试请求未完成，请检查应用服务和网络后重试。')
      },
      onFinally: () => { loading.value = false },
    })
    return accepted
  }
  return { loading, result, error, title, alertType, testConnection }
}
