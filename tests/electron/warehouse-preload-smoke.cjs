'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const preloadPath = path.resolve(__dirname, '../../resources/store-backend-page-preload.js')
const SAVE_API = 'dsm.order.bff.PartitionWarehousePriorityService.saveWarehousePriorityByRegionId'
const REQUEST_SOURCE = 'ECOMMERCE_TOOLBOX_WAREHOUSE_EXTENSION_V1'
const RESPONSE_SOURCE = 'ECOMMERCE_TOOLBOX_WAREHOUSE_PAGE_V1'

const html = `<!doctype html><meta charset="utf-8"><script>
  window.__warehouseSmoke = {
    preloadWasEarly: window.__ECOMMERCE_TOOLBOX_WAREHOUSE_BRIDGE__ === true,
    completed: false,
    response: null,
    requests: []
  };
  const saveApi = ${JSON.stringify(SAVE_API)};
  window.__DSM_SECURITY_CONFIG = {securityWhiteList: {[saveApi]: '0248a'}};
  window.ParamsSign = class {
    constructor(options) { this.options = options; }
    async sign() { return {h5st: 'signed-test-value'}; }
  };
  window.CryptoJS = {SHA256() { return {toString() { return 'BODY_HASH'; }}; }};
  window.getJsToken = callback => callback({jsToken: 'E'.repeat(128)});
  window.fetch = async (url, options) => {
    window.__warehouseSmoke.requests.push({
      url,
      method: options.method,
      headers: options.headers,
      body: JSON.parse(options.body)
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {msg: '成功', code: 200, 'dsm-trace-id': '11163100.41661.17878500000000000'};
      }
    };
  };
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.source !== ${JSON.stringify(RESPONSE_SOURCE)}) return;
    if (message.requestId === 'smoke-save') {
      window.postMessage({
        source: ${JSON.stringify(REQUEST_SOURCE)},
        requestId: 'smoke-clear',
        type: 'SAVE_PRIORITIES',
        regionId: 1,
        level: 1,
        details: []
      }, location.origin);
      return;
    }
    if (message.requestId !== 'smoke-clear') return;
    window.__warehouseSmoke.response = message;
    window.__warehouseSmoke.completed = true;
  });
  window.postMessage({
    source: ${JSON.stringify(REQUEST_SOURCE)},
    requestId: 'smoke-save',
    type: 'SAVE_PRIORITIES',
    regionId: 1,
    level: 1,
    details: [{priority: 1, seqNum: '800014550', type: 1, warehouseId: '5717074'}]
  }, location.origin);
</script>`

async function waitForResult(win, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let lastResult = null
  while (Date.now() < deadline) {
    const result = await win.webContents.executeJavaScript('window.__warehouseSmoke || null', true)
    lastResult = result
    if (result?.completed) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('仓库 preload 验证超时，最终状态=' + JSON.stringify(lastResult))
}

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'})
    response.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const diagnostics = []
  const consoleMessages = []
  let exitCode = 0
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      additionalArguments: ['--dxe-warehouse-preload-smoke'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.on('console-message', (_event, levelOrDetails, ...legacyArgs) => {
    const message = String(
      levelOrDetails && typeof levelOrDetails === 'object'
        ? levelOrDetails.message || ''
        : legacyArgs[0] || ''
    )
    consoleMessages.push(message)
    if (message.startsWith('[DXE_WAREHOUSE_DIAG]')) diagnostics.push(message)
  })

  try {
    await win.loadURL(`http://127.0.0.1:${address.port}/warehouse-smoke`)
    const result = await waitForResult(win)
    const saveRequest = result.requests?.[0]
    const clearRequest = result.requests?.[1]
    assert.equal(result.preloadWasEarly, true)
    assert.equal(result.response?.ok, true)
    assert.equal(saveRequest?.method, 'POST')
    assert.equal(saveRequest?.headers?.['dsm-eid']?.length, 128)
    assert.equal(saveRequest?.headers?.['x-rp-client'], 'h5_2.4.0')
    assert.match(saveRequest?.headers?.['dsm-trace-id'], /^\d+\.41661\.\d+$/)
    assert.equal(saveRequest?.body?.request?.source, '2000')
    assert.deepEqual(saveRequest?.body?.request?.data?.details, [
      {priority: 1, seqNum: '800014550', type: 1, warehouseId: '5717074'}
    ])
    assert.equal(clearRequest?.method, 'POST')
    assert.equal(clearRequest?.body?.request?.source, '2000')
    assert.equal(clearRequest?.body?.request?.data?.details, null)
    assert.ok(diagnostics.some(message => message.includes('"phase":"bridge_ready"')))
    assert.ok(diagnostics.some(message => message.includes('"phase":"request"')))
    assert.ok(diagnostics.some(message => message.includes('"phase":"response"')))
    console.log('WAREHOUSE_PRELOAD_SMOKE PASS early-main-world eid=128 rp=h5_2.4.0 save+clear=verified')
  } catch (error) {
    exitCode = 1
    console.error('WAREHOUSE_PRELOAD_SMOKE FAIL ' + String(error?.stack || error))
    console.error('WAREHOUSE_PRELOAD_SMOKE CONSOLE ' + JSON.stringify(consoleMessages))
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await new Promise(resolve => server.close(resolve))
    if (exitCode) app.exit(exitCode)
    else app.quit()
  }
}).catch(error => {
  console.error('WAREHOUSE_PRELOAD_SMOKE FAIL ' + String(error?.stack || error))
  app.exit(1)
})
