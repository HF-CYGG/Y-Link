<script setup lang="ts">
/**
 * 模块说明：src/views/o2o/O2oVerifyConsoleView.vue
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
 */


import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { PageContainer } from '@/components/common'
import { getO2oVerifyDetail, verifyO2oPreorder, type O2oPreorderDetail } from '@/api/modules/o2o'

const verifyCode = ref('')
const detail = ref<O2oPreorderDetail | null>(null)
const loading = ref(false)
const submitting = ref(false)

/**
 * 查询核销信息：
 * - 支持直接粘贴二维码解析后的核销码，也兼容扫码枪连续输入后回车；
 * - 查询成功后在当前页右侧展示订单详情，供工作人员复核。
 */
const handleSearch = async () => {
  if (!verifyCode.value.trim()) {
    ElMessage.warning('请输入核销码')
    return
  }

  loading.value = true
  try {
    detail.value = await getO2oVerifyDetail(verifyCode.value.trim())
  } finally {
    loading.value = false
  }
}

// 详细注释：此处承接当前模块的关键状态、流程或结构定义。
const handleVerify = async () => {
  if (!detail.value) {
    return
  }

  submitting.value = true
  try {
    detail.value = await verifyO2oPreorder(detail.value.order.verifyCode)
    ElMessage.success('核销完成，库存已同步扣减')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <PageContainer title="预订单核销台" description="支持工作人员录入或扫码核销码，核销后自动扣减实际库存与预订库存">
    <div class="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <p class="text-lg font-semibold text-slate-900">扫码 / 输入核销码</p>
        <p class="mt-2 text-sm text-slate-400">扫码枪录入后按回车即可，手动录入可点击“查询订单”</p>

        <el-input
          v-model="verifyCode"
          class="mt-4"
          placeholder="请输入核销码"
          clearable
          @keyup.enter="handleSearch"
        />

        <el-button class="mt-4 w-full" type="primary" :loading="loading" @click="handleSearch">
          查询订单
        </el-button>
      </section>

      <section class="rounded-3xl bg-white p-5 shadow-sm">
        <template v-if="detail">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="text-lg font-semibold text-slate-900">{{ detail.order.showNo }}</p>
              <p class="mt-1 text-sm text-slate-400">状态：{{ detail.order.status }}</p>
            </div>
            <el-button
              type="success"
              :disabled="detail.order.status !== 'pending'"
              :loading="submitting"
              @click="handleVerify"
            >
              确认核销出库
            </el-button>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-3">
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">总件数</p>
              <p class="mt-1 text-base font-semibold text-slate-900">{{ detail.order.totalQty }} 件</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">创建时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ detail.order.createdAt }}</p>
            </div>
            <div class="rounded-2xl bg-slate-50 px-4 py-3">
              <p class="text-sm text-slate-400">核销码</p>
              <p class="mt-1 break-all text-sm text-slate-700">{{ detail.order.verifyCode }}</p>
            </div>
          </div>

          <el-table class="mt-4" :data="detail.items" row-key="id">
            <el-table-column prop="productName" label="商品名称" min-width="180" />
            <el-table-column prop="productCode" label="编码" min-width="120" />
            <el-table-column prop="qty" label="数量" width="90" align="right" />
          </el-table>
        </template>

        <div v-else class="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-200 text-sm text-slate-400">
          请输入核销码或使用扫码枪扫入后查询
        </div>
      </section>
    </div>
  </PageContainer>
</template>
