import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/views/client/ClientMallView.vue', 'utf8')

const assertIncludes = (needle, message) => {
  assert.ok(source.includes(needle), message)
}

assertIncludes(':size="isPhone ? \'auto\' : \'400px\'"', 'PC product detail drawer should keep the established 400px width')
assertIncludes('client-detail-header', 'detail layout should keep the compact header structure')
assertIncludes('client-detail-side-actions', 'detail layout should keep the image preview action in the compact side column')
assertIncludes('client-detail-action-bar', 'detail layout should keep the single quantity and cart action area')
assertIncludes('client-detail-sku-groups', 'detail layout should group SKU values by specification dimension')
assertIncludes('client-detail-sku-options', 'detail layout should wrap compact specification options instead of stacking full SKU cards')
assertIncludes('client-detail-sku-option', 'detail layout should keep a dedicated compact option style')
assertIncludes('detailSkuSpecGroups', 'detail layout should render the dynamic SKU group model')
assertIncludes('@media (max-width: 640px)', 'detail layout should retain mobile height safeguards')
assertIncludes('grid-template-columns: 3.9rem minmax(0, 1fr) auto;', 'client product card should keep the established three-column compact width')
assertIncludes('box-sizing: border-box;', 'client product card should measure the card size with border and padding included')
assertIncludes('min-height: 6.8rem;', 'client product card should match the approved 108.74px compact height')
assertIncludes('column-gap: 0.68rem;', 'client product card should keep the established inner column gap')
assertIncludes('padding: 0.64rem 0.7rem;', 'client product card should keep the established compact padding')
assertIncludes('height: 3.9rem;', 'client product card image should keep the established square size')
assertIncludes('width: 3.9rem;', 'client product card image should keep the established square size')
assertIncludes('align-self: stretch;', 'client product card content should use the full vertical space instead of clustering in the center')
assertIncludes('height: 100%;', 'client product card body should allow content to spread vertically')
const cardStyles = source.slice(source.indexOf('.client-product-card {'), source.indexOf('.client-detail-image-button {'))
const cardRule = (selector) => {
  const start = cardStyles.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `Missing card layout rule: ${selector}`)
  return cardStyles.slice(start, cardStyles.indexOf('}', start))
}
assert.match(cardRule('.client-product-card__body'), /grid-column:\s*2\s*;/, 'detail body should use the lower content column')
assert.match(cardRule('.client-product-card__name.el-button'), /grid-column:\s*2\s*\/\s*4/, 'product name should span the full content width')
assert.match(cardRule('.client-product-card__name.el-button'), /text-overflow:\s*ellipsis/, 'long product names should truncate inside the card')
assert.equal((source.match(/class="client-product-card__name" @click="openProductDetail\(/g) || []).length, 4, 'all four card titles should open product detail')
assert.equal((source.match(/class="client-product-card__body" @click="openProductDetail\(/g) || []).length, 4, 'all four card bodies should retain the detail target')
assert.equal((source.match(/class="client-product-card__image-button" @click="openProductImagePreview\(/g) || []).length, 4, 'all four card templates should retain the image preview target')
assert.equal((source.match(/class="client-product-card__actions"/g) || []).length, 4, 'all four card templates should keep separate actions')
assertIncludes('justify-self: end;', 'client product card add button should stay close to the right edge')
assertIncludes('grid-template-columns: minmax(0, max-content) minmax(0, max-content);', 'client product card badges should retain two shrinkable status columns')
assertIncludes('grid-column: 1 / -1;', 'client product card available badge should occupy the first status row')
assertIncludes('max-width: 5.4rem;', 'client product card badges should truncate before expanding the card')
assertIncludes('text-overflow: ellipsis;', 'client product card badges should truncate long content instead of resizing the card')

assert.ok(!source.includes(':size="isPhone ? \'auto\' : \'720px\'"'), 'PC product detail drawer must not be widened to 720px')
assert.ok(!source.includes('client-detail-desktop-grid'), '400px drawer should not use a desktop two-column grid')
assert.ok(!source.includes('client-detail-media-card'), '400px drawer should not duplicate a desktop media card')
assert.ok(!source.includes('client-detail-desktop-actions'), '400px drawer should not duplicate desktop-only actions')
assert.ok(!source.includes('grid-template-columns: minmax(13.5rem'), '400px drawer should not keep the previous wide-grid columns')
assert.ok(!source.includes('v-for="sku in resolveActiveSkus(detailProduct)"'), 'detail drawer should not render one vertical card per full SKU combination')
assert.ok(!source.includes('class="client-product-card__desc"'), 'client product cards should not render product detail descriptions')
assert.ok(!source.includes('.client-product-card__desc'), 'client product cards should not keep description-only card styles')

console.log('[verify:client-detail-layout] Client product detail and card fixed-size layout guard passed')
