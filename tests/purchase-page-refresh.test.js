import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('../src/main/purchase-order-capture.js', import.meta.url), 'utf8')
const overlayStart = mainSource.indexOf('const PRODUCT_INFO_OVERLAY = `')
const overlayEnd = mainSource.indexOf('// ============ 商品链接提取按钮', overlayStart)
const overlaySource = mainSource.slice(overlayStart, overlayEnd)

describe('采购淘宝商品页手动刷新浮窗', () => {
  it('只在淘宝或天猫商品详情页提供手动刷新，不在结算页自动触发', () => {
    expect(overlaySource).toContain("id = '__dxe_purchase_refresh_row__'")
    expect(overlaySource).toContain('var isTaobaoProductPage = !isCheckout')
    expect(overlaySource).toContain('item\\.taobao\\.com\\/item\\.htm')
    expect(overlaySource).toContain('detail\\.tmall\\.(com|hk)\\/item\\.htm')
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
})
