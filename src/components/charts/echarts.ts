/**
 * 模块说明：src/components/charts/echarts.ts
 * 文件职责：承载对应业务模块能力，本次仅补充中文注释，不改动原有逻辑。
 * 维护说明：阅读时优先关注导出接口、关键分支与边界处理，便于联调和交接。
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
