<script setup lang="ts">
/**
 * 模块说明：src/views/base-data/components/TagManager.vue
 * 文件职责：负责标签主数据维护与标签聚合统计查询，并复用统一的响应式列表壳输出桌面表格与移动卡片。
 * 实现逻辑：
 * - 通过 `useCrudManager` 统一处理标签新增、编辑、删除与列表刷新；
 * - 通过 `useStableRequest` 承接统计查询，只保留最后一次筛选结果，避免重复点击导致旧统计覆盖；
 * - 通过列表共享壳在桌面展示表格、在移动端展示卡片；
 * - 对标签列表显式关闭逐项卡片过渡，避免 keep-alive 恢复、刷新列表和统计联动时批量重排造成操作迟滞。
 * 维护说明：
 * - 标签页本身数据量通常较小，但在弱机和移动端仍容易被频繁动画放大体感卡顿，后续保持“稳态优先”即可；
 * - 若统计区后续新增图表，优先异步化图表子块，不要阻塞主列表交互。
 */


import dayjs from 'dayjs'
import { computed, onActivated, onMounted, ref } from 'vue'
import { type FormInstance, type FormRules } from 'element-plus'
import { getTagAggregate, type TagAggregateResult } from '@/api/modules/dashboard'
import { createTag, deleteTag, getTagList, updateTag, type CreateTagDto, type Tag } from '@/api/modules/tag'
import {
  BizCrudDialogShell,
  BizResponsiveDataCollectionShell,
  PageToolbarCard,
} from '@/components/common'
import { useCrudManager } from '@/composables/useCrudManager'
import { usePermissionAction } from '@/composables/usePermissionAction'
import { useStableRequest } from '@/composables/useStableRequest'
import { extractErrorMessage } from '@/utils/error'
import { normalizeSubmitText } from '@/utils/submit-feedback'


import { showAppError, showAppWarning } from '@/utils/app-alert'

const formRef = ref<FormInstance>()
const { hasPermission, ensurePermission } = usePermissionAction()
const canManageTags = computed(() => hasPermission('tags:manage'))
const pageReady = ref(false)
const keepAliveActivated = ref(false)
const aggregateLoading = ref(false)
const aggregateResult = ref<TagAggregateResult | null>(null)
const aggregateRequest = useStableRequest()
const aggregateDateRange = ref<[string, string]>([
  dayjs().subtract(30, 'day').format('YYYY-MM-DD'),
  dayjs().format('YYYY-MM-DD'),
])
const aggregateTagId = ref('')
const aggregateOrderType = ref<'' | 'department' | 'walkin'>('')

/**
 * 标签表单类型：
 * - 对齐当前弹窗中的两个可编辑字段；
 * - 独立类型可让通用 CRUD composable 正确推断表单结构。
 */
interface TagForm {
  id: string
  tagName: string
  tagCode: string
}

/**
 * 标签表单模型：
 * - 通过工厂函数沉淀默认值；
 * - 确保新增、编辑关闭后再次打开时行为一致。
 */
const createDefaultForm = (): TagForm => ({
  id: '',
  tagName: '',
  tagCode: '#409EFF',
})

/**
 * 表单规则：
 * - 限制标签名称不能为空；
 * - 颜色选择必填，保证标签展示稳定。
 */
const rules: FormRules = {
  tagName: [{ required: true, message: '请输入标签名称', trigger: 'blur' }],
  tagCode: [{ required: true, message: '请选择标签颜色', trigger: 'change' }],
}

/**
 * 预置色板：
 * - 提供常用业务色，减少用户随意输入导致的视觉失控；
 * - 保留色值文案，便于复制与识别。
 */
const predefinedColors = [
  '#ff4500', '#ff8c00', '#ffd700', '#90ee90', '#00ced1', '#1e90ff', '#c71585',
  '#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399',
]

/**
 * 编辑标签：
 * - 回填当前标签名称与颜色；
 * - 若服务端颜色为空则回退到默认主色。
 */
const buildEditForm = (row: Tag): TagForm => ({
  id: row.id,
  tagName: row.tagName,
  tagCode: row.tagCode || '#409EFF',
})

/**
 * 将标签表单映射为提交 payload：
 * - 统一由页面声明实体字段到接口 DTO 的转换；
 * - 让新增与编辑都走相同的数据构造规则。
 */
const buildSubmitPayload = (currentForm: TagForm): CreateTagDto => ({
  tagName: normalizeSubmitText(currentForm.tagName),
  tagCode: normalizeSubmitText(currentForm.tagCode),
})

const upsertTag = (tag: Tag) => {
  const currentIndex = tags.value.findIndex((item) => item.id === tag.id)

  if (currentIndex > -1) {
    tags.value.splice(currentIndex, 1, tag)
    return
  }

  tags.value.unshift(tag)
}

/**
 * 通用 CRUD 管理：
 * - 收敛标签页的列表加载、弹窗表单、提交保存与删除确认；
 * - 页面只保留标签独有的色板配置和视图结构。
 */
const {
  items: tags,
  loading,
  dialogVisible,
  dialogTitle,
  submitting,
  form,
  loadData,
  handleAdd,
  handleEdit,
  handleDelete,
  handleSubmit,
} = useCrudManager<Tag, TagForm, CreateTagDto>({
  formRef,
  createDefaultForm,
  buildEditForm,
  buildSubmitPayload,
  loadList: getTagList,
  createItem: createTag,
  updateItem: updateTag,
  deleteItem: deleteTag,
  messages: {
    createTitle: '新增标签',
    editTitle: '编辑标签',
    submitPending: '正在提交标签信息，请稍候',
    duplicateSubmit: '标签信息正在提交，请勿重复点击',
    validateError: '请先完善标签名称与颜色后再提交',
    createSuccess: '创建成功',
    updateSuccess: '更新成功',
    saveError: '保存失败',
    loadError: '获取标签失败',
    deleteConfirm: '确定要删除该标签吗？',
    deleteSuccess: '删除成功',
    deleteError: '删除失败',
  },
  syncAfterSubmit: ({ result }) => {
    upsertTag(result)
    return 'local'
  },
})

const refreshTagView = async () => {
  await loadData()
  if (!aggregateTagId.value && tags.value.length > 0) {
    aggregateTagId.value = tags.value[0].id
  }
}

const aggregateSummary = computed(() => {
  if (!aggregateResult.value) {
    return []
  }

  return [
    {
      key: 'totalQuantity',
      label: '总数量',
      value: `${Number(aggregateResult.value.totalQuantity ?? 0).toFixed(2)} 件`,
    },
    {
      key: 'totalAmount',
      label: '总金额',
      value: `¥${Number(aggregateResult.value.totalAmount ?? 0).toFixed(2)}`,
    },
    {
      key: 'orderCount',
      label: '订单数',
      value: `${aggregateResult.value.orderCount} 单`,
    },
    {
      key: 'productCount',
      label: '产品数',
      value: `${aggregateResult.value.productCount} 种`,
    },
  ]
})

const handleAggregateSearch = async () => {
  if (!aggregateTagId.value.trim()) {
    showAppWarning('请选择标签后再查询统计')
    return
  }

  aggregateLoading.value = true
  await aggregateRequest.runLatest({
    executor: (signal) =>
      getTagAggregate(
        aggregateTagId.value,
        {
          dateRange: aggregateDateRange.value,
          orderType: aggregateOrderType.value || undefined,
        },
        { signal },
      ),
    onSuccess: (result) => {
      aggregateResult.value = result
    },
    onError: (error) => {
      showAppError(extractErrorMessage(error, '获取标签统计失败'))
    },
    onFinally: () => {
      aggregateLoading.value = false
    },
  })
}

const handleAggregateReset = () => {
  aggregateOrderType.value = ''
  aggregateDateRange.value = [dayjs().subtract(30, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')]
  if (!aggregateTagId.value && tags.value.length > 0) {
    aggregateTagId.value = tags.value[0].id
  }
  handleAggregateSearch().catch(() => undefined)
}

const handleAddTag = () => {
  if (!ensurePermission('tags:manage', '新增标签')) {
    return
  }
  handleAdd()
}

const handleEditTag = (row: Tag) => {
  if (!ensurePermission('tags:manage', '编辑标签')) {
    return
  }
  handleEdit(row)
}

const handleDeleteTag = async (row: Tag) => {
  if (!ensurePermission('tags:manage', '删除标签')) {
    return
  }
  await handleDelete(row)
}

const handleSubmitTag = async () => {
  if (!ensurePermission('tags:manage', '保存标签')) {
    return
  }
  await handleSubmit()
}

onMounted(() => {
  pageReady.value = true
  refreshTagView().then(() => handleAggregateSearch()).catch(() => undefined)
})

onActivated(() => {
  if (!pageReady.value) {
    return
  }

  if (!keepAliveActivated.value) {
    keepAliveActivated.value = true
    return
  }

  refreshTagView().then(() => handleAggregateSearch()).catch(() => undefined)
})
</script>

<template>
  <div class="tag-manager flex min-w-0 flex-col gap-3 sm:gap-4">
    <PageToolbarCard compact :action-stretch-on-phone="false">
      <template #default>
        <div class="max-w-3xl text-xs leading-5 text-slate-500 dark:text-slate-400 sm:text-sm sm:leading-6">统一维护标签名称与颜色，用于产品分类展示，并为产品检索、筛选与视觉识别提供稳定标签体系。</div>
      </template>

      <template #actions="{ isPhone }">
        <div class="grid w-full grid-cols-2 gap-2">
          <el-tag v-if="!canManageTags" type="info">当前为只读模式</el-tag>
          <el-button v-if="canManageTags" :class="isPhone ? 'w-full min-w-0' : ''" type="primary" icon="Plus" @click="handleAddTag">新增标签</el-button>
          <el-button :class="isPhone ? 'w-full min-w-0' : ''" icon="Refresh" @click="refreshTagView">刷新列表</el-button>
        </div>
      </template>
    </PageToolbarCard>

    <div class="apple-card p-3 sm:p-5 xl:p-6">
      <div class="flex flex-wrap items-center gap-2 sm:gap-3">
        <el-select
          v-model="aggregateTagId"
          filterable
          placeholder="请选择标签"
          :class="['!w-full', 'sm:!w-[220px]']"
        >
          <el-option v-for="item in tags" :key="item.id" :label="item.tagName" :value="item.id" />
        </el-select>
        <el-date-picker
          v-model="aggregateDateRange"
          type="daterange"
          unlink-panels
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :class="['!w-full', 'sm:!w-[320px]']"
        />
        <el-select
          v-model="aggregateOrderType"
          clearable
          placeholder="订单类型（可选）"
          :class="['!w-full', 'sm:!w-[180px]']"
        >
          <el-option label="部门单" value="department" />
          <el-option label="散客单" value="walkin" />
        </el-select>
        <div class="flex w-full gap-2 sm:w-auto">
          <el-button class="flex-1 sm:flex-none" type="primary" :loading="aggregateLoading" @click="handleAggregateSearch">
            查询统计
          </el-button>
          <el-button class="flex-1 sm:flex-none" :disabled="aggregateLoading" @click="handleAggregateReset">重置</el-button>
        </div>
      </div>
      <div v-if="aggregateLoading" class="mt-3 sm:mt-4">
        <el-skeleton animated :rows="4" />
      </div>
      <div v-else-if="aggregateResult" class="mt-3 space-y-2 sm:mt-4 sm:space-y-3">
        <div class="tag-aggregate-current truncate rounded-xl bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500 dark:bg-slate-900/40 dark:text-slate-300 sm:px-3 sm:py-2">
          {{ aggregateResult.tagName }} ｜ {{ aggregateDateRange[0] }} 至 {{ aggregateDateRange[1] }} ｜ {{ aggregateOrderType ? (aggregateOrderType === 'department' ? '部门单' : '散客单') : '全部订单类型' }}
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-4">
          <div v-for="item in aggregateSummary" :key="item.key" class="rounded-xl bg-slate-50 px-2.5 py-2 dark:bg-slate-900/40 sm:px-3 sm:py-2.5">
            <div class="text-xs text-slate-500 dark:text-slate-400">{{ item.label }}</div>
            <div class="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{{ item.value }}</div>
          </div>
        </div>
      </div>
      <div v-else class="mt-3 flex min-h-[88px] items-center justify-center rounded-xl bg-slate-50 text-slate-400 dark:bg-slate-900/40 sm:mt-4 sm:min-h-[110px]">
        <el-empty :image-size="56" description="请选择标签并查询统计" />
      </div>
    </div>

    <BizResponsiveDataCollectionShell
      :items="tags"
      :loading="loading"
      empty-description="暂无标签数据"
      :empty-card="true"
      :disable-card-transition="true"
      card-key="id"
      wrapper-class="flex min-h-0 flex-1 flex-col"
      table-wrapper-class="apple-card h-full min-w-0 overflow-hidden px-0 py-3 sm:py-4 xl:py-5"
      card-container-class="pb-3 xl:grid-cols-3"
    >
      <template #table>
        <el-table native-scrollbar :data="tags" class="h-full w-full" stripe row-key="id" table-layout="auto">
            <el-table-column label="标签名称" prop="tagName" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <el-tag :color="row.tagCode || '#409EFF'" effect="dark" class="border-none">
                  {{ row.tagName }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="颜色编码" prop="tagCode" min-width="220" show-overflow-tooltip />
            <el-table-column v-if="canManageTags" label="操作" width="160" fixed="right" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEditTag(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeleteTag(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
      </template>

      <template #card="{ item }">
        <div class="apple-card flex min-w-0 flex-col justify-between gap-2 p-3 sm:gap-4 sm:p-4">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <el-tag :color="item.tagCode || '#409EFF'" effect="dark" class="min-w-0 border-none">
              {{ item.tagName }}
            </el-tag>
            <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">{{ item.tagCode || '#409EFF' }}</span>
          </div>
          <div v-if="canManageTags" class="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-2 dark:border-white/10 sm:pt-3">
            <el-button size="small" @click="handleEditTag(item)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="handleDeleteTag(item)">删除</el-button>
          </div>
        </div>
      </template>
    </BizResponsiveDataCollectionShell>

    <BizCrudDialogShell
      v-if="canManageTags"
      v-model="dialogVisible"
      :title="dialogTitle"
      height-mode="auto"
      phone-width="92%"
      tablet-width="640px"
      desktop-width="500px"
      :confirm-loading="submitting"
      dialog-class="tag-dialog"
      @confirm="handleSubmitTag"
    >
      <template #default="{ isPhone }">
        <el-form ref="formRef" :model="form" :rules="rules" :label-width="isPhone ? '82px' : '80px'">
          <el-form-item label="标签名称" prop="tagName">
            <el-input v-model="form.tagName" placeholder="请输入标签名称" />
          </el-form-item>
          <el-form-item label="标签颜色" prop="tagCode">
            <div class="flex flex-wrap items-center gap-3">
              <el-color-picker v-model="form.tagCode" :predefine="predefinedColors" />
              <span class="text-slate-500 dark:text-slate-400">{{ form.tagCode }}</span>
            </div>
          </el-form-item>
        </el-form>
      </template>
    </BizCrudDialogShell>
  </div>
</template>
