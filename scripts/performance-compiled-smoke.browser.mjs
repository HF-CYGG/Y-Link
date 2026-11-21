/** 在浏览器执行原/新生产chunk，真实SVG比对和ZXing图片解码，不模拟算法。 */
const evidence = { status: 'running', barcodeCases: 0, decoded: [], formats: [], physicalCameraTested: false }
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const output = document.getElementById('result')
const manifest = await (await fetch('/manifest.json')).json()
const barcodeFactory = (namespace) => {
  let result = Object.values(namespace)[0]
  if (typeof result === 'function' && typeof result.getModule !== 'function') result = result()
  result = result?.default ?? result
  assert(typeof result === 'function' && typeof result.getModule === 'function', '生产条码default模块形状错误')
  return result
}
const scannerValues = (namespace) => {
  const values = [...Object.values(namespace)]
  for (const value of [...values]) if (value && typeof value === 'object') values.push(...Object.values(value))
  const Scanner = values.find((value) => typeof value === 'function' && typeof value.prototype?.scanFile === 'function' && typeof value.prototype?.start === 'function')
  const formats = values.find((value) => value && typeof value === 'object' && value.QR_CODE === 0 && typeof value.CODE_128 === 'number')
  assert(Scanner && formats, '生产扫码模块两值形状错误')
  return { Scanner, formats }
}
const options = { format: 'CODE128', displayValue: false, margin: 0, marginLeft: 20, marginRight: 20, height: 60, width: 2 }
const svgResult = (factory, value) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), valid = []
  factory(element, value, { ...options, valid: (accepted) => valid.push(accepted) })
  return { element, comparable: JSON.stringify({ svg: element.outerHTML, valid }) }
}
const rasterize = async (svg) => {
  const image = new Image(), imageUrl = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }))
  try {
    image.src = imageUrl; await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width * 2; canvas.height = image.height * 2
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    assert(blob, '真实SVG栅格化失败')
    return new File([blob], 'code128.png', { type: 'image/png' })
  } finally { URL.revokeObjectURL(imageUrl) }
}
try {
  const oldBarcode = barcodeFactory(await import(manifest.compiled.baseline.barcode.url))
  const globalBefore = Object.getOwnPropertyDescriptor(window, 'JsBarcode')
  let globalReads = 0, globalWrites = 0
  Object.defineProperty(window, 'JsBarcode', { configurable: true, get() { globalReads += 1; return '宿主旧值' }, set() { globalWrites += 1 } })
  let currentBarcode
  try { currentBarcode = barcodeFactory(await import(manifest.compiled.current.barcode.url)) }
  finally { if (globalBefore) Object.defineProperty(window, 'JsBarcode', globalBefore); else delete window.JsBarcode }
  assert(globalReads === 0 && globalWrites === 0, '新条码chunk读写了宿主JsBarcode')
  evidence.privateScope = true
  for (const value of ['WC02001', 'YZ0100001', '00123456789', 'constructor', '__proto__', 'A'.repeat(64), '中文无效', '']) {
    assert(svgResult(oldBarcode, value).comparable === svgResult(currentBarcode, value).comparable, `新旧生产SVG/valid不同：${value}`)
    evidence.barcodeCases += 1
  }
  const visibleBarcode = svgResult(currentBarcode, 'YZ0100001').element
  document.getElementById('artifacts').append(visibleBarcode)
  const barcodeFile = await rasterize(visibleBarcode)
  const qrFile = new File([await (await fetch('/qr.png')).blob()], 'qr.png', { type: 'image/png' })
  const formatNames = ['QR_CODE', 'CODE_128', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_39', 'ITF', 'CODABAR', 'PDF_417', 'DATA_MATRIX', 'AZTEC']
  const baseline = scannerValues(await import(manifest.compiled.baseline['qr-scanner'].url))
  const current = scannerValues(await import(manifest.compiled.current['qr-scanner'].url))
  for (const name of formatNames) assert(baseline.formats[name] === current.formats[name], `格式改变：${name}`)
  evidence.formats = formatNames
  for (const [name, module] of [['baseline', baseline], ['current', current]]) {
    const host = document.createElement('div'); host.id = `compiled-scan-${name}`; host.style.width = '600px'; document.getElementById('artifacts').append(host)
    const scanner = new module.Scanner(host.id, { verbose: false, formatsToSupport: formatNames.map((format) => module.formats[format]), useBarCodeDetectorIfSupported: false })
    try {
      const qrText = await scanner.scanFile(qrFile, false)
      assert(qrText === manifest.qrText, `${name}真实ZXing QR解码失败`)
      const barcodeText = await scanner.scanFile(barcodeFile, false)
      assert(barcodeText === 'YZ0100001', `${name}真实ZXing Code128解码失败`)
      evidence.decoded.push({ name, qr: true, code128: true, barcodeDetectorDisabled: true })
    } finally { scanner.clear(); host.remove() }
  }
  evidence.status = 'passed'
} catch (error) { evidence.status = 'failed'; evidence.error = String(error.stack ?? error) }
output.textContent = JSON.stringify(evidence, null, 2)
window.__performanceCompiledSmoke = evidence
await fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evidence) })
