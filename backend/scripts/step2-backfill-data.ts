/**
 * 模块说明：大表回填脚本（第二步）
 * 文件职责：按游标分批回填 base_product 的历史空字段，降低全表更新风险
 * 维护说明：若新增需要回填的字段，需同步更新查询条件、回填语句与批处理节流策略
 */
import { AppDataSource } from '../src/config/data-source.js'

/**
 * 第二步：低频回填脚本 (适用大表)
 * 用法：npx tsx scripts/step2-backfill-data.ts
 * 
 * 思路：
 * - 为什么不用一条 SQL "UPDATE base_product SET ... WHERE ... IS NULL" ?
 *   因为在大表下，全表 UPDATE 会造成极大的 binlog、Undo Log 写入，并持有大量的行锁，容易引发主从延迟或死锁。
 * - 因此，采用基于主键 (ID) 范围的“游标分页”分批回填。
 */
async function runBackfill() {
  await AppDataSource.initialize()
  const BATCH_SIZE = 500

  try {
    let lastId = 0
    let totalUpdated = 0

    while (true) {
      // 1. 查找下一批需要订正的 ID (游标扫描，极快)
      const rows = await AppDataSource.query(
        `SELECT id FROM base_product 
         WHERE id > ? 
           AND (o2o_status IS NULL 
             OR current_stock IS NULL 
             OR pre_ordered_stock IS NULL 
             OR limit_per_user IS NULL)
         ORDER BY id ASC LIMIT ?`,
        [lastId, BATCH_SIZE],
      )

      if (!rows || rows.length === 0) {
        console.log(`回填完成！共计订正：${totalUpdated} 条商品记录。`)
        break
      }

      const ids = rows.map((r: any) => r.id)
      
      // 2. 可以在这里加入特殊的业务逻辑：
      // 比如，如果是某类历史重点商品，你可以直接让它的 o2o_status='listed'
      // 甚至可以从另外的旧库存表 / ERP 系统接口拉取历史真实库存，而不是全都写死 0。
      
      // 本例使用默认的安全占位回填：
      await AppDataSource.query(
        `UPDATE base_product
         SET 
           o2o_status = COALESCE(o2o_status, 'unlisted'),
           limit_per_user = COALESCE(limit_per_user, 5),
           current_stock = COALESCE(current_stock, 0),
           pre_ordered_stock = COALESCE(pre_ordered_stock, 0)
         WHERE id IN (?)`,
        [ids],
      )

      lastId = ids[ids.length - 1]
      totalUpdated += ids.length
      console.log(`已成功订正至 ID = ${lastId}，累计订正 ${totalUpdated} 条...`)

      // 3. 故意等待 50ms，让出数据库 IO 和 CPU 资源，防止打挂线上请求
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch (error) {
    console.error('回填中断，错误原因：', error)
  } finally {
    await AppDataSource.destroy()
  }
}

await runBackfill()
