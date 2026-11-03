<script setup lang="ts">
/**
 * 模块说明：src/components/common/KingdeeRegistrationEditor.vue
 * 文件职责：按原预订单登记、更正或清空金蝶单据编号。
 * 实现逻辑：
 * - 复用共享弹窗编辑编号，卡片只保留号码与入口；保存期间禁止关闭；
 * - 独立版本提交；冲突后读取最新版本并保留输入，须再次明确确认才能重试；
 * - 按会话收敛登记版本，轮询不覆盖草稿，保存后的旧响应不能回退登记投影。
 * 维护说明：不编辑主状态或商品，后台父单应逐来源调用；失活、卸载和换单后丢弃迟到请求。
 */
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { getKingdeeSession, synchronizeKingdeeResponse } from '@/utils/kingdee-freshness'
import type { KingdeeRegistration } from '../../../packages/shared-types/src/orders'
import { getO2oConsoleOrderDetail, getO2oPreorderDetail, updateAdminKingdeeRegistration, updateMyKingdeeRegistration } from '@/api/modules/o2o'
import { notifyClientOrderRefresh } from '@/utils/client-order-refresh'
import { normalizeRequestError } from '@/utils/error'
import BizCrudDialogShell from '@/components/common/business-composite/BizCrudDialogShell.vue'
const props = withDefaults(defineProps<{ orderId: string; registration: KingdeeRegistration; admin?: boolean; canEdit?: boolean; numberOnly?: boolean }>(), { admin: false, canEdit: true, numberOnly: false })
const emit = defineEmits<{ saved: [] }>()
const draft = ref('')
const version = ref(0)
const busy = ref(false)
const editing = ref(false)
const message = ref('')
const conflictVersion = ref<number | null>(null)
const conflictPending = ref(false)
const localRegistration = ref<KingdeeRegistration>(props.registration)
const editable = computed(() => Boolean(props.orderId.trim()) && props.canEdit && localRegistration.value.kingdeeEditable)
const orderContext = computed(() => {
  const registration = props.registration as KingdeeRegistration & { sourcePreorderNo?: string | null; preorderNo?: string | null }
  return registration.sourcePreorderNo || registration.preorderNo || props.orderId || '未记录'
})
const label = computed(() => ({ not_applied: '未申请', applied_pending: '已申请待补编号', registered: '已登记', unknown: '待确认' }[localRegistration.value.kingdeeStatus ?? 'unknown']))
let generation = 0
let controller: AbortController | null = null
const scope = () => props.admin ? 'admin' as const : 'client' as const
const adopt = (value: KingdeeRegistration) => synchronizeKingdeeResponse(scope(), { id: props.orderId, ...value })
// 上下文离开强制失效，不受活动页面保存期间的用户关闭守卫限制。
// abort 只取消客户端等待，不承诺撤销已到达服务端的写入。
const invalidateEditing = () => {
  generation += 1; controller?.abort(); controller = null
  busy.value = false; editing.value = false; draft.value = ''; version.value = 0
  message.value = ''; conflictVersion.value = null; conflictPending.value = false
}
watch(() => [props.orderId, props.admin, getKingdeeSession(scope()).epoch], () => {
  invalidateEditing()
  localRegistration.value = { kingdeeVoucherNo: null, kingdeeVersion: 0, kingdeeStatus: null, kingdeeEditable: false }
}, { flush: 'sync' })
watch(() => [props.orderId, props.registration] as const, ([, value]) => { localRegistration.value = adopt(value) }, { immediate: true })
const confirmConflict = () => { if (busy.value || !editing.value || !editable.value || conflictVersion.value === null) return; version.value = conflictVersion.value; conflictVersion.value = null; conflictPending.value = false; message.value = '已采用最新版本，请核对输入并点击保存' }
const begin = () => {
  if (busy.value || !editable.value) return
  draft.value = localRegistration.value.kingdeeVoucherNo ?? ''; version.value = localRegistration.value.kingdeeVersion
  message.value = ''; conflictVersion.value = null; conflictPending.value = false; editing.value = true
}
const setEditing = (value: boolean) => {
  if (value || busy.value) return
  generation += 1; controller?.abort(); editing.value = false; message.value = ''; conflictVersion.value = null; conflictPending.value = false
}
const beforeClose = (done: () => void) => { if (!busy.value) done() }
const save = async () => {
  if (!editing.value || busy.value || conflictPending.value || !editable.value) return
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(draft.value) || [...draft.value.trim()].length > 128) { message.value = '编号最多 128 个字符，不能包含控制字符'; return }
  const request = ++generation
  const id = props.orderId
  controller?.abort(); controller = new AbortController(); busy.value = true; message.value = ''
  try {
    const update = props.admin ? updateAdminKingdeeRegistration : updateMyKingdeeRegistration
    const result = await update(id, { kingdeeVoucherNo: draft.value.trim() || null, expectedKingdeeVersion: version.value }, { signal: controller.signal })
    if (request !== generation) return
    localRegistration.value = adopt(result.order); editing.value = false
    notifyClientOrderRefresh({ orderId: id, reason: 'compliance_updated' }); emit('saved')
  } catch (error) {
    if (request !== generation) return
    const normalized = normalizeRequestError(error, '金蝶登记失败')
    message.value = normalized.message
    const status = normalized.status
    if (status === 409) {
      conflictPending.value = true
      try {
        const get = props.admin ? getO2oConsoleOrderDetail : getO2oPreorderDetail
        const latest = await get(id, { signal: controller.signal })
        if (request !== generation) return
        localRegistration.value = adopt(latest.order); conflictVersion.value = localRegistration.value.kingdeeVersion
        message.value = `登记已变化，最新编号：${latest.order.kingdeeVoucherNo || '未填写'}。已保留你的输入，请核对后重新确认。`
      } catch { if (request === generation) message.value = '登记冲突且刷新失败，已保留输入，请关闭编辑后重试' }
    }
  } finally { if (request === generation) busy.value = false }
}
onDeactivated(invalidateEditing)
onBeforeUnmount(invalidateEditing)
</script>
<template>
  <div class="space-y-2" data-testid="kingdee-registration-editor">
    <div v-if="numberOnly" class="relative">
      <p class="break-all text-sm text-slate-700 dark:text-slate-200" :class="{ 'pr-14': editable }">{{ localRegistration.kingdeeVoucherNo || '无' }}</p>
      <el-button v-if="editable" class="!absolute right-0 top-0 !h-5 !py-0" size="small" @click="begin">{{ localRegistration.kingdeeVoucherNo ? '更改' : '填写' }}</el-button>
    </div>
    <template v-else>
      <p class="text-sm">{{ localRegistration.kingdeeStatus === null ? '不适用' : label }}<span v-if="localRegistration.kingdeeVoucherNo"> · {{ localRegistration.kingdeeVoucherNo }}</span></p>
      <el-button v-if="editable" size="small" @click="begin">填写 / 更正金蝶编号</el-button>
    </template>
    <BizCrudDialogShell
      :model-value="editing"
      title="修改金蝶单据编号"
      height-mode="auto"
      :before-close="beforeClose"
      :show-close="!busy"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      @update:model-value="setEditing"
    >
      <p class="mb-4 break-all text-sm text-slate-500 dark:text-slate-400">当前来源预订单：{{ orderContext }}</p>
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="金蝶单据编号">
          <el-input v-model="draft" :disabled="busy || !editable" maxlength="128" placeholder="金蝶单据编号，留空可清空" clearable @keyup.enter="save" />
        </el-form-item>
        <p class="text-xs text-slate-500 dark:text-slate-400">最多 128 个字符，不能包含控制字符；留空保存将清空编号。</p>
        <p v-if="message" class="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">{{ message }}</p>
        <el-button v-if="conflictVersion !== null" class="mt-3" :disabled="busy || !editable" @click="confirmConflict">按最新版本重新确认</el-button>
      </el-form>
      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <el-button :disabled="busy" @click="setEditing(false)">取消</el-button>
          <el-button type="primary" :loading="busy" :disabled="busy || conflictPending || !editable" @click="save">保存</el-button>
        </div>
      </template>
    </BizCrudDialogShell>
  </div>
</template>
