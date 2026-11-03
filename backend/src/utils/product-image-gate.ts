/** 商品图上传与后台缩略图共用资源闸门；只在最外层申请，禁止任务内部嵌套申请。 */
import { PRODUCT_IMAGE_GATE_POLICY } from '../config/load-protection-policy.js'
import { BoundedConcurrencyGate } from './bounded-concurrency.js'
export const productImageProcessingGate = new BoundedConcurrencyGate({
  name: 'product-image-processing', ...PRODUCT_IMAGE_GATE_POLICY,
  busyMessage: '商品图片处理繁忙，请稍后重试',
})
