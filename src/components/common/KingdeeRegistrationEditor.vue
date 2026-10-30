<script setup lang="ts">
/**
 * 模块说明：src/components/common/KingdeeRegistrationEditor.vue
 * 文件职责：按原预订单登记、更正或清空金蝶单据编号。
 * 实现逻辑：
 * - 独立版本提交；冲突后读取最新版本并保留输入，须再次明确确认才能重试；
 * - 按会话收敛登记版本，轮询不覆盖草稿，保存后的旧响应不能回退登记投影。
 * 维护说明：不编辑主状态或商品，后台父单应逐来源调用；关闭和换单后丢弃迟到请求。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getKingdeeSession, synchronizeKingdeeResponse } from '@/utils/kingdee-freshness'
import type { KingdeeRegistration } from '../../../packages/shared-types/src/orders'
import { getO2oConsoleOrderDetail, getO2oPreorderDetail, updateAdminKingdeeRegistration, updateMyKingdeeRegistration } from '@/api/modules/o2o'
import { notifyClientOrderRefresh } from '@/utils/client-order-refresh'
import { normalizeRequestError } from '@/utils/error'
const props = withDefaults(defineProps<{ orderId: string; registration: KingdeeRegistration; admin?: boolean; canEdit?: boolean }>(), { admin: false, canEdit: true })
const emit = defineEmits<{ saved: [] }>()
const draft = ref('')
const version = ref(0)
const busy = ref(false)
const editing = ref(false)
const message = ref('')
const conflictVersion = ref<number | null>(null)
const localRegistration = ref<KingdeeRegistration>(props.registration)
const label = computed(() => ({ not_applied: '未申请', applied_pending: '已申请待补编号', registered: '已登记', unknown: '待确认' }[localRegistration.value.kingdeeStatus ?? 'unknown']))
let generation = 0
let controller: AbortController | null = null
const scope = () => props.admin ? 'admin' as const : 'client' as const
const adopt = (value: KingdeeRegistration) => synchronizeKingdeeResponse(scope(), { id: props.orderId, ...value })
watch(() => [props.orderId, props.admin, getKingdeeSession(scope()).epoch], () => {
  generation += 1; controller?.abort(); busy.value = false; editing.value = false; draft.value = ''; message.value = ''; conflictVersion.value = null
  localRegistration.value = { kingdeeVoucherNo: null, kingdeeVersion: 0, kingdeeStatus: null, kingdeeEditable: false }
}, { flush: 'sync' })
watch(() => [props.orderId, props.registration] as const, ([, value]) => { localRegistration.value = adopt(value) }, { immediate: true })
const confirmConflict = () => { if (busy.value || conflictVersion.value === null) return; version.value = conflictVersion.value; conflictVersion.value = null; message.value = '已采用最新版本，请核对输入并点击保存' }
const begin = () => { draft.value = localRegistration.value.kingdeeVoucherNo ?? ''; version.value = localRegistration.value.kingdeeVersion; message.value = ''; conflictVersion.value = null; editing.value = true }
const save = async () => {
  if (busy.value || conflictVersion.value !== null || !props.canEdit || !localRegistration.value.kingdeeEditable) return
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
onBeforeUnmount(() => { generation += 1; controller?.abort() })
</script>
<template>
  <div class="space-y-2" data-testid="kingdee-registration-editor">
    <p class="text-sm">{{ localRegistration.kingdeeStatus === null ? '不适用' : label }}<span v-if="localRegistration.kingdeeVoucherNo"> · {{ localRegistration.kingdeeVoucherNo }}</span></p>
    <el-button v-if="canEdit && localRegistration.kingdeeEditable && !editing" size="small" @click="begin">填写 / 更正金蝶编号</el-button>
    <template v-if="editing">
      <el-input v-model="draft" :disabled="busy" maxlength="128" placeholder="金蝶单据编号，留空可清空" clearable />
      <p v-if="message" class="text-sm text-red-600" role="alert">{{ message }}</p>
      <el-button v-if="conflictVersion !== null" :disabled="busy" @click="confirmConflict">按最新版本重新确认</el-button>
      <el-button type="primary" size="small" :loading="busy" :disabled="conflictVersion !== null" @click="save">保存</el-button>
      <el-button size="small" :disabled="busy" @click="editing = false">取消</el-button>
    </template>
  </div>
</template>
