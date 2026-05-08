/**
 * test-pdd-address.js - 测试 PDD 自动改地址脚本（Electron-only 模式）
 * 验证：buildPddAddressScript 注入是否正常、不报错、不触发排队
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
    title: 'PDD Address Test',
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
    if (message.includes('[Test]') || message.includes('[PddAddress]') || message.includes('Error') || level >= 2) {
      console.log(`[Console L${level}] ${message.substring(0, 300)}`)
    }
  })

  mainWindow.webContents.on('did-finish-load', async () => {
    const url = mainWindow.webContents.getURL()
    const title = await mainWindow.webContents.executeJavaScript('document.title').catch(() => '')
    console.log(`[Test] Page loaded: title="${title}", url=${url.substring(0, 120)}`)

    // 检查是否被风控
    try {
      const bodyText = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerText.substring(0, 300) : ""')
      const isBlocked = bodyText.includes('排队') || bodyText.includes('验证') || bodyText.includes('风控')
      console.log(`[Test] Blocked: ${isBlocked}`)
    } catch (e) {}
  })

  // Step 1: Load PDD home
  const pddUrl = 'https://mobile.yangkeduo.com/'
  console.log(`[Test] Step 1: Loading PDD home: ${pddUrl}`)
  try {
    await mainWindow.loadURL(pddUrl)
  } catch (e) {
    console.error(`[Test] loadURL failed: ${e.message}`)
  }

  // Wait for home page to load
  await new Promise(r => setTimeout(r, 5000))

  // Step 2: Navigate to address page and inject script
  console.log(`[Test] Step 2: Navigating to address page...`)
  try {
    await mainWindow.loadURL('https://mobile.yangkeduo.com/addresses.html')
  } catch (e) {
    console.error(`[Test] navigate to addresses failed: ${e.message}`)
  }

  // Wait for address page
  await new Promise(r => setTimeout(r, 5000))

  const addrUrl = mainWindow.webContents.getURL()
  console.log(`[Test] Address page URL: ${addrUrl.substring(0, 120)}`)

  // Step 3: Inject the address script
  console.log(`[Test] Step 3: Injecting buildPddAddressScript...`)

  const addressScript = `
  (function() {
    if (window.__pddAddrDone) return;
    window.__pddAddrDone = true;
    console.log('[PddAddress] Pinduoduo addresses page loaded');

    var targetName = "测试收货人";
    var targetPhone = "13800138000";
    var targetProvince = "江苏省";
    var targetCity = "南京市";
    var targetArea = "玄武区";
    var targetOther = "长江路100号";

    if (!targetName && !targetPhone && !targetOther) {
      console.log('[PddAddress] No receiver info provided, skipping');
      return;
    }

    function delCookie(name, domain) {
      document.cookie = name + '=;path=/;' + (domain ? 'domain=' + domain + ';' : '') + 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
    delCookie('ua', 'mobile.yangkeduo.com');
    delCookie('transac_batch_cart', 'mobile.yangkeduo.com');
    delCookie('ua', '');
    delCookie('transac_batch_cart', '');
    console.log('[PddAddress] Cookies cleared');

    if (document.querySelector('.login-container') && !document.querySelector('#name')) {
      console.log('[PddAddress] Need login');
      return;
    }

    var addressList = null;
    try {
      if (window.rawData && window.rawData["stores"] && window.rawData["stores"]["store"]) {
        addressList = window.rawData["stores"]["store"]["addressList"];
      } else if (window.rawData && window.rawData["store"]) {
        addressList = window.rawData["store"]["addressList"];
      }
    } catch(e) {}

    var addrCount = addressList ? addressList.length : 0;
    console.log('[PddAddress] Current address count: ' + addrCount);

    if (addrCount >= 20) {
      console.log('[PddAddress] Addresses >= 20, would need to delete first');
    } else {
      console.log('[PddAddress] Address count OK, proceeding to add');
    }

    // Try to click add button
    var clickDiv = document.querySelector("#main");
    if (clickDiv) {
      clickDiv = clickDiv.querySelector("div");
      if (clickDiv) {
        var lastChild = clickDiv.lastChild;
        if (lastChild) {
          var prev = lastChild.previousSibling;
          if (prev) {
            if (prev.childNodes.length != 1) prev = prev.previousSibling;
            if (prev) {
              var innerDiv = prev.querySelector("div");
              if (innerDiv) {
                innerDiv.click();
                console.log('[PddAddress] Clicked add address button');
              } else {
                console.log('[PddAddress] No inner div in add button');
              }
            }
          }
        }
      }
    } else {
      console.log('[PddAddress] #main not found');
    }

    // Check if form appears
    setTimeout(function() {
      var nameInput = document.querySelector("#name");
      var mobileInput = document.querySelector("#mobile");
      var addressInput = document.querySelector("#address");
      console.log('[PddAddress] Form check: name=' + !!nameInput + ', mobile=' + !!mobileInput + ', address=' + !!addressInput);

      if (nameInput && mobileInput && addressInput) {
        var evInput = document.createEvent("HTMLEvents");
        evInput.initEvent("input", true, true);

        addressInput.innerHTML = targetOther;
        addressInput.dispatchEvent(evInput);
        nameInput.setAttribute('value', targetName);
        nameInput.dispatchEvent(evInput);
        mobileInput.setAttribute('value', targetPhone);
        mobileInput.dispatchEvent(evInput);
        console.log('[PddAddress] Form filled successfully (NOT saving - test only)');

        // Check region selector
        var addrSelect = document.querySelector(".m-addr-select");
        console.log('[PddAddress] Region selector found: ' + !!addrSelect);
      } else {
        console.log('[PddAddress] Form not found - may need login or page not fully loaded');
      }
    }, 2000);
  })()
  `

  try {
    const result = await mainWindow.webContents.executeJavaScript(addressScript)
    console.log(`[Test] Address script result: ${JSON.stringify(result).substring(0, 200)}`)
  } catch (e) {
    console.error(`[Test] Address script error: ${e.message}`)
  }

  // Wait and check final state
  await new Promise(r => setTimeout(r, 5000))

  const finalUrl = mainWindow.webContents.getURL()
  console.log(`[Test] Final URL: ${finalUrl.substring(0, 120)}`)
  console.log(`[Test] Test complete - close window to exit`)

  mainWindow.on('closed', () => { app.quit() })
})

app.on('window-all-closed', () => { app.quit() })
