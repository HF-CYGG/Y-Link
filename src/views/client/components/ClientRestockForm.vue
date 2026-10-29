<script setup lang="ts">
/**
 * 模块说明：src/views/client/components/ClientRestockForm.vue
 * 文件职责：承载补货商品与缺货规格选择、截止时间校验以及幂等提交。
 * 实现逻辑：进入时读取实时目录，规格切换先查已有申请；结果未知时冻结原载荷并复用请求键重试。
 * 维护说明：数量不受商城限购限制；时区固定 UTC+8，账号切换后废弃前一账号的候选和请求。
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import type { CreateRestockRequestInput } from '../../../../packages/shared-types/src/index'
import { createClientRestockRequest, getActiveClientRestockRequest } from '@/api/modules/customer-service-feedback'
import { getO2oMallProducts, type O2oMallProduct } from '@/api/modules/o2o'
import { useStableRequest } from '@/composables/useStableRequest'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { extractErrorMessage, normalizeRequestError } from '@/utils/error'
import { getRestockSkus, isValidRestockQuantity, RESTOCK_MAX_QUANTITY, toRestockIso } from '@/utils/restock'
import { showAppError, showAppSuccess, showAppWarning } from '@/utils/app-alert'

const route = useRoute()
const router = useRouter()
const auth = useClientAuthStore(pinia)
const emit = defineEmits<{ (event: 'busy', value: boolean): void }>()
const catalogRequest = useStableRequest()
const activeRequest = useStableRequest()
const products = ref<O2oMallProduct[]>([])
const loading = ref(false)
const checking = ref(false)
const checkFailed = ref(false)
const creating = ref(false)
const existingConversationId = ref('')
const pendingSubmission = ref<CreateRestockRequestInput | null>(null)
const serverClock = ref<{ value: number; receivedAt: number } | null>(null)
const form = reactive({ productId: '', skuId: '', quantity: 1, latestPickupAt: '', remark: '' })
const product = computed(() => products.value.find((item) => item.id === form.productId) ?? null)
const skus = computed(() => getRestockSkus(product.value))
const selectedSku = computed(() => skus.value.find((item) => item.id === form.skuId))
const locked = computed(() => creating.value || checking.value || Boolean(pendingSubmission.value))
watch(locked, (value) => emit('busy', value), { immediate: true })
const queryText = (value: unknown) => typeof value === 'string' ? value : ''
const updateClock = (value: string) => {
  const time = Date.parse(value)
  if (Number.isFinite(time)) serverClock.value = { value: time, receivedAt: Date.now() }
}
const estimatedNow = () => serverClock.value ? serverClock.value.value + Date.now() - serverClock.value.receivedAt : null

const checkExisting = async () => {
  activeRequest.cancel()
  existingConversationId.value = ''
  checkFailed.value = false
  checking.value = false
  if (!selectedSku.value || !auth.currentUser?.id) return
  const skuId = form.skuId
  const userId = auth.currentUser.id
  checking.value = true
  await activeRequest.runLatest({
    executor: (signal) => getActiveClientRestockRequest(skuId, { signal }),
    onSuccess: async (result) => {
      if (auth.currentUser?.id !== userId || form.skuId !== skuId) return
      updateClock(result.serverNow)
      existingConversationId.value = result.restock?.conversationId ?? ''
      if (existingConversationId.value) {
        showAppSuccess('已有进行中的补货申请，进入原会话继续跟进')
        await router.replace(`/client/feedback/${existingConversationId.value}`)
      }
    },
    onError: (error) => { checkFailed.value = true; showAppError(extractErrorMessage(error, '查询已有补货申请失败，请重试')) },
    onFinally: () => { checking.value = false },
  })
}

watch(() => form.productId, () => {
  activeRequest.cancel()
  existingConversationId.value = ''
  const activeSkus = product.value?.skus.filter((sku) => sku.isCurrent && sku.isActive) ?? []
  form.skuId = activeSkus.length === 1 && skus.value.length === 1 ? skus.value[0]!.id : ''
})
watch(() => form.skuId, () => { void checkExisting() })

const loadCatalog = async () => {
  const userId = auth.currentUser?.id
  activeRequest.cancel()
  products.value = []
  form.productId = ''
  form.skuId = ''
  pendingSubmission.value = null
  existingConversationId.value = ''
  serverClock.value = null
  checking.value = false
  if (!userId) return
  loading.value = true
  await catalogRequest.runLatest({
    executor: (signal) => getO2oMallProducts({ signal }),
    onSuccess: (result) => {
      if (auth.currentUser?.id !== userId) return
      products.value = result.list.filter((item) => getRestockSkus(item).length > 0)
      const productId = queryText(route.query.productId)
      if (!productId) return
      if (!products.value.some((item) => item.id === productId)) { showAppWarning('该商品当前没有可申请的缺货规格，请重新选择'); return }
      form.productId = productId
    },
    onError: (error) => { showAppError(extractErrorMessage(error, '缺货商品加载失败，请重试')) },
    onFinally: () => { loading.value = false },
  })
  // 商品 watcher 已完成默认规格处理，再应用商城明确选择的规格。
  const skuId = queryText(route.query.skuId)
  if (skuId && auth.currentUser?.id === userId && skus.value.some((sku) => sku.id === skuId)) form.skuId = skuId
}
watch(() => auth.currentUser?.id, () => {
  form.quantity = 1
  form.latestPickupAt = ''
  form.remark = ''
  void loadCatalog()
}, { immediate: true })

const submit = async () => {
  if (creating.value || checking.value || !auth.currentUser?.id) return
  const userId = auth.currentUser.id
  if (!pendingSubmission.value) {
    if (!selectedSku.value || !product.value) { showAppWarning('请选择当前缺货的商品规格'); return }
    if (!isValidRestockQuantity(form.quantity)) { showAppWarning('请输入大于 0 的整数数量'); return }
    const latestPickupAt = toRestockIso(form.latestPickupAt)
    if (!latestPickupAt) { showAppWarning('请选择精确到分钟的最晚取货时间'); return }
    // 提交前重新查活跃申请并获取服务端时钟；不能把本机时间当业务真值。
    await checkExisting()
    if (auth.currentUser?.id !== userId || existingConversationId.value || checkFailed.value) return
    const now = estimatedNow()
    if (now === null || Date.parse(latestPickupAt) <= now) { showAppWarning('最晚取货时间必须晚于当前北京时间'); return }
    if (!selectedSku.value || !product.value) return
    pendingSubmission.value = {
      productId: product.value.id, skuId: selectedSku.value.id, quantity: form.quantity,
      latestPickupAt, remark: form.remark.trim() || undefined, clientRequestId: crypto.randomUUID(),
    }
  }
  const payload = pendingSubmission.value
  if (!payload) return
  creating.value = true
  try {
    const result = await createClientRestockRequest(payload)
    if (auth.currentUser?.id !== userId) return
    updateClock(result.serverNow)
    pendingSubmission.value = null
    creating.value = false
    showAppSuccess(result.created ? '补货需求已提交' : '已有补货需求，进入原会话查看')
    await router.replace(`/client/feedback/${result.conversation.id}`)
  } catch (error) {
    if (auth.currentUser?.id !== userId) return
    const status = normalizeRequestError(error).status
    // 明确拒绝允许修正；超时/断网/服务端错误必须保留原请求与原载荷。
    if (status && status >= 400 && status < 500 && status !== 408) pendingSubmission.value = null
    showAppError(extractErrorMessage(error, '补货提交结果未确认，请重试原申请'))
  } finally { creating.value = false }
}

onBeforeRouteLeave(() => {
  if (pendingSubmission.value || creating.value) { showAppWarning('请先重试确认这次补货申请的结果，再离开页面'); return false }
})
onBeforeUnmount(() => { activeRequest.cancel(); catalogRequest.cancel() })
</script>

<template>
  <section class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)] dark:bg-[#141415]" aria-label="补货申请表单">
    <p class="text-base font-semibold text-slate-900 dark:text-slate-100">补货需求</p>
    <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">仅可选择当前缺货的启用规格。已有有效需求会直接进入原会话，数量和时间保持原申请内容。</p>
    <el-form label-position="top" class="mt-4" :disabled="locked">
      <el-form-item label="缺货商品">
        <el-select v-model="form.productId" filterable :loading="loading" class="w-full" placeholder="请选择缺货商品">
          <el-option v-for="item in products" :key="item.id" :value="item.id" :label="`${item.productName}（${item.productCode}）`" />
        </el-select>
      </el-form-item>
      <el-form-item label="缺货规格">
        <el-select v-model="form.skuId" class="w-full" :disabled="!product" placeholder="请选择要补货的规格">
          <el-option v-for="sku in skus" :key="sku.id" :value="sku.id" :label="`${sku.specText || '默认规格'} · ${sku.skuCode}`" />
        </el-select>
      </el-form-item>
      <el-form-item label="期望数量（正整数）">
        <el-input-number v-model="form.quantity" :min="1" :max="RESTOCK_MAX_QUANTITY" :step="1" :precision="0" :step-strictly="true" controls-position="right" class="!w-full" aria-label="期望补货数量" />
      </el-form-item>
      <el-form-item label="最晚取货时间（北京时间 UTC+8）">
        <el-date-picker v-model="form.latestPickupAt" type="datetime" format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DD HH:mm" class="!w-full" placeholder="请选择未来时间，精确到分钟" />
      </el-form-item>
      <el-form-item label="备注（选填）">
        <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="可补充需要的用途或其他说明" />
      </el-form-item>
    </el-form>
    <p v-if="pendingSubmission && !creating" class="mb-3 text-sm text-amber-700 dark:text-amber-300">上次提交结果尚未确认。重试将查询同一份申请，请先确认结果再修改内容或离开。</p>
    <div class="flex flex-wrap gap-2">
      <el-button v-if="!locked" plain :loading="loading" @click="loadCatalog">刷新缺货商品</el-button>
      <el-button type="primary" :loading="creating || checking" :disabled="loading || checking || (!pendingSubmission && !selectedSku)" @click="submit">{{ pendingSubmission ? '重试并确认原申请' : '提交补货需求' }}</el-button>
    </div>
    <p v-if="!loading && !products.length" class="mt-3 text-sm text-slate-500 dark:text-slate-400">当前没有可申请补货的缺货商品。</p>
  </section>
</template>
