<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PageContainer } from '@/components/common'
import { getProductList, type ProductRecord } from '@/api/modules/product'
import { getO2oInventoryLogs, inboundO2oStock, type O2oInventoryLog } from '@/api/modules/o2o'

const loading = ref(false)
const logLoading = ref(false)
const submitting = ref(false)
const products = ref<ProductRecord[]>([])
const logs = ref<O2oInventoryLog[]>([])

const form = reactive({
  productId: '',
  qty: 1,
  remark: '',
})

const selectedProduct = computed(() => {
  return products.value.find((item) => item.id === form.productId) ?? null
})

const loadProducts = async () => {
  loading.value = true
  try {
    products.value = await getProductList({})
  } finally {
    loading.value = false
  }
}

const loadLogs = async () => {
  logLoading.value = true
  try {
    logs.value = await getO2oInventoryLogs(20)
  } finally {
    logLoading.value = false
  }
}

/**
 * 提交入库：
 * - 管理端手动登记到货数量；
 * - 成功后立即刷新商品库存与最近流水，方便核对结果。
 */
const handleInbound = async () => {
  if (!form.productId) {
    ElMessage.warning('请选择商品')
    return
  }
  if (!Number.isInteger(form.qty) || form.qty <= 0) {
    ElMessage.warning('入库数量必须为正整数')
    return
  }

  submitting.value = true
  try {
    await inboundO2oStock({
      productId: form.productId,
      qty: form.qty,
      remark: form.remark.trim() || undefined,
    })
    ElMessage.success('入库成功')
    form.qty = 1
    form.remark = ''
    await Promise.all([loadProducts(), loadLogs()])
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadProducts(), loadLogs()])
})
</script>

<template>
  <PageContainer title="入库管理" description="由工作人员登记到货入库，并实时查看最近库存流水变化">
    <div class="grid gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <p class="text-lg font-semibold text-slate-900">登记入库</p>
        <p class="mt-2 text-sm text-slate-400">支持按商品手动补货，成功后自动写入库存流水</p>

        <el-form class="mt-4" label-width="88px">
          <el-form-item label="商品">
            <el-select v-model="form.productId" placeholder="请选择商品" filterable :loading="loading" style="width: 100%">
              <el-option
                v-for="product in products"
                :key="product.id"
                :label="`${product.productName}（可用 ${product.availableStock}）`"
                :value="product.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="数量">
            <el-input-number v-model="form.qty" :min="1" :step="1" style="width: 100%" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.remark" type="textarea" :rows="4" placeholder="可填写供应商、批次或到货说明" />
          </el-form-item>
        </el-form>

        <div v-if="selectedProduct" class="rounded-2xl bg-slate-50 px-4 py-4 text-sm leading-7 text-slate-600">
          <div>商品名称：{{ selectedProduct.productName }}</div>
          <div>当前库存：{{ selectedProduct.currentStock }}</div>
          <div>已预订：{{ selectedProduct.preOrderedStock }}</div>
          <div>可用库存：{{ selectedProduct.availableStock }}</div>
        </div>

        <el-button class="mt-4 w-full" type="primary" :loading="submitting" @click="handleInbound">
          确认入库
        </el-button>
      </section>

      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <div class="mb-4 flex items-center justify-between">
          <div>
            <p class="text-lg font-semibold text-slate-900">最近库存流水</p>
            <p class="text-sm text-slate-400">可追踪预订占用、核销出库、手动入库等变化</p>
          </div>
          <el-button @click="loadLogs">刷新流水</el-button>
        </div>

        <el-table :data="logs" :loading="logLoading" row-key="id">
          <el-table-column prop="createdAt" label="时间" min-width="160" />
          <el-table-column prop="productName" label="商品" min-width="160" />
          <el-table-column prop="changeType" label="类型" width="140" />
          <el-table-column prop="changeQty" label="数量" width="90" align="right" />
          <el-table-column label="库存变化" min-width="220">
            <template #default="{ row }">
              <div class="text-sm leading-6 text-slate-600">
                <div>物理库存：{{ row.beforeCurrentStock }} -> {{ row.afterCurrentStock }}</div>
                <div>预订库存：{{ row.beforePreorderedStock }} -> {{ row.afterPreorderedStock }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="operatorName" label="操作人" width="110" />
        </el-table>
      </section>
    </div>
  </PageContainer>
</template>
