/**
 * test-pdd-address2.js - 完整测试 PDD 地址流程
 */
const { app, BrowserWindow, session } = require('electron')
const path = require('path')

process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0) })
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0) })

let mainWindow

app.whenReady().then(async () => {
  const partitionName = 'persist:cef-pdd-test'
  const ses = session.fromPartition(partitionName)

  const chromeVersion = process.versions.chrome || '134.0.0.0'
  const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    if (details.requestHeaders) {
      details.requestHeaders['Sec-CH-UA'] = secChUa
      details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
      details.requestHeaders['User-Agent'] = cleanUA
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: 'PDD Address Test 2',
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'src', 'main', 'purchase-preload.js')
    }
  })

  mainWindow.webContents.setUserAgent(cleanUA)

  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (message.includes('[Test]') || message.includes('[PddAddress]') || level >= 2) {
      console.log(`[Console L${level}] ${message.substring(0, 300)}`)
    }
  })

  // ===== Step 1: Load PDD home, check not blocked =====
  console.log('[Test] Step 1: Loading PDD home...')
  try { await mainWindow.loadURL('https://mobile.yangkeduo.com/') } catch(e) { console.error('[Test] loadURL failed:', e.message) }
  await new Promise(r => setTimeout(r, 5000))

  let title = await mainWindow.webContents.executeJavaScript('document.title').catch(() => '')
  let bodyText = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerText.substring(0, 200) : ""').catch(() => '')
  console.log(`[Test] Home: title="${title}", blocked=${bodyText.includes('排队')}`)
  if (bodyText.includes('排队')) { console.log('[Test] FAIL: Blocked on home page!'); app.quit(); return }

  // ===== Step 2: Navigate to address page =====
  console.log('[Test] Step 2: Navigating to address page...')
  try { await mainWindow.loadURL('https://mobile.yangkeduo.com/addresses.html') } catch(e) { console.error('[Test] navigate failed:', e.message) }
  await new Promise(r => setTimeout(r, 5000))

  let addrUrl = mainWindow.webContents.getURL()
  title = await mainWindow.webContents.executeJavaScript('document.title').catch(() => '')
  bodyText = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerText.substring(0, 200) : ""').catch(() => '')
  console.log(`[Test] Address page: title="${title}", url=${addrUrl.substring(0, 80)}`)
  console.log(`[Test] Address page blocked: ${bodyText.includes('排队')}`)

  if (bodyText.includes('排队')) { console.log('[Test] FAIL: Blocked on address page!'); app.quit(); return }

  // ===== Step 3: Inject address script =====
  console.log('[Test] Step 3: Injecting PDD address script...')
  const script = `
  (function() {
    var results = [];
    function log(msg) { results.push(msg); console.log('[PddAddress] ' + msg); }

    log('Script starting');

    // Check login
    if (document.querySelector('.login-container') && !document.querySelector('#name')) {
      log('Need login');
      return JSON.stringify(results);
    }

    // Clear cookies
    function delCookie(name, domain) {
      document.cookie = name + '=;path=/;' + (domain ? 'domain=' + domain + ';' : '') + 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
    delCookie('ua', 'mobile.yangkeduo.com');
    delCookie('transac_batch_cart', 'mobile.yangkeduo.com');
    delCookie('ua', '');
    delCookie('transac_batch_cart', '');
    log('Cookies cleared');

    // Check rawData
    var addressList = null;
    try {
      if (window.rawData && window.rawData["stores"] && window.rawData["stores"]["store"]) {
        addressList = window.rawData["stores"]["store"]["addressList"];
      } else if (window.rawData && window.rawData["store"]) {
        addressList = window.rawData["store"]["addressList"];
      }
    } catch(e) {}
    var addrCount = addressList ? addressList.length : 0;
    log('Address count: ' + addrCount);

    // Check #main
    var mainEl = document.querySelector("#main");
    log('#main found: ' + !!mainEl);

    // Try to find add button
    if (mainEl) {
      var mainDiv = mainEl.querySelector("div");
      if (mainDiv) {
        var lastChild = mainDiv.lastChild;
        if (lastChild) {
          var prev = lastChild.previousSibling;
          if (prev) {
            if (prev.childNodes.length != 1) prev = prev.previousSibling;
            if (prev) {
              var innerDiv = prev.querySelector("div");
              log('Add button inner div: ' + !!innerDiv);
              if (innerDiv) {
                innerDiv.click();
                log('Clicked add address button');
              }
            }
          }
        }
      }
    }

    // Wait for form
    return JSON.stringify(results);
  })()
  `
  try {
    const result = await mainWindow.webContents.executeJavaScript(script)
    console.log(`[Test] Script result: ${result}`)
  } catch (e) {
    console.error(`[Test] Script error: ${e.message}`)
  }

  // Wait for form to appear
  await new Promise(r => setTimeout(r, 3000))

  // ===== Step 4: Check form state =====
  console.log('[Test] Step 4: Checking form state...')
  const formCheck = await mainWindow.webContents.executeJavaScript(`
    JSON.stringify({
      name: !!document.querySelector('#name'),
      mobile: !!document.querySelector('#mobile'),
      address: !!document.querySelector('#address'),
      mAddrSelect: !!document.querySelector('.m-addr-select'),
      marsRegions: !!document.querySelector('div.mars-regions'),
      url: window.location.href.substring(0, 80),
      bodyText: document.body ? document.body.innerText.substring(0, 150) : ''
    })
  `).catch(e => `{"error":"${e.message}"}`)
  console.log(`[Test] Form state: ${formCheck}`)

  // ===== Step 5: Final blocked check =====
  const finalBody = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerText.substring(0, 300) : ""').catch(() => '')
  const isBlocked = finalBody.includes('排队') || finalBody.includes('风控')
  console.log(`[Test] Final blocked check: ${isBlocked}`)
  if (isBlocked) {
    console.log('[Test] FAIL: PDD detected automation!')
  } else {
    console.log('[Test] PASS: PDD did not block us')
  }

  console.log('[Test] All tests complete. Closing in 3s...')
  await new Promise(r => setTimeout(r, 3000))
  app.quit()
})

app.on('window-all-closed', () => { app.quit() })
