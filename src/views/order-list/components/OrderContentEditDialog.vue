<script setup lang="ts">
/**
 * 模块说明：`src/views/order-list/components/OrderContentEditDialog.vue`
 * 文件职责：在订单详情中编辑商品、SKU、数量、单价与备注，并提交乐观版本。
 * 实现逻辑：
 * - 打开时从详情快照初始化草稿，同时加载当前启用商品和 SKU；
 * - 历史/退役明细可原位减量或删除，新行只能选择当前启用 SKU；
 * - 金额仅作前端预览，最终合计、库存差额与 revision 全部由服务端重算并原子提交。
 * 维护说明：不得在前端推断或写库存；`legacy_none` 只展示服务端约定的不追溯提示。
 */

import { computed, ref, watch } from 'vue'
import { getProductList, type ProductRecord } from '@/api/modules/product'
import {
  updateOrderContent,
  type OrderDetailResult,
  type UpdateOrderContentPayload,
} from '@/api/modules/order'
import { BizCrudDialogShell } from '@/components/common'
import { showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { showCriticalErrorDialog } from '@/utils/error-dialog'

interface DraftRow {
  uid: string
  original: boolean
  productId: string
  skuId: string
  productName: string
  skuLabel: string
  qty: number
  unitPrice: number
  remark: string
}

const props = defineProps<{ modelValue: boolean; order: OrderDetailResult }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  committed: [result: Awaited<ReturnType<typeof updateOrderContent>>]
}>()

const products = ref<ProductRecord[]>([])
const rows = ref<DraftRow[]>([])
const reason = ref('')
const businessNo = ref('')
const loadingProducts = ref(false)
const committing = ref(false)
let rowSequence = 0

const inventoryNotice = computed(() => props.order.inventoryMode === 'legacy_none'
  ? '该历史订单未接入库存扣减。本次只修订单据内容，不追溯扣减或回补库存。'
  : '保存后将按新旧数量差额同步扣减或回补商品与 SKU 库存。')
const totalAmount = computed(() => rows.value.reduce(
  (sum, row) => sum + Number((Number(row.qty || 0) * Number(row.unitPrice || 0)).toFixed(2)),
  0,
).toFixed(2))

const productById = computed(() => new Map(products.value.map((product) => [product.id, product])))
const skuOptions = (row: DraftRow) => {
  const activeOptions = (productById.value.get(row.productId)?.skus ?? []).filter((sku) => sku.id && sku.isActive && sku.isCurrent)
  if (row.original && row.skuId && !activeOptions.some((sku) => sku.id === row.skuId)) {
    return [{ id: row.skuId, specText: row.skuLabel, skuCode: row.skuLabel, isActive: false, isCurrent: false }, ...activeOptions]
  }
  return activeOptions
}
const canKeepSkuEmpty = (row: DraftRow) => (
  row.original && props.order.inventoryMode === 'legacy_none' && !row.skuId
)

const initialize = async () => {
  rowSequence = 0
  rows.value = props.order.items.map((item) => ({
    uid: `existing-${item.id}`,
    original: true,
    productId: item.productId,
    skuId: item.skuId || '',
    productName: item.productName,
    skuLabel: item.specText || item.skuCode || '历史规格',
    qty: Number(item.qty),
    unitPrice: Number(item.unitPrice),
    remark: item.remark || '',
  }))
  reason.value = ''
  businessNo.value = props.order.businessNo
  loadingProducts.value = true
  try {
    products.value = await getProductList({ isActive: true })
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '商品候选加载失败',
      fallback: '暂时无法新增或替换明细，可关闭后重试',
      operation: '加载订单编辑商品候选',
    })
  } finally {
    loadingProducts.value = false
  }
}

watch(() => props.modelValue, (visible) => {
  if (visible) void initialize()
})

const addRow = () => {
  rowSequence += 1
  rows.value.push({
    uid: `new-${rowSequence}`,
    original: false,
    productId: '',
    skuId: '',
    productName: '',
    skuLabel: '',
    qty: 1,
    unitPrice: 0,
    remark: '',
  })
}

const handleProductChange = (row: DraftRow) => {
  row.skuId = ''
  const product = productById.value.get(row.productId)
  row.productName = product?.productName ?? ''
  const candidates = (product?.skus ?? []).filter((sku) => sku.id && sku.isActive && sku.isCurrent)
  if (candidates.length === 1) {
    row.skuId = String(candidates[0]?.id ?? '')
    row.unitPrice = Number(candidates[0]?.defaultPrice ?? product?.defaultPrice ?? 0)
  }
}

const validate = () => {
  if (!reason.value.trim()) return showAppWarning('请填写内容修改原因'), false
  if (!businessNo.value.trim()) return showAppWarning('业务单号不能为空'), false
  if (!rows.value.length) return showAppWarning('至少保留一条订单明细'), false
  for (const [index, row] of rows.value.entries()) {
    if (!row.productId || (!row.skuId && !canKeepSkuEmpty(row))) {
      return showAppWarning(`第 ${index + 1} 行请选择商品和规格`), false
    }
    if (!Number.isFinite(row.qty) || row.qty <= 0) return showAppWarning(`第 ${index + 1} 行数量必须大于 0`), false
    if (props.order.inventoryMode === 'manual_applied' && !Number.isSafeInteger(row.qty)) {
      return showAppWarning(`第 ${index + 1} 行数量必须为正整数`), false
    }
    if (!Number.isFinite(row.unitPrice) || row.unitPrice <= 0) return showAppWarning(`第 ${index + 1} 行单价必须大于 0`), false
  }
  return true
}

const commit = async () => {
  if (!validate()) return
  committing.value = true
  try {
    const payload: UpdateOrderContentPayload = {
      expectedVersion: props.order.editVersion,
      reason: reason.value.trim(),
      businessNo: businessNo.value.trim(),
      items: rows.value.map((row) => ({
        productId: row.productId,
        skuId: row.skuId,
        qty: row.qty,
        unitPrice: row.unitPrice,
        remark: row.remark.trim() || null,
      })),
    }
    const result = await updateOrderContent(props.order.id, payload)
    showAppSuccess(result.notice || '订单内容已更新')
    emit('committed', result)
    emit('update:modelValue', false)
  } catch (error) {
    void showCriticalErrorDialog(error, {
      title: '订单内容更新失败',
      fallback: '订单可能已被更新或库存不足，请刷新详情后重试',
      operation: '编辑订单内容',
    })
  } finally {
    committing.value = false
  }
}
</script>

<template>
  <BizCrudDialogShell
    :model-value="props.modelValue"
    title="编辑订单内容"
    height-mode="scroll"
    phone-width="96%"
    tablet-width="900px"
    desktop-width="1080px"
    dialog-class="order-content-edit-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="space-y-4">
      <el-alert :title="inventoryNotice" :type="order.inventoryMode === 'legacy_none' ? 'warning' : 'info'" :closable="false" show-icon />
      <el-form-item label="业务单号" required class="!mb-0">
        <el-input v-model="businessNo" maxlength="32" placeholder="沿用订单类型对应的 hyyz/hyyzjd 命名空间" />
      </el-form-item>
      <el-table v-loading="loadingProducts" :data="rows" border size="small" table-layout="auto">
        <el-table-column label="商品" min-width="190">
          <template #default="{ row }">
            <span v-if="row.original">{{ row.productName }}</span>
            <el-select v-else v-model="row.productId" filterable @change="handleProductChange(row)">
              <el-option v-for="product in products" :key="product.id" :label="`${product.productCode} · ${product.productName}`" :value="product.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="规格" min-width="180">
          <template #default="{ row }">
            <span v-if="canKeepSkuEmpty(row)">{{ row.skuLabel }}</span>
            <el-select v-else v-model="row.skuId" filterable :disabled="!row.productId">
              <el-option
                v-for="sku in skuOptions(row)"
                :key="sku.id"
                :label="sku.specText || sku.skuCode || '默认规格'"
                :value="String(sku.id)"
                :disabled="row.original && sku.id === row.skuId && (!sku.isActive || !sku.isCurrent)"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="140">
          <template #default="{ row }">
            <el-input-number
              v-model="row.qty"
              :min="order.inventoryMode === 'manual_applied' ? 1 : 0.01"
              :precision="order.inventoryMode === 'manual_applied' ? 0 : 2"
              controls-position="right"
            />
          </template>
        </el-table-column>
        <el-table-column label="单价" width="150">
          <template #default="{ row }"><el-input-number v-model="row.unitPrice" :min="0.01" :precision="2" controls-position="right" /></template>
        </el-table-column>
        <el-table-column label="备注" min-width="160">
          <template #default="{ row }"><el-input v-model="row.remark" maxlength="200" /></template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ $index }"><el-button link type="danger" @click="rows.splice($index, 1)">删除</el-button></template>
        </el-table-column>
      </el-table>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <el-button plain type="primary" @click="addRow">新增明细</el-button>
        <span class="text-sm text-slate-600">服务端重算前预览：¥{{ totalAmount }}</span>
      </div>
      <el-form-item label="修改原因" required class="!mb-0">
        <el-input v-model="reason" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="请说明本次修改原因" />
      </el-form-item>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="committing" @click="commit">保存并生成修订记录</el-button>
    </template>
  </BizCrudDialogShell>
</template>
