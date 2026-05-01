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


import { computed, onMounted, ref, watch } from 'vue'
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
// 详细注释：提货人输入框支持“默认用户名 + 用户自定义记忆”。
// - 未编辑过时：默认回填当前登录用户名（优先 account）；
// - 编辑过时：按当前客户端账号维度写入 localStorage，并在下次进入自动回填；
// - 记忆值可反复修改，始终以用户最后一次输入为准。
const pickupContact = ref('')
// 详细注释：结算页始终默认走“散客”模式，只有用户主动点选“部门订”才切换，
// 这样可以避免因为账号资料里恰好有部门信息，导致用户未感知地提交成部门单。
const clientOrderType = ref<O2oClientOrderType>('walkin')
const submitting = ref(false)
// 详细注释：“金蝶系统是否已申请”改为“用户主动选择”的必填项。
// - `null` 表示用户尚未做出选择（仅部门订会出现该状态）；
// - `true/false` 分别表示“金蝶已申请/金蝶未申请”。
const departmentSystemApplyChoice = ref<boolean | null>(null)

const PICKUP_CONTACT_STORAGE_KEY_PREFIX = 'ylink:client:checkout:pickup-contact:'

const resolveDefaultPickupContact = (): string => {
  const currentUser = clientAuthStore.currentUser
  const username = currentUser?.account?.trim()
  if (username) {
    return username
  }
  return currentUser?.realName?.trim() || currentUser?.mobile?.trim() || ''
}

const resolvePickupContactStorageKey = (): string => {
  const currentUser = clientAuthStore.currentUser
  const userIdentity = `${currentUser?.id ?? currentUser?.account ?? ''}`.trim()
  return `${PICKUP_CONTACT_STORAGE_KEY_PREFIX}${userIdentity || 'anonymous'}`
}

const restorePickupContactDraft = () => {
  const storageKey = resolvePickupContactStorageKey()
  const defaultPickupContact = resolveDefaultPickupContact()
  if (globalThis.window === undefined) {
    pickupContact.value = defaultPickupContact
    return
  }
  try {
    const cachedPickupContact = globalThis.window.localStorage.getItem(storageKey)?.trim() || ''
    pickupContact.value = cachedPickupContact || defaultPickupContact
  } catch {
    pickupContact.value = defaultPickupContact
  }
}

const persistPickupContactDraft = () => {
  if (globalThis.window === undefined) {
    return
  }
  const storageKey = resolvePickupContactStorageKey()
  const normalizedPickupContact = pickupContact.value.trim()
  try {
    if (normalizedPickupContact) {
      globalThis.window.localStorage.setItem(storageKey, normalizedPickupContact)
      return
    }
    globalThis.window.localStorage.removeItem(storageKey)
  } catch {
    // 详细注释：本地存储失败不阻断下单流程，仅降级为本次会话内输入有效。
  }
}

const handlePickupContactBlur = () => {
  const normalizedPickupContact = pickupContact.value.trim()
  if (normalizedPickupContact) {
    pickupContact.value = normalizedPickupContact
    persistPickupContactDraft()
    return
  }

  // 详细注释：若用户清空输入，回退到默认用户名，避免“提货人”显示为空。
  pickupContact.value = resolveDefaultPickupContact()
  persistPickupContactDraft()
}

onMounted(() => {
  clientCartStore.initialize()
  // 从商城页直接进入结算时，用户可能尚未进入购物车页手动勾选；
  // 这里默认全选“仍有效”的商品，减少结算前的重复操作。
  if (!clientCartStore.selectedValidItems.length && clientCartStore.validItems.length > 0) {
    clientCartStore.toggleAllValidSelected(true)
  }
  restorePickupContactDraft()
})

watch(
  () => clientAuthStore.currentUser?.id,
  () => {
    restorePickupContactDraft()
  },
)

const selectedItems = computed(() => clientCartStore.selectedValidItems)
const totalQty = computed(() => selectedItems.value.reduce((sum, item) => sum + item.qty, 0))
const totalAmount = computed(() => selectedItems.value.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0))
const submitDisabled = computed(() => submitting.value || !selectedItems.value.length)
const currentDepartmentName = computed(() => clientAuthStore.currentUser?.departmentName?.trim() || '')
const isDepartmentOrder = computed(() => clientOrderType.value === 'department')
const orderTypeDescription = computed(() => {
  if (isDepartmentOrder.value) {
    return currentDepartmentName.value
      ? `已切换为部门订，请先选择“金蝶系统是否已申请”后再提交；核销后会归入部门出库单：${currentDepartmentName.value}`
      : '部门订需要先在个人资料中完善部门信息'
  }
  return '当前默认按散客下单，如需归入部门，请主动切换为部门订'
})

const systemApplyStatusText = computed(() => {
  if (!isDepartmentOrder.value) {
    return '散客单不要求填写金蝶系统申请状态'
  }
  if (departmentSystemApplyChoice.value === true) {
    return '已选择：金蝶系统内已完成审批申请'
  }
  if (departmentSystemApplyChoice.value === false) {
    return '已选择：金蝶系统内未完成审批申请'
  }
  return '必填：请先选择金蝶系统是否已申请'
})

const handleBack = () => {
  if (props.standalone) {
    router.back()
  } else {
    emit('close')
  }
}

const handleSubmit = async () => {
  const normalizedPickupContact = pickupContact.value.trim() || resolveDefaultPickupContact()
  if (!normalizedPickupContact) {
    ElMessage.warning('请填写提货人')
    return
  }
  pickupContact.value = normalizedPickupContact
  persistPickupContactDraft()

  if (!selectedItems.value.length) {
    ElMessage.warning('请先选择可结算商品')
    return
  }
  if (isDepartmentOrder.value && !currentDepartmentName.value) {
    ElMessage.warning('部门订需要先完善账号部门信息')
    return
  }
  if (isDepartmentOrder.value && departmentSystemApplyChoice.value === null) {
    ElMessage.warning('请先选择金蝶系统是否已申请')
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
          isSystemApplied: isDepartmentOrder.value ? Boolean(departmentSystemApplyChoice.value) : false,
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

      <div class="mb-4 rounded-[1.2rem] border border-slate-100 bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="inline-flex h-6 items-center rounded-full bg-teal-50 px-2 text-xs font-semibold text-teal-700">提货信息</span>
            <p class="text-sm font-semibold text-slate-800">提货人</p>
          </div>
          <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">可编辑并自动记忆</span>
        </div>
        <div class="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 focus-within:border-teal-300 focus-within:bg-white">
          <p class="text-[11px] text-slate-400">提货姓名</p>
          <input
            v-model.trim="pickupContact"
            type="text"
            maxlength="32"
            class="mt-1 w-full border-0 bg-transparent p-0 text-base font-semibold text-slate-900 outline-none"
            placeholder="请输入提货人（默认用户名）"
            @blur="handlePickupContactBlur"
          />
        </div>
        <div class="mt-3 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <span class="font-medium text-slate-600">所属部门</span>
          <span class="truncate">{{ clientAuthStore.currentUser?.departmentName || '未设置部门' }}</span>
        </div>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="mb-3 text-sm font-semibold text-slate-700">下单归属</p>
        <p class="mb-3 text-xs leading-5 text-slate-400">默认按散客下单，如需归入部门，请主动选择“部门订”并在提交前完成必填项确认。</p>
        <div class="grid grid-cols-2 gap-3">
          <button
            type="button"
            class="rounded-[1.2rem] border px-4 py-3 text-left transition"
            :class="clientOrderType === 'department' ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-slate-200 bg-slate-50 text-slate-600'"
            @click="clientOrderType = 'department'; departmentSystemApplyChoice = null"
          >
            <p class="text-sm font-semibold">部门订</p>
            <p class="mt-1 text-xs leading-5">适用于代表部门统一领取物资</p>
          </button>
          <button
            type="button"
            class="rounded-[1.2rem] border px-4 py-3 text-left transition"
            :class="clientOrderType === 'walkin' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-600'"
            @click="clientOrderType = 'walkin'; departmentSystemApplyChoice = null"
          >
            <p class="text-sm font-semibold">散客</p>
            <p class="mt-1 text-xs leading-5">适用于个人临时领取，不归入部门</p>
          </button>
        </div>
        <div v-if="isDepartmentOrder" class="mt-4 rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <p class="text-sm font-semibold text-slate-700">金蝶系统是否已申请</p>
            <span class="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600">必填</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">用于标记该笔出库是否已在金蝶系统内完成审批申请。</p>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <button
              type="button"
              class="rounded-[0.9rem] border px-3 py-2 text-sm font-medium transition"
              :class="
                departmentSystemApplyChoice === true
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              "
              @click="departmentSystemApplyChoice = true"
            >
              金蝶已申请
            </button>
            <button
              type="button"
              class="rounded-[0.9rem] border px-3 py-2 text-sm font-medium transition"
              :class="
                departmentSystemApplyChoice === false
                  ? 'border-amber-300 bg-amber-50 text-amber-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              "
              @click="departmentSystemApplyChoice = false"
            >
              金蝶未申请
            </button>
          </div>
          <p class="mt-2 text-xs" :class="departmentSystemApplyChoice === null ? 'text-rose-600' : 'text-slate-500'">
            {{ systemApplyStatusText }}
          </p>
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
