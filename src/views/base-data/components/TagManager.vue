<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { type FormInstance, type FormRules } from 'element-plus'
import { createTag, deleteTag, getTagList, updateTag, type CreateTagDto, type Tag } from '@/api/modules/tag'
import {
  BizCrudDialogShell,
  BizResponsiveDataCollectionShell,
  PageToolbarCard,
} from '@/components/common'
import { useCrudManager } from '@/composables/useCrudManager'

const formRef = ref<FormInstance>()

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
  tagName: currentForm.tagName,
  tagCode: currentForm.tagCode,
})

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
    createSuccess: '创建成功',
    updateSuccess: '更新成功',
    saveError: '保存失败',
    loadError: '获取标签失败',
    deleteConfirm: '确定要删除该标签吗？',
    deleteSuccess: '删除成功',
    deleteError: '删除失败',
  },
})

onMounted(() => {
  void loadData()
})
</script>

<template>
  <div class="tag-manager flex min-w-0 flex-col gap-4">
    <PageToolbarCard>
      <template #default>
        <div class="text-sm leading-6 text-slate-500 dark:text-slate-400">统一维护标签名称与颜色，用于产品分类展示。</div>
      </template>

      <template #actions="{ isPhone }">
        <el-button :class="isPhone ? 'flex-1' : ''" type="primary" icon="Plus" @click="handleAdd">新增标签</el-button>
        <el-button :class="isPhone ? 'flex-1' : ''" icon="Refresh" @click="loadData">刷新列表</el-button>
      </template>
    </PageToolbarCard>

    <BizResponsiveDataCollectionShell
      :items="tags"
      :loading="loading"
      empty-description="暂无标签数据"
      :empty-card="true"
      card-key="id"
    >
      <template #table>
        <el-table :data="tags" class="h-full w-full" stripe row-key="id">
            <el-table-column label="标签名称" prop="tagName">
              <template #default="{ row }">
                <el-tag :color="row.tagCode || '#409EFF'" effect="dark" class="border-none">
                  {{ row.tagName }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="颜色编码" prop="tagCode" />
            <el-table-column label="操作" width="150" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
      </template>

      <template #card="{ item }">
        <div class="apple-card mobile-tag-card flex min-w-0 flex-col justify-between gap-4 p-4">
          <div>
            <el-tag :color="item.tagCode || '#409EFF'" effect="dark" class="border-none" size="large">
              {{ item.tagName }}
            </el-tag>
            <div class="mt-3 break-all text-xs text-slate-500 dark:text-slate-400">{{ item.tagCode || '#409EFF' }}</div>
          </div>
          <div class="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3 dark:border-white/10">
            <el-button size="small" @click="handleEdit(item)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="handleDelete(item)">删除</el-button>
          </div>
        </div>
      </template>
    </BizResponsiveDataCollectionShell>

    <BizCrudDialogShell
      v-model="dialogVisible"
      :title="dialogTitle"
      phone-width="92%"
      tablet-width="640px"
      desktop-width="500px"
      :confirm-loading="submitting"
      dialog-class="tag-dialog"
      @confirm="handleSubmit"
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

<style scoped>
.mobile-tag-card {
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
</style>
