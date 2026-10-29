/** 仅由扫码composable动态加载：复用原库低层两值，避免聚合入口执行未使用的高层UI模块。 */
export { Html5Qrcode } from 'html5-qrcode/esm/html5-qrcode'
export { Html5QrcodeSupportedFormats } from 'html5-qrcode/esm/core'
