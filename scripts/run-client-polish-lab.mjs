/** 全入口隔离验收入口；默认交互模式，Ctrl+C保存ledger后关闭。生产源码不被替换。 */
import fs from 'node:fs'
import path from 'node:path'
import { createLabEvidenceDir, startClientPolishServer } from './client-polish-lab-server.mjs'
import { createClientPolishLab } from './client-polish-lab-fixture.mjs'
const root=process.cwd(), output=process.env.POLISH_EVIDENCE_DIR?path.resolve(process.env.POLISH_EVIDENCE_DIR):createLabEvidenceDir()
fs.mkdirSync(output,{recursive:true})
const lab=createClientPolishLab()
const browserBoundary=`window.__polishQrControl=Object.assign({fail:[],hold:[],calls:[],release:{}},JSON.parse(sessionStorage.getItem('polish.qrControl')||'{}'));sessionStorage.removeItem('polish.qrControl');window.__polishQrBoundary=async function(payload){const c=window.__polishQrControl;c.calls.push(payload);if(c.hold.includes(payload))await new Promise(done=>c.release[payload]=done);const index=c.fail.indexOf(payload);if(index>=0){c.fail.splice(index,1);throw Error('隔离QR故障')}};navigator.vibrate=function(){window.__polishVibrations=(window.__polishVibrations||0)+1;return true};`
const init={name:'polish-test-boundary',transformIndexHtml(html){return html.replace('<head>','<head><script>'+browserBoundary+'</script>')}}
const vite=await startClientPolishServer({root,output,plugins:[lab.plugin,lab.qrPlugin,init]})
const {origin}=vite
const manifest={origin,fixture:true,realBackend:false,startedAt:new Date().toISOString(),output,entry:'/client/mall',state:origin+'/__polish/state',control:origin+'/__polish/control',credentials:{accounts:['体验甲','体验乙','T001'],password:'FixturePass42',captcha:'1234',verificationCode:'123456'},matrix:path.join(root,'scripts/client-polish-coverage.json'),instructions:'在浏览器打开origin，按矩阵操作；DevTools设备模式设置viewport/theme/reduced-motion。所有数据只在本进程内存。'}
Object.assign(manifest,{pid:process.pid,readiness:vite.readiness,isolation:vite.config})
fs.writeFileSync(path.join(output,'lab-session.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify(manifest,null,2))
let closing=false
const close=async()=>{if(closing)return;closing=true;lab.close();fs.writeFileSync(path.join(output,'lab-state.json'),JSON.stringify(lab.state(),null,2));await vite.close()}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close())
if(process.argv.includes('--probe-only'))await close()
