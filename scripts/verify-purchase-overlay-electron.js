'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

function extractRuntimeOverlaySource(mainSource) {
  const declaration = 'const PRODUCT_INFO_OVERLAY = '
  const declarationIndex = mainSource.indexOf(declaration)
  const literalStart = mainSource.indexOf('`', declarationIndex + declaration.length)
  const literalEnd = mainSource.indexOf('\n`', literalStart + 1)
  if (declarationIndex < 0 || literalStart < 0 || literalEnd < 0) {
    throw new Error('PRODUCT_INFO_OVERLAY template not found')
  }
  const literalExpression = mainSource.slice(literalStart, literalEnd + 2).trim()
  return Function(`return ${literalExpression}`)()
}

async function runVerification() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: `dxe-purchase-overlay-verification-${process.pid}`,
      contextIsolation: false,
      sandbox: false
    }
  })

  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'taobao-same-history-electron.html'))
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'purchase-order-capture.js'), 'utf8')
    const runtimeOverlay = extractRuntimeOverlaySource(mainSource)
      .replace('var isTaobaoProductPage = !isCheckout && (', 'var isTaobaoProductPage = true || (')
    await win.webContents.executeJavaScript(`
      window.__jdProductInfo = {
        platform: 'tmall',
        goodsName: '采购浮窗验证商品',
        sku: '棕色',
        quantity: 1,
        price: 15.9,
        shippingName: '测试用户',
        shippingPhone: '13800000000',
        shippingAddress: '测试地址'
      };
      ${runtimeOverlay}
    `)
    const result = await win.webContents.executeJavaScript(`({
      overlayPresent: !!document.getElementById('jd-product-overlay'),
      overlayText: document.getElementById('jd-product-overlay')?.textContent || '',
      refreshPresent: !!document.getElementById('__dxe_purchase_refresh_row__'),
      refreshText: document.getElementById('__dxe_purchase_refresh_row__')?.textContent || ''
    })`)
    if (!result.overlayPresent || !result.overlayText.includes('采购浮窗验证商品')) {
      throw new Error('original product information overlay was not rendered')
    }
    if (!result.refreshPresent || !result.refreshText.includes('刷新页面')) {
      throw new Error('manual refresh control was not rendered')
    }
    process.stdout.write(`ELECTRON_PURCHASE_OVERLAY_VERIFY_OK ${JSON.stringify(result)}\n`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

app.whenReady()
  .then(runVerification)
  .then(() => app.quit())
  .catch(error => {
    process.stderr.write(`ELECTRON_PURCHASE_OVERLAY_VERIFY_FAILED ${error.stack || error.message}\n`)
    app.exit(1)
  })
