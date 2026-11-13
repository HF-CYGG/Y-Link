/** 使用生产共享导出入口及既有Code128预设，不替代图片渲染或PDF超链接插件。 */
import JsBarcode from 'virtual:ylink-code128'
import {exportVoucherPdf} from '../src/utils/pdf/export-voucher-pdf'
JsBarcode('#media-barcode','YLINK-PDF-20261113',{format:'CODE128',width:2,height:90,margin:14,displayValue:true})
document.querySelector('#export-media')!.addEventListener('click',async()=>{
 try{
  const image=document.querySelector<HTMLImageElement>('#media-document img')!
  await image.decode()
  await exportVoucherPdf({sourceElement:document.querySelector<HTMLElement>('#media-document')!,filename:'pdf-media-contract.pdf',orientation:'portrait',marginMm:8,scale:2})
  document.body.dataset.mediaExport='passed'
 }catch{document.body.dataset.mediaExport='failed'}
})
