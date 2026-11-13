/** 生产静态fixture上的真实PDF下载/分页/横竖/快照/失败恢复与jsPDF SVG路径；不访问组件内部状态。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {startProductionStaticServer} from './production-static-server.mjs'
const root=process.cwd(),modules=process.env.YLINK_BROWSER_NODE_MODULES,evidence=process.env.Y_LINK_VERIFY_EVIDENCE_DIR
assert.ok(modules&&evidence,'必须显式提供既有工具库及独占证据目录，不自动安装依赖')
fs.mkdirSync(evidence,{recursive:true});const require=createRequire(import.meta.url)
const {chromium}=require(require.resolve('playwright',{paths:[modules]}));const {PDFDocument,PDFName}=require(require.resolve('pdf-lib',{paths:[modules]}));const sharp=require(require.resolve('sharp',{paths:[path.join(root,'backend')]}))
const server=await startProductionStaticServer({dist:path.join(root,'output/voucher-production')});const results=[]
const record=()=>fs.writeFileSync(path.join(evidence,'pdf-results.json'),JSON.stringify({mode:'production-static',results},null,2))
let browser,page;const errors=[]
const scene=process.env.Y_LINK_PDF_SCENES
let expectedCanvasFailure=false
async function inspectPdf(file,label,orientation,multiple){
 const bytes=fs.readFileSync(file),document=await PDFDocument.load(bytes);assert.ok(document.getPageCount()>=(multiple?2:1))
 const dimensions=document.getPages().map(sheet=>({width:sheet.getWidth(),height:sheet.getHeight()}))
 for(const sheet of dimensions){
  const expected=orientation==='landscape'?[841.89,595.28]:[595.28,841.89]
  assert.ok(Math.abs(sheet.width-expected[0])<1&&Math.abs(sheet.height-expected[1])<1,'实际PDF每页必须为所选方向的A4尺寸')
 }
 const prefix=path.join(evidence,label);const render=spawnSync(process.env.PDFTOPPM_PATH??'pdftoppm',['-scale-to','1200','-png',file,prefix],{encoding:'utf8',windowsHide:true});assert.equal(render.status,0,'PDF独立渲染失败')
 const images=fs.readdirSync(evidence).filter(name=>new RegExp('^'+label+'-[0-9]+\\.png$').test(name));assert.equal(images.length,document.getPageCount());for(const image of images){const stats=await sharp(path.join(evidence,image)).stats();assert.ok(stats.channels.slice(0,3).some(channel=>channel.stdev>5),'PDF页面不可为空白')}
 return {pages:document.getPageCount(),dimensions,images}
}
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})})
 page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message))
 page.on('console',message=>{if(message.type()==='error'&&!(expectedCanvasFailure&&message.text().includes('fixture-canvas-failure')))errors.push(message.text())})
 if(!['svg','contracts','media'].includes(scene)){
 for(const orientation of ['portrait','landscape'])for(const long of [false,true]){
  const label=`client-${orientation}-${long?'multi':'single'}`;const row={label,status:'running'};results.push(row);record()
  await page.goto(server.origin+`/scripts/client-voucher-visual-fixture.html?orientation=${orientation}&long=${long?1:0}`)
  const exportButton=page.getByRole('button',{name:'导出PDF',exact:true});await exportButton.waitFor();await page.waitForFunction(()=>window.__clientVoucherReady===true);assert.equal(await exportButton.isEnabled(),true)
  if(!long&&orientation==='portrait'){
   await page.evaluate(()=>{const original=HTMLCanvasElement.prototype.toDataURL;let fail=true;HTMLCanvasElement.prototype.toDataURL=function(...args){if(fail){fail=false;throw Error('fixture-canvas-failure')}return original.apply(this,args)}})
   expectedCanvasFailure=true
   try{await exportButton.click();await page.waitForFunction(()=>Boolean(window.__clientVoucherError));await page.waitForFunction(()=>!document.querySelector('.client-order-detail-dialog--voucher .el-dialog__footer button:last-child')?.disabled);assert.equal(await page.locator('style[data-voucher-pdf-font-metrics]').count(),0)}finally{expectedCanvasFailure=false}
   row.failureRecovery='真实canvas故障后按钮恢复且可再次导出'
  }
  const downloading=page.waitForEvent('download');await exportButton.click();const downloaded=await downloading;const file=path.join(evidence,label+'.pdf');await downloaded.saveAs(file)
  const lock=JSON.parse(await page.locator('#client-voucher-export-lock-state').last().textContent());assert.ok(lock.closeDisabled&&lock.headerCloseHidden&&lock.snapshotStable);row.snapshot=lock;row.pdf=await inspectPdf(file,label,orientation,long)
  assert.equal(row.pdf.pages,await page.evaluate(()=>window.__clientVoucherPages),'实际PDF页数必须与真实凭证分页结果一致')
  row.layout=await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,voucherWidth:document.querySelector('.client-order-detail-dialog--voucher .voucher-print-document')?.getBoundingClientRect().width}))
  assert.ok(row.layout.documentWidth<=row.layout.viewport+1,'测试页面不可被导出数据或预览撑出异常宽度')
  assert.ok(row.layout.voucherWidth>600&&row.layout.voucherWidth<1200,'真实凭证预览宽度必须处于所选A4范围')
  row.status='passed';await page.screenshot({path:path.join(evidence,label+'-preview.png')});record()
 }
 await page.goto(server.origin+'/scripts/voucher-visual-fixture.html?orientation=landscape&long=1&merged=1&export=1');await page.waitForSelector('#voucher-export-data',{state:'attached'});const encoded=await page.locator('#voucher-export-data').textContent();const adminFile=path.join(evidence,'admin-multipage.pdf');fs.writeFileSync(adminFile,Buffer.from(encoded.split(',')[1],'base64'));results.push({label:'admin-multipage',status:'passed',pdf:await inspectPdf(adminFile,'admin-multipage','landscape',true)});record()
 }
 if(scene!=='media'){
 await page.goto(server.origin+'/scripts/pdf-svg-visual-fixture.html');const svgDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出 SVG PDF'}).click();const svg=await svgDownload;const file=path.join(evidence,'svg-contract.pdf');await svg.saveAs(file);assert.equal(await page.locator('body').getAttribute('data-svg-export'),'passed')
 const svgPdf=await inspectPdf(file,'svg-contract','landscape',false)
 const rendered=await sharp(path.join(evidence,svgPdf.images[0])).removeAlpha().raw().toBuffer({resolveWithObject:true})
 const features={purplePath:0,orangeFilter:0,bottomText:0,gradient:0}
 // A4横版1200px栅格中，40px PDF坐标原点与600×360px SVG按0.75pt/px映射。
 const factor=1200/841.89*0.75,origin=40*factor
 for(let y=0;y<rendered.info.height;y++)for(let x=0;x<rendered.info.width;x++){
  const i=(y*rendered.info.width+x)*rendered.info.channels,[r,g,b]=rendered.data.subarray(i,i+3),sx=(x-origin)/factor,sy=(y-origin)/factor
  if(sx>300&&sx<560&&sy>40&&sy<300&&b>r*1.5&&b>g*1.4)features.purplePath++
  if(sx>380&&sx<480&&sy>110&&sy<230&&r>200&&g>100&&g<220&&b<100)features.orangeFilter++
  if(sx>30&&sx<590&&sy>300&&sy<345&&r<150&&g<150&&b<150)features.bottomText++
  if(sx>80&&sx<250&&sy>70&&sy<250&&g>100&&g>r&&b>70)features.gradient++
 }
 for(const [name,count] of Object.entries(features))assert.ok(count>100,'SVG声明元素必须在实际PDF中完整出现：'+name)
 results.push({label:'svg-path-text-gradient-clip-filter',status:'passed',pdf:svgPdf,features});record()
 }
 if(scene!=='svg'){
  await page.goto(server.origin+'/scripts/pdf-media-visual-fixture.html')
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出媒体PDF',exact:true}).click();const media=await download
  const mediaFile=path.join(evidence,'media-contract.pdf');await media.saveAs(mediaFile)
  assert.equal(await page.locator('body').getAttribute('data-media-export'),'passed')
  const pdf=await inspectPdf(mediaFile,'media-contract','portrait',false);assert.equal(pdf.pages,1)
  const document=await PDFDocument.load(fs.readFileSync(mediaFile)),annotations=[]
  const annots=document.getPage(0).node.Annots();assert.ok(annots,'生产超链接插件必须写入实际PDF注释')
  for(let i=0;i<annots.size();i++){
   const annotation=document.context.lookup(annots.get(i));const action=document.context.lookup(annotation.get(PDFName.of('A')))
   const uri=action?.get(PDFName.of('URI'));if(uri)annotations.push(uri.decodeText())
  }
  assert.ok(annotations.includes('https://example.com/y-link/pdf-contract'),'PDF链接注释必须保留预期安全地址')
  await page.addScriptTag({path:path.join(root,'node_modules/html5-qrcode/third_party/zxing-js.umd.js')})
  // 1200px是逐页视觉缩略图，窄条重采样会让解码失败；独立打印级栅格保持原PDF与导出质量不变。
  const barcodePrefix=path.join(evidence,'media-contract-300dpi')
  const barcodeRender=spawnSync(process.env.PDFTOPPM_PATH??'pdftoppm',['-r','300','-png','-singlefile',mediaFile,barcodePrefix],{encoding:'utf8',windowsHide:true})
  assert.equal(barcodeRender.status,0,'打印级PDF条码栅格化失败')
  const image=fs.readFileSync(barcodePrefix+'.png')
  const barcode=await page.evaluate(async uri=>{
   const image=new Image();image.src=uri;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0)
   const bitmap=new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(canvas)))
   const hints=new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.CODE_128]]])
   return new ZXing.MultiFormatReader().decode(bitmap,hints).getText()
  },'data:image/png;base64,'+image.toString('base64'))
  assert.equal(barcode,'YLINK-PDF-20261113','独立解码器必须从实际PDF栅格恢复完整条码载荷')
  results.push({label:'media-image-code128-hyperlink',status:'passed',pdf,annotations,barcode,decoderRaster:{dpi:300,mode:'完整PDF页面',image:'media-contract-300dpi.png'},image:'public/y-link-icon.png；实际PDF图像由逐页视觉核验确认'});record()
 }
 assert.equal(errors.length,0,'真实页面不能有未处理异常');record()
}finally{await browser?.close();await server.close()}
