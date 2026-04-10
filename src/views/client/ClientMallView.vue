<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import ClientShell from '@/views/client/components/ClientShell.vue'
import { getO2oMallProducts, submitO2oPreorder, type O2oMallProduct } from '@/api/modules/o2o'

const router = useRouter()

const loading = ref(false)
const submitting = ref(false)
const products = ref<O2oMallProduct[]>([])
const quantities = reactive<Record<string, number>>({})
const remark = ref('')

/**
 * 当前已选商品：
 * - 仅保留数量大于 0 的行；
 * - 提交订单和底部汇总都复用这份派生结果。
 */
const selectedItems = computed(() => {
  return products.value
    .map((product) => ({
      product,
      qty: quantities[product.id] ?? 0,
    }))
    .filter((item) => item.qty > 0)
})

const totalQty = computed(() => {
  return selectedItems.value.reduce((sum, item) => sum + item.qty, 0)
})

const loadProducts = async () => {
  loading.value = true
  try {
    products.value = await getO2oMallProducts()
  } finally {
    loading.value = false
  }
}

/**
 * 调整单个商品的预订数量：
 * - 不允许超过剩余库存；
 * - 若系统开启了限购，则前端同步尊重每个商品的单人上限。
 */
const updateQty = (product: O2oMallProduct, delta: number) => {
  const current = quantities[product.id] ?? 0
  const next = Math.max(0, current + delta)
  const maxQty = Math.max(0, Math.min(product.availableStock, product.limitPerUser))
  quantities[product.id] = Math.min(next, maxQty)
}

const handleSubmit = async () => {
  if (!selectedItems.value.length) {
    ElMessage.warning('请先选择至少一个商品')
    return
  }

  submitting.value = true
  try {
    const result = await submitO2oPreorder({
      remark: remark.value.trim() || undefined,
      items: selectedItems.value.map((item) => ({
        productId: item.product.id,
        qty: item.qty,
      })),
    })
    ElMessage.success('预订单已提交')
    await loadProducts()
    Object.keys(quantities).forEach((id) => {
      quantities[id] = 0
    })
    remark.value = ''
    await router.push(`/client/orders/${result.order.id}`)
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await loadProducts()
})
</script>

<template>
  <ClientShell title="商品大厅" subtitle="可直接查看剩余库存、已预订数量，并在线提交预订单">
    <section class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div class="space-y-4">
        <div class="flex items-center justify-between rounded-3xl bg-white px-5 py-4 shadow-sm">
          <div>
            <p class="text-lg font-semibold text-slate-900">可预订商品</p>
            <p class="text-sm text-slate-500">展示“剩余可用”与“已被预订”，库存变化会在下次刷新后同步</p>
          </div>
          <button class="rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-600" @click="loadProducts">
            刷新库存
          </button>
        </div>

        <div v-if="loading" class="rounded-3xl bg-white p-8 text-center text-slate-400 shadow-sm">商品加载中...</div>
        <div v-else-if="!products.length" class="rounded-3xl bg-white p-8 text-center text-slate-400 shadow-sm">
          当前暂无上架商品
        </div>

        <article
          v-for="product in products"
          :key="product.id"
          class="overflow-hidden rounded-3xl bg-white shadow-sm"
        >
          <div class="grid gap-0 md:grid-cols-[13rem_minmax(0,1fr)]">
            <div class="flex min-h-[12rem] items-center justify-center bg-slate-100">
              <img v-if="product.thumbnail" :src="product.thumbnail" :alt="product.productName" class="h-full w-full object-cover" />
              <span v-else class="text-sm text-slate-400">暂无预览图</span>
            </div>
            <div class="space-y-4 p-5">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="text-xl font-semibold text-slate-900">{{ product.productName }}</p>
                  <p class="mt-1 text-sm text-slate-400">编码：{{ product.productCode }}</p>
                </div>
                <div class="text-right">
                  <p class="text-sm text-slate-400">建议单价</p>
                  <p class="text-xl font-semibold text-slate-900">¥ {{ product.defaultPrice }}</p>
                </div>
              </div>

              <div class="grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
                <div class="rounded-2xl bg-emerald-50 px-4 py-3">
                  <p class="text-slate-400">当前剩余</p>
                  <p class="mt-1 text-lg font-semibold text-emerald-600">{{ product.availableStock }} 件</p>
                </div>
                <div class="rounded-2xl bg-amber-50 px-4 py-3">
                  <p class="text-slate-400">已被预订</p>
                  <p class="mt-1 text-lg font-semibold text-amber-600">{{ product.preOrderedStock }} 件</p>
                </div>
                <div class="rounded-2xl bg-slate-100 px-4 py-3">
                  <p class="text-slate-400">单人限购</p>
                  <p class="mt-1 text-lg font-semibold text-slate-700">{{ product.limitPerUser }} 件</p>
                </div>
              </div>

              <p v-if="product.detailContent" class="line-clamp-3 text-sm leading-6 text-slate-500">
                {{ product.detailContent }}
              </p>

              <div class="flex flex-wrap items-center justify-between gap-4">
                <div class="inline-flex items-center rounded-full border border-slate-200 bg-slate-50">
                  <button class="qty-button" type="button" @click="updateQty(product, -1)">-</button>
                  <span class="min-w-14 text-center text-base font-semibold text-slate-900">{{ quantities[product.id] ?? 0 }}</span>
                  <button class="qty-button" type="button" @click="updateQty(product, 1)">+</button>
                </div>
                <span class="text-xs text-slate-400">提交后会先占用预订库存，线下核销后再扣减物理库存</span>
              </div>
            </div>
          </div>
        </article>
      </div>

      <aside class="sticky top-24 h-fit rounded-3xl bg-white p-5 shadow-sm">
        <p class="text-lg font-semibold text-slate-900">待提交预订单</p>
        <p class="mt-1 text-sm text-slate-400">已选 {{ selectedItems.length }} 种商品，共 {{ totalQty }} 件</p>

        <div class="mt-4 space-y-3">
          <div
            v-for="item in selectedItems"
            :key="item.product.id"
            class="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3 text-sm"
          >
            <div>
              <p class="font-medium text-slate-900">{{ item.product.productName }}</p>
              <p class="text-slate-400">限购 {{ item.product.limitPerUser }} 件</p>
            </div>
            <span class="font-semibold text-slate-900">x {{ item.qty }}</span>
          </div>

          <div v-if="!selectedItems.length" class="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
            右侧选择商品数量后，这里会汇总待提交内容
          </div>
        </div>

        <textarea
          v-model.trim="remark"
          class="mt-4 min-h-28 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none"
          placeholder="备注（选填，例如希望领取时间）"
        />

        <button class="mt-4 w-full rounded-full bg-slate-900 px-4 py-3 text-sm font-semibold text-white" :disabled="submitting" @click="handleSubmit">
          {{ submitting ? '提交中...' : '提交预订单' }}
        </button>
      </aside>
    </section>
  </ClientShell>
</template>

<style scoped>
.qty-button {
  padding: 0.8rem 1rem;
  color: rgb(71 85 105);
  font-size: 1.1rem;
  font-weight: 700;
}
</style>
