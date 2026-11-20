<script setup lang="ts">
import ClientProductSmallImage from './components/ClientProductSmallImage.vue'
/**
 * 模块说明：src/views/client/ClientCheckoutView.vue
 * 文件职责：承载客户端确认订单页，展示实名归属信息、提货信息、商品明细与下单提交入口。
 * 实现逻辑：
 * - 部门账号每次进入页面须填写实际领取教师姓名；个人账号恢复提货人草稿，并同步最新商品库存快照；
 * - 下单归属完全由当前登录账号类型决定，页面只负责展示部门/工号/实名信息，不允许手动篡改归属；
 * - 部门账号下单前强制校验所属部门、教职工号与金蝶申请状态，避免订单归属与实名链路脱节；
 * - 部门单必须选择到店取货时间：日期按钮（el-button）+ 半小时时段下拉，日期范围受店铺自动取消时长（pickupWindowHours）约束，
 *   各营业时段分别生成半小时档位，店铺配置刷新后复核新单草稿。
 * - 原提交不能重试时，用户核实订单后可解除同账号的有效标记，重新填写并单独提交新单。
 * 维护说明：
 * - 若后端继续扩展实名字段或工号核验状态，请优先同步本页的实名信息展示区与 `handleSubmit()` 前置校验；
 * - 若调整下单归属说明文案，请保持“前端只展示，服务端强制判定”的口径不变；
 * - 到店取货时间必须同时进入提交载荷与提交意图指纹，否则弱网重试会用同一请求键提交不同取货时间并被服务端判为冲突。
 */
import { onActivated, onDeactivated, onBeforeUnmount, computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ArrowLeft } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { getO2oCheckoutStorefront, getO2oMallStorefront, submitO2oPreorder, type SubmitO2oPreorderPayload } from '@/api/modules/o2o'
import { useClientMallSnapshotRefresh } from '@/composables/useClientMallSnapshotRefresh'
import { useIdempotentAction } from '@/composables/useIdempotentAction'
import { getClientCheckoutNewSubmitBlockReason, isClientCheckoutSubmitOutcomeUnknown, settleCurrentClientCheckoutSuccess } from './client-checkout-submit-policy'
import { useClientAuthStore, useClientCartStore } from '@/store'
import { useClientCatalogStore } from '@/store/modules/client-catalog'
import pinia from '@/store/pinia'
import { normalizeRequestError } from '@/utils/error'
import { showCriticalErrorDialog } from '@/utils/error-dialog'
import { showAppInfo, showAppSuccess, showAppWarning } from '@/utils/app-alert'
import { resolveO2oPriceView } from '@/utils/o2o-price'
import { resolvePickupSlotMinutes } from '@/utils/store-business-hours'
import {
  buildClientPreorderSubmitIntentKey,
  clearClientPreorderSubmitLock,
  createClientPreorderSubmitLock,
  dismissClientPreorderSubmitMarker,
  readActiveClientPreorderSubmitLock,
  type ClientPreorderSubmitLockSnapshot,
} from '@/utils/client-preorder-submit-guard'

const props = defineProps<{
  standalone?: boolean
  active?: boolean
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
const kingdeeVoucherNo = ref('')
const pendingSubmit = ref<ClientPreorderSubmitLockSnapshot | null>(null)
const recoveryError = ref('')
const confirmingRecovery = ref(false)
let pendingClockTimer: ReturnType<typeof setInterval> | null = null
const restorePendingSubmit = () => {
  try {
    pendingSubmit.value = clientAuthStore.currentUser?.id ? readActiveClientPreorderSubmitLock(clientAuthStore.currentUser.id) : null
    recoveryError.value = ''
  } catch {
    pendingSubmit.value = null
    recoveryError.value = '无法读取原始提交记录，请恢复浏览器会话存储后刷新；请先查看订单，勿重复下单。'
  }
}


// 到店取货时间：日期与时段分开选择，避免在手机上使用体积更大的日期时间弹层。
const pickupDateKey = ref<string | null>(null)
const pickupTimeSlot = ref<string | null>(null)
const pickupSelectionNotice = ref('')
/** 取货可选范围依赖“当前时间”，用一次性时钟快照驱动 computed，避免每次渲染都读 Date.now() 造成结果抖动。 */
const pickupClock = ref(Date.now())
const PICKUP_LEAD_MINUTES = 15
const PICKUP_MAX_DATE_OPTIONS = 8
const PICKUP_DEFAULT_WINDOW_HOURS = 7 * 24
const PICKUP_WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad2 = (value: number) => String(value).padStart(2, '0')
const toDateKey = (date: Date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
const buildPickupDate = (dateKey: string, minutesOfDay: number) => {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1, Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0)
}

const pickupSlotMinutes = computed(() => resolvePickupSlotMinutes(clientCatalogStore.storefront.businessHoursText))

const pickupWindowHours = computed(() => {
  const configuredHours = clientCatalogStore.storefront.pickupWindowHours
  return typeof configuredHours === 'number' && configuredHours > 0 ? configuredHours : null
})
const resolvePickupWindowEndMs = (windowHours: number | null) =>
  pickupClock.value + (windowHours ?? PICKUP_DEFAULT_WINDOW_HOURS) * 60 * 60 * 1000
const pickupWindowEndMs = computed(() => resolvePickupWindowEndMs(pickupWindowHours.value))
const pickupWindowHint = computed(() => (
  pickupWindowHours.value
    ? `请在下单后 ${pickupWindowHours.value} 小时内到店取货，超时未取将自动取消`
    : '可选择未来 7 天内的到店时间'
))

const buildPickupSlots = (dateKey: string, slotMinutes = pickupSlotMinutes.value, windowEndMs = pickupWindowEndMs.value) => {
  const earliestMs = pickupClock.value + PICKUP_LEAD_MINUTES * 60 * 1000
  const slots: Array<{ value: string; label: string }> = []
  for (const minutes of slotMinutes) {
    const slotDate = buildPickupDate(dateKey, minutes)
    const slotMs = slotDate.getTime()
    if (slotMs < earliestMs || slotMs > windowEndMs) {
      continue
    }
    const slotText = `${pad2(slotDate.getHours())}:${pad2(slotDate.getMinutes())}`
    slots.push({ value: slotText, label: slotText })
  }
  return slots
}

const pickupDateOptions = computed(() => {
  const options: Array<{ key: string; label: string; dateText: string }> = []
  const today = new Date(pickupClock.value)
  for (let offset = 0; offset < PICKUP_MAX_DATE_OPTIONS; offset += 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    if (date.getTime() > pickupWindowEndMs.value) {
      break
    }
    const dateKey = toDateKey(date)
    if (!buildPickupSlots(dateKey).length) {
      continue
    }
    const relativeLabel = offset === 0 ? '今天' : offset === 1 ? '明天' : offset === 2 ? '后天' : PICKUP_WEEKDAY_LABELS[date.getDay()]
    options.push({
      key: dateKey,
      label: relativeLabel,
      dateText: `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    })
  }
  return options
})

const pickupTimeOptions = computed(() => (pickupDateKey.value ? buildPickupSlots(pickupDateKey.value) : []))

const pickupAtIso = computed(() => {
  if (!pickupDateKey.value || !pickupTimeSlot.value) {
    return null
  }
  const [hours, minutes] = pickupTimeSlot.value.split(':').map(Number)
  return buildPickupDate(pickupDateKey.value, (hours ?? 0) * 60 + (minutes ?? 0)).toISOString()
})

const pickupAtStatusText = computed(() => {
  if (!isDepartmentOrder.value) return '散客单无需选择到店取货时间'
  if (pickupSelectionNotice.value) return pickupSelectionNotice.value
  if (!pickupDateOptions.value.length) return '当前暂无可选到店时间，请稍后重试或联系门店'
  if (!pickupDateKey.value) return '必填：请先选择到店取货日期'
  if (!pickupTimeSlot.value) return '必填：请选择到店取货时段'
  const selectedDate = pickupDateOptions.value.find((option) => option.key === pickupDateKey.value)
  return `已选择：${selectedDate?.dateText ?? pickupDateKey.value} ${pickupTimeSlot.value} 到店取货`
})

/** 选择日期时同步刷新时钟，确保“今天”的过期时段被及时剔除；原时段不在新范围内时清空重选。 */
const selectPickupDate = (dateKey: string) => {
  pickupClock.value = Date.now()
  pickupSelectionNotice.value = ''
  pickupDateKey.value = dateKey
  if (pickupTimeSlot.value && !buildPickupSlots(dateKey).some((slot) => slot.value === pickupTimeSlot.value)) {
    pickupTimeSlot.value = null
  }
}

const resetPickupSelection = () => {
  pickupClock.value = Date.now()
  pickupDateKey.value = null
  pickupTimeSlot.value = null
  pickupSelectionNotice.value = ''
}

const PICKUP_RESELECT_NOTICE = '所选到店取货时间已不可选，请重新选择'
const recheckPickupDraft = (slotsForDate = buildPickupSlots) => {
  const dateKey = pickupDateKey.value
  if (!dateKey) return
  const options = slotsForDate(dateKey)
  if (!options.length) pickupDateKey.value = null
  if (!options.length || (pickupTimeSlot.value && !options.some((slot) => slot.value === pickupTimeSlot.value))) {
    pickupTimeSlot.value = null
    pickupSelectionNotice.value = PICKUP_RESELECT_NOTICE
  }
}

const refreshPickupStorefront = () => {
  clientCatalogStore.initialize(clientAuthStore.currentUser?.id)
  return clientCatalogStore.refreshStorefront(getO2oMallStorefront)
}

const PICKUP_CONTACT_STORAGE_KEY_PREFIX = 'ylink:client:checkout:pickup-contact:'

const resolveDefaultPickupContact = () => {
  const currentUser = clientAuthStore.currentUser
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
    pickupContact.value = ''
    try {
      globalThis.window?.localStorage.removeItem(storageKey)
    } catch {
      // 旧部门草稿清理失败不影响本次显式输入。
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
      // 部门账号不保存领取人草稿，清理失败不影响本次下单。
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
    pickupContact.value = pickupContact.value.trim()
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
  if (!clientCartStore.selectedItems.length && clientCartStore.validItems.length > 0) {
    clientCartStore.toggleAllValidSelected(true)
  }
  restorePickupContactDraft()
  restorePendingSubmit()
  pendingClockTimer = setInterval(restorePendingSubmit, 15000)
  void refreshPickupStorefront()
  void refreshMallSnapshot()
})

watch(
  () => clientAuthStore.currentUser?.id,
  () => {
    pendingSubmit.value = null
    recoveryError.value = ''
    remark.value = ''
    kingdeeVoucherNo.value = ''
    submitting.value = false
    restorePickupContactDraft()
    restorePendingSubmit()
    departmentSystemApplyChoice.value = null
    resetPickupSelection()
    if (checkoutActive && clientAuthStore.currentUser?.id) void refreshPickupStorefront()
  },
  { flush: 'sync' },
)

watch(
  () => clientAuthStore.currentUser?.accountType,
  () => restorePickupContactDraft(),
)

// 结算展示和提交都必须观察全部已选行，不能把失效项过滤后静默提交剩余商品。
const selectedItems = computed(() => clientCartStore.selectedItems)
const totalQty = computed(() => selectedItems.value.reduce((sum, item) => sum + item.qty, 0))
const totalAmount = computed(() => selectedItems.value.reduce((sum, item) => sum + Math.max(0, Number(item.defaultPrice || 0)) * item.qty, 0))
const submitDisabled = computed(() => submitting.value || confirmingRecovery.value || Boolean(recoveryError.value)
  || (pendingSubmit.value ? !pendingSubmit.value.payload || pendingSubmit.value.expired : !selectedItems.value.length))
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
const pickupContactInputHint = computed(() => (
  isDepartmentOrder.value ? '每次下单填写实际领取教师姓名' : '可编辑并自动记忆'
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

let checkoutActive = true
watch(() => props.active, (active) => {
  if (active === false) invalidateCheckout()
  else if (active === true) {
    checkoutActive = true
    checkoutGeneration += 1
    void refreshPickupStorefront()
  }
}, { flush: 'sync' })
let checkoutGeneration = 0
const invalidateCheckout = () => { checkoutActive = false; checkoutGeneration += 1 }
const refreshVisiblePickupStorefront = () => {
  if (checkoutActive && globalThis.document.visibilityState === 'visible') void refreshPickupStorefront()
}
onMounted(() => globalThis.document?.addEventListener('visibilitychange', refreshVisiblePickupStorefront))
onBeforeUnmount(() => {
  invalidateCheckout()
  if (pendingClockTimer) clearInterval(pendingClockTimer)
  globalThis.document?.removeEventListener('visibilitychange', refreshVisiblePickupStorefront)
})
onDeactivated(invalidateCheckout)
onActivated(() => { checkoutActive = true; void refreshPickupStorefront() })
watch(() => clientAuthStore.currentUser?.id, () => { checkoutGeneration += 1 }, { flush: 'sync' })
watch([() => clientCatalogStore.storefront.businessHoursText, pickupWindowHours], () => {
  if (!checkoutActive || pendingSubmit.value || recoveryError.value) return
  pickupClock.value = Date.now()
  recheckPickupDraft()
})
const handleBack = () => {
  invalidateCheckout()
  if (props.standalone) {
    router.back()
  } else {
    emit('close')
  }
}

const handleDismissPendingSubmit = async () => {
  const owner = clientAuthStore.currentUser?.id
  const session = clientAuthStore.sessionGeneration
  const generation = checkoutGeneration
  const route = router.currentRoute.value
  const isCurrent = () => checkoutActive && props.active !== false && generation === checkoutGeneration
    && owner === clientAuthStore.currentUser?.id && session === clientAuthStore.sessionGeneration
    && route === router.currentRoute.value
  const marker = pendingSubmit.value?.dismissibleMarker
  if (!owner || !marker || !isCurrent() || recoveryError.value || submitting.value || confirmingRecovery.value) return

  const matchesMarker = () => pendingSubmit.value?.dismissibleMarker === marker && !recoveryError.value
  const warnMarkerChanged = () => showAppWarning(recoveryError.value || '原提交记录已变化，请重新核对订单。')
  restorePendingSubmit()
  if (!matchesMarker()) {
    warnMarkerChanged()
    return
  }

  confirmingRecovery.value = true
  try {
    await ElMessageBox.confirm(
      '请先到“我的订单”核实原结果，避免重复下单。恢复填写后，如需下新单，请再次提交。',
      '确认已核对订单',
      { type: 'warning', confirmButtonText: '已核对，恢复结算', cancelButtonText: '取消', closeOnClickModal: false },
    )
    if (!isCurrent() || submitting.value) return
    if (!matchesMarker()) {
      warnMarkerChanged()
      return
    }
    const dismissed = dismissClientPreorderSubmitMarker(owner, marker)
    restorePendingSubmit()
    if (!dismissed) {
      warnMarkerChanged()
      return
    }
    pickupClock.value = Date.now()
    recheckPickupDraft()
  } catch (error) {
    if (!isCurrent() || error === 'cancel' || error === 'close') return
    restorePendingSubmit()
    showAppWarning(recoveryError.value || '未能恢复结算，请稍后重试。')
  } finally {
    confirmingRecovery.value = false
  }
}

const sendFrozenSubmission = async (payload: SubmitO2oPreorderPayload, isCurrent: () => boolean, owner: string | number | undefined, recovered = false) => {
  let result: Awaited<ReturnType<typeof submitO2oPreorder>>
  try {
    result = await submitO2oPreorder(payload)
  } catch (error) {
    const normalizedError = normalizeRequestError(error, '提交失败，请稍后再试')
    if (isClientCheckoutSubmitOutcomeUnknown(normalizedError.status)) {
      if (isCurrent()) {
        restorePendingSubmit()
        showAppWarning('提交结果尚未确认，请继续确认原提交或查看订单，勿重复下单。')
      }
      return
    }
    try { clearClientPreorderSubmitLock(owner, payload.clientRequestId) } catch { /* 清理失败保留查单入口。 */ }
    if (!isCurrent()) return
    restorePendingSubmit()
    void showCriticalErrorDialog(normalizedError, { title: '预订单提交失败', fallback: '提交失败，请稍后再试', operation: '提交预订单' })
    return
  }
  // 页面已失效时不清锁也不回写购物车；再次进入仍只能恢复原 key，不能为原购物车生成新 key。
  const settled = settleCurrentClientCheckoutSuccess({
    isCurrent,
    applyConfirmedItems: () => {
      clientCartStore.consumeSubmittedItems(payload.items)
      if (!recovered) {
        clientCatalogStore.applyPreorderSubmission(payload.items.map((item) => ({ ...item, productId: String(item.productId), skuId: item.skuId == null ? null : String(item.skuId) })))
        clientCartStore.syncWithCatalog(clientCatalogStore.products)
      }
    },
    clearPending: () => {
      try { clearClientPreorderSubmitLock(owner, payload.clientRequestId) } catch { /* 保守保留原锁，可再次查单。 */ }
      pendingSubmit.value = null
    },
  })
  if (!settled) return
  showAppSuccess('预订单提交成功')
  if (recovered) {
    const refreshResult = await refreshMallSnapshot({ isCurrent })
    if (!isCurrent()) return
    if (!refreshResult.success) showAppWarning('订单已确认成功，商品目录暂未同步，请刷新后继续选购')
  }
  if (!props.standalone) emit('close')
  await router.replace(`/client/orders/${result.order.id}`)
}

const handleSubmit = async () => {
  if (!checkoutActive || confirmingRecovery.value) return
  const initiatingUserId = clientAuthStore.currentUser?.id
  const generation = checkoutGeneration
  const isCurrent = () => checkoutActive && generation === checkoutGeneration && initiatingUserId === clientAuthStore.currentUser?.id
  restorePendingSubmit()
  if (recoveryError.value) { showAppWarning(recoveryError.value); return }
  if (pendingSubmit.value) {
    const pending = pendingSubmit.value
    if (!pending.payload || pending.expired) { showAppWarning('原始提交不能安全重试，请先查看订单核实结果。'); return }
    const payload = JSON.parse(JSON.stringify(pending.payload)) as SubmitO2oPreorderPayload
    await runWithGate({ actionKey: 'client-checkout-submit', executor: async () => {
      submitting.value = true
      try { await sendFrozenSubmission(payload, isCurrent, initiatingUserId, true) }
      finally { if (isCurrent()) submitting.value = false }
    } })
    return
  }
  const normalizedPickupContact = isDepartmentOrder.value
    ? pickupContact.value.trim()
    : (pickupContact.value.trim() || resolveDefaultPickupContact())
  if (!normalizedPickupContact) {
    showAppWarning(isDepartmentOrder.value ? '请填写领取人姓名（教师姓名）' : '请填写提货人')
    return
  }
  if (normalizedPickupContact.length > 32) {
    showAppWarning('领取人姓名不能超过 32 个字符')
    return
  }
  pickupContact.value = normalizedPickupContact
  persistPickupContactDraft()

  if (!selectedItems.value.length) {
    showAppWarning('请先选择商品')
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

  // 到店取货时间只对部门单必填；提交前刷新时钟复核所选时段是否仍在可选范围内，避免页面停留过久后提交已过期时间。
  let requestedPickupAt: string | null = null
  let requestedPickupSlot: { dateKey: string; timeSlot: string } | null = null
  if (isDepartmentOrder.value) {
    pickupClock.value = Date.now()
    if (!pickupDateKey.value || !pickupTimeSlot.value) {
      showAppWarning('请选择到店取货时间')
      return
    }
    if (!pickupTimeOptions.value.some((slot) => slot.value === pickupTimeSlot.value)) {
      recheckPickupDraft()
      showAppWarning(PICKUP_RESELECT_NOTICE)
      return
    }
    requestedPickupAt = pickupAtIso.value
    requestedPickupSlot = { dateKey: pickupDateKey.value, timeSlot: pickupTimeSlot.value }
  }

  const requestedKingdeeVoucherNo = isDepartmentOrder.value && departmentSystemApplyChoice.value ? kingdeeVoucherNo.value.trim() || null : null
  if (isDepartmentOrder.value && departmentSystemApplyChoice.value && !requestedKingdeeVoucherNo) { showAppWarning('请填写金蝶单据编号'); return }
  const submitRemark = remark.value.trim() || undefined
  const requestedClientOrderType = enforcedClientOrderType.value
  // 刷新目录之前冻结新单原始载荷。刷新后的商品只用于校验提交意图。
  const frozenPayload = {
    isSystemApplied: isDepartmentOrder.value && Boolean(departmentSystemApplyChoice.value),
    kingdeeVoucherNo: requestedKingdeeVoucherNo,
    pickupContact: normalizedPickupContact,
    pickupAt: requestedPickupAt,
    ...(submitRemark === undefined ? {} : { remark: submitRemark }),
    items: selectedItems.value.map(({ productId, skuId, qty }) => ({ productId, skuId, qty })),
  }
  const buildSubmitIntent = (items: typeof frozenPayload.items) => buildClientPreorderSubmitIntentKey({
    ...frozenPayload,
    clientUserId: initiatingUserId,
    clientOrderType: requestedClientOrderType,
    items,
  })
  const requestedIntentKey = buildSubmitIntent(frozenPayload.items)

  await runWithGate({
    actionKey: 'client-checkout-submit',
    onDuplicated: () => {
      showAppInfo('订单提交中，请勿重复点击')
    },
    executor: async () => {
      submitting.value = true
      try {
        // 提交前必须等待一次成功的最新目录刷新；失败或被取消时绝不能沿用旧快照提交。
        const [refreshResult, checkoutStorefront] = await Promise.all([
          refreshMallSnapshot({ isCurrent }),
          requestedPickupSlot ? clientCatalogStore.refreshStorefront(getO2oCheckoutStorefront, 'checkout') : null,
        ])
        if (!isCurrent()) return
        if (requestedPickupSlot) {
          if (!checkoutStorefront) {
            showAppWarning('门店取货时间同步失败，请稍后重试')
            return
          }
          pickupClock.value = Date.now()
          // 取本次私有读取的快照，目录与其他页面的回包不参与新单时段复核。
          const slotMinutes = resolvePickupSlotMinutes(checkoutStorefront.businessHoursText)
          const windowEndMs = resolvePickupWindowEndMs(checkoutStorefront.pickupWindowHours)
          const slotsForDate = (key: string) => buildPickupSlots(key, slotMinutes, windowEndMs)
          const { dateKey, timeSlot } = requestedPickupSlot
          if (!slotsForDate(dateKey).some((slot) => slot.value === timeSlot)) {
            recheckPickupDraft(slotsForDate)
            showAppWarning(PICKUP_RESELECT_NOTICE)
            return
          }
        }
        const freshItemSnapshot = clientCartStore.createSelectedCheckoutSnapshot()
        const reason = getClientCheckoutNewSubmitBlockReason({
          refreshSucceeded: refreshResult.success,
          requestedIntentKey,
          selectedConflictCount: clientCartStore.selectedCheckoutConflicts.length,
          freshItems: freshItemSnapshot,
          freshIntentKey: freshItemSnapshot ? buildSubmitIntent(freshItemSnapshot) : null,
        })
        if (reason) {
          const messageByReason = {
            refresh_failed: refreshResult.error?.message || '商品目录同步失败，请稍后重试',
            selected_conflicts: '已选商品的库存或规格已变化，请先返回购物车调整数量、取消选择或移除后再提交',
            empty_snapshot: '请先选择可结算商品',
            selection_changed_after_refresh: '商品选择在同步期间已变化，请确认购物车后重新提交',
          } satisfies Record<typeof reason, string>
          showAppWarning(messageByReason[reason])
          return
        }
        // 写入并读回完全一致后才允许首次 POST；存储失败不能发送。
        const submitRequestKey = createClientPreorderSubmitLock(initiatingUserId, requestedIntentKey, frozenPayload)
        restorePendingSubmit()
        await sendFrozenSubmission({ ...frozenPayload, clientRequestId: submitRequestKey }, isCurrent, initiatingUserId)
      } catch (error) {
        if (isCurrent()) showAppWarning(normalizeRequestError(error, '原始提交保存失败，本次未发送').message)
      } finally {
        if (isCurrent()) submitting.value = false
      }
    },
  })
}
</script>

<template>
  <div class="client-checkout h-full flex flex-col bg-[var(--ylink-color-bg)]" :class="{ 'client-checkout--standalone': props.standalone }">
    <div class="sticky top-0 z-10 flex items-center gap-3 bg-[var(--ylink-color-surface)] px-4 py-3 shadow-sm">
      <button type="button" class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-white/10" @click="handleBack">
        <el-icon :size="20"><ArrowLeft /></el-icon>
      </button>
      <p class="text-lg font-semibold text-slate-900 dark:text-slate-100">确认订单</p>
    </div>

    <section class="flex-1 overflow-y-auto px-4 py-4 pb-32 sm:px-5">
      <div class="mb-4 rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)] dark:bg-[#141415]">
        <p class="break-words text-sm text-slate-700 dark:text-slate-200">取货地址：{{ clientCatalogStore.storefront.pickupAddress }}</p>
        <p class="mb-2 break-words text-sm text-slate-700 dark:text-slate-200">营业时间：{{ clientCatalogStore.storefront.businessHoursText }}</p>
        <p class="text-sm text-slate-500 dark:text-slate-400">提交前将以服务端库存与限购规则为准</p>
        <p class="mt-2 text-xs text-slate-400">
          {{ catalogSyncing ? '正在后台同步最新库存；提交时会再次校验全部已选商品' : '进入页面后会自动同步最新库存与限购信息' }}
        </p>
      </div>

      <div v-if="pendingSubmit || recoveryError" class="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
        <p class="font-semibold">{{ recoveryError || (pendingSubmit?.expired ? '原提交确认期限已到，结果仍需核实' : '有一笔提交结果尚未确认') }}</p>
        <template v-if="pendingSubmit?.payload">
          <p class="mt-2">原提货人：{{ pendingSubmit.payload.pickupContact }}；取货时间：{{ pendingSubmit.payload.pickupAt || '无需预约' }}</p>
          <p>金蝶申请：{{ pendingSubmit.payload.isSystemApplied ? '已申请' : '未申请' }} {{ pendingSubmit.payload.kingdeeVoucherNo }}</p>
          <p class="whitespace-pre-wrap">原备注：{{ pendingSubmit.payload.remark || '无' }}</p>
          <ul><li v-for="(item, index) in pendingSubmit.payload.items" :key="index">商品 {{ item.productId }} / 规格 {{ item.skuId || '默认' }} × {{ item.qty }}</li></ul>
        </template>
        <p v-if="pendingSubmit" class="mt-2">{{ pendingSubmit.payload ? '继续确认会原样重试首次提交。' : '原提交无法重试，结果仍需在“我的订单”核实。' }}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <el-button @click="router.push('/client/orders')">查看我的订单</el-button>
          <el-button
            v-if="pendingSubmit?.dismissibleMarker && !recoveryError"
            class="!ml-0"
            :disabled="submitting || confirmingRecovery"
            @click="handleDismissPendingSubmit"
          >已核对订单，恢复结算</el-button>
        </div>
      </div>
      <template v-if="!pendingSubmit && !recoveryError">
      <div class="mb-4 rounded-[1.2rem] border border-slate-100 bg-white p-4 shadow-[var(--ylink-shadow-soft)] dark:border-white/5 dark:bg-[#141415]">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="inline-flex h-6 items-center rounded-full bg-teal-50 px-2 text-xs font-semibold text-teal-700 dark:bg-teal-500/10 dark:text-teal-300">提货信息</span>
            <p class="text-sm font-semibold text-slate-800 dark:text-slate-100">{{ isDepartmentOrder ? '领取人姓名（教师姓名）' : '提货人' }}</p>
          </div>
          <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-white/10 dark:text-slate-400">{{ pickupContactInputHint }}</span>
        </div>
        <div class="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 focus-within:border-teal-300 focus-within:bg-white dark:border-white/10 dark:bg-white/5">
          <p class="text-[11px] text-slate-400">{{ isDepartmentOrder ? '实际领取教师' : '提货姓名' }}</p>
          <input
            v-model.trim="pickupContact"
            type="text"
            maxlength="32"
            class="mt-1 w-full border-0 bg-transparent p-0 text-base font-semibold text-slate-900 outline-none dark:text-slate-100"
            :placeholder="isDepartmentOrder ? '请输入实际领取教师姓名' : '请输入提货人（默认用户名）'"
            @blur="handlePickupContactBlur"
          />
        </div>
        <div class="mt-3 grid gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-white/5 dark:text-slate-400">
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600 dark:text-slate-300">账号类型</span>
            <span class="truncate">{{ currentAccountTypeLabel }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600 dark:text-slate-300">账号实名</span>
            <span class="truncate">{{ currentRealName }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600 dark:text-slate-300">所属部门</span>
            <span class="truncate">{{ isDepartmentOrder || isTeacherAccount ? (clientAuthStore.currentUser?.departmentName || '未设置部门') : '个人账号不适用' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600 dark:text-slate-300">{{ currentStaffNoLabel }}</span>
            <span class="truncate">{{ isDepartmentOrder || isTeacherAccount ? (clientAuthStore.currentUser?.staffNo || '未设置编号') : '个人账号不适用' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-600 dark:text-slate-300">工号核验</span>
            <span class="truncate">{{ currentStaffVerifiedText }}</span>
          </div>
        </div>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)] dark:bg-[#141415]">
        <p class="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">下单归属</p>
        <p class="mb-3 text-xs leading-5 text-slate-400">订单归属由当前账号类型自动判定，客户端不可手动切换。</p>
        <div class="rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
          <div class="flex flex-wrap items-center gap-2">
            <span>当前账户类型：<span class="font-semibold text-slate-900 dark:text-slate-100">{{ currentAccountTypeLabel }}</span></span>
            <span class="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-700 dark:bg-[#141415] dark:text-teal-300">{{ isDepartmentOrder ? '部门单' : '散客单' }}</span>
          </div>
          <p class="mt-1 text-xs font-medium text-slate-700 dark:text-slate-200">{{ currentAccountOrderHint }}</p>
        </div>
        <div v-if="isDepartmentOrder" class="mt-4 rounded-[1rem] border border-slate-200 bg-slate-50 px-3 py-3 dark:border-white/10 dark:bg-white/5">
          <div class="flex flex-wrap items-center gap-2">
            <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">金蝶系统是否已申请</p>
            <span class="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">必填</span>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">用于标记本次部门出库是否已在金蝶系统完成审批申请。</p>
          <el-radio-group v-model="departmentSystemApplyChoice" class="mt-3">
            <el-radio-button :value="true">已申请</el-radio-button>
            <el-radio-button :value="false">未申请</el-radio-button>
          </el-radio-group>
          <el-input v-if="departmentSystemApplyChoice === true" v-model="kingdeeVoucherNo" class="mt-3" maxlength="128" placeholder="请输入金蝶单据编号" clearable />
          <p v-if="departmentSystemApplyChoice === false" class="mt-2 text-sm text-red-600">请及时在金蝶申请并填写金蝶单据编号</p>

          <div class="mt-4 border-t border-slate-200 pt-3 dark:border-white/10">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm font-semibold text-slate-700 dark:text-slate-200">到店取货时间</p>
              <span class="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">必填</span>
            </div>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">{{ pickupWindowHint }}</p>

            <div v-if="pickupDateOptions.length" class="pickup-date-grid mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              <el-button
                v-for="option in pickupDateOptions"
                :key="option.key"
                class="pickup-date-option"
                :type="pickupDateKey === option.key ? 'primary' : 'default'"
                plain
                @click="selectPickupDate(option.key)"
              >
                <span class="flex flex-col items-center leading-tight">
                  <span class="text-sm font-medium">{{ option.label }}</span>
                  <span class="mt-0.5 text-[11px] opacity-70">{{ option.dateText }}</span>
                </span>
              </el-button>
            </div>

            <el-select
              v-if="pickupDateOptions.length"
              v-model="pickupTimeSlot"
              class="mt-3 w-full"
              placeholder="请选择到店时段"
              aria-label="到店时段"
              :disabled="!pickupDateKey"
              @change="pickupSelectionNotice = ''"
            >
              <el-option v-for="slot in pickupTimeOptions" :key="slot.value" :label="slot.label" :value="slot.value" />
            </el-select>

            <p class="mt-2 text-xs" :class="!pickupAtIso ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'" role="status">
              {{ pickupAtStatusText }}
            </p>
          </div>
        </div>
        <p class="mt-3 text-xs leading-5" :class="isDepartmentOrder && !currentDepartmentName ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'">
          {{ orderTypeDescription }}
        </p>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)] dark:bg-[#141415]">
        <p class="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">商品明细</p>
        <div
          v-if="clientCartStore.selectedCheckoutConflicts.length"
          class="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <p class="font-semibold">以下已选商品暂不能提交，请返回购物车主动调整、取消选择或移除：</p>
          <ul class="mt-1 list-disc space-y-1 pl-4">
            <li v-for="conflict in clientCartStore.selectedCheckoutConflicts" :key="conflict.item.skuId || conflict.item.productId">
              {{ conflict.item.productName }}：{{ conflict.message }}
            </li>
          </ul>
        </div>
        <article
          v-for="item in selectedItems"
          :key="item.skuId || item.productId"
          class="mb-2 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 dark:bg-white/5"
        >
          <ClientProductSmallImage :small="item.thumbnailSmall" :original="item.thumbnail" :source-key="item.skuId || item.productId" :alt="item.productName" />
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{{ item.productName }}</p>
            <p v-if="item.specText" class="mt-0.5 text-xs text-slate-400">{{ item.specText }}</p>
            <p class="mt-1 text-sm font-bold text-teal-600">¥{{ Number(resolveO2oPriceView(item).discountedPrice).toFixed(2) }}</p>
            <p v-if="resolveO2oPriceView(item).isDiscounted" class="mt-0.5 text-xs text-slate-400">
              原价 ¥{{ Number(resolveO2oPriceView(item).originalPrice).toFixed(2) }} · {{ resolveO2oPriceView(item).discountLabel }}
            </p>
          </div>
          <span class="text-sm font-semibold text-slate-700 dark:text-slate-200">x {{ item.qty }}</span>
        </article>
        <div v-if="!selectedItems.length" class="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400 dark:border-white/10">
          暂无可结算商品
        </div>
      </div>

      <div class="mb-4 rounded-[1.2rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)] dark:bg-[#141415]">
        <p class="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">备注信息</p>
        <textarea
          v-model.trim="remark"
          class="min-h-24 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-teal-300 dark:border-white/10 dark:bg-white/5"
          placeholder="选填：如特殊说明、联系事项等"
        />
      </div>
      </template>
    </section>

    <div class="client-cart-summary absolute bottom-0 left-0 right-0 z-20 border-t border-slate-200 bg-white px-4 py-3 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] dark:border-white/10 dark:bg-[#141415]">
      <div class="mx-auto flex w-full max-w-[1100px] items-center justify-between">
        <div class="flex flex-col">
          <p class="text-sm text-slate-500 dark:text-slate-400">共 <span class="font-bold text-slate-900 dark:text-slate-100">{{ totalQty }}</span> 件，合计 <span class="font-bold text-teal-600">¥{{ totalAmount.toFixed(2) }}</span></p>
          <p class="mt-0.5 text-xs text-slate-400">{{ pendingSubmit?.payload ? '确认以原始提交摘要为准' : pendingSubmit || recoveryError ? '原提交结果待核实' : '提交后进入待提货状态' }}</p>
        </div>
        <button
          type="button"
          class="rounded-full bg-slate-900 px-8 py-2.5 text-sm font-semibold text-white shadow-md transition-transform hover:shadow-lg active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="submitDisabled"
          @click="handleSubmit"
        >
          {{ submitting ? '提交中...' : pendingSubmit?.payload ? '继续确认原提交' : pendingSubmit || recoveryError ? '待核实原提交' : '提交预订单' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 独立路由与公共底栏共存；抽屉继续沿用贴底摘要，不继承路由页的导航留白。 */
.client-checkout--standalone > .client-cart-summary {
  bottom: calc(var(--client-tab-bar-clearance, 0px) + 0.75rem);
}
.client-checkout--standalone > section {
  padding-bottom: calc(8rem + var(--client-tab-bar-clearance, 0px) + 0.75rem);
}
.pb-safe {
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
}

/* 取货日期按钮要在栅格里等宽并容纳两行文案：Element Plus 默认固定行高、相邻按钮还带左外边距，会撑破栅格。 */
.pickup-date-grid :deep(.el-button) {
  width: 100%;
  height: auto;
  padding: 0.5rem 0.5rem;
  border-radius: 0.9rem;
}

.pickup-date-grid :deep(.el-button + .el-button) {
  margin-left: 0;
}
</style>
