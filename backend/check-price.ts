/**
 * 模块说明：后端临时排查脚本（商品价格）
 * 文件职责：读取商品表并输出商品名称与默认售价，便于快速核对数据库中的价格数据
 * 维护说明：仅用于本地排查，若后续扩展字段请保持“只读查询、不写库”的安全策略
 */
import { AppDataSource } from './src/config/data-source.js'
import { BaseProduct } from './src/entities/base-product.entity.js'

try {
  await AppDataSource.initialize()
  const repo = AppDataSource.getRepository(BaseProduct)
  const products = await repo.find()
  console.log(products.map((item) => ({ name: item.productName, price: item.defaultPrice })))
} finally {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy()
  }
  process.exit(0)
}
