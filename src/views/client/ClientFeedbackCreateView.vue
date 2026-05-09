<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientFeedbackCreateView.vue
 * 文件职责：提供客户端独立的新建反馈页面，让用户在进入会话页后仅通过按钮跳转到此页面提交新的普通建议或专业 BUG。
 * 实现逻辑：
 * - 页面仅负责“新建反馈”链路，不再混合历史会话查看，减少反馈会话页首屏信息密度；
 * - 普通建议默认走轻量提交流程，切换为专业 BUG 后才显示优先级和结构化字段；
 * - 提交成功后自动跳回反馈会话页，并带上新会话编号用于回显与续接。
 * 维护说明：
 * - 若后续要接入附件上传或截图，可继续在本页面的 BUG 扩展区追加，不影响会话页结构；
 * - 若反馈入口文案改为系统配置驱动，优先复用共享 API 返回的门户配置，不在页面层写死提示。
 */

import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_ISSUE_TYPE_OPTIONS,
  FEEDBACK_PRIORITY_OPTIONS,
  createClientFeedbackConversation,
  getClientFeedbackPortalConfig,
  type FeedbackIssueCategory,
  type FeedbackIssuePriority,
  type FeedbackIssueType,
} from '@/api/modules/customer-service-feedback'
import { useClientAuthStore } from '@/store'
import pinia from '@/store/pinia'
import { extractErrorMessage } from '@/utils/error'
import { normalizeSubmitText } from '@/utils/submit-feedback'

const router = useRouter()
const clientAuthStore = useClientAuthStore(pinia)

const creating = ref(false)
const portalNotice = ref('请尽量描述问题现象、出现时间和影响范围，便于客服持续跟进。')

const createForm = reactive({
  issueType: 'suggestion' as FeedbackIssueType,
  title: '',
  summary: '',
  category: 'order' as FeedbackIssueCategory,
  priority: 'medium' as FeedbackIssuePriority,
  orderRef: '',
  expectedResult: '',
  actualResult: '',
  reproductionSteps: '',
  contactPreference: '',
  tagText: '',
})

const currentClientUser = computed(() => clientAuthStore.currentUser)
const isBugMode = computed(() => createForm.issueType === 'bug')

const parseTagText = (value: string): string[] => {
  return [...new Set(
    value
      .split(/[，,]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )]
}

const handleNavigateBack = () => {
  if (globalThis.history.length > 1) {
    router.back()
    return
  }
  router.push('/client/feedback')
}

const resetBugFields = () => {
  createForm.priority = 'medium'
  createForm.orderRef = ''
  createForm.expectedResult = ''
  createForm.actualResult = ''
  createForm.reproductionSteps = ''
  createForm.contactPreference = ''
  createForm.tagText = ''
}

const handleChangeIssueType = (issueType: FeedbackIssueType) => {
  createForm.issueType = issueType
  if (issueType !== 'bug') {
    resetBugFields()
  }
}

const loadPortalConfig = async () => {
  const config = await getClientFeedbackPortalConfig()
  portalNotice.value = config.entryNotice
}

const handleCreateConversation = async () => {
  if (!currentClientUser.value) {
    ElMessage.warning('当前登录状态异常，请重新进入客户端后重试')
    return
  }

  const normalizedTitle = normalizeSubmitText(createForm.title)
  const normalizedSummary = normalizeSubmitText(createForm.summary)
  const normalizedExpectedResult = normalizeSubmitText(createForm.expectedResult)
  const normalizedActualResult = normalizeSubmitText(createForm.actualResult)

  if (!normalizedTitle || !normalizedSummary) {
    ElMessage.warning('请至少填写问题标题和问题描述')
    return
  }
  if (isBugMode.value && (!normalizedExpectedResult || !normalizedActualResult)) {
    ElMessage.warning('专业 BUG 需要补充期望结果与实际结果，方便客服快速定位')
    return
  }

  creating.value = true
  try {
    const createdRecord = await createClientFeedbackConversation({
      title: normalizedTitle,
      summary: normalizedSummary,
      issueType: createForm.issueType,
      priority: isBugMode.value ? createForm.priority : 'medium',
      category: createForm.category,
      orderRef: createForm.orderRef,
      expectedResult: isBugMode.value ? normalizedExpectedResult : undefined,
      actualResult: isBugMode.value ? normalizedActualResult : undefined,
      reproductionSteps: isBugMode.value ? createForm.reproductionSteps : undefined,
      contactPreference: isBugMode.value ? createForm.contactPreference : undefined,
      tags: isBugMode.value ? parseTagText(createForm.tagText) : undefined,
    })

    ElMessage.success('反馈已提交，正在跳转到反馈单详情页')
    await router.replace({
      path: `/client/feedback/${createdRecord.id}`,
    })
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '反馈提交失败，请稍后重试'))
  } finally {
    creating.value = false
  }
}

onMounted(async () => {
  if (!currentClientUser.value?.id) {
    return
  }
  try {
    await loadPortalConfig()
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '新建反馈页加载失败，请稍后重试'))
  }
})
</script>

<template>
  <section class="space-y-4 pb-4">
    <div class="rounded-[1.5rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-start gap-3">
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          @click="handleNavigateBack"
        >
          <svg viewBox="0 0 20 20" fill="none" class="h-4 w-4" aria-hidden="true">
            <path d="M11.5 4.5L6 10l5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>返回</span>
        </button>
        <div class="min-w-0 flex-1">
          <p class="text-xl font-semibold text-slate-900">新建反馈</p>
          <p class="mt-1 text-sm leading-6 text-slate-500">
            使用独立页面提交新的普通建议或专业 BUG，提交成功后会自动回到反馈会话页继续跟进。
          </p>
        </div>
      </div>
      <div class="mt-4 rounded-[1rem] border border-slate-200 bg-slate-50 px-4 py-3">
        <p class="text-sm font-medium text-slate-700">{{ portalNotice }}</p>
        <p class="mt-1 text-xs leading-5 text-slate-500">若问题已存在，请优先回到原会话继续补充，避免重复建单。</p>
      </div>
    </div>

    <article class="rounded-[1.4rem] bg-white p-4 shadow-[var(--ylink-shadow-soft)]">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="text-base font-semibold text-slate-900">反馈信息</p>
          <p class="mt-1 text-xs leading-5 text-slate-400">普通建议默认轻量提交，专业 BUG 再展开排查字段。</p>
        </div>
        <span class="rounded-full bg-brand/10 px-3 py-1 text-xs font-semibold text-brand">独立提交页</span>
      </div>

      <div class="mt-4 space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <button
            v-for="item in FEEDBACK_ISSUE_TYPE_OPTIONS"
            :key="item.value"
            type="button"
            class="rounded-[1rem] border p-4 text-left transition"
            :class="createForm.issueType === item.value ? 'border-brand bg-brand/5' : 'border-slate-200 bg-slate-50 hover:border-slate-300'"
            @click="handleChangeIssueType(item.value)"
          >
            <p class="text-sm font-semibold text-slate-900">{{ item.label }}</p>
            <p class="mt-1 text-xs leading-5 text-slate-500">{{ item.hint }}</p>
          </button>
        </div>

        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">问题标题</span>
          <input
            v-model="createForm.title"
            type="text"
            maxlength="80"
            class="feedback-input"
            placeholder="例如：订单核销后客户端仍显示待提货"
          />
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-slate-500">问题分类</span>
            <select v-model="createForm.category" class="feedback-input">
              <option v-for="item in FEEDBACK_CATEGORY_OPTIONS" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </label>
          <label v-if="isBugMode" class="block">
            <span class="mb-1 block text-xs font-medium text-slate-500">优先级</span>
            <select v-model="createForm.priority" class="feedback-input">
              <option v-for="item in FEEDBACK_PRIORITY_OPTIONS" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-xs font-medium text-slate-500">问题描述</span>
          <textarea
            v-model="createForm.summary"
            class="feedback-textarea"
            maxlength="400"
            :placeholder="isBugMode ? '请描述异常现象、出现时间、影响范围和使用环境。' : '请说明你的建议、诉求或遇到的不便。'"
          />
        </label>

        <div v-if="isBugMode" class="rounded-[1rem] border border-slate-200 bg-slate-50/80 p-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-slate-900">专业 BUG 补充</p>
              <p class="mt-1 text-xs text-slate-400">仅在需要排查时填写，客服会按这些结构化字段定位问题。</p>
            </div>
            <span class="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-500">结构化字段</span>
          </div>

          <div class="mt-3 space-y-3">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-500">关联订单号</span>
              <input
                v-model="createForm.orderRef"
                type="text"
                maxlength="64"
                class="feedback-input"
                placeholder="如与某笔订单相关，可填写订单号或提货码"
              />
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-500">期望结果</span>
              <textarea
                v-model="createForm.expectedResult"
                class="feedback-textarea feedback-textarea--short"
                maxlength="240"
                placeholder="例如：核销成功后订单应立即更新为已提货。"
              />
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-500">实际结果</span>
              <textarea
                v-model="createForm.actualResult"
                class="feedback-textarea feedback-textarea--short"
                maxlength="240"
                placeholder="例如：订单状态仍停留在待提货，并重复弹出核销提示。"
              />
            </label>

            <label class="block">
              <span class="mb-1 block text-xs font-medium text-slate-500">复现步骤</span>
              <textarea
                v-model="createForm.reproductionSteps"
                class="feedback-textarea feedback-textarea--short"
                maxlength="300"
                placeholder="可按 1、2、3 步说明操作路径，帮助客服复现。"
              />
            </label>

            <div class="grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="mb-1 block text-xs font-medium text-slate-500">联系偏好</span>
                <input
                  v-model="createForm.contactPreference"
                  type="text"
                  maxlength="64"
                  class="feedback-input"
                  placeholder="如：优先站内回复 / 也可电话联系"
                />
              </label>
              <label class="block">
                <span class="mb-1 block text-xs font-medium text-slate-500">标签</span>
                <input
                  v-model="createForm.tagText"
                  type="text"
                  maxlength="120"
                  class="feedback-input"
                  placeholder="使用中文逗号分隔，如：核销，状态不同步"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        class="mt-4 w-full rounded-[1rem] bg-brand px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="creating"
        @click="handleCreateConversation"
      >
        {{ creating ? '提交中...' : '提交反馈并进入会话' }}
      </button>
    </article>
  </section>
</template>

<style scoped>
.feedback-input,
.feedback-textarea {
  width: 100%;
  border: 1px solid rgb(226 232 240);
  border-radius: 1rem;
  background: #ffffff;
  color: rgb(15 23 42);
  font-size: 0.95rem;
  line-height: 1.5;
  padding: 0.8rem 0.92rem;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.feedback-input:focus,
.feedback-textarea:focus {
  outline: none;
  border-color: rgba(13, 148, 136, 0.45);
  box-shadow: 0 0 0 4px rgba(13, 148, 136, 0.12);
}

.feedback-textarea {
  min-height: 7.5rem;
  resize: vertical;
}

.feedback-textarea--short {
  min-height: 5.5rem;
}
</style>
