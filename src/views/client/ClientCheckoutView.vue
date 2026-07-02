<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientCheckoutView.vue
 * 文件职责：承载客户端确认订单页，展示实名归属信息、提货信息、商品明细与下单提交入口。
 * 实现逻辑：
 * - 进入页面后会恢复当前账号的提货人草稿，并同步最新商品库存快照；
 * - 下单归属完全由当前登录账号类型决定，页面只负责展示部门/工号/实名信息，不允许手动篡改归属；
 * - 部门账号下单前强制校验所属部门、教职工号与金蝶申请状态，避免订单归属与实名链路脱节。
 * 维护说明：
 * - 若后端继续扩展实名字段或工号核验状态，请优先同步本页的实名信息展示区与 `handleSubmit()` 前置校验；
 * - 若调整下单归属说明文案，请保持“前端只展示，服务端强制判定”的口径不变。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ArrowLeft } from '@element-plus/icons-vue'
import { submitO2oPreorder } from '@/api/modules/o2o'
import { useClientMallSnapshotRefresh } from '@/composables/useClientMallSnapshotRefresh'
import { useIdempotentAction } from '@/composables/useIdempotentAction'
import { useClientAuthStore, useClientCartStore } from '@/store'
import { useClientCatalogStore } from '@/store/modules/client-catalog'
import pinia from '@/store/pinia'
import { normalizeRequestError } from '@/utils/error'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { resolveO2oPriceView } from '@/utils/o2o-price'
import {
  buildClientPreorderSubmitIntentKey,
  clearClientPreorderSubmitLock,
  createClientPreorderSubmitLock,
  readActiveClientPreorderSubmitLock,
  refreshClientPreorderSubmitLock,
} from '@/utils/client-preorder-submit-guard'

const props = defineProps<{
  standalone?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)
const clientCartStore = useClientCartStore(pinia)
const clientCatalogStore = useClientCatalogStore(pinia)
const { syncing: catalogSyncing, refreshMallSnapshot } = useClientMallSnapshotRefresh()
const { runWithGate } = useIdempotentAction()

const remark = ref('')
const pickupContact = ref('')
const submitting = ref(false)
const departmentSystemApplyChoice = ref<boolean | null>(null)

const PICKUP_CONTACT_STORAGE_KEY_PREFIX = 'ylink:client:checkout:pickup-contact:'
const AMBIGUOUS_PREORDER_SUBMIT_STATUS_SET = new Set<number | undefined>([undefined, 408, 502, 503, 504])

const resolveDefaultPickupContact = () => {
  const currentUser = clientAuthStore.currentUser
  if (currentUser?.accountType === 'department') {
    return currentUser.realName?.trim() || currentUser.username?.trim() || currentUser.account?.trim() || ''
  }
  const username = currentUser?.username?.trim() || currentUser?.account?.trim()
  if (username) return username
  return currentUser?.realName?.trim() || currentUser?.mobile?.trim() || ''
}

const resolvePickupContactStorageKey = () => {
  const currentUser = clientAuthStore.currentUser
  const userIdentity = `${currentUser?.id ?? currentUser?.username ?? currentUser?.account ?? ''}`.trim()
  return `${PICKUP_CONTACT_STORAGE_KEY_PREFIX}${userIdentity || 'anonymous'}`
}

const restorePickupContactDraft = () => {
  const storageKey = resolvePickupContactStorageKey()
  const defaultPickupContact = resolveDefaultPickupContact()
  if (clientAuthStore.currentUser?.accountType === 'department') {
    pickupContact.value = defaultPickupContact
    try {
      globalThis.window?.localStorage.removeItem(storageKey)
    } catch {
      // 部门账号提货人由实名锁定，本地缓存清理失败不影响下单。
    }
    return
  }
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
  if (globalThis.window === undefined) return
  const storageKey = resolvePickupContactStorageKey()
  if (clientAuthStore.currentUser?.accountType === 'department') {
    try {
      globalThis.window.localStorage.removeItem(storageKey)
    } catch {
      // 部门账号提货人不可编辑，不依赖本地缓存。
    }
    return
  }
  const normalizedPickupContact = pickupContact.value.trim()
  try {
    if (normalizedPickupContact) {
      globalThis.window.localStorage.setItem(storageKey, normalizedPickupContact)
      return
    }
    globalThis.window.localStorage.removeItem(storageKey)
  } catch {
    // 本地存储异常时不阻塞下单
  }
}

const handlePickupContactBlur = () => {
  if (clientAuthStore.currentUser?.accountType === 'department') {
    pickupContact.value = resolveDefaultPickupContact()
    persistPickupContactDraft()
    return
  }
  const normalizedPickupContact = pickupContact.value.trim()
  if (normalizedPickupContact) {
    pickupContact.value = normalizedPickupContact
    persistPickupContactDraft()
    return
  }
  pickupContact.value = resolveDefaultPickupContact()
  persistPickupContactDraft()
}

onMounted(() => {
  clientCartStore.initialize(clientAuthStore.currentUser?.id)
  if (!clientCartStore.selectedValidItems.length && clientCartStore.validItems.length > 0) {
    clientCartStore.toggleAllValidSelected(true)
  }
  restorePickupContactDraft()
  void refreshMallSnapshot()
})

watch(
  () => clientAuthStore.currentUser?.id,
  () => {
    restorePickupContactDraft()
    departmentSystemApplyChoice.value = null
  },
)

watch(
  () => [
    clientAuthStore.currentUser?.accountType,
    clientAuthStore.currentUser?.realName,
    clientAuthStore.currentUser?.username,
    clientAuthStore.currentUser?.account,
  ],
  () => {
    if (clientAuthStore.currentUser?.accountType === 'department') {
      pickupContact.value = resolveDefaultPickupContact()
      persistPickupContactDraft()
    }
  },
)

const selectedItems = computed(() => clientCartStore.selectedValidItems)
const totalQty = computed(() => selectedItems.value.reduce((sum, item) => sum + item.qty, 0))
const totalAmount = computed(() => selectedItems.value.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0))
const submitDisabled = computed(() => submitting.value || !selectedItems.value.length)
const currentRealName = computed(() => (
  clientAuthStore.currentUser?.realName?.trim()
  || clientAuthStore.currentUser?.username?.trim()
  || clientAuthStore.currentUser?.account?.trim()
  || '未设置'
))
const isTeacherAccount = computed(() => (
  clientAuthStore.currentUser?.accountType === 'personal'
  && Boolean(clientAuthStore.currentUser?.staffVerified)
  && Boolean(clientAuthStore.currentUser?.staffNo?.trim())
))
const currentAccountTypeLabel = computed(() => {
  if (clientAuthStore.currentUser?.accountType === 'department') return '部门共享账号'
  return isTeacherAccount.value ? '教师账号' : '散客账号'
})
const currentDepartmentName = computed(() => clientAuthStore.currentUser?.departmentName?.trim() || '')
const currentStaffNo = computed(() => clientAuthStore.currentUser?.staffNo?.trim() || '')
const currentStaffNoLabel = computed(() => (isDepartmentOrder.value ? '账号编号' : '教职工号'))
const currentStaffVerifiedText = computed(() => {
  if (!isDepartmentOrder.value) {
    return isTeacherAccount.value ? '教师身份已核验，散客下单无需部门核验' : '个人账号无需工号核验'
  }
  return clientAuthStore.currentUser?.staffVerified ? '已完成工号核验' : '待人工核验'
})
const enforcedClientOrderType = computed(() => (
  clientAuthStore.currentUser?.accountType === 'department' ? 'department' : 'walkin'
))
const isDepartmentOrder = computed(() => enforcedClientOrderType.value === 'department')
const pickupContactReadonly = computed(() => isDepartmentOrder.value)
const pickupContactInputHint = computed(() => (
  isDepartmentOrder.value ? '部门账号提货人按实名锁定，不可更改' : '可编辑并自动记忆'
))
const currentAccountOrderHint = computed(() => (
  isDepartmentOrder.value ? '当前为部门共享账号，可提交部门订单' : '当前按散客下单'
))
const orderTypeDescription = computed(() => {
  if (isDepartmentOrder.value) {
    return currentDepartmentName.value
      ? `当前账号为部门账号，下单后将自动归入部门：${currentDepartmentName.value}`
      : '当前账号为部门账号，请先在个人资料中完善部门信息'
  }
  return isTeacherAccount.value
    ? '当前账号为教师账号，下单后仍自动按散客归属处理'
    : '当前账号为个人账号，下单后自动按散客归属处理'
})

const systemApplyStatusText = computed(() => {
  if (!isDepartmentOrder.value) return '散客单无需填写金蝶系统申请状态'
  if (departmentSystemApplyChoice.value === true) return '已选择：金蝶系统内已完成审批申请'
  if (departmentSystemApplyChoice.value === false) return '已选择：金蝶系统内未完成审批申请'
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
  const normalizedPickupContact = isDepartmentOrder.value
    ? resolveDefaultPickupContact()
    : (pickupContact.value.trim() || resolveDefaultPickupContact())
  if (!normalizedPickupContact) {
    showAppWarning('请填写提货人')
    return
  }
  pickupContact.value = normalizedPickupContact
  persistPickupContactDraft()

  if (!selectedItems.value.length) {
    showAppWarning('请先选择可结算商品')
    return
  }
  if (isDepartmentOrder.value && !currentDepartmentName.value) {
    showAppWarning('部门账号下单前，请先完善所属部门')
    return
  }
  if (isDepartmentOrder.value && !currentStaffNo.value) {
    showAppWarning('部门账号缺少教职工号，请先完善后再下单')
    return
  }
  if (isDepartmentOrder.value && departmentSystemApplyChoice.value === null) {
    showAppWarning('请选择金蝶系统是否已申请')
    return
  }

  const submitItemSnapshot = selectedItems.value.map((item) => ({
    productId: item.productId,
    skuId: item.skuId,
    qty: item.qty,
  }))
  const submitRemark = remark.value.trim() || undefined
  const submitIntentKey = buildClientPreorderSubmitIntentKey({
    clientUserId: clientAuthStore.currentUser?.id,
    clientOrderType: enforcedClientOrderType.value,
    isSystemApplied: isDepartmentOrder.value ? Boolean(departmentSystemApplyChoice.value) : false,
    pickupContact: normalizedPickupContact,
    remark: submitRemark,
    items: submitItemSnapshot,
  })

  const activeSubmitLock = readActiveClientPreorderSubmitLock(clientAuthStore.currentUser?.id)
  if (activeSubmitLock?.intentKey === submitIntentKey) {
    showAppInfo('相同预订单正在确认中，请勿重复提交')
    return
  }
  const submitRequestKey = createClientPreorderSubmitLock(clientAuthStore.currentUser?.id, submitIntentKey)

  const runResult = await runWithGate({
    actionKey: 'client-checkout-submit',
    onDuplicated: () => {
      showAppInfo('订单提交中，请勿重复点击')
    },
    executor: async () => {
      submitting.value = true
      try {
        const result = await submitO2oPreorder({
          isSystemApplied: isDepartmentOrder.value ? Boolean(departmentSystemApplyChoice.value) : false,
          pickupContact: normalizedPickupContact,
          remark: submitRemark,
          items: submitItemSnapshot,
        })

        submitItemSnapshot.forEach((item) => {
          clientCartStore.removeItem(String(item.skuId || item.productId))
        })
        clientCatalogStore.applyPreorderSubmission(submitItemSnapshot)
        clientCartStore.syncWithCatalog(clientCatalogStore.products)
        clearClientPreorderSubmitLock(clientAuthStore.currentUser?.id, submitRequestKey)

        showAppSuccess('预订单提交成功')
        if (!props.standalone) {
          emit('close')
        }
        await router.replace(`/client/orders/${result.order.id}`)
      } catch (error) {
        const normalizedError = normalizeRequestError(error, '提交失败，请稍后再试')
        if (AMBIGUOUS_PREORDER_SUBMIT_STATUS_SET.has(normalizedError.status)) {
          refreshClientPreorderSubmitLock(clientAuthStore.currentUser?.id, submitIntentKey, submitRequestKey)
          showAppWarning('提交结果确认中，请勿重复提交。可前往“我的订单”查询是否已创建成功。')
          return
        }
        clearClientPreorderSubmitLock(clientAuthStore.currentUser?.id, submitRequestKey)
        void showCriticalErrorDialog(normalizedError, {
          title: '预订单提交失败',
          fallback: '提交失败，请稍后再试',
          operation: '提交预订单',
        })
      } finally {
        submitting.value = false
      }
    },
  })
  if (runResult === null) return
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

    <section class="flex-1 overflow-y-auto px-4 py-4 pb-32 sm:px-5">
      <div class="mb-4 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="text-sm text-slate-500">提交前将以服务端库存与限购规则为准</p>
        <p class="mt-2 text-xs text-slate-400">
          {{ catalogSyncing ? '正在后台同步最新库存，不影响当前填写与提交' : '进入页面后会自动同步最新库存与限购信息' }}
        </p>
      </div>

      <div class="mb-4 rounded-[1.2rem] border border-slate-100 bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="inline-flex h-6 items-center rounded-full bg-teal-50 px-2 text-xs font-semibold text-teal-700">提货信息</span>
            <p class="text-sm font-semibold text-slate-800">提货人</p>
          </div>
          <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{{ pickupContactInputHint }}</span>
        </div>
        <div class="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 focus-within:border-teal-300 focus-within:bg-white">
          <p class="text-[11px] text-slate-400">提货姓名</p>
          <input
            v-model.trim="pickupContact"
            type="text"
            maxlength="32"
            :readonly="pickupContactReadonly"
            :class="[
              'mt-1 w-full border-0 bg-transparent p-0 text-base font-semibold text-slate-900 outline-none',
              pickupContactReadonly ? 'cursor-default text-slate-900' : '',
            ]"
            placeholder="请输入提货人（默认用户名）"
            @blur="handlePickupContactBlur"
          />
        </div>
        <div class="mt-3 grid gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600">账号类型</span>
            <span class="truncate">{{ currentAccountTypeLabel }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600">真实姓名</span>
            <span class="truncate">{{ currentRealName }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600">所属部门</span>
            <span class="truncate">{{ isDepartmentOrder || isTeacherAccount ? (clientAuthStore.currentUser?.departmentName || '未设置部门') : '个人账号不适用' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600">{{ currentStaffNoLabel }}</span>
            <span class="truncate">{{ isDepartmentOrder || isTeacherAccount ? (clientAuthStore.currentUser?.staffNo || '未设置编号') : '个人账号不适用' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600">工号核验</span>
            <span class="truncate">{{ currentStaffVerifiedText }}</span>
          </div>
        </div>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
        <p class="mb-3 text-sm font-semibold text-slate-700">下单归属</p>
        <p class="mb-3 text-xs leading-5 text-slate-400">订单归属由当前账号类型自动判定，客户端不可手动切换。</p>
        <div class="rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
          <div class="flex flex-wrap items-center gap-2">
            <span>当前账户类型：<span class="font-semibold text-slate-900">{{ currentAccountTypeLabel }}</span></span>
            <span class="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700">{{ isDepartmentOrder ? '部门单' : '散客单' }}</span>
          </div>
          <p class="mt-1 text-xs font-medium text-slate-700">{{ currentAccountOrderHint }}</p>
        </div>
        <div v-if="isDepartmentOrder" class="mt-4 rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <p class="text-sm font-semibold text-slate-700">金蝶系统是否已申请</p>
            <span class="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600">必填</span>
          </div>
          <p class="mt-1 text-xs text-slate-500">用于标记本次部门出库是否已在金蝶系统完成审批申请。</p>
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
              已申请
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
              未申请
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
          :key="item.skuId || item.productId"
          class="mb-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-slate-900">{{ item.productName }}</p>
            <p v-if="item.specText" class="mt-0.5 text-xs text-slate-400">{{ item.specText }}</p>
            <p class="mt-1 text-sm font-bold text-teal-600">¥{{ Number(resolveO2oPriceView(item).discountedPrice).toFixed(2) }}</p>
            <p v-if="resolveO2oPriceView(item).isDiscounted" class="mt-0.5 text-xs text-slate-400">
              原价 ¥{{ Number(resolveO2oPriceView(item).originalPrice).toFixed(2) }} · {{ resolveO2oPriceView(item).discountLabel }}
            </p>
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
          placeholder="选填：如领取时间、特殊说明等"
        />
      </div>
    </section>

    <div class="client-cart-summary absolute bottom-0 left-0 right-0 z-20 border-t border-slate-200 bg-white px-4 py-3 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
      <div class="mx-auto flex w-full max-w-[1100px] items-center justify-between">
        <div class="flex flex-col">
          <p class="text-sm text-slate-500">共 <span class="font-bold text-slate-900">{{ totalQty }}</span> 件，合计 <span class="font-bold text-teal-600">¥{{ totalAmount.toFixed(2) }}</span></p>
          <p class="mt-0.5 text-xs text-slate-400">提交后进入待提货状态</p>
        </div>
        <button
          type="button"
          class="rounded-full bg-slate-900 px-8 py-2.5 text-sm font-semibold text-white shadow-md transition-transform hover:shadow-lg active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
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
