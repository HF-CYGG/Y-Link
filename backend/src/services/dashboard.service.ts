import { AppDataSource } from '../config/data-source.js'
import { BizOutboundOrder } from '../entities/biz-outbound-order.entity.js'
import { BaseProduct } from '../entities/base-product.entity.js'

export const dashboardService = {
  async getStats() {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    // 今日单数
    const todayOrderCount = await AppDataSource.getRepository(BizOutboundOrder)
      .createQueryBuilder('order')
      .where('order.createdAt >= :today', { today })
      .getCount()

    // 今日总金额
    const { totalAmount } = await AppDataSource.getRepository(BizOutboundOrder)
      .createQueryBuilder('order')
      .select('SUM(order.totalAmount)', 'totalAmount')
      .where('order.createdAt >= :today', { today })
      .getRawOne()

    // 产品总数
    const totalProductCount = await AppDataSource.getRepository(BaseProduct)
      .createQueryBuilder('product')
      .where('product.isActive = :isActive', { isActive: true })
      .getCount()

    return {
      todayOrderCount,
      todayOrderAmount: totalAmount || 0,
      totalProductCount,
    }
  }
}
