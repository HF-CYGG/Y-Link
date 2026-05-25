/**
 * 模块说明：F:/Y-Link/src/components/charts/echarts.ts
 * 文件职责：图表依赖封装文件，集中管理 ECharts 按需引入与注册。
 * 实现逻辑：统一导出项目使用的图表能力，避免页面重复注册。
 * 维护说明：新增图表类型时在此处注册并核对打包体积变化。
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
