/**
 * 模块说明：移动端订单卡片加载器的兼容出口。
 * 文件职责：保留既有导入路径，直接复用开单与订单列表共用的有界加载器。
 * 维护说明：加载语义统一维护在 src/utils/timed-async-loader.ts，此处不得另起一套状态机。
 */
export { createTimedAsyncLoader, type TimedAsyncLoaderOptions } from '../../utils/timed-async-loader'
