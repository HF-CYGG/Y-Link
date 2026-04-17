<script setup lang="ts">
/**
 * 模块说明：src/components/common/page-shared/UnifiedScanDialog.vue
 * 文件职责：提供统一的扫码弹窗 UI 壳，内部通过插槽和 ref 回传对接不同的扫码引擎。
 * 维护说明：只负责扫码弹窗的视觉交互与多端适配，不包含具体的扫码硬件调用逻辑。
 */
import { computed, ref, watch } from 'vue'
import { useAppStore } from '@/store'

interface Props {
  modelValue: boolean
  title?: string
  loading?: boolean
  statusText?: string
  hintText?: string
  modeLabel?: string
  width?: string
  bindScannerContainer?: (element: HTMLDivElement | null) => void
}

const props = withDefaults(defineProps<Props>(), {
  title: '扫码识别',
  loading: false,
  statusText: '正在准备扫码能力，请稍候...',
  hintText: '请将二维码或条码对准取景框中央，识别成功后会自动回填。',
  modeLabel: '智能识别',
  width: '860px',
  bindScannerContainer: undefined,
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'closed'): void
}>()

const localScannerContainerRef = ref<HTMLDivElement | null>(null)
const appStore = useAppStore()

/**
 * 扫码卡片布局模式：
 * - desktop 使用横向信息布局，强调可视区域和辅助说明并排展示；
 * - 非桌面设备（手机/平板）统一使用竖屏卡片，避免被误判后套用 PC 样式。
 */
const isMobileLayout = computed(() => !appStore.isDesktop)

// 统一为外部 composable 回填扫码容器 DOM，
// 这样页面层只负责弹窗视觉，底层可以自由切换具体扫码引擎实现。
watch(
  localScannerContainerRef,
  (element) => {
    props.bindScannerContainer?.(element)
  },
  { immediate: true },
)

const handleDialogClosed = () => {
  emit('closed')
}

const closeDialog = () => {
  emit('update:modelValue', false)
}

const handleDialogModelValueChange = (value: boolean) => {
  emit('update:modelValue', value)
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="props.title"
    :width="props.width"
    class="unified-scan-dialog"
    :close-on-click-modal="false"
    @update:model-value="handleDialogModelValueChange"
    @closed="handleDialogClosed"
  >
    <div v-if="!isMobileLayout" class="scan-shell scan-shell--desktop">
      <div class="scan-shell__topbar">
        <div class="scan-shell__intro">
          <p class="scan-shell__eyebrow">智能扫码卡片</p>
          <p class="scan-shell__headline">请将条码或二维码放入中央识别区</p>
        </div>
        <div class="scan-shell__meta">
          <span class="scan-shell__mode">{{ props.modeLabel }}</span>
          <span class="scan-shell__status">{{ props.loading ? '启动中' : '识别中' }}</span>
        </div>
      </div>

      <div class="scan-shell__layout">
        <section class="scan-shell__stage-card">
          <div class="scan-shell__preview">
            <div ref="localScannerContainerRef" class="scan-shell__scanner-host" />
            <div class="scan-shell__guide-frame" />
            <div v-if="props.loading" class="scan-shell__mask">正在启动摄像头...</div>
          </div>
        </section>

        <aside class="scan-shell__info-card" aria-label="扫码提示信息">
          <p class="scan-shell__status-text">{{ props.statusText }}</p>
          <p class="scan-shell__hint-text">{{ props.hintText }}</p>
          <div class="scan-shell__tips">
            <span class="scan-shell__tip">保持设备稳定</span>
            <span class="scan-shell__tip">二维码尽量铺满中央框体</span>
            <span class="scan-shell__tip">反光或模糊时改用拍照识别</span>
          </div>
        </aside>
      </div>
    </div>

    <div v-else class="scan-shell-mobile">
      <div class="scan-shell-mobile__topbar">
        <div class="scan-shell-mobile__intro">
          <p class="scan-shell-mobile__eyebrow">智能扫码卡片</p>
          <p class="scan-shell-mobile__headline">请将条码或二维码放入中央识别区</p>
        </div>
        <div class="scan-shell-mobile__meta">
          <span class="scan-shell-mobile__mode">{{ props.modeLabel }}</span>
          <span class="scan-shell-mobile__status">{{ props.loading ? '启动中' : '识别中' }}</span>
        </div>
      </div>

      <section class="scan-shell-mobile__stage-card">
        <div class="scan-shell-mobile__preview">
          <div ref="localScannerContainerRef" class="scan-shell-mobile__scanner-host" />
          <div class="scan-shell-mobile__guide-frame" />
          <div v-if="props.loading" class="scan-shell-mobile__mask">正在启动摄像头...</div>
        </div>
      </section>

      <aside class="scan-shell-mobile__info-card" aria-label="扫码提示信息">
        <p class="scan-shell-mobile__status-text">{{ props.statusText }}</p>
        <p class="scan-shell-mobile__hint-text">{{ props.hintText }}</p>
        <div class="scan-shell-mobile__tips">
          <span class="scan-shell-mobile__tip">保持设备稳定</span>
          <span class="scan-shell-mobile__tip">二维码尽量铺满中央框体</span>
          <span class="scan-shell-mobile__tip">反光或模糊时改用拍照识别</span>
        </div>
      </aside>
    </div>

    <template #footer>
      <el-button @click="closeDialog">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.unified-scan-dialog:deep(.el-dialog) {
  width: min(96vw, 1120px) !important;
  max-height: 94vh;
  border-radius: 24px;
  overflow: hidden;
}

.unified-scan-dialog:deep(.el-dialog__body) {
  padding-top: 10px;
  max-height: calc(94vh - 112px);
  overflow: auto;
}

.scan-shell {
  border-radius: 24px;
  background:
    radial-gradient(circle at top right, rgba(45, 212, 191, 0.12), transparent 36%),
    linear-gradient(180deg, rgba(15, 23, 42, 0.02), rgba(15, 23, 42, 0.06));
  padding: 18px;
  box-sizing: border-box;
}

.scan-shell--desktop {
  min-height: 0;
}

.scan-shell__topbar {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 12px;
}

.scan-shell__intro {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.scan-shell__eyebrow {
  color: rgb(13, 148, 136);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.scan-shell__headline {
  color: rgb(15, 23, 42);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.45;
}

.scan-shell__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.scan-shell__layout {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(260px, 0.82fr);
  gap: 14px;
  align-items: stretch;
}

.scan-shell__stage-card,
.scan-shell__info-card {
  border-radius: 20px;
  overflow: hidden;
}

.scan-shell__stage-card {
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 1));
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.06),
    0 18px 40px rgba(15, 23, 42, 0.12);
}

.scan-shell__mode,
.scan-shell__status {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  border-radius: 999px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
}

.scan-shell__mode {
  background: #d1fae5;
  color: #065f46;
}

.scan-shell__status {
  background: #e2e8f0;
  color: #0f172a;
}

.scan-shell__preview {
  position: relative;
  overflow: hidden;
  width: 100%;
  max-width: none;
  margin: 0 auto;
  aspect-ratio: 16 / 10;
  max-height: min(66vh, 720px);
  padding: 14px;
  box-sizing: border-box;
}

.scan-shell__scanner-host {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  border-radius: 22px;
  overflow: hidden;
  background:
    radial-gradient(circle at center, rgba(15, 23, 42, 0.16), rgba(15, 23, 42, 0.88));
}

.scan-shell__scanner-host:deep(#qr-shaded-region),
.scan-shell__scanner-host:deep(#qr-shaded-region > div) {
  border-radius: 18px;
}

.scan-shell__scanner-host:deep(video),
.scan-shell__scanner-host:deep(canvas),
.scan-shell__scanner-host:deep(.barcode-scanner-view),
.scan-shell__scanner-host:deep(.barcode-scanner-container) {
  width: 100% !important;
  height: 100% !important;
  min-height: 0;
  max-height: none;
  border-radius: 22px;
}

.scan-shell__scanner-host:deep(video) {
  object-fit: cover;
}

.scan-shell__guide-frame {
  position: absolute;
  inset: 10%;
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow:
    0 0 0 999px rgba(2, 6, 23, 0.06),
    inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  pointer-events: none;
}

.scan-shell__mask {
  position: absolute;
  inset: 14px;
  display: grid;
  place-items: center;
  border-radius: 22px;
  background: rgba(15, 23, 42, 0.58);
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
}

.scan-shell__info-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: rgba(255, 255, 255, 0.82);
  padding: 18px 16px;
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.05);
}

.scan-shell__status-text {
  color: rgb(30, 41, 59);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.6;
}

.scan-shell__hint-text {
  color: rgb(100, 116, 139);
  font-size: 13px;
  line-height: 1.6;
}

.scan-shell__tips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.scan-shell__tip {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  border-radius: 999px;
  padding: 0 12px;
  background: #e2e8f0;
  color: #0f172a;
  font-size: 12px;
  font-weight: 600;
}

@media (max-width: 767px) {
  .unified-scan-dialog:deep(.el-dialog) {
    width: 100dvw !important;
    max-width: 100vw !important;
    max-height: 100dvh;
    margin: 0 !important;
    border-radius: 0;
  }

  .unified-scan-dialog:deep(.el-dialog__body) {
    max-height: calc(100dvh - 112px);
    padding-top: 6px;
    padding-left: 10px;
    padding-right: 10px;
  }

  .scan-shell-mobile {
    display: grid;
    gap: 10px;
    min-height: 0;
    padding-bottom: 4px;
  }

  .scan-shell-mobile__topbar {
    display: grid;
    gap: 8px;
  }

  .scan-shell-mobile__intro {
    display: grid;
    gap: 4px;
  }

  .scan-shell-mobile__eyebrow {
    color: rgb(13, 148, 136);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .scan-shell-mobile__headline {
    color: rgb(15, 23, 42);
    font-size: 15px;
    font-weight: 700;
    line-height: 1.4;
  }

  .scan-shell-mobile__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .scan-shell-mobile__mode,
  .scan-shell-mobile__status {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    border-radius: 999px;
    padding: 0 12px;
    font-size: 12px;
    font-weight: 600;
  }

  .scan-shell-mobile__mode {
    background: #d1fae5;
    color: #065f46;
  }

  .scan-shell-mobile__status {
    background: #e2e8f0;
    color: #0f172a;
  }

  .scan-shell-mobile__stage-card {
    border-radius: 18px;
    overflow: hidden;
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 1));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.06),
      0 14px 28px rgba(15, 23, 42, 0.1);
  }

  .scan-shell-mobile__preview {
    position: relative;
    width: min(100%, 430px);
    margin: 0 auto;
    max-height: min(62dvh, 620px);
    aspect-ratio: 4 / 5;
    padding: 8px;
    box-sizing: border-box;
    overflow: hidden;
  }

  .scan-shell-mobile__scanner-host {
    width: 100%;
    height: 100%;
    border-radius: 16px;
    overflow: hidden;
    background: radial-gradient(circle at center, rgba(15, 23, 42, 0.16), rgba(15, 23, 42, 0.88));
  }

  .scan-shell-mobile__scanner-host:deep(#qr-shaded-region),
  .scan-shell-mobile__scanner-host:deep(#qr-shaded-region > div) {
    border-radius: 14px;
  }

  .scan-shell-mobile__scanner-host:deep(video),
  .scan-shell-mobile__scanner-host:deep(canvas),
  .scan-shell-mobile__scanner-host:deep(.barcode-scanner-view),
  .scan-shell-mobile__scanner-host:deep(.barcode-scanner-container) {
    width: 100% !important;
    height: 100% !important;
    border-radius: 16px;
    object-fit: cover;
  }

  .scan-shell-mobile__guide-frame {
    position: absolute;
    inset: 8%;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    box-shadow:
      0 0 0 999px rgba(2, 6, 23, 0.04),
      inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }

  .scan-shell-mobile__mask {
    position: absolute;
    inset: 10px;
    display: grid;
    place-items: center;
    border-radius: 16px;
    background: rgba(15, 23, 42, 0.58);
    color: #ffffff;
    font-size: 13px;
    font-weight: 500;
  }

  .scan-shell-mobile__info-card {
    display: grid;
    gap: 8px;
    border-radius: 16px;
    padding: 12px 10px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.05);
  }

  .scan-shell-mobile__status-text {
    color: rgb(30, 41, 59);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.55;
  }

  .scan-shell-mobile__hint-text {
    color: rgb(100, 116, 139);
    font-size: 12px;
    line-height: 1.5;
  }

  .scan-shell-mobile__tips {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 2px;
  }

  .scan-shell-mobile__tip {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    border-radius: 999px;
    padding: 0 10px;
    background: #e2e8f0;
    color: #0f172a;
    font-size: 11px;
    font-weight: 600;
  }
}

@media (min-width: 768px) {
  .scan-shell__preview {
    aspect-ratio: 16 / 10;
    max-height: min(66vh, 720px);
  }
}
</style>
