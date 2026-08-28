'use strict'

const http = require('http')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, BrowserWindow } = require('electron')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const smokeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-store-backend-tabs-'))
app.setPath('userData', smokeUserDataDir)
app.disableHardwareAcceleration()
process.once('exit', () => {
  try {
    fs.rmSync(smokeUserDataDir, { recursive: true, force: true })
  } catch {}
})
let smokeServer = null

// Keep the test process alive long enough to assert resource cleanup after the
// last BrowserWindow closes. run() calls app.quit() after all assertions pass.
app.on('window-all-closed', () => {})

function waitFor(readValue, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      try {
        const value = readValue()
        if (value) {
          clearInterval(timer)
          resolve(value)
        } else if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer)
          reject(new Error(`等待超时 ${timeoutMs}ms`))
        }
      } catch (error) {
        clearInterval(timer)
        reject(error)
      }
    }, 50)
  })
}

function createServer() {
  return http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/child') {
      response.end('<!doctype html><html><head><title>物流详情</title></head><body>child-ready</body></html>')
      return
    }
    response.end('<!doctype html><html><head><title>订单列表</title></head><body><a id="detail" href="/child" target="_blank">查看物流</a></body></html>')
  })
}

async function run() {
  const server = createServer()
  smokeServer = server
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const rootUrl = `http://127.0.0.1:${address.port}/`
  const { openStoreBackendBrowser, closeAllStoreBackendBrowsers } = require('../src/main/store-backend-browser')

  const opened = openStoreBackendBrowser({
    storeId: 'smoke-tabs',
    url: rootUrl,
    title: '标签页冒烟验证',
    partitionName: 'persist:store-backend-tabs-smoke',
    resourceRoot: path.resolve(__dirname, '..'),
    runtimeLog: {
      writeLog(code, message) {
        console.log(`[${code}] ${message}`)
      }
    },
    show: false
  })
  const browser = opened.browser
  const rootTab = browser.activeTab()
  await waitFor(() => rootTab.view.webContents.getTitle() === '订单列表')
  const rootBridgeReady = await rootTab.view.webContents.executeJavaScript(
    "typeof window.dxeStoreBackendBridge?.requestOrderPurchaseAction === 'function'"
  )
  assert.strictEqual(rootBridgeReady, true, '普通标签页应加载店铺后台页面 preload')
  console.log('[store-backend-tabs-smoke] root-ready')

  rootTab.view.webContents.executeJavaScript("document.getElementById('detail').click()", true).catch(error => {
    console.error('[store-backend-tabs-smoke] click-script-failed', error)
  })
  await waitFor(() => browser.tabs.length === 2)
  const childTab = browser.activeTab()
  await waitFor(() => childTab.view.webContents.getTitle() === '物流详情')
  const popupBridgeReady = await childTab.view.webContents.executeJavaScript(
    "typeof window.dxeStoreBackendBridge?.requestOrderPurchaseAction === 'function'"
  )
  assert.strictEqual(popupBridgeReady, true, 'window.open 合并标签页也应加载店铺后台页面 preload')
  console.log('[store-backend-tabs-smoke] popup-merged')

  assert.strictEqual(BrowserWindow.getAllWindows().length, 1, '网页弹窗不应创建第二个 BrowserWindow')
  assert.notStrictEqual(childTab.id, rootTab.id, '弹窗应创建独立标签')
  assert.match(childTab.view.webContents.getURL(), /\/child$/, '新标签应加载物流页面')
  assert.strictEqual(childTab.view.webContents.session, rootTab.view.webContents.session, '同店铺标签应共用登录会话')

  browser.closeTab(rootTab.id)
  assert.strictEqual(browser.tabs.length, 1, '关闭来源标签后应只剩物流标签')
  assert.strictEqual(childTab.view.webContents.isDestroyed(), false, '物流标签不应随来源标签关闭')
  console.log('[store-backend-tabs-smoke] opener-closed-child-alive')

  const childContents = childTab.view.webContents
  browser.window.close()
  await waitFor(() => childContents.isDestroyed())
  assert.strictEqual(BrowserWindow.getAllWindows().length, 0, '关闭店铺后台后应释放浏览器窗口')
  console.log('[store-backend-tabs-smoke] resources-released')

  console.log(JSON.stringify({
    passed: true,
    browserWindows: 1,
    tabsAfterPopup: 2,
    sessionSharedWithinStore: true,
    rootBridgeReady,
    popupBridgeReady,
    childSurvivedOpenerClose: true,
    resourcesReleased: true
  }))

  closeAllStoreBackendBrowsers()
  await new Promise(resolve => server.close(resolve))
  smokeServer = null
}

app.whenReady().then(run).then(() => {
  app.quit()
}).catch(error => {
  console.error('[store-backend-tabs-smoke] FAILED', error)
  if (smokeServer) {
    smokeServer.close(() => {
      smokeServer = null
      app.exit(1)
    })
  } else {
    app.exit(1)
  }
})
