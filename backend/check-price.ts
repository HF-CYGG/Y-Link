import { AppDataSource } from './src/config/data-source.js';
import { BaseProduct } from './src/entities/base-product.entity.js';

(async () => {
  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository(BaseProduct);
  const products = await repo.find();
  console.log(products.map(p => ({ name: p.productName, price: p.defaultPrice })));
  process.exit(0);
})();
