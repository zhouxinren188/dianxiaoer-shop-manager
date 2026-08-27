const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, session } = require('electron')
const { openStoreBackendBrowser } = require('../src/main/store-backend-browser')

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitFor(check, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await wait(100)
  }
  throw new Error(message)
}

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-store-popup-'))
app.setPath('userData', userDataPath)

app.whenReady().then(async () => {
  const partitionName = 'persist:platform-popup-smoke'
  const testSession = session.fromPartition(partitionName)
  const events = []
  const confirmations = []
  try {
    testSession.protocol.interceptBufferProtocol('https', (request, callback) => {
      const url = new URL(request.url)
      if (url.hostname !== 'wares-jdm.jd.com') {
        callback({statusCode: 404, data: Buffer.from('not found')})
        return
      }
      const body = url.searchParams.get('categoryId') === 'new'
        ? '<!doctype html><title>新类目商品信息</title><body id="target">target</body>'
        : `<!doctype html><title>编辑商品</title><body id="opener">
            <button id="change-category" style="width:240px;height:80px">确认修改类目</button>
            <script>
            window.addEventListener('beforeunload', event => {
              event.preventDefault();
              event.returnValue = '';
            });
            document.querySelector('#change-category').addEventListener('click', () => {
              location.href = 'https://wares-jdm.jd.com/popPublish/?categoryId=new&productId=10035634525312';
            });
          </script></body>`
      callback({mimeType: 'text/html', charset: 'utf-8', data: Buffer.from(body)})
    })

    const { browser } = openStoreBackendBrowser({
      storeId: 'popup-smoke',
      partitionName,
      url: 'https://wares-jdm.jd.com/popPublish/?categoryId=40219&productId=10035634525312',
      title: '弹窗合并测试',
      resourceRoot: path.resolve(__dirname, '..'),
      show: false,
      confirmBeforeUnload: details => {
        confirmations.push(details)
        return true
      },
      runtimeLog: {writeLog: (_type, message) => events.push(message)}
    })

    const openerContents = browser.activeContents()
    await waitFor(async () => openerContents.executeJavaScript("document.readyState === 'complete'"), '商品编辑页没有完成加载')
    browser.window.showInactive()
    await wait(100)
    openerContents.debugger.attach('1.3')
    await openerContents.debugger.sendCommand('Runtime.evaluate', {
      expression: "document.querySelector('#change-category').click()",
      userGesture: true,
      awaitPromise: true
    })
    openerContents.debugger.detach()
    browser.window.hide()

    const targetTab = await waitFor(() => browser.tabs.find(tab =>
      tab.view.webContents.getURL().includes('categoryId=new')
    ), '点击“离开”后商品发布页没有在原标签载入新类目')
    if (confirmations.length !== 1) throw new Error(`离开确认回调次数错误: ${confirmations.length}`)
    console.log(JSON.stringify({
      ok: true,
      targetUrl: targetTab.view.webContents.getURL(),
      tabCount: browser.tabs.length,
      reusedOriginalTab: targetTab.id.endsWith('-1'),
      confirmations: confirmations.length,
      events
    }))
    browser.window.close()
    testSession.protocol.uninterceptProtocol('https')
    app.exit(0)
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: error?.stack || String(error), events}))
    app.exit(1)
  }
})
