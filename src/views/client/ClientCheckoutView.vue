<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientCheckoutView.vue
 * 文件职责：负责客户端确认订单页的下单归属选择、商品清单确认、备注填写与预订单提交。
 * 实现逻辑：
 * - 结算页默认按“散客”下单，避免系统根据账号资料自动推断成部门单，减少误下单；
 * - 用户若主动切换为“部门订”，提交前必须再次确认，确保其明确知晓订单会归入部门出库；
 * - 真正提交成功后再清理购物车并跳转订单详情页，避免前端先删数据导致状态丢失。
 * 维护说明：
 * - 若后续继续扩展下单归属类型，需要同步调整本页选项卡、提交校验和确认文案；
 * - 若后端修改预订单入参结构，需要同步检查 `submitO2oPreorder` 的 payload 拼装逻辑。
 */


import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
import { submitO2oPreorder, type O2oClientOrderType } from '@/api/modules/o2o'
import { useIdempotentAction } from '@/composables/useIdempotentAction'
import { useClientAuthStore, useClientCartStore } from '@/store'
import { normalizeRequestError } from '@/utils/error'

const props = defineProps<{
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const router = useRouter()
const clientAuthStore = useClientAuthStore()
const clientCartStore = useClientCartStore()
const { runWithGate } = useIdempotentAction()

const remark = ref('')
// 详细注释：结算页始终默认走“散客”模式，只有用户主动点选“部门订”才切换，
// 这样可以避免因为账号资料里恰好有部门信息，导致用户未感知地提交成部门单。
const clientOrderType = ref<O2oClientOrderType>('walkin')
const submitting = ref(false)

onMounted(() => {
  clientCartStore.initialize()
  // 从商城页直接进入结算时，用户可能尚未进入购物车页手动勾选；
  // 这里默认全选“仍有效”的商品，减少结算前的重复操作。
  if (!clientCartStore.selectedValidItems.length && clientCartStore.validItems.length > 0) {
    clientCartStore.toggleAllValidSelected(true)
  }
})

const selectedItems = computed(() => clientCartStore.selectedValidItems)
const totalQty = computed(() => selectedItems.value.reduce((sum, item) => sum + item.qty, 0))
const totalAmount = computed(() => selectedItems.value.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0))
const submitDisabled = computed(() => submitting.value || !selectedItems.value.length)
const currentDepartmentName = computed(() => clientAuthStore.currentUser?.departmentName?.trim() || '')
const isDepartmentOrder = computed(() => clientOrderType.value === 'department')
const orderTypeDescription = computed(() => {
  if (isDepartmentOrder.value) {
    return currentDepartmentName.value
      ? `已切换为部门订，提交时还需再次确认，核销后会归入部门出库单：${currentDepartmentName.value}`
      : '部门订需要先在个人资料中完善部门信息'
  }
  return '当前默认按散客下单，如需归入部门，请主动切换为部门订'
})

const handleBack = () => {
  if (props.standalone) {
    router.back()
  } else {
    emit('close')
  }
}

const handleSubmit = async () => {
  if (!selectedItems.value.length) {
    ElMessage.warning('请先选择可结算商品')
    return
  }
  if (isDepartmentOrder.value && !currentDepartmentName.value) {
    ElMessage.warning('部门订需要先完善账号部门信息')
    return
  }
  if (isDepartmentOrder.value) {
    try {
      // 详细注释：部门单会影响后续门店出库归属，因此在真正提交前增加一次显式确认，
      // 防止用户误触了“部门订”卡片后直接下单。
      await ElMessageBox.confirm(
        `当前将按“部门订”提交，核销后会归入部门：${currentDepartmentName.value}。请确认是否继续提交？`,
        '确认提交部门订单',
        {
          confirmButtonText: '确认提交',
          cancelButtonText: '返回检查',
          type: 'warning',
          distinguishCancelAndClose: true,
        },
      )
    } catch {
      return
    }
  }

  const runResult = await runWithGate({
    actionKey: 'client-checkout-submit',
    onDuplicated: () => {
      ElMessage.info('订单提交中，请勿重复点击')
    },
    executor: async () => {
      // 提交锁只防重复点击，不承担真正幂等保障；最终仍以服务端库存与限购校验结果为准。
      submitting.value = true
      try {
        const result = await submitO2oPreorder({
          clientOrderType: clientOrderType.value,
          remark: remark.value.trim() || undefined,
          items: selectedItems.value.map((item) => ({
            productId: item.productId,
            qty: item.qty,
          })),
        })

        // 只有服务端创建预订单成功后，才真正从购物车中移除已提交商品，避免前端先删导致状态丢失。
        selectedItems.value.forEach((item) => {
          clientCartStore.removeItem(item.productId)
        })

        ElMessage.success('预订单提交成功')

        // 如果是内嵌抽屉模式，先关闭弹窗
        if (!props.standalone) {
          emit('close')
        }

        // 结算成功后直接跳转订单详情页，帮助用户立即看到核销码与待提货状态。
        await router.replace(`/client/orders/${result.order.id}`)
      } catch (error) {
        const normalizedError = normalizeRequestError(error, '提交失败，请稍后再试')
        ElMessage.error(normalizedError.message)
      } finally {
        submitting.value = false
      }
    },
  })
  if (runResult === null) {
    return
  }
}
</script>

<template>
  <div class="h-full flex flex-col bg-[var(--ylink-color-bg)]">
    <div class="sticky top-0 z-10 flex items-center gap-3 bg-[var(--ylink-color-surface)] px-4 py-3 shadow-sm">
      <button type="button" class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-slate-100" @click="handleBack">
        <el-icon :size="20"><ArrowLeft /></el-icon>
      </button>
      <p class="text-lg font-semibold text-slate-900">确认订单</p>
    </div>

    <section class="flex-1 overflow-y-auto px-4 py-4 sm:px-5 pb-32">
      <div class="mb-4 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="text-sm text-slate-500">提交前将以服务端库存与限购规则为准</p>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="text-sm text-slate-500">提货人</p>
        <p class="mt-1 text-base font-semibold text-slate-900">
          {{ clientAuthStore.currentUser?.account || clientAuthStore.currentUser?.realName || clientAuthStore.currentUser?.mobile }}
        </p>
        <p class="text-xs text-slate-400">{{ clientAuthStore.currentUser?.departmentName || '未设置部门' }}</p>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="mb-3 text-sm font-semibold text-slate-700">下单归属</p>
        <p class="mb-3 text-xs leading-5 text-slate-400">默认按散客下单，如需归入部门，请主动选择“部门订”并在提交前再次确认。</p>
        <div class="grid grid-cols-2 gap-3">
          <button
            type="button"
            class="rounded-[1.2rem] border px-4 py-3 text-left transition"
            :class="clientOrderType === 'department' ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-slate-200 bg-slate-50 text-slate-600'"
            @click="clientOrderType = 'department'"
          >
            <p class="text-sm font-semibold">部门订</p>
            <p class="mt-1 text-xs leading-5">适用于代表部门统一领取物资</p>
          </button>
          <button
            type="button"
            class="rounded-[1.2rem] border px-4 py-3 text-left transition"
            :class="clientOrderType === 'walkin' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-600'"
            @click="clientOrderType = 'walkin'"
          >
            <p class="text-sm font-semibold">散客</p>
            <p class="mt-1 text-xs leading-5">适用于个人临时领取，不归入部门</p>
          </button>
        </div>
        <p class="mt-3 text-xs leading-5" :class="isDepartmentOrder && !currentDepartmentName ? 'text-amber-600' : 'text-slate-500'">
          {{ orderTypeDescription }}
        </p>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="mb-3 text-sm font-semibold text-slate-700">商品明细</p>
        <article
          v-for="item in selectedItems"
          :key="item.productId"
          class="mb-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-slate-900">{{ item.productName }}</p>
            <p class="mt-1 text-sm font-bold text-teal-600">¥{{ Number(item.defaultPrice).toFixed(2) }}</p>
          </div>
          <span class="text-sm font-semibold text-slate-700">x {{ item.qty }}</span>
        </article>
        <div v-if="!selectedItems.length" class="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
          暂无可结算商品
        </div>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="mb-2 text-sm font-semibold text-slate-700">备注信息</p>
        <textarea
          v-model.trim="remark"
          class="min-h-24 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-teal-300"
          placeholder="选填：例如希望领取时间、特殊说明"
        />
      </div>
    </section>

    <div class="client-cart-summary absolute bottom-0 left-0 right-0 z-20 bg-white border-t border-slate-200 px-4 py-3 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
        <div class="flex items-center justify-between w-full max-w-[1100px] mx-auto">
          <div class="flex flex-col">
            <p class="text-sm text-slate-500">共 <span class="font-bold text-slate-900">{{ totalQty }}</span> 件，合计 <span class="font-bold text-teal-600">¥{{ totalAmount.toFixed(2) }}</span></p>
            <p class="text-xs text-slate-400 mt-0.5">提交后进入待提货状态</p>
          </div>
        <button
          type="button"
          class="rounded-full bg-slate-900 px-8 py-2.5 text-sm font-semibold text-white transition-transform active:scale-95 shadow-md hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="submitDisabled"
          @click="handleSubmit"
        >
          {{ submitting ? '提交中...' : '提交预订单' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pb-safe {
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
}
</style>
