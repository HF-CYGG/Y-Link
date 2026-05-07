/**
 * 模块说明：src/composables/useCrudManager.ts
 * 文件职责：提供管理端高频 CRUD 页面共享的列表、弹窗、提交与删除编排能力，统一提交反馈规范。
 * 实现逻辑：
 * - 收口列表加载、弹窗新增/编辑、提交保存、删除确认、本地同步与重载策略，减少页面重复脚本；
 * - 在共享层统一处理提交中状态、重复点击防护、前端校验失败提示与失败文案归一化；
 * - 通过配置注入页面独有的表单映射、接口方法与后处理回调，保持公共骨架稳定、业务差异外置。
 * 维护说明：
 * - 若后续有新的 CRUD 页面接入，应优先复用本 composable，而不是复制提交逻辑；
 * - 若要扩展批量提交、只读详情、草稿保存等能力，应优先在此处补齐共享状态机。
 */

import { ref, type Ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import type { RequestConfig } from '@/api/http'
import { useIdempotentAction } from '@/composables/useIdempotentAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'

/**
 * 通用 CRUD 表单约束：
 * - 当前主数据页面都以 id 是否存在区分新增与编辑；
 * - 通过基础约束让通用逻辑可以安全判断操作模式。
 */
interface CrudFormModel {
  id?: string
}

/**
 * CRUD 成功与失败文案配置：
 * - 统一沉淀页面交互用语，避免每个页面重复拼装消息；
 * - 页面只需声明业务文案，通用 composable 负责在正确时机触发。
 */
interface CrudManagerMessages {
  createTitle: string
  editTitle: string
  submitPending?: string
  duplicateSubmit?: string
  validateError?: string
  createSuccess: string
  updateSuccess: string
  saveError: string
  loadError: string
  deleteConfirm: string
  deleteSuccess: string
  deleteError: string
  confirmTitle?: string
}

/**
 * 通用 CRUD 配置项：
 * - 页面提供自己的实体类型、表单映射和接口实现；
 * - composable 只编排通用流程，不感知具体字段细节。
 */
type CrudSubmitSyncMode = 'reload' | 'local'

interface CrudManagerConfig<TEntity extends { id: string }, TForm extends CrudFormModel, TPayload> {
  formRef?: Ref<FormInstance | undefined>
  createDefaultForm: () => TForm
  buildEditForm: (row: TEntity) => TForm
  buildSubmitPayload: (form: TForm) => Promise<TPayload> | TPayload
  loadList: (requestConfig?: RequestConfig) => Promise<TEntity[] | null | undefined>
  createItem: (payload: TPayload) => Promise<TEntity>
  updateItem: (id: string, payload: TPayload) => Promise<TEntity>
  deleteItem: (id: string) => Promise<unknown>
  messages: CrudManagerMessages
  afterSubmit?: (context: {
    mode: 'create' | 'update'
    rowId: string | undefined
    payload: TPayload
    form: TForm
    result: TEntity
  }) => Promise<void> | void
  syncAfterSubmit?: (context: {
    mode: 'create' | 'update'
    rowId: string | undefined
    payload: TPayload
    form: TForm
    result: TEntity
    items: TEntity[]
  }) => Promise<CrudSubmitSyncMode> | CrudSubmitSyncMode
  afterDelete?: (context: {
    row: TEntity
    items: TEntity[]
  }) => Promise<void> | void
}

/**
 * 通用主数据 CRUD 管理 composable：
 * - 统一封装列表加载、弹窗开关、表单提交、删除确认与本地列表同步；
 * - 通过配置驱动兼容不同实体字段，降低页面脚本的重复度；
 * - 页面仍保留自己的查询条件、表单规则和视图结构，确保交互不变。
 */
export const useCrudManager = <
  TEntity extends { id: string },
  TForm extends CrudFormModel,
  TPayload,
>(config: CrudManagerConfig<TEntity, TForm, TPayload>) => {
  const items = ref<TEntity[]>([]) as Ref<TEntity[]>
  const loading = ref(true)
  const dialogVisible = ref(false)
  const dialogTitle = ref(config.messages.createTitle)
  const formRef = config.formRef || ref<FormInstance>()
  const submitting = ref(false)
  const form = ref(config.createDefaultForm()) as Ref<TForm>
  const listRequest = useStableRequest()
  const submitAction = useIdempotentAction()

  /**
   * 加载列表数据：
   * - 由页面传入真实查询逻辑，兼容有筛选条件与无筛选条件两类页面；
   * - 统一处理加载态与失败提示，减少重复 try/catch。
   */
  const loadData = async () => {
    loading.value = true
    await listRequest.runLatest({
      executor: (signal) => config.loadList({ signal }),
      onSuccess: (result) => {
        items.value = result || []
      },
      onError: (error) => {
        ElMessage.error(extractErrorMessage(error, config.messages.loadError))
      },
      onFinally: () => {
        loading.value = false
      },
    })
  }

  /**
   * 打开新增弹窗：
   * - 始终回到默认表单，避免残留上一次编辑数据；
   * - 标题由配置提供，保证页面语义清晰。
   */
  const handleAdd = () => {
    form.value = config.createDefaultForm()
    dialogTitle.value = config.messages.createTitle
    dialogVisible.value = true
  }

  /**
   * 打开编辑弹窗：
   * - 由页面提供实体到表单的映射逻辑；
   * - 通用层只负责切换标题与弹窗状态。
   */
  const handleEdit = (row: TEntity) => {
    form.value = config.buildEditForm(row)
    dialogTitle.value = config.messages.editTitle
    dialogVisible.value = true
  }

  /**
   * 删除列表项：
   * - 先进行统一确认，再调用删除接口；
   * - 删除成功后同步移除本地列表，保持当前页面即时反馈。
   */
  const handleDelete = async (row: TEntity) => {
    try {
      await ElMessageBox.confirm(
        config.messages.deleteConfirm,
        config.messages.confirmTitle || '提示',
        { type: 'warning' },
      )
      await config.deleteItem(row.id)
      ElMessage.success(config.messages.deleteSuccess)

      const index = items.value.findIndex((item) => item.id === row.id)
      if (index > -1) {
        items.value.splice(index, 1)
      }

      await config.afterDelete?.({
        row,
        items: items.value,
      })
    } catch (error) {
      if (error !== 'cancel' && error !== 'close') {
        ElMessage.error(extractErrorMessage(error, config.messages.deleteError))
      }
    }
  }

  /**
   * 提交新增/编辑表单：
   * - 统一先走表单校验，再构建业务 payload；
   * - 成功后关闭弹窗并重新加载列表，确保服务端结果为最终事实来源。
   */
  const handleSubmit = async () => {
    if (!formRef.value) {
      return
    }

    if (submitting.value) {
      ElMessage.warning(config.messages.duplicateSubmit || '正在提交，请勿重复点击')
      return
    }

    const isValid = await formRef.value.validate().catch(() => false)
    if (!isValid) {
      ElMessage.warning(config.messages.validateError || '请先完善表单必填项后再提交')
      return
    }

    const submitResult = await submitAction.runWithGate({
      actionKey: 'crud-submit',
      onDuplicated: () => {
        ElMessage.warning(config.messages.duplicateSubmit || '正在提交，请勿重复点击')
      },
      executor: async () => {
        submitting.value = true
        ElMessage.info(config.messages.submitPending || '正在提交，请稍候')
        try {
          const currentForm = form.value
          const payload = await config.buildSubmitPayload(currentForm)
          const rowId = currentForm.id
          const isEdit = Boolean(rowId)
          const mode = isEdit ? 'update' : 'create'
          let result: TEntity

          if (isEdit && rowId) {
            result = await config.updateItem(rowId, payload)
            ElMessage.success(config.messages.updateSuccess)
          } else {
            result = await config.createItem(payload)
            ElMessage.success(config.messages.createSuccess)
          }

          await config.afterSubmit?.({
            mode,
            rowId,
            payload,
            form: currentForm,
            result,
          })

          dialogVisible.value = false
          const syncMode = await config.syncAfterSubmit?.({
            mode,
            rowId,
            payload,
            form: currentForm,
            result,
            items: items.value,
          })

          if (syncMode !== 'local') {
            void loadData()
          }

          return true
        } catch (error) {
          ElMessage.error(extractErrorMessage(error, config.messages.saveError))
          return false
        } finally {
          submitting.value = false
        }
      },
    })

    if (submitResult === null) {
      return
    }
  }

  return {
    items,
    loading,
    dialogVisible,
    dialogTitle,
    formRef,
    submitting,
    form,
    loadData,
    handleAdd,
    handleEdit,
    handleDelete,
    handleSubmit,
  }
}
