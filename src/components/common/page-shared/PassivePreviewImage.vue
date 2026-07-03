<script setup lang="ts">
/**
 * 模块说明：src/components/common/page-shared/PassivePreviewImage.vue
 * 文件职责：提供不依赖 Element Plus ImageViewer 的图片缩略图与预览弹窗，规避预览态非被动 wheel 监听。
 * 实现逻辑：
 * - 缩略图使用原生 img 渲染，通过 span role="button" 承接点击与键盘打开行为，避免在上传按钮内形成按钮嵌套；
 * - 预览态使用普通 ElDialog 展示图片，不支持滚轮缩放，从源头避免 passive:false 的 wheel 监听；
 * - previewImages 为空时仅展示缩略图，不开启预览，兼容占位图展示场景。
 * 维护说明：
 * - 商品、规格等业务图片预览优先复用本组件，不要直接使用 el-image 的预览能力；
 * - 若未来要支持多图切换，只增加按钮或键盘切换，不要引入滚轮缩放交互。
 */
import { computed, ref, watch } from 'vue'

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<{
  src: string
  alt?: string
  fit?: 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'
  previewImages?: ReadonlyArray<string>
  dialogTitle?: string
}>(), {
  alt: '图片预览',
  fit: 'cover',
  previewImages: () => [],
  dialogTitle: '图片预览',
})

const previewVisible = ref(false)
const activeIndex = ref(0)

const normalizedPreviewImages = computed(() => {
  return props.previewImages
    .map((image) => image.trim())
    .filter(Boolean)
})

const canPreview = computed(() => normalizedPreviewImages.value.length > 0)

const activePreviewImage = computed(() => {
  return normalizedPreviewImages.value[activeIndex.value] ?? props.src
})

const imageStyle = computed(() => ({
  objectFit: props.fit,
}))

watch(normalizedPreviewImages, (images) => {
  if (activeIndex.value >= images.length) {
    activeIndex.value = 0
  }
})

const openPreview = () => {
  if (!canPreview.value) {
    return
  }

  activeIndex.value = 0
  previewVisible.value = true
}

const showPreviousImage = () => {
  const count = normalizedPreviewImages.value.length
  if (count <= 1) {
    return
  }

  activeIndex.value = (activeIndex.value + count - 1) % count
}

const showNextImage = () => {
  const count = normalizedPreviewImages.value.length
  if (count <= 1) {
    return
  }

  activeIndex.value = (activeIndex.value + 1) % count
}
</script>

<template>
  <span
    v-bind="$attrs"
    class="passive-preview-image"
    :class="{ 'is-previewable': canPreview }"
    :role="canPreview ? 'button' : undefined"
    :tabindex="canPreview ? 0 : undefined"
    :aria-label="canPreview ? props.dialogTitle : undefined"
    @click.stop="openPreview"
    @keydown.enter.prevent.stop="openPreview"
    @keydown.space.prevent.stop="openPreview"
  >
    <img :src="props.src" :alt="props.alt" :style="imageStyle">
  </span>

  <el-dialog
    v-model="previewVisible"
    :title="props.dialogTitle"
    append-to-body
    destroy-on-close
    class="passive-preview-image-dialog"
    width="min(92vw, 960px)"
  >
    <div class="passive-preview-image-dialog__body">
      <button
        v-if="normalizedPreviewImages.length > 1"
        type="button"
        class="passive-preview-image-dialog__nav passive-preview-image-dialog__nav--prev"
        aria-label="上一张图片"
        @click="showPreviousImage"
      >
        ‹
      </button>
      <img :src="activePreviewImage" :alt="props.alt" class="passive-preview-image-dialog__image">
      <button
        v-if="normalizedPreviewImages.length > 1"
        type="button"
        class="passive-preview-image-dialog__nav passive-preview-image-dialog__nav--next"
        aria-label="下一张图片"
        @click="showNextImage"
      >
        ›
      </button>
    </div>
  </el-dialog>
</template>

<style scoped>
.passive-preview-image {
  display: inline-flex;
  align-items: stretch;
  justify-content: stretch;
  min-width: 0;
  overflow: hidden;
  line-height: 0;
  background: rgb(241 245 249);
}

.passive-preview-image.is-previewable {
  cursor: zoom-in;
}

.passive-preview-image img {
  display: block;
  width: 100%;
  height: 100%;
}

.passive-preview-image-dialog__body {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
  max-height: min(72vh, 720px);
  overflow: auto;
  background: rgb(15 23 42);
  border-radius: 8px;
}

.passive-preview-image-dialog__image {
  display: block;
  max-width: 100%;
  max-height: min(72vh, 720px);
  object-fit: contain;
}

.passive-preview-image-dialog__nav {
  position: absolute;
  top: 50%;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  padding: 0;
  border: 0;
  border-radius: 999px;
  color: white;
  font-size: 2rem;
  line-height: 1;
  background: rgba(15, 23, 42, 0.64);
  transform: translateY(-50%);
  cursor: pointer;
}

.passive-preview-image-dialog__nav:hover {
  background: rgba(15, 23, 42, 0.82);
}

.passive-preview-image-dialog__nav--prev {
  left: 1rem;
}

.passive-preview-image-dialog__nav--next {
  right: 1rem;
}
</style>
