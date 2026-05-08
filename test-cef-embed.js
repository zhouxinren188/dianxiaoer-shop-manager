/**
 * test-cef-embed.js - 测试 CEF 内嵌：拼多多 → 个人中心 → 登录 → 结算
 *
 * 用法: npx electron test-cef-embed.js
 */
const { app, BrowserWindow } = require('electron')
const { launchEmbeddedCEF } = require('./src/main/cef-embed')
const { createTitleBarOverlay } = require('./src/main/titlebar-overlay')

// 全局 EPIPE 错误处理
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0) })
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0) })
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return
  console.error('[Uncaught]', err.message)
})

let mainWindow
let cefHandle

function log(tag, msg) {
  try { console.log(`[${tag}] ${msg}`) } catch (e) {}
}

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 900,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  })

  mainWindow.loadURL('data:text/html,<html><body style="margin:0;padding:0;background:transparent;"></body></html>')

  // ★ 关键：设置 renderer 背景色为透明（alpha=0）
  // WS_EX_TRANSPARENT + WS_EX_LAYERED 的命中测试基于 alpha 通道
  // 如果 renderer 白底（alpha=255），点击不会穿透到 CEF
  // setBackgroundColor 让 renderer 从一开始就透明，首次加载即可点击
  mainWindow.setBackgroundColor('#00000000')

  await new Promise(r => setTimeout(r, 1000))

  try {
    log('Test', 'Launching embedded CEF with PDD...')
    cefHandle = await launchEmbeddedCEF({
      url: 'https://mobile.yangkeduo.com/',
      parentWindow: mainWindow,
      partition: 'persist:cef-pdd-test',
    })
    log('Test', 'CEF launched successfully!')

    // 创建标题栏覆盖（最小化/最大化/关闭按钮）
    const titleBar = createTitleBarOverlay(mainWindow)
    if (titleBar) log('Test', 'Title bar overlay created')

    await cefHandle.resize()
    await new Promise(r => setTimeout(r, 3000))

    // ===== 第一步：确认首页加载 =====
    const url1 = await cefHandle.getUrl()
    const title1 = await cefHandle.evaluate('document.title')
    log('Test', `首页: URL=${url1}, title=${JSON.stringify(title1)}`)

    // ===== 第二步：导航到个人中心，触发登录 =====
    log('Test', '导航到个人中心...')
    await cefHandle.navigate('https://mobile.yangkeduo.com/user.html')
    await new Promise(r => setTimeout(r, 3000))

    const url2 = await cefHandle.getUrl()
    const title2 = await cefHandle.evaluate('document.title')
    log('Test', `个人中心: URL=${url2}, title=${JSON.stringify(title2)}`)

    // 检查是否跳转到登录页
    const isLoginPage = url2.includes('login') || url2.includes('signin')
    log('Test', `是否跳转到登录页: ${isLoginPage}`)

    // 获取页面信息（看看当前显示什么）
    const pageText = await cefHandle.evaluate(`
      (function() {
        var body = document.body;
        if (!body) return 'no body';
        var text = body.innerText.substring(0, 800);
        var inputs = Array.from(document.querySelectorAll('input')).map(function(el) {
          return el.type + ':' + (el.placeholder || el.name || '');
        });
        var links = Array.from(document.querySelectorAll('a')).slice(0, 10).map(function(a) {
          return a.textContent.trim().substring(0, 30);
        }).filter(function(t) { return t; });
        return JSON.stringify({ text: text, inputs: inputs, links: links });
      })()
    `)
    log('Test', `页面内容: ${pageText}`)

    // ===== 第三步：等用户手动登录，然后继续 =====
    log('Test', '请在 CEF 窗口中手动登录，登录后按回车继续测试...')
    // 等待用户在 CEF 窗口中登录（60秒超时）
    await new Promise(r => setTimeout(r, 60000))

    // 检查登录后状态
    const url3 = await cefHandle.getUrl()
    const title3 = await cefHandle.evaluate('document.title')
    log('Test', `登录后: URL=${url3}, title=${JSON.stringify(title3)}`)

    // ===== 第四步：导航到商品详情页，尝试加购物车/去结算 =====
    log('Test', '导航到商品详情页...')
    await cefHandle.navigate('https://mobile.yangkeduo.com/goods.html?goods_id=584623825824')
    await new Promise(r => setTimeout(r, 5000))

    const url4 = await cefHandle.getUrl()
    const title4 = await cefHandle.evaluate('document.title')
    log('Test', `商品详情: URL=${url4}, title=${JSON.stringify(title4)}`)

    // 查找"去拼单"或"发起拼单"按钮
    const goodsInfo = await cefHandle.evaluate(`
      (function() {
        var body = document.body;
        if (!body) return 'no body';
        var text = body.innerText.substring(0, 500);
        var btns = Array.from(document.querySelectorAll('button, div[class*="btn"], span[class*="btn"]')).slice(0, 20).map(function(el) {
          return el.textContent.trim().substring(0, 20);
        }).filter(function(t) { return t.length > 0 && t.length < 15; });
        return JSON.stringify({ text: text, buttons: btns });
      })()
    `)
    log('Test', `商品页内容: ${goodsInfo}`)

    // 尝试点击"去拼单"按钮
    const clickResult = await cefHandle.evaluate(`
      (function() {
        var btns = document.querySelectorAll('button, div[class*="btn"], span[class*="btn"]');
        for (var i = 0; i < btns.length; i++) {
          var txt = btns[i].textContent.trim();
          if (txt.indexOf('拼单') >= 0 || txt.indexOf('购买') >= 0 || txt.indexOf('去拼') >= 0) {
            btns[i].click();
            return 'clicked: ' + txt;
          }
        }
        return 'no buy button found';
      })()
    `)
    log('Test', `点击购买: ${clickResult}`)

    await new Promise(r => setTimeout(r, 3000))

    // 检查是否到达结算页
    const url5 = await cefHandle.getUrl()
    const title5 = await cefHandle.evaluate('document.title')
    log('Test', `点击后: URL=${url5}, title=${JSON.stringify(title5)}`)

    const isCheckout = url5.includes('checkout') || url5.includes('order') || url5.includes('settlement')
    log('Test', `是否到达结算页: ${isCheckout}`)

  } catch (e) {
    log('Test', `Error: ${e.message}`)
  }

  mainWindow.on('closed', () => {
    if (cefHandle) cefHandle.close()
    app.quit()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
