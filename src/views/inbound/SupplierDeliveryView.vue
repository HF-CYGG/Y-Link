<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import { PageContainer } from '@/components/common'
import { getProductList, type ProductRecord } from '@/api/modules/product'
import { submitSupplierDelivery } from '@/api/modules/inbound'
import { extractErrorMessage } from '@/utils/error'

const loading = ref(false)
const submitting = ref(false)
const products = ref<ProductRecord[]>([])

// 供货单明细
const items = ref<Array<{ productId: string; qty: number }>>([])
const remark = ref('')

// 二维码与成功状态
const qrCodeDataUrl = ref('')
const currentShowNo = ref('')
const isSuccess = ref(false)

const totalQty = computed(() => {
  return items.value.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
})

const loadProducts = async () => {
  loading.value = true
  try {
    products.value = await getProductList({})
  } finally {
    loading.value = false
  }
}

const handleAddItem = () => {
  items.value.push({ productId: '', qty: 1 })
}

const handleRemoveItem = (index: number) => {
  items.value.splice(index, 1)
}

const generateQRCode = async (verifyCode: string) => {
  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(verifyCode, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    })
  } catch (err) {
    console.error('Failed to generate QR code', err)
  }
}

const handleSubmit = async () => {
  const validItems = items.value.filter((i) => i.productId && i.qty > 0)
  if (!validItems.length) {
    ElMessage.warning('请至少添加一件有效的送货商品')
    return
  }

  try {
    await ElMessageBox.confirm('送货单生成后不可修改，确认提交吗？', '确认生成', {
      confirmButtonText: '确认生成',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }

  const uniqueItems = new Map<string, number>()
  for (const item of validItems) {
    uniqueItems.set(item.productId, (uniqueItems.get(item.productId) || 0) + item.qty)
  }

  const submitData = {
    remark: remark.value.trim(),
    items: Array.from(uniqueItems.entries()).map(([productId, qty]) => ({ productId, qty })),
  }

  submitting.value = true
  try {
    const result = await submitSupplierDelivery(submitData)
    const verifyCode = result.order.verifyCode
    currentShowNo.value = result.order.showNo
    await generateQRCode(verifyCode)
    isSuccess.value = true
    ElMessage.success('送货单生成成功')
  } catch (err) {
    ElMessage.error(extractErrorMessage(err, '生成失败'))
  } finally {
    submitting.value = false
  }
}

const handleReset = () => {
  items.value = []
  remark.value = ''
  isSuccess.value = false
  qrCodeDataUrl.value = ''
  currentShowNo.value = ''
  handleAddItem()
}

onMounted(() => {
  loadProducts()
  handleAddItem()
})
</script>

<template>
  <PageContainer title="送货单录入">
    <div class="max-w-3xl mx-auto">
      <div v-if="!isSuccess" class="bg-white dark:bg-slate-800 rounded-2xl p-6 shadow-sm border border-slate-100 dark:border-slate-700">
        <div class="mb-6 flex justify-between items-center">
          <h2 class="text-lg font-medium text-slate-800 dark:text-slate-100">填写本次送货明细</h2>
          <el-button type="primary" link @click="handleAddItem">
            <el-icon class="mr-1"><Plus /></el-icon>添加商品
          </el-button>
        </div>

        <div v-loading="loading" class="space-y-4">
          <div
            v-for="(item, index) in items"
            :key="index"
            class="flex items-start gap-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl"
          >
            <div class="flex-1">
              <el-select
                v-model="item.productId"
                placeholder="请选择商品"
                filterable
                class="w-full"
              >
                <el-option
                  v-for="p in products"
                  :key="p.id"
                  :label="p.productName"
                  :value="p.id"
                >
                  <span class="float-left">{{ p.productName }}</span>
                  <span class="float-right text-slate-400 text-sm">{{ p.productCode }}</span>
                </el-option>
              </el-select>
            </div>
            <div class="w-32">
              <el-input-number
                v-model="item.qty"
                :min="1"
                :step="1"
                step-strictly
                class="w-full"
                placeholder="数量"
              />
            </div>
            <el-button type="danger" link @click="handleRemoveItem(index)" :disabled="items.length === 1">
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>

          <div class="mt-6">
            <el-input
              v-model="remark"
              type="textarea"
              :rows="2"
              placeholder="备注信息（选填）"
              resize="none"
            />
          </div>

          <div class="mt-8 flex items-center justify-between border-t border-slate-100 dark:border-slate-700 pt-6">
            <div class="text-slate-600 dark:text-slate-400">
              总计：<span class="text-xl font-semibold text-brand dark:text-teal-400">{{ totalQty }}</span> 件
            </div>
            <el-button
              type="primary"
              size="large"
              :loading="submitting"
              :disabled="totalQty === 0"
              @click="handleSubmit"
              class="w-40 !rounded-xl"
            >
              生成送货单
            </el-button>
          </div>
        </div>
      </div>

      <!-- 成功生成二维码视图 -->
      <div v-else class="bg-white dark:bg-slate-800 rounded-2xl p-8 shadow-sm border border-slate-100 dark:border-slate-700 text-center">
        <div class="w-16 h-16 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full flex items-center justify-center mx-auto mb-4">
          <el-icon :size="32"><Check /></el-icon>
        </div>
        <h2 class="text-2xl font-semibold text-slate-800 dark:text-slate-100 mb-2">送货单已生成</h2>
        <p class="text-slate-500 dark:text-slate-400 mb-8">单号：{{ currentShowNo }}</p>

        <div class="inline-block p-4 bg-white border-2 border-slate-100 rounded-2xl shadow-sm mb-8">
          <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="核销二维码" class="w-64 h-64 object-contain" />
          <div v-else class="w-64 h-64 flex items-center justify-center bg-slate-50 text-slate-400">
            生成中...
          </div>
        </div>

        <div class="text-slate-500 dark:text-slate-400 text-sm mb-8">
          请在交货时向库管员出示此二维码<br>扫码即可一键完成入库
        </div>

        <el-button plain size="large" @click="handleReset" class="!rounded-xl px-8">
          继续录入下一单
        </el-button>
      </div>
    </div>
  </PageContainer>
</template>
