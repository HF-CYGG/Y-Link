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
