import { MockProduct } from '../../../components/ProductCard';

export const mockProducts: MockProduct[] = [
  {
    id: 'p_101',
    title: '校园定制 纯棉印花T恤 (多色可选)',
    imageUrl: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?auto=format&fit=crop&w=400&q=80',
    price: 49.9,
    originalPrice: 89.0,
    stock: 200,
    tags: ['热销', '包邮'],
  },
  {
    id: 'p_102',
    title: '便携式迷你加湿器 宿舍静音大雾量',
    imageUrl: 'https://images.unsplash.com/photo-1595859702882-938b8eb97e28?auto=format&fit=crop&w=400&q=80',
    price: 35.0,
    stock: 50,
    tags: ['上新', '宿舍必备'],
  },
  {
    id: 'p_103',
    title: '真无线蓝牙耳机 半入耳式 高音质续航',
    imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?auto=format&fit=crop&w=400&q=80',
    price: 129.0,
    originalPrice: 199.0,
    stock: 3,
    tags: ['限量特价'],
  },
  {
    id: 'p_104',
    title: '网红零食大礼包 休闲小吃 宿舍充饥',
    imageUrl: 'https://images.unsplash.com/photo-1582293041079-7814c2f12063?auto=format&fit=crop&w=400&q=80',
    price: 68.8,
    stock: 0,
    tags: ['美味', '囤货'],
  }
];
