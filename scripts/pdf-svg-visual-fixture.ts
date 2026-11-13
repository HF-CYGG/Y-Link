/** jsPDF 的真实 addSvgAsImage→canvg 路径，覆盖曲线、中文、渐变、裁剪与滤镜。 */
import {jsPDF} from 'jspdf'
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><defs><linearGradient id="gradient"><stop stop-color="#00a6a6"/><stop offset="1" stop-color="#f97316"/></linearGradient><clipPath id="clip"><circle cx="170" cy="160" r="85"/></clipPath><filter id="blur"><feGaussianBlur stdDeviation="4"/></filter></defs><rect width="600" height="360" fill="white"/><rect x="55" y="55" width="240" height="220" fill="url(#gradient)" clip-path="url(#clip)"/><path d="M 310 240 C 340 40 470 40 535 230 Q 440 300 310 240 Z" fill="#4338ca"/><circle cx="430" cy="170" r="48" fill="#f59e0b" filter="url(#blur)"/><text x="40" y="325" font-family="sans-serif" font-size="25" fill="#111827">中文 SVG · 路径 / 渐变 / 裁剪 / 滤镜</text></svg>`
document.querySelector('#svg-target')!.innerHTML=svg
document.querySelector('#export-svg')!.addEventListener('click',async()=>{
 // 此API把width/height同时用作canvas像素和PDF单位。使用px并保留600×360画布，防止把SVG原坐标裁进270×162画布。
 try{const pdf=new jsPDF({orientation:'landscape',unit:'px',format:'a4',hotfixes:['px_scaling']});await pdf.addSvgAsImage(svg,40,40,600,360);pdf.save('svg-render-contract.pdf');document.body.dataset.svgExport='passed'}
 catch{document.body.dataset.svgExport='failed'}
})
