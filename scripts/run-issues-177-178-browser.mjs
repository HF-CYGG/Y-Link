/** 真实浏览器验收入口：只在主线放行后运行，自建后端/前端/浏览器资源，输出截图与真实PDF。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runIssueBrowserCases } from './issues-177-178-browser-cases.mjs'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { code128BarcodePlugin } from './code128-barcode-module.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
// 整页复用已通过performance构建的资产，避免开发依赖重优化刷新改变会话/草稿。
const builtPagesPlugin={name:'验收已构建页面',configureServer(server){
  const dist=path.join(root,'dist');assert.ok(fs.existsSync(path.join(dist,'index.html')),'须先完成既定前端构建')
  server.middlewares.use((req,res,next)=>{
    const url=new URL(req.url,'http://127.0.0.1'),spa=url.pathname==='/'||/^\/(?:client|order-list|reports|o2o-console|inventory|dashboard|base-data|login)(?:\/|$)/.test(url.pathname)
    if(!spa&&!url.pathname.startsWith('/assets/'))return next()
    const file=spa?path.join(dist,'index.html'):path.resolve(dist,'.'+decodeURIComponent(url.pathname))
    if(!file.startsWith(dist+path.sep)||!fs.existsSync(file))return next()
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2'}[path.extname(file)]??'application/octet-stream'
    res.setHeader('Content-Type',mime);fs.createReadStream(file).pipe(res)
  })
}}

assert.ok(process.env.YLINK_ISSUES_VERIFY_ROOT && /^[\x20-\x7e]+$/.test(path.resolve(process.env.YLINK_ISSUES_VERIFY_ROOT)),'须提供独占英文临时目录')
const modules=process.env.YLINK_BROWSER_NODE_MODULES
assert.ok(modules,'须显式提供已安装的工具运行库目录，不自动安装依赖')
const require=createRequire(import.meta.url)
const {chromium}=require(require.resolve('playwright',{paths:[modules]}))
const {PDFDocument}=require(require.resolve('pdf-lib',{paths:[modules]}))
const pdfjs=await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs',{paths:[modules]})).href)
const ExcelJS=require(require.resolve('exceljs',{paths:[path.join(root,'backend')]}))
const evidence=path.resolve(process.env.YLINK_ISSUES_EVIDENCE_DIR??path.join(root,'output/issues-177-178-browser'))
fs.mkdirSync(evidence,{recursive:true})
const child=fork(path.join(root,'backend/scripts/issues-177-178-ui-fixture.ts'),[],{cwd:path.join(root,'backend'),execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env}})
// 分层逐场景保留结果；中途失败不把尚未执行项写成通过。
const selectedScenes=process.env.YLINK_ISSUES_BROWSER_SCENES?.split(',').filter(Boolean)??null
const results=[],artifactRecords=[]
const recordArtifact=(item)=>{artifactRecords.push(item);saveResults('running')}
const saveResults=(status)=>fs.writeFileSync(path.join(evidence,'browser-result.json'),JSON.stringify({status,results,artifactRecords,physicalScanner:'未验证；仅实际SVG像素的独立Code128解码',artifacts:'真实页面截图、Chromium打印PDF、生产导出PDF/Excel；局部宿主另标层次'},null,2))
const scenario=async(id,name,layer,run)=>{
  if(selectedScenes&&!selectedScenes.includes(id))return
  const item={id,name,layer,status:'running',...(id==='KD1'&&process.env.YLINK_ISSUES_KD1_VISUAL_ONLY==='true'?{scope:'仅补POST前稳定视觉，行为复用attempt-05'}:{})};results.push(item);saveResults('running')
  try{await run();item.status='passed';saveResults('running')}
  catch(error){item.status='failed';item.error=error instanceof Error?error.message:'未知失败';saveResults('failed');throw error}
}
child.stderr.on('data',(chunk)=>process.stderr.write(chunk))
let vite,browser
try{
  const ready=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('隔离后端未就绪')),60000);child.once('message',(message)=>{clearTimeout(timeout);resolve(message)});child.once('exit',(code)=>{clearTimeout(timeout);reject(new Error(`隔离后端退出 ${code}`))});child.once('error',reject)})
  assert.equal(ready.type,'ready')
  const backend=`http://127.0.0.1:${ready.port}`
  vite=await createServer({configFile:false,envDir:false,root,cacheDir:path.join(process.env.YLINK_ISSUES_VERIFY_ROOT,'vite-browser-cache'),plugins:[builtPagesPlugin,vue(),Components({dts:false,resolvers:[ElementPlusResolver()]}),code128BarcodePlugin()],optimizeDeps:{noDiscovery:true,include:['vue','vue-router','pinia','axios','dayjs','dayjs/plugin/advancedFormat.js','dayjs/plugin/customParseFormat.js','dayjs/plugin/dayOfYear.js','dayjs/plugin/isSameOrAfter.js','dayjs/plugin/isSameOrBefore.js','dayjs/plugin/localeData.js','dayjs/plugin/weekOfYear.js','dayjs/plugin/weekYear.js','element-plus','@element-plus/icons-vue','@vueuse/core','qrcode','browser-image-compression','html5-qrcode']},resolve:{alias:{'@':path.join(root,'src')}},server:{host:'127.0.0.1',port:0,proxy:{'/api':backend,'/health':backend,'/uploads':backend,'/__issues_verify':backend}}})
  await vite.listen();const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`
  browser=await chromium.launch({headless:true,...(process.env.YLINK_BROWSER_EXECUTABLE?{executablePath:process.env.YLINK_BROWSER_EXECUTABLE}:{})})
  await runIssueBrowserCases({browser,origin,ready,evidence,root,PDFDocument,pdfjs,ExcelJS,scenario,recordArtifact})
  saveResults('passed')
}finally{
  await browser?.close();await vite?.close()
  if(child.connected){const exit=new Promise((resolve)=>child.once('exit',resolve));child.send('stop');await Promise.race([exit,new Promise((resolve)=>setTimeout(resolve,10000))]);if(child.exitCode===null)child.kill()}
}
