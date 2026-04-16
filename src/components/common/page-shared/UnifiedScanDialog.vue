<script setup lang="ts">
import { ref, watch } from 'vue'

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
  width: '520px',
  bindScannerContainer: undefined,
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'closed'): void
}>()

const localScannerContainerRef = ref<HTMLDivElement | null>(null)

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
    <div class="scan-shell">
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

        <aside class="scan-shell__info-card">
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

    <template #footer>
      <el-button @click="closeDialog">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.unified-scan-dialog:deep(.el-dialog) {
  width: min(92vw, 860px) !important;
  max-height: 92vh;
  border-radius: 24px;
  overflow: hidden;
}

.unified-scan-dialog:deep(.el-dialog__body) {
  padding-top: 12px;
  max-height: calc(92vh - 116px);
  overflow: auto;
}

.scan-shell {
  border-radius: 24px;
  background:
    radial-gradient(circle at top right, rgba(45, 212, 191, 0.12), transparent 36%),
    linear-gradient(180deg, rgba(15, 23, 42, 0.02), rgba(15, 23, 42, 0.06));
  padding: 16px;
  box-sizing: border-box;
}

.scan-shell__topbar {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 16px;
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
  grid-template-columns: minmax(0, 1.45fr) minmax(240px, 0.9fr);
  gap: 16px;
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
  background: rgba(13, 148, 136, 0.1);
  color: rgb(15, 118, 110);
}

.scan-shell__status {
  background: rgba(15, 23, 42, 0.08);
  color: rgb(71, 85, 105);
}

.scan-shell__preview {
  position: relative;
  overflow: hidden;
  width: min(100%, 460px);
  margin: 0 auto;
  aspect-ratio: 1 / 1;
  padding: 18px;
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
  inset: 18%;
  border-radius: 28px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow:
    0 0 0 999px rgba(2, 6, 23, 0.06),
    inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  pointer-events: none;
}

.scan-shell__mask {
  position: absolute;
  inset: 18px;
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
  background: rgba(15, 23, 42, 0.06);
  color: rgb(51, 65, 85);
  font-size: 12px;
  font-weight: 500;
}

@media (max-width: 767px) {
  .unified-scan-dialog:deep(.el-dialog) {
    width: 100vw !important;
    max-width: 100vw !important;
    max-height: 100vh;
    margin: 0 !important;
    border-radius: 0;
  }

  .unified-scan-dialog:deep(.el-dialog__body) {
    max-height: calc(100vh - 112px);
    padding-top: 8px;
  }

  .scan-shell {
    padding: 10px 10px 12px;
  }

  .scan-shell__topbar {
    flex-direction: column;
    align-items: flex-start;
    margin-bottom: 12px;
  }

  .scan-shell__meta {
    justify-content: flex-start;
  }

  .scan-shell__layout {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .scan-shell__preview {
    width: 100%;
    max-width: 100%;
    aspect-ratio: 1 / 1;
    padding: 10px;
  }

  .scan-shell__guide-frame {
    inset: 15%;
    border-radius: 20px;
  }

  .scan-shell__mask {
    inset: 10px;
  }

  .scan-shell__info-card {
    gap: 10px;
    padding: 12px 10px;
  }

  .scan-shell__headline {
    font-size: 15px;
  }

  .scan-shell__status-text {
    font-size: 13px;
  }

  .scan-shell__hint-text {
    font-size: 12px;
  }

  .scan-shell__tips {
    gap: 6px;
  }

  .scan-shell__tip {
    min-height: 28px;
    padding: 0 10px;
    font-size: 11px;
  }
}

@media (min-width: 768px) {
  .scan-shell__preview {
    aspect-ratio: 4 / 3;
  }
}
</style>
