/**
 * 模块说明：条码局部竞态浏览器宿主。
 * 文件职责：只以组件公开props和可见控件控制关闭/卸载/新批次，数据和前检均走生产HTTP。
 * 维护说明：整页库存入口另有验收，此宿主不记为产品页全流程；禁止赋labels/打印快照伪造成功。
 */
import { createApp, h, ref } from 'vue'
import ElementPlus, { ElButton } from 'element-plus'
import 'element-plus/dist/index.css'
import '../src/style.css'
import BarcodeLabelPrintDialog from '../src/views/inventory/components/BarcodeLabelPrintDialog.vue'
const manifest=await fetch('/__issues_verify/manifest').then((response)=>response.json()) as {skuIds:string[]}
const visible=ref(true), mounted=ref(true), skuIds=ref(manifest.skuIds)
createApp({setup:()=>()=>h('main',[
  h('nav',{'aria-label':'局部竞态宿主'},[
    h(ElButton,{onClick:()=>{visible.value=false}},()=> '关闭组件'),
    h(ElButton,{onClick:()=>{mounted.value=false}},()=> '卸载组件'),
    h(ElButton,{onClick:()=>{skuIds.value=[manifest.skuIds[1]!] }},()=> '新批次'),
  ]),
  mounted.value?h(BarcodeLabelPrintDialog,{modelValue:visible.value,skuIds:skuIds.value,'onUpdate:modelValue':(value:boolean)=>{visible.value=value}}):null,
])}).use(ElementPlus).mount('#app')
