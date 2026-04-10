<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { submitO2oPreorder } from '@/api/modules/o2o'
import { useClientAuthStore, useClientCartStore } from '@/store'

const router = useRouter()
const clientAuthStore = useClientAuthStore()
const clientCartStore = useClientCartStore()

const remark = ref('')
const submitting = ref(false)

onMounted(() => {
  clientCartStore.initialize()
  if (!clientCartStore.selectedValidItems.length && clientCartStore.validItems.length > 0) {
    clientCartStore.toggleAllValidSelected(true)
  }
})

const selectedItems = computed(() => clientCartStore.selectedValidItems)
const totalQty = computed(() => selectedItems.value.reduce((sum, item) => sum + item.qty, 0))
const submitDisabled = computed(() => submitting.value || !selectedItems.value.length)

const handleSubmit = async () => {
  if (!selectedItems.value.length) {
    ElMessage.warning('请先选择可结算商品')
    return
  }

  submitting.value = true
  try {
    const result = await submitO2oPreorder({
      remark: remark.value.trim() || undefined,
      items: selectedItems.value.map((item) => ({
        productId: item.productId,
        qty: item.qty,
      })),
    })

    selectedItems.value.forEach((item) => {
      clientCartStore.removeItem(item.productId)
    })

    ElMessage.success('预订单提交成功')
    await router.replace(`/client/orders/${result.order.id}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提交失败，请稍后再试')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <section class="space-y-4 pb-24">
    <div class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-xl font-semibold text-slate-900">确认订单</p>
      <p class="mt-1 text-sm text-slate-500">提交前将以服务端库存与限购规则为准</p>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="text-sm text-slate-500">提货人</p>
      <p class="mt-1 text-base font-semibold text-slate-900">{{ clientAuthStore.currentUser?.realName || clientAuthStore.currentUser?.mobile }}</p>
      <p class="text-xs text-slate-400">{{ clientAuthStore.currentUser?.departmentName || '未设置部门' }}</p>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="mb-3 text-sm font-semibold text-slate-700">商品明细</p>
      <article
        v-for="item in selectedItems"
        :key="item.productId"
        class="mb-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"
      >
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-slate-900">{{ item.productName }}</p>
          <p class="text-xs text-slate-400">{{ item.productCode }}</p>
        </div>
        <span class="text-sm font-semibold text-slate-700">x {{ item.qty }}</span>
      </article>
      <div v-if="!selectedItems.length" class="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
        暂无可结算商品
      </div>
    </div>

    <div class="rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <p class="mb-2 text-sm font-semibold text-slate-700">备注信息</p>
      <textarea
        v-model.trim="remark"
        class="min-h-24 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-teal-300"
        placeholder="选填：例如希望领取时间、特殊说明"
      />
    </div>

    <div class="fixed bottom-[82px] left-1/2 z-20 flex w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 items-center justify-between rounded-[1.2rem] bg-slate-900 px-4 py-3 text-white shadow-[var(--ylink-shadow-floating)]">
      <div>
        <p class="text-sm font-semibold">共 {{ totalQty }} 件</p>
        <p class="text-xs text-white/70">提交后进入待提货状态</p>
      </div>
      <button
        type="button"
        class="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="submitDisabled"
        @click="handleSubmit"
      >
        {{ submitting ? '提交中...' : '提交预订单' }}
      </button>
    </div>
  </section>
</template>
