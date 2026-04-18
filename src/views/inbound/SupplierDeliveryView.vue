<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/SupplierDeliveryView.vue
 * 文件职责：供货方录入本次送货明细，提交后生成唯一送货单与核销二维码。
 * 维护说明：
 * - 页面允许同一商品多行录入，提交前会自动合并数量，调整提交流程时需保留该兼容；
 * - 二维码生成失败不代表送货单创建失败，因此必须保留“订单已生成但二维码缺失”的友好提示。
 */

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

// 单行录入项结构：使用稳定 uid 作为 transition-group key，避免按索引 key 在删除中间项时触发错位过渡。
interface DeliveryItemRow {
  uid: string
  productId: string
  qty: number
}

// 自增序号用于生成局部唯一 uid；页面生命周期内无需全局 UUID，保证轻量且可预测。
const itemUidSeed = ref(0)
const createDeliveryItemRow = (): DeliveryItemRow => ({
  uid: `delivery-item-${itemUidSeed.value++}`,
  productId: '',
  qty: 1,
})

// 供货单明细
const items = ref<DeliveryItemRow[]>([])
const remark = ref('')

// 二维码与成功状态
const qrCodeDataUrl = ref('')
const currentShowNo = ref('')
const isSuccess = ref(false)

// 统计总数量，用于底部汇总与禁用状态判断
const totalQty = computed(() => {
  return items.value.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
})

// 统计已选择商品行数，辅助右侧信息面板展示当前录入进度
const selectedCount = computed(() => {
  return items.value.filter((item) => item.productId).length
})

// 提交按钮统一可用性判定，避免模板中散落复杂表达式
const canSubmit = computed(() => {
  return !submitting.value && totalQty.value > 0
})

// 右侧操作提示，强调供应商录入流程的关键步骤
const helperSteps = [
  '先选择商品，再填写数量，支持多行连续录入。',
  '同一商品重复填写会在提交时自动合并数量。',
  '点击“生成送货单”后将生成唯一二维码并进入历史记录。',
  '交货时请向库管员出示二维码完成一键入库。',
] as const

// 读取商品列表，录入页初始化必须先有可选商品
const loadProducts = async () => {
  loading.value = true
  try {
    products.value = await getProductList({})
  } finally {
    loading.value = false
  }
}

const handleAddItem = () => {
  items.value.push(createDeliveryItemRow())
}

const handleRemoveItem = (index: number) => {
  items.value.splice(index, 1)
}

// 送货单创建成功后立即生成二维码；若失败，只提醒二维码渲染失败，不回滚已创建单据。
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
    qrCodeDataUrl.value = ''
    ElMessage.warning(extractErrorMessage(err, '送货单已生成，但二维码渲染失败，请刷新后到历史单据查看'))
  }
}

const handleSubmit = async () => {
  // 仅提交“商品已选中且数量>0”的有效行，避免空行污染数据
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

  // 按商品ID聚合数量，兼容同一商品被多次录入的场景
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

// 重置时恢复为首行可编辑状态，方便供应商连续录入下一单。
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
    <div class="max-w-6xl mx-auto">
      <!-- 录入态与成功态使用同一过渡，降低视图切换突兀感 -->
      <transition name="supplier-form-switch" mode="out-in">
        <div
          v-if="!isSuccess"
          key="delivery-form"
          class="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6 items-start"
        >
          <div class="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 overflow-hidden">
            <div class="px-6 py-5 border-b border-slate-100 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40 flex justify-between items-center">
              <div>
                <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-100">填写本次送货明细</h2>
                <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">请确保商品与数量准确，系统将按本次明细生成唯一送货单。</p>
              </div>
              <el-button type="primary" link @click="handleAddItem">
                <el-icon class="mr-1"><Plus /></el-icon>添加商品
              </el-button>
            </div>

            <div v-loading="loading" class="p-6 space-y-5">
              <!-- 商品录入行使用过渡组，新增/删除时提供轻微动效反馈 -->
              <transition-group name="item-list" tag="div" class="space-y-3">
                <div
                  v-for="(item, index) in items"
                  :key="item.uid"
                  class="flex items-start gap-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-100 dark:border-slate-700"
                >
                  <div class="w-8 h-8 shrink-0 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 text-slate-500 text-sm flex items-center justify-center font-medium">
                    {{ index + 1 }}
                  </div>
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
                  <el-tooltip content="删除该商品" placement="top">
                    <el-button
                      class="delete-button"
                      type="danger"
                      link
                      @click="handleRemoveItem(index)"
                      :disabled="items.length === 1"
                    >
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </el-tooltip>
                </div>
              </transition-group>

              <div class="p-4 bg-slate-50/70 dark:bg-slate-900/40 rounded-xl border border-slate-100 dark:border-slate-700">
                <p class="text-sm text-slate-600 dark:text-slate-400 mb-2">备注信息</p>
                <el-input
                  v-model="remark"
                  type="textarea"
                  :rows="2"
                  placeholder="备注信息（选填）"
                  resize="none"
                />
              </div>
            </div>

            <!-- 吸附式操作栏：列表较长时仍可快速完成提交 -->
            <div class="sticky bottom-0 z-10 px-6 py-4 border-t border-slate-100 dark:border-slate-700 bg-white/90 dark:bg-slate-800/95 backdrop-blur-sm flex items-center justify-between">
              <div class="text-slate-600 dark:text-slate-400">
                总计：<span class="text-2xl font-semibold text-brand dark:text-teal-400">{{ totalQty }}</span> 件
              </div>
              <el-button
                type="primary"
                size="large"
                :loading="submitting"
                :disabled="!canSubmit"
                @click="handleSubmit"
                class="w-44 !rounded-xl"
              >
                生成送货单
              </el-button>
            </div>
          </div>

          <aside class="space-y-4">
            <div class="bg-white dark:bg-slate-800 rounded-2xl p-5 shadow-sm border border-slate-100 dark:border-slate-700">
              <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3">本次录入概览</h3>
              <div class="grid grid-cols-2 gap-3">
                <div class="rounded-xl bg-slate-50 dark:bg-slate-900/40 p-3">
                  <p class="text-xs text-slate-500 dark:text-slate-400">商品行数</p>
                  <p class="text-xl font-semibold text-slate-800 dark:text-slate-100">{{ items.length }}</p>
                </div>
                <div class="rounded-xl bg-slate-50 dark:bg-slate-900/40 p-3">
                  <p class="text-xs text-slate-500 dark:text-slate-400">已选择</p>
                  <p class="text-xl font-semibold text-slate-800 dark:text-slate-100">{{ selectedCount }}</p>
                </div>
              </div>
            </div>

            <div class="bg-white dark:bg-slate-800 rounded-2xl p-5 shadow-sm border border-slate-100 dark:border-slate-700">
              <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3">录入提示</h3>
              <ul class="space-y-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                <li v-for="(tip, index) in helperSteps" :key="tip" class="flex gap-2">
                  <span class="text-brand dark:text-teal-400">{{ index + 1 }}.</span>
                  <span>{{ tip }}</span>
                </li>
              </ul>
            </div>
          </aside>
        </div>

        <!-- 成功生成二维码视图 -->
        <div
          v-else
          key="delivery-success"
          class="bg-white dark:bg-slate-800 rounded-2xl p-8 shadow-sm border border-slate-100 dark:border-slate-700 text-center max-w-3xl mx-auto"
        >
          <div class="w-16 h-16 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full flex items-center justify-center mx-auto mb-4">
            <el-icon :size="32"><Check /></el-icon>
          </div>
          <h2 class="text-2xl font-semibold text-slate-800 dark:text-slate-100 mb-2">送货单已生成</h2>
          <p class="text-slate-500 dark:text-slate-400 mb-8">单号：{{ currentShowNo }}</p>

          <div class="inline-block p-4 bg-white border-2 border-slate-100 rounded-2xl shadow-sm mb-8">
            <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="核销二维码" class="w-64 h-64 object-contain" />
            <div v-else class="w-64 h-64 flex items-center justify-center">
              <el-skeleton animated>
                <template #template>
                  <el-skeleton-item variant="image" style="width: 256px; height: 256px; border-radius: 16px" />
                </template>
              </el-skeleton>
            </div>
          </div>

          <div class="text-slate-500 dark:text-slate-400 text-sm mb-8">
            请在交货时向库管员出示此二维码<br>扫码即可一键完成入库
          </div>

          <el-button plain size="large" @click="handleReset" class="!rounded-xl px-8">
            继续录入下一单
          </el-button>
        </div>
      </transition>
    </div>
  </PageContainer>
</template>

<style scoped>
/* 列表项入场/离场动画：让新增和删除反馈更柔和 */
.item-list-enter-active,
.item-list-leave-active {
  transition: all 0.28s ease;
}
.item-list-enter-from,
.item-list-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
.item-list-move {
  transition: transform 0.28s ease;
}

/* 页面状态切换动画：使用局部命名，避免与全局样式重名引发切换串扰。 */
.supplier-form-switch-enter-active,
.supplier-form-switch-leave-active {
  transition:
    transform 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.supplier-form-switch-enter-from,
.supplier-form-switch-leave-to {
  opacity: 0;
  transform: scale(0.985);
}

/* 删除按钮加入背景过渡，解决纯图标弱可见性问题 */
.delete-button {
  border-radius: 10px;
  padding: 6px;
  transition: background-color 0.2s ease;
}
.delete-button:not(.is-disabled):hover {
  background-color: rgba(239, 68, 68, 0.1);
}
</style>
