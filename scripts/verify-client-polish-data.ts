/** 客户端文本与历史购物车快照行为回归，不访问真实账户。 */
import assert from 'node:assert/strict'
import { htmlToPlainText } from '../src/utils/plain-text'
import { readPersistedClientCartSnapshot, persistClientCartSnapshot } from '../src/utils/client-cart-storage'
assert.equal(htmlToPlainText('2 < 3 且 5 > 4'), '2 < 3 且 5 > 4')
assert.equal(htmlToPlainText('保留 <优惠> 与 &lt;规格&gt;'), '保留 <优惠> 与 <规格>')
assert.equal(htmlToPlainText('<p>第一段 &amp; 第二段</p><p>末段<br>换行</p>'), '第一段 & 第二段\n末段\n换行')
assert.equal(htmlToPlainText('完整内容<p'), '完整内容')
assert.equal(htmlToPlainText('比较 x<price'), '比较 x<price')
assert.equal(htmlToPlainText('<script>危险内容</script>正文'), '正文')
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } })
const key = 'y-link.client-cart.snapshot:fixture-user'
values.set(key, JSON.stringify([{productId:'p',skuId:'s',productName:'测试',thumbnail:'/original.jpg',defaultPrice:'12',qty:2,selected:true}]))
const old = readPersistedClientCartSnapshot('fixture-user')
assert.equal(old[0]?.thumbnailSmall, null)
const next = old.map((item) => ({...item, thumbnailSmall:'/small.webp'}))
persistClientCartSnapshot('fixture-user', next)
assert.equal(readPersistedClientCartSnapshot('fixture-user')[0]?.thumbnailSmall, '/small.webp')
assert.equal(readPersistedClientCartSnapshot('fixture-user')[0]?.thumbnail, '/original.jpg')
console.log('通过：文本尖括号/实体/段落/截断标签与购物车旧缓存、小图持久化')
