import { ref, type Ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import type { RequestConfig } from '@/api/http'
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
interface CrudManagerConfig<TEntity extends { id: string }, TForm extends CrudFormModel, TPayload> {
  formRef?: Ref<FormInstance | undefined>
  createDefaultForm: () => TForm
  buildEditForm: (row: TEntity) => TForm
  buildSubmitPayload: (form: TForm) => Promise<TPayload> | TPayload
  loadList: (requestConfig?: RequestConfig) => Promise<TEntity[] | null | undefined>
  createItem: (payload: TPayload) => Promise<unknown>
  updateItem: (id: string, payload: TPayload) => Promise<unknown>
  deleteItem: (id: string) => Promise<unknown>
  messages: CrudManagerMessages
  afterSubmit?: (context: {
    mode: 'create' | 'update'
    rowId: string | undefined
    payload: TPayload
    form: TForm
  }) => Promise<void> | void
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

    const isValid = await formRef.value.validate().catch(() => false)
    if (!isValid) {
      return
    }

    submitting.value = true
    try {
      const currentForm = form.value
      const payload = await config.buildSubmitPayload(currentForm)
      const rowId = currentForm.id
      const isEdit = Boolean(rowId)

      if (isEdit && rowId) {
        await config.updateItem(rowId, payload)
        ElMessage.success(config.messages.updateSuccess)
      } else {
        await config.createItem(payload)
        ElMessage.success(config.messages.createSuccess)
      }

      await config.afterSubmit?.({
        mode: isEdit ? 'update' : 'create',
        rowId,
        payload,
        form: currentForm,
      })

      dialogVisible.value = false
      void loadData()
    } catch (error) {
      ElMessage.error(extractErrorMessage(error, config.messages.saveError))
    } finally {
      submitting.value = false
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
