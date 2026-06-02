/**
 * 模块说明：src/components/charts/echarts.ts
 * 文件职责：集中注册前端图表层当前使用到的 ECharts 渲染器、图表类型与组件插件，供共享图表组件复用。
 * 实现逻辑：
 * - 按需引入 Canvas 渲染器、折线图、饼图和常用提示/图例/网格组件，避免整包注册带来的体积浪费；
 * - 把图表注册动作收口到单独文件，保证所有图表页面共用同一注册入口；
 * - 基础图表组件只需导入该文件即可完成依赖初始化，不必在每个图表页重复注册。
 */

import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart, LineChart } from 'echarts/charts'
import { TooltipComponent, LegendComponent, GridComponent, GraphicComponent } from 'echarts/components'

use([
  CanvasRenderer,
  PieChart,
  LineChart,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  GraphicComponent,
])
