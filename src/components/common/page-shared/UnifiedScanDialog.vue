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
  bindVideoElement?: (element: HTMLVideoElement | null) => void
}

const props = withDefaults(defineProps<Props>(), {
  title: '扫码识别',
  loading: false,
  statusText: '正在准备扫码能力，请稍候...',
  hintText: '请将二维码或条码对准取景框中央，识别成功后会自动回填。',
  modeLabel: '智能识别',
  width: '520px',
  bindVideoElement: undefined,
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'closed'): void
}>()

const localVideoRef = ref<HTMLVideoElement | null>(null)

// 统一为外部 composable 回填 video DOM 引用，保持扫码逻辑与弹窗视觉解耦。
watch(
  localVideoRef,
  (element) => {
    props.bindVideoElement?.(element)
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
      <div class="scan-shell__header">
        <span class="scan-shell__mode">{{ props.modeLabel }}</span>
        <span class="scan-shell__status">{{ props.loading ? '启动中' : '识别中' }}</span>
      </div>

      <div class="scan-shell__preview">
        <video ref="localVideoRef" class="scan-shell__video" autoplay muted playsinline />
        <div class="scan-shell__frame"></div>
        <div class="scan-shell__scan-line"></div>
        <div v-if="props.loading" class="scan-shell__mask">正在启动摄像头...</div>
      </div>

      <div class="scan-shell__footer">
        <p class="scan-shell__status-text">{{ props.statusText }}</p>
        <p class="scan-shell__hint-text">{{ props.hintText }}</p>
      </div>
    </div>

    <template #footer>
      <el-button @click="closeDialog">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.scan-shell {
  border-radius: 20px;
  background:
    radial-gradient(circle at top right, rgba(45, 212, 191, 0.12), transparent 36%),
    linear-gradient(180deg, rgba(15, 23, 42, 0.02), rgba(15, 23, 42, 0.06));
  padding: 12px;
}

.scan-shell__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 12px;
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
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.88), rgba(2, 6, 23, 0.96));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}

.scan-shell__video {
  display: block;
  width: 100%;
  min-height: 280px;
  object-fit: cover;
}

.scan-shell__frame {
  position: absolute;
  inset: 16% 14%;
  border: 2px solid rgba(255, 255, 255, 0.94);
  border-radius: 20px;
  box-shadow: 0 0 0 999px rgba(2, 6, 23, 0.34);
  pointer-events: none;
}

.scan-shell__scan-line {
  position: absolute;
  left: 18%;
  right: 18%;
  top: 22%;
  height: 2px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(45, 212, 191, 0), rgba(45, 212, 191, 1), rgba(45, 212, 191, 0));
  box-shadow: 0 0 12px rgba(45, 212, 191, 0.65);
  animation: scan-line-move 2s ease-in-out infinite;
  pointer-events: none;
}

.scan-shell__mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.58);
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
}

.scan-shell__footer {
  margin-top: 12px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.7);
  padding: 12px 14px;
}

.scan-shell__status-text {
  color: rgb(30, 41, 59);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
}

.scan-shell__hint-text {
  margin-top: 4px;
  color: rgb(100, 116, 139);
  font-size: 12px;
  line-height: 1.6;
}

@keyframes scan-line-move {
  0% {
    transform: translateY(0);
    opacity: 0.75;
  }
  50% {
    transform: translateY(180px);
    opacity: 1;
  }
  100% {
    transform: translateY(0);
    opacity: 0.75;
  }
}

@media (max-width: 767px) {
  .scan-shell {
    padding: 10px;
  }

  .scan-shell__video {
    min-height: 240px;
  }

  .scan-shell__frame {
    inset: 15% 12%;
  }
}
</style>
