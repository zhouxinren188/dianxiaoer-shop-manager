import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { SALES_PRODUCT_CARD_RENDERER_SOURCE } = require('../src/main/sales-product-card-script')

const mainSource = readFileSync(new URL('../src/main/purchase-order-capture.js', import.meta.url), 'utf8')
const overlayDeclaration = 'const PRODUCT_INFO_OVERLAY = '
const overlayStart = mainSource.indexOf(overlayDeclaration)
const literalStart = mainSource.indexOf('`', overlayStart + overlayDeclaration.length)
const literalEnd = mainSource.indexOf('\n`', literalStart + 1)
const overlayLiteral = mainSource.slice(literalStart, literalEnd + 2).trim()
const overlaySource = mainSource.slice(overlayStart, literalEnd + 2)
const runtimeOverlaySource = Function(
  'SALES_PRODUCT_CARD_RENDERER_SOURCE',
  `return ${overlayLiteral}`
)(SALES_PRODUCT_CARD_RENDERER_SOURCE)

describe('采购淘宝商品页手动刷新浮窗', () => {
  it('只在淘宝或天猫商品详情页提供手动刷新，不在结算页自动触发', () => {
    expect(overlaySource).toContain("id = '__dxe_purchase_refresh_row__'")
    expect(overlaySource).toContain('var isTaobaoProductPage = !isCheckout')
    expect(runtimeOverlaySource).toContain('item\\.taobao\\.com\\/item\\.htm')
    expect(runtimeOverlaySource).toContain('detail\\.tmall\\.(com|hk)\\/item\\.htm')
    expect(runtimeOverlaySource).toContain("return '[OVERLAY] skipped: payment page'")
    expect(runtimeOverlaySource).toContain("return '[OVERLAY] Taobao skipped: not product or checkout page'")
    expect(overlaySource).toContain("refreshLabel.textContent = '\\u5237\\u65b0\\u9875\\u9762'")
    expect(overlaySource).toContain("refreshLabel.textContent = '\\u5237\\u65b0\\u4e2d...'" )
    expect(overlaySource).toContain('function placeLikeSameSourceControl()')
    expect(overlaySource).toContain("document.querySelector('#J_Toolkit .tb-toolkit-list-new')")
    expect(overlaySource).toContain('Math.round(toolkitRect.left + (toolkitRect.width - 48) / 2) - 510')
    expect(overlaySource).toContain('window.innerWidth - rowWidth - 530')
  })

  it('刷新只绑定用户点击事件，并在触发前阻止重复点击', () => {
    const clickHandler = overlaySource.slice(
      overlaySource.indexOf("refreshBtn.addEventListener('click'"),
      overlaySource.indexOf('refreshRow.appendChild(refreshBtn)')
    )
    expect(clickHandler).toContain('if (refreshBtn.disabled) return;')
    expect(clickHandler).toContain('refreshBtn.disabled = true;')
    expect(clickHandler).toContain('window.location.reload();')
    expect(overlaySource.indexOf('window.location.reload();')).toBeGreaterThan(
      overlaySource.indexOf("refreshBtn.addEventListener('click'")
    )
  })

  it('编译真正发送给淘宝页面的运行时脚本，并保证原浮层先于附加按钮构建', () => {
    expect(() => new Function(runtimeOverlaySource)).not.toThrow()
    const finalBuild = runtimeOverlaySource.slice(runtimeOverlaySource.lastIndexOf('// 原商品信息浮层'))
    expect(finalBuild.indexOf('buildOverlay();')).toBeLessThan(finalBuild.indexOf('buildManualRefreshButton();'))
    expect(finalBuild).toContain("console.warn('[PurchaseManualRefresh] initialization failed:'")
  })

  it('商品主图鼠标悬停时直接放大，移开后恢复', () => {
    expect(runtimeOverlaySource).toContain("image.addEventListener('mouseenter', showImagePreview)")
    expect(runtimeOverlaySource).toContain("image.addEventListener('mouseleave', hideImagePreview)")
    expect(runtimeOverlaySource).toContain("image.style.transform = 'scale(2.45)'")
    expect(runtimeOverlaySource).toContain("overlay.style.overflow = 'visible'")
    expect(runtimeOverlaySource).toContain("imageTransformOrigin: isPdd ? 'right center' : 'left center'")
    expect(runtimeOverlaySource).toContain("transform-origin:' + imageTransformOrigin")
  })

  it('商品信息主体由采购页和搜同款页共用，不再各维护一套', () => {
    expect(mainSource).toContain("require('./sales-product-card-script')")
    expect(runtimeOverlaySource).toContain('renderSalesProductCard({')
    expect(SALES_PRODUCT_CARD_RENDERER_SOURCE).toContain('销售规格：')
  })
})
