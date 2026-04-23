<script setup lang="ts">
/**
 * 模块说明：src/views/inbound/SupplierDeliveryView.vue
 * 文件职责：供货方录入本次送货明细，提交后生成唯一送货单与核销二维码，并在工作台中呈现更聚焦的录入与成功反馈界面。
 * 实现逻辑：
 * - 页面使用“录入主卡 + 侧边辅助卡 + 成功结果区”的结构，突出主操作区并统一工作台视觉语言；
 * - 商品明细仍然允许多行录入，提交前继续按商品 ID 聚合数量，保证现有业务兼容；
 * - 通过克制的局部反馈增强新增、删除、提交成功等关键动作的可感知性，但不阻塞输入与连续录入。
 * 维护说明：
 * - 页面允许同一商品多行录入，提交前会自动合并数量，调整提交流程时需保留该兼容；
 * - 二维码生成失败不代表送货单创建失败，因此必须保留“订单已生成但二维码缺失”的友好提示；
 * - 当前页面在供货工作台中作为被嵌入子页面渲染，不要重新恢复独立页头。
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
const qrCodeUnavailable = ref(false)

// 统计总数量，用于底部汇总与禁用状态判断
const totalQty = computed(() => {
  return items.value.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
})

// 统计已选择商品行数，辅助右侧信息面板展示当前录入进度
const selectedCount = computed(() => {
  return items.value.filter((item) => item.productId).length
})

// 录入完成度：用于侧边辅助区展示当前选择进度，帮助供货方快速判断是否仍有空行待补全。
const completionRate = computed(() => {
  if (!items.value.length) {
    return 0
  }

  return Math.round((selectedCount.value / items.value.length) * 100)
})

// 提交按钮统一可用性判定，避免模板中散落复杂表达式
const canSubmit = computed(() => {
  return !submitting.value && totalQty.value > 0
})

// 右侧操作提示：只保留真正影响提交和交货的关键信息，避免与页头和成功态重复。
const helperSteps = [
  '同一商品可分多行填写，提交时会自动合并数量。',
  '确认生成后单据不可修改，请先核对商品和总件数。',
  '如二维码未显示，可稍后到历史单据中补查。',
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
    qrCodeUnavailable.value = false
  } catch (err) {
    qrCodeDataUrl.value = ''
    qrCodeUnavailable.value = true
    ElMessage.warning(extractErrorMessage(err, '送货单已生成，但二维码渲染失败，请刷新后到历史单据查看'))
  }
}

const handleSubmit = async () => {
  // 仅提交“商品已选中且数量>0”的有效行，避免空行污染数据
  const validItems = items.value.filter((item) => item.productId && item.qty > 0)
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

  // 按商品 ID 聚合数量，兼容同一商品被多次录入的场景。
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
  qrCodeUnavailable.value = false
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
    <div class="mx-auto max-w-7xl">
      <!-- 录入态与成功态使用同一过渡，降低视图切换突兀感。 -->
      <transition name="supplier-form-switch" mode="out-in">
        <div
          v-if="!isSuccess"
          key="delivery-form"
          class="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]"
        >
          <div class="delivery-main-card overflow-hidden rounded-[28px] border border-slate-200/70 bg-white/95 shadow-[0_18px_46px_-40px_rgba(15,23,42,0.2)] dark:border-slate-700/80 dark:bg-slate-800/95">
            <div class="delivery-main-card__header flex flex-col gap-4 border-b border-slate-200/70 px-5 py-5 dark:border-slate-700/80 sm:px-6">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div class="min-w-0 space-y-2">
                  <h2 class="text-lg font-semibold text-slate-800 dark:text-slate-100">填写本次送货明细</h2>
                  <div class="flex flex-wrap gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <span class="delivery-inline-metric">明细 {{ items.length }}</span>
                    <span class="delivery-inline-metric">已选 {{ selectedCount }}/{{ items.length }}</span>
                    <span class="delivery-inline-metric">总件数 {{ totalQty }}</span>
                  </div>
                </div>
                <el-button type="primary" class="delivery-action-button self-start lg:self-auto" @click="handleAddItem">
                  <el-icon class="mr-1"><Plus /></el-icon>添加商品
                </el-button>
              </div>
            </div>

            <div v-loading="loading" class="space-y-5 p-5 sm:p-6">
              <!-- 商品录入行使用过渡组，新增/删除时提供轻微动效反馈。 -->
              <transition-group name="item-list" tag="div" class="space-y-3">
                <div
                  v-for="(item, index) in items"
                  :key="item.uid"
                  class="delivery-item-row flex flex-col gap-4 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/50 lg:flex-row lg:items-start"
                >
                  <div class="delivery-item-row__index flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200/80 bg-white text-sm font-medium text-slate-500 dark:border-slate-600 dark:bg-slate-800">
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
                        v-for="product in products"
                        :key="product.id"
                        :label="product.productName"
                        :value="product.id"
                      >
                        <span class="float-left">{{ product.productName }}</span>
                        <span class="float-right text-sm text-slate-400">{{ product.productCode }}</span>
                      </el-option>
                    </el-select>
                  </div>
                  <div class="w-full lg:w-36">
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
                      :disabled="items.length === 1"
                      @click="handleRemoveItem(index)"
                    >
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </el-tooltip>
                </div>
              </transition-group>

              <div class="rounded-2xl border border-slate-200/70 bg-slate-50/70 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
                <p class="mb-2 text-sm font-medium text-slate-600 dark:text-slate-400">备注信息</p>
                <el-input
                  v-model="remark"
                  type="textarea"
                  :rows="2"
                  placeholder="备注信息（选填）"
                  resize="none"
                />
              </div>
            </div>

            <!-- 吸附式操作栏：列表较长时仍可快速完成提交。 -->
            <div class="delivery-submit-bar sticky bottom-0 z-10 flex flex-col gap-3 border-t border-slate-200/70 bg-white/92 px-5 py-4 backdrop-blur-md dark:border-slate-700/80 dark:bg-slate-800/96 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
              <div class="space-y-1 text-slate-600 dark:text-slate-400">
                <p class="text-xs uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">当前汇总</p>
                <p>
                  总计：<span class="text-2xl font-semibold text-brand dark:text-teal-400">{{ totalQty }}</span> 件
                </p>
              </div>
              <el-button
                type="primary"
                size="large"
                :loading="submitting"
                :disabled="!canSubmit"
                @click="handleSubmit"
                class="delivery-submit-button !h-12 w-full !rounded-2xl sm:w-52"
              >
                生成送货单
              </el-button>
            </div>
          </div>

          <aside class="space-y-4">
            <div class="delivery-side-card rounded-[28px] border border-slate-200/70 bg-white/95 p-5 shadow-[0_16px_40px_-40px_rgba(15,23,42,0.18)] dark:border-slate-700/80 dark:bg-slate-800/95">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-100">提交前留意</h3>
                  <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    生成后单据不可修改，请在提交前核对商品、数量和备注。
                  </p>
                </div>
                <span class="delivery-side-card__signal">
                  {{ completionRate }}%
                </span>
              </div>

              <div class="mt-4 space-y-4">
                <div class="delivery-side-metric rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-700/70 dark:bg-slate-900/40">
                  <div class="flex items-center justify-between">
                    <span class="text-sm text-slate-500 dark:text-slate-400">已完成选择</span>
                    <span class="text-lg font-semibold text-slate-900 dark:text-slate-100">{{ selectedCount }}/{{ items.length }}</span>
                  </div>
                  <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700/80">
                    <div class="delivery-side-metric__progress h-full rounded-full bg-teal-500/80" :style="{ width: `${completionRate}%` }" />
                  </div>
                </div>

                <div class="flex flex-wrap gap-2 text-sm text-slate-500 dark:text-slate-400">
                  <span class="delivery-inline-metric">总件数 {{ totalQty }}</span>
                  <span class="delivery-inline-metric">备注 {{ remark.trim() ? '已填' : '未填' }}</span>
                </div>
              </div>

              <ul class="delivery-helper-list mt-4 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                <li v-for="(tip, index) in helperSteps" :key="tip" class="flex gap-3 rounded-2xl border border-slate-200/70 bg-slate-50/75 p-3 dark:border-slate-700/70 dark:bg-slate-900/35">
                  <span class="text-brand dark:text-teal-400">{{ index + 1 }}.</span>
                  <span>{{ tip }}</span>
                </li>
              </ul>
            </div>
          </aside>
        </div>

        <!-- 成功生成二维码视图：聚焦二维码与下一步动作，让完成反馈更明确。 -->
        <div
          v-else
          key="delivery-success"
          class="delivery-success-shell mx-auto max-w-5xl overflow-hidden rounded-[32px] border border-slate-200/70 bg-white/95 shadow-[0_18px_48px_-40px_rgba(15,23,42,0.18)] dark:border-slate-700/80 dark:bg-slate-800/95"
        >
          <div class="grid gap-0 lg:grid-cols-[minmax(0,1.1fr)_380px]">
            <div class="delivery-success-shell__content p-6 sm:p-8 lg:p-10">
              <div class="delivery-success-shell__icon inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400">
                <el-icon :size="22"><Check /></el-icon>
              </div>
              <p class="mt-4 text-sm font-medium text-emerald-600 dark:text-emerald-300">已生成送货单</p>
              <h2 class="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">送货单已生成</h2>
              <p class="mt-3 text-sm leading-6 text-slate-500 dark:text-slate-400">
                单号 <span class="font-semibold text-slate-700 dark:text-slate-200">{{ currentShowNo }}</span> 已生成，交货时出示二维码即可。
              </p>

              <div class="mt-6 flex flex-wrap gap-2 text-sm text-slate-500 dark:text-slate-400">
                <span class="delivery-inline-metric">状态 待入库</span>
                <span class="delivery-inline-metric">总件数 {{ totalQty }} 件</span>
              </div>

              <div class="mt-6 flex justify-center lg:justify-start">
                <el-button plain size="large" @click="handleReset" class="delivery-reset-button !rounded-2xl px-8">
                  继续录入下一单
                </el-button>
              </div>
            </div>

            <div class="delivery-success-qr border-t border-slate-200/70 bg-slate-50/60 p-6 dark:border-slate-700/70 dark:bg-slate-900/30 lg:border-l lg:border-t-0 lg:p-8">
              <p class="text-center text-sm font-medium text-emerald-700 dark:text-emerald-300">交货时出示二维码</p>
              <p class="mt-1 text-center text-xs text-slate-500 dark:text-slate-400">{{ currentShowNo }}</p>
              <div class="mt-4 rounded-[24px] border border-white/80 bg-white p-4 shadow-[0_10px_24px_-22px_rgba(15,23,42,0.24)] dark:border-slate-700/70 dark:bg-slate-900/70">
                <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="核销二维码" class="mx-auto h-64 w-64 object-contain" />
                <div v-else-if="!qrCodeUnavailable" class="mx-auto flex h-64 w-64 items-center justify-center">
                  <el-skeleton animated>
                    <template #template>
                      <el-skeleton-item variant="image" style="width: 256px; height: 256px; border-radius: 20px" />
                    </template>
                  </el-skeleton>
                </div>
                <div
                  v-else
                  class="mx-auto flex h-64 w-64 flex-col items-center justify-center rounded-3xl border border-dashed border-amber-300 bg-amber-50/70 px-6 text-center dark:border-amber-800 dark:bg-amber-950/20"
                >
                  <p class="text-sm font-medium text-amber-700 dark:text-amber-300">二维码暂未生成</p>
                  <p class="mt-2 text-xs leading-5 text-amber-700/85 dark:text-amber-200/85">
                    单据已创建，可稍后到历史单据中查看。
                  </p>
                </div>
              </div>
              <p class="mt-3 text-center text-sm leading-6 text-emerald-700/85 dark:text-emerald-200/90">
                {{ qrCodeUnavailable ? '若二维码暂未显示，可在历史单据中补查。' : '二维码已与本次送货单绑定。' }}
              </p>
            </div>
          </div>
        </div>
      </transition>
    </div>
  </PageContainer>
</template>

<style scoped>
.delivery-side-card,
.delivery-main-card,
.delivery-success-shell {
  transition:
    box-shadow 0.16s ease,
    border-color 0.18s ease;
}

.delivery-main-card__header {
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.88), rgba(255, 255, 255, 0.92));
}

.delivery-inline-metric {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  background: rgba(248, 250, 252, 0.88);
  padding: 0.38rem 0.78rem;
}

.delivery-side-card__signal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.8rem;
  border-radius: 999px;
  background: rgba(204, 251, 241, 0.52);
  padding: 0.45rem 0.8rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: rgb(15 118 110);
}

.delivery-action-button,
.delivery-submit-button,
.delivery-reset-button {
  transition:
    background-color 0.16s ease,
    box-shadow 0.16s ease;
}

.delivery-action-button:not(.is-disabled):hover,
.delivery-submit-button:not(.is-disabled):hover,
.delivery-reset-button:not(.is-disabled):hover {
  box-shadow: 0 10px 20px -22px rgba(15, 118, 110, 0.26);
}

.delivery-item-row {
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease;
}

.delivery-item-row:hover {
  border-color: rgba(148, 163, 184, 0.45);
}

.delivery-item-row__index {
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
}

.delivery-submit-bar {
  box-shadow: 0 -8px 18px -18px rgba(15, 23, 42, 0.22);
}

.delivery-side-metric__progress {
  transition: width 0.18s ease;
}

.delivery-success-shell__content {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.94));
}

.delivery-success-shell__icon {
  box-shadow: 0 10px 20px -18px rgba(16, 185, 129, 0.22);
}

.delivery-success-qr {
  transition: background-color 0.18s ease;
}

.delivery-helper-list li {
  transition: border-color 0.16s ease;
}

/* 列表项入场/离场动画：让新增和删除反馈更柔和。 */
.item-list-enter-active,
.item-list-leave-active {
  transition: all 0.18s ease;
}

.item-list-enter-from,
.item-list-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.item-list-move {
  transition: transform 0.18s ease;
}

/* 页面状态切换动画：使用局部命名，避免与全局样式重名引发切换串扰。 */
.supplier-form-switch-enter-active,
.supplier-form-switch-leave-active {
  transition:
    transform 0.18s ease,
    opacity 0.16s ease;
}

.supplier-form-switch-enter-from,
.supplier-form-switch-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* 删除按钮加入背景与位移动效，解决纯图标弱可见性问题。 */
.delete-button {
  border-radius: 10px;
  padding: 6px;
  transition: background-color 0.16s ease;
}

.delete-button:not(.is-disabled):hover {
  background-color: rgba(239, 68, 68, 0.08);
}

@media (max-width: 767px) {
  .delivery-side-card,
  .delivery-main-card,
  .delivery-success-shell {
    border-radius: 1.5rem;
  }

  .delivery-submit-bar {
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  }
}

@media (prefers-reduced-motion: reduce) {
  .delivery-side-card,
  .delivery-main-card,
  .delivery-success-shell,
  .delivery-action-button,
  .delivery-submit-button,
  .delivery-reset-button,
  .delivery-item-row,
  .item-list-enter-active,
  .item-list-leave-active,
  .item-list-move,
  .supplier-form-switch-enter-active,
  .supplier-form-switch-leave-active,
  .delete-button,
  .delivery-side-metric__progress {
    transition: none;
  }
}
</style>
