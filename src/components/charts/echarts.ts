/**
 * 模块说明：src/components/charts/echarts.ts
 * 文件职责：集中注册前端图表层当前使用到的 ECharts 渲染器、图表类型与组件插件，供共享图表组件复用。
 * 实现逻辑：
 * - 只注册当前图表真实用到的能力：Canvas 渲染器、折线图、饼图、提示框与直角坐标系网格；
 * - 把图表注册动作收口到单独文件，保证所有图表页面共用同一注册入口；
 * - 基础图表组件只需导入该文件即可完成依赖初始化，不必在每个图表页重复注册。
 * 维护说明：
 * - 这里是“用到什么才注册什么”，不是“先全注册以备不时之需”：ECharts 的每个组件都会实打实地
 *   进入 charting 分包，注册了却不用等于白付体积（曾经注册的 LegendComponent 与 GraphicComponent
 *   全仓库无人使用，占了约 30 KB）；
 * - 因此新写图表时若用到 legend、graphic、dataZoom、markLine、visualMap 等 option 键，
 *   必须先在本文件补上对应组件的注册，否则该配置会静默失效并在控制台留下告警。
 */

import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { PieChart, LineChart } from 'echarts/charts'
import { TooltipComponent, GridComponent } from 'echarts/components'

use([
  CanvasRenderer,
  PieChart,
  LineChart,
  TooltipComponent,
  GridComponent,
])
