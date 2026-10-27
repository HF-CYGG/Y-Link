/** 同版本官方Code128预设的惰性模块，保持原JsBarcode默认工厂调用合同。 */
declare module 'virtual:ylink-code128' {
  import type JsBarcode from 'jsbarcode'
  const factory: typeof JsBarcode
  export default factory
}
