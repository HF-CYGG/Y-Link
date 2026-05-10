<script setup lang="ts">
/**
 * 模块说明：src/views/client/ClientFeedbackCreateView.vue
 * 文件职责：提供客户端独立的新建反馈页面，让用户提交普通建议或专业 BUG，并在建单时一并上传图片附件。
 * 实现逻辑：
 * - 页面仅负责“新建反馈”链路，不再混合历史会话查看，减少反馈会话页首屏信息密度；
 * - 普通建议默认走轻量提交流程，切换为专业 BUG 后才显示优先级和结构化字段；
 * - 附件仍归属到当前反馈单首条消息，提交成功后自动跳到详情页继续沿用原有会话与实时链路。
 * 维护说明：
 * - 当前上传能力仅开放图片附件，如后续要扩展视频或文档，请同步调整前后端白名单与预览方式；
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
  resolveFeedbackAttachmentUrl,
  uploadClientFeedbackAttachment,
  type FeedbackConversationMessageAttachment,
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
const FEEDBACK_ATTACHMENT_LIMIT = 9
const FEEDBACK_ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024

const creating = ref(false)
const uploadingAttachments = ref(false)
const portalNotice = ref('请尽量描述问题现象、出现时间和影响范围，便于客服持续跟进。')
const createAttachments = ref<FeedbackConversationMessageAttachment[]>([])
const createAttachmentInputRef = ref<HTMLInputElement | null>(null)
const previewImageUrl = ref('')

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
const hasCreateAttachments = computed(() => createAttachments.value.length > 0)

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

const formatAttachmentSize = (size: number | null) => {
  if (!size || size <= 0) {
    return '大小未知'
  }
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

const resolveAttachmentPreviewUrl = (attachment: FeedbackConversationMessageAttachment) => {
  return resolveFeedbackAttachmentUrl(attachment.url)
}

const isImageAttachment = (attachment: FeedbackConversationMessageAttachment) => {
  const normalizedMimeType = attachment.mimeType?.toLowerCase() || ''
  if (normalizedMimeType.startsWith('image/')) {
    return true
  }
  return /\.(png|jpe?g|gif|webp)$/i.test(attachment.name)
}

const openAttachmentPicker = () => {
  createAttachmentInputRef.value?.click()
}

/**
 * 上传图片附件时保持串行处理：
 * - 逐个上传更容易给出具体失败文件提示；
 * - 当前反馈首条消息最多 9 个附件，与后端校验口径保持一致。
 */
const handleCreateAttachmentChange = async (event: Event) => {
  const input = event.target as HTMLInputElement | null
  const files = Array.from(input?.files ?? [])
  if (!files.length) {
    return
  }

  if (createAttachments.value.length >= FEEDBACK_ATTACHMENT_LIMIT) {
    ElMessage.warning(`单条反馈最多上传 ${FEEDBACK_ATTACHMENT_LIMIT} 张图片`)
    input!.value = ''
    return
  }

  const remainCount = FEEDBACK_ATTACHMENT_LIMIT - createAttachments.value.length
  const targetFiles = files.slice(0, remainCount)
  uploadingAttachments.value = true
  try {
    for (const file of targetFiles) {
      if (!file.type.startsWith('image/')) {
        ElMessage.warning(`文件 ${file.name} 不是图片，已跳过`)
        continue
      }
      if (file.size > FEEDBACK_ATTACHMENT_MAX_SIZE) {
        ElMessage.warning(`文件 ${file.name} 超过 10MB，已跳过`)
        continue
      }
      const attachment = await uploadClientFeedbackAttachment(file)
      createAttachments.value = [...createAttachments.value, attachment]
    }
    ElMessage.success('附件上传完成，可随反馈单一并提交')
  } catch (error) {
    ElMessage.error(extractErrorMessage(error, '附件上传失败，请稍后重试'))
  } finally {
    uploadingAttachments.value = false
    if (input) {
      input.value = ''
    }
  }
}

const handleRemoveAttachment = (attachmentIndex: number) => {
  createAttachments.value = createAttachments.value.filter((_, index) => index !== attachmentIndex)
}

const handlePreviewAttachment = (attachment: FeedbackConversationMessageAttachment) => {
  const previewUrl = resolveAttachmentPreviewUrl(attachment)
  if (!previewUrl) {
    ElMessage.warning('当前附件地址无效，暂时无法预览')
    return
  }
  if (!isImageAttachment(attachment)) {
    window.open(previewUrl, '_blank', 'noopener')
    return
  }
  previewImageUrl.value = previewUrl
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
      attachments: createAttachments.value,
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

        <div class="rounded-[1rem] border border-dashed border-slate-200 bg-slate-50/80 p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-slate-900">图片附件</p>
              <p class="mt-1 text-xs leading-5 text-slate-400">
                可上传截图、异常界面或订单凭证图片，帮助客服更快理解问题。单次最多 {{ FEEDBACK_ATTACHMENT_LIMIT }} 张，仅支持 JPG/PNG/WEBP/GIF。
              </p>
            </div>
            <button
              type="button"
              class="rounded-[0.9rem] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="uploadingAttachments || createAttachments.length >= FEEDBACK_ATTACHMENT_LIMIT"
              @click="openAttachmentPicker"
            >
              {{ uploadingAttachments ? '上传中...' : hasCreateAttachments ? '继续添加图片' : '上传图片附件' }}
            </button>
          </div>
          <input
            ref="createAttachmentInputRef"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            class="hidden"
            @change="handleCreateAttachmentChange"
          />

          <div v-if="hasCreateAttachments" class="mt-4 grid gap-3 sm:grid-cols-2">
            <article
              v-for="(attachment, index) in createAttachments"
              :key="`${attachment.url}-${index}`"
              class="rounded-[1rem] bg-white p-3 shadow-sm ring-1 ring-inset ring-slate-200"
            >
              <div class="flex items-start gap-3">
                <img
                  v-if="isImageAttachment(attachment)"
                  :src="resolveAttachmentPreviewUrl(attachment)"
                  :alt="attachment.name"
                  class="feedback-attachment-thumb"
                />
                <div
                  v-else
                  class="feedback-attachment-thumb feedback-attachment-thumb--placeholder flex items-center justify-center text-xs font-semibold text-slate-500"
                >
                  附件
                </div>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ attachment.name }}</p>
                  <p class="mt-1 text-xs text-slate-400">{{ formatAttachmentSize(attachment.size) }}</p>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-200"
                      @click="handlePreviewAttachment(attachment)"
                    >
                      预览
                    </button>
                    <button
                      type="button"
                      class="rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-100"
                      @click="handleRemoveAttachment(index)"
                    >
                      移除
                    </button>
                  </div>
                </div>
              </div>
            </article>
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

  <Teleport to="body">
    <div v-if="previewImageUrl" class="feedback-preview-overlay" @click.self="previewImageUrl = ''">
      <div class="feedback-preview-panel">
        <button type="button" class="feedback-preview-close" @click="previewImageUrl = ''">关闭</button>
        <img :src="previewImageUrl" alt="附件预览" class="feedback-preview-image" />
      </div>
    </div>
  </Teleport>
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

.feedback-attachment-thumb {
  height: 4.5rem;
  width: 4.5rem;
  flex-shrink: 0;
  border-radius: 1rem;
  object-fit: cover;
  background: rgb(241 245 249);
}

.feedback-attachment-thumb--placeholder {
  border: 1px dashed rgb(203 213 225);
}

.feedback-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.72);
  padding: 1rem;
}

.feedback-preview-panel {
  width: min(100%, 48rem);
  border-radius: 1.5rem;
  background: rgba(255, 255, 255, 0.98);
  padding: 1rem;
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
}

.feedback-preview-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: rgb(241 245 249);
  color: rgb(71 85 105);
  padding: 0.55rem 0.95rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.feedback-preview-image {
  margin-top: 0.9rem;
  max-height: 72vh;
  width: 100%;
  border-radius: 1.25rem;
  object-fit: contain;
  background: rgb(248 250 252);
}
</style>
