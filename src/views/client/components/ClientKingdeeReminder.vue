<script lang="ts">
/**
 * 模块说明：src/views/client/components/ClientKingdeeReminder.vue
 * 文件职责：服务端会话确认后聚合展示本人的金蝶编号待办。
 * 实现逻辑：分页读取，普通路由不重复弹；查询失败展示重试；账号变化取消请求并清理内存。
 * 维护说明：待办有效性由后端判断，不能用前端日期过滤已核销记录或把失败当作零待办。
 */
// 本次应用打开只按账号在内存去重，不写入持久化已读标记。
const remindedAccounts = new Set<string>()
</script>
<script setup lang="ts">

import { onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { getMyKingdeeTodos, type O2oPreorderSummary } from '@/api/modules/o2o'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { subscribeClientOrderRefresh } from '@/utils/client-order-refresh'
const auth = useClientAuthStore(pinia)
const router = useRouter()
const visible = ref(false)
const loading = ref(false)
const error = ref('')
const list = ref<O2oPreorderSummary[]>([])
const total = ref(0)
const page = ref(1)
let epoch = 0
let controller: AbortController | null = null
let previousAccount: string | null = null
const load = async (open = false) => {
  const id = auth.currentUser?.id
  if (!id || !auth.initialized || auth.initializing) return
  const generation = ++epoch
  controller?.abort(); controller = new AbortController(); loading.value = true; error.value = ''
  try {
    const result = await getMyKingdeeTodos({ page: page.value, pageSize: 20 }, { signal: controller.signal })
    if (generation !== epoch || id !== auth.currentUser?.id) return
    list.value = result.list; total.value = result.total
    if (open && result.total > 0) visible.value = true
  } catch {
    if (generation !== epoch) return
    error.value = '金蝶待办读取失败，请重试'; if (open) visible.value = true
  } finally { if (generation === epoch) loading.value = false }
}
watch(() => auth.initialized && !auth.initializing ? auth.currentUser?.id ?? null : null, (id) => {
  epoch += 1; controller?.abort(); visible.value = false; loading.value = false; list.value = []; total.value = 0; error.value = ''; page.value = 1
  if (previousAccount && previousAccount !== id) remindedAccounts.delete(previousAccount)
  previousAccount = id
  if (id && !remindedAccounts.has(id)) { remindedAccounts.add(id); void load(true) }
}, { immediate: true, flush: 'sync' })
const unsubscribe = subscribeClientOrderRefresh(() => { if (visible.value) void load() })
const go = (id: string) => { visible.value = false; void router.push(`/client/orders/${encodeURIComponent(id)}`) }
onBeforeUnmount(() => { epoch += 1; controller?.abort(); unsubscribe(); loading.value = false; visible.value = false; list.value = []; total.value = 0 })
</script>
<template>
  <el-dialog v-model="visible" title="金蝶编号待办" width="min(92vw, 560px)" append-to-body>
    <p class="mb-3 text-red-600">请及时在金蝶申请并填写金蝶单据编号</p>
    <p v-if="error" role="alert">{{ error }} <el-button :loading="loading" @click="load(true)">重试</el-button></p>
    <div v-else v-loading="loading" class="space-y-2">
      <el-button v-for="order in list" :key="order.id" class="!ml-0 w-full" @click="go(order.id)">{{ order.preorderNo }} · {{ order.status === 'verified' ? '已核销' : '待核销' }}</el-button>
      <p v-if="!loading && total === 0">当前没有待补编号的订单</p>
      <el-pagination v-if="total > 20" v-model:current-page="page" :total="total" :page-size="20" layout="prev, pager, next" @current-change="load()" />
    </div>
  </el-dialog>
</template>
