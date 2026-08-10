'use strict'

const { app, BrowserWindow, ipcMain, nativeImage, session } = require('electron')
const crypto = require('crypto')
const http = require('http')
const https = require('https')
const path = require('path')
const { getAuthToken } = require('./auth-store')
const runtimeLog = require('./runtime-logger')
const {
  normalizeTaobaoSkuSelection,
  buildTaobaoSelectedSkuExtractionScript
} = require('./taobao-sku-selection')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const TB_IMAGE_SEARCH_REFERER = 'https://h5.m.taobao.com/awp/core/detail.htm?id=620000000000000000'
const TB_IMAGE_SEARCH_API = 'mtop.relationrecommend.wirelessRecommend.recommend'
const TB_IMAGE_SEARCH_API_PATH = 'mtop.relationrecommend.wirelessrecommend.recommend'
const TB_IMAGE_SEARCH_APP_KEY = '12574478'
const TB_IMAGE_SEARCH_APP_ID = '34850'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DIRECT_JPEG_BYTES = 500 * 1024
const SEARCH_REQUEST_TIMEOUT = 25000

const searchWindowStates = new Map()
const searchQueues = new Map()
const productWindows = new Set()
const preparedImageCache = new Map()
const PREPARED_IMAGE_CACHE_TTL = 20 * 60 * 1000
const MAX_PREPARED_IMAGE_CACHE = 20
let productWindowSequence = 0

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function attachTaobaoProductPriceDiagnostics(productWindow, diagnosticId) {
  const webContents = productWindow.webContents
  const onConsoleMessage = (_event, _level, message) => {
    const text = String(message || '')
    if (!text.startsWith('[DXE_PRICE_DIAG]')) return
    runtimeLog.writeLog('TaobaoPriceDiag', `window=${diagnosticId}, dom=${text.slice('[DXE_PRICE_DIAG]'.length, 1800)}`)
  }
  webContents.on('console-message', onConsoleMessage)
  runtimeLog.writeLog('TaobaoPriceDiag', `window=${diagnosticId}, dom-listener=ready`)
  productWindow.once('closed', () => {
    try { webContents.removeListener('console-message', onConsoleMessage) } catch (_) {}
  })
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const transport = urlObj.protocol === 'https:' ? https : http
    const headers = { ...(options.headers || {}) }
    const token = getAuthToken()
    if (token) headers.Authorization = 'Bearer ' + token

    const req = transport.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || 10000,
      rejectUnauthorized: false
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        data: Buffer.concat(chunks).toString('utf8')
      }))
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function isTaobaoCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase()
  return normalized === 'taobao.com' ||
    normalized.endsWith('.taobao.com') ||
    normalized === 'tmall.com' ||
    normalized.endsWith('.tmall.com') ||
    normalized === 'tmall.hk' ||
    normalized.endsWith('.tmall.hk')
}

function hasTaobaoLoginCookie(cookies) {
  return (cookies || []).some(cookie => cookie && (cookie.name === 'unb' || cookie.name === 'cookie17'))
}

function getTaobaoSamePartition(accountId) {
  return 'persist:dianxiaoer-tb-account-' + accountId
}

function getTaobaoPurchasePartition(accountId) {
  return 'persist:purchase-' + accountId
}

function normalizeSameSite(value) {
  const normalized = String(value || '').toLowerCase().replace(/-/g, '_')
  if (normalized === 'none' || normalized === 'no_restriction') return 'no_restriction'
  if (normalized === 'strict') return 'strict'
  if (normalized === 'lax') return 'lax'
  return 'unspecified'
}

async function fetchStoredAccountCookies(accountId) {
  const response = await httpRequest(BUSINESS_SERVER + '/api/purchase-accounts/' + accountId + '/cookies')
  if (response.statusCode !== 200 || !response.data) return []
  const json = JSON.parse(response.data)
  if (json.code !== 0 || !json.data || !json.data.cookie_data) return []
  const raw = typeof json.data.cookie_data === 'string'
    ? JSON.parse(json.data.cookie_data)
    : json.data.cookie_data
  return Array.isArray(raw) ? raw : []
}

async function injectTaobaoCookiesFromAccount(ses, accountId) {
  let storedCookies = []
  try {
    storedCookies = await fetchStoredAccountCookies(accountId)
  } catch (error) {
    runtimeLog.writeLog('TaobaoSame', '读取账号Cookie失败: accountId=' + accountId + ', error=' + error.message)
    return 0
  }

  const now = Date.now() / 1000
  let restored = 0
  for (const cookie of storedCookies) {
    if (!cookie || !cookie.name || !isTaobaoCookieDomain(cookie.domain)) continue
    if (cookie.expirationDate && cookie.expirationDate > 0 && cookie.expirationDate <= now) continue
    const domain = String(cookie.domain || '').replace(/^\./, '')
    const path = cookie.path || '/'
    const sameSite = normalizeSameSite(cookie.sameSite)
    const secure = sameSite === 'no_restriction' ? true : !!cookie.secure
    try {
      const detail = {
        url: (secure ? 'https' : 'http') + '://' + domain + path,
        name: cookie.name,
        value: cookie.value || '',
        domain: cookie.domain || domain,
        path,
        secure,
        httpOnly: !!cookie.httpOnly,
        sameSite
      }
      if (cookie.expirationDate && cookie.expirationDate > now) detail.expirationDate = cookie.expirationDate
      await ses.cookies.set(detail)
      restored++
    } catch (_) {
      // 单条Cookie格式异常不阻断其余Cookie恢复。
    }
  }
  if (restored > 0) await ses.flushStorageData()
  runtimeLog.writeLog('TaobaoSame', '账号Cookie恢复完成: accountId=' + accountId + ', count=' + restored)
  return restored
}

function isTaobaoLoginPageUrl(url) {
  const lower = String(url || '').toLowerCase()
  return lower.includes('login.taobao.com') ||
    lower.includes('login.tmall.com') ||
    lower.includes('passport') ||
    lower.includes('login_jump')
}

function isTaobaoVerificationUrl(url) {
  const lower = String(url || '').toLowerCase()
  return lower.includes('_____tmd_____') ||
    lower.includes('punish') ||
    lower.includes('sec.taobao.com') ||
    lower.includes('verify')
}

function showSearchWindow(state, title) {
  if (!state || !state.win || state.win.isDestroyed()) return
  state.win.setTitle(title || '淘宝搜同款')
  state.win.show()
  state.win.focus()
}

async function waitForTaobaoSearchPageStable(win, timeoutMs = 12000) {
  const startedAt = Date.now()
  let lastUrl = ''
  let stableSince = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!win || win.isDestroyed()) throw new Error('淘宝搜同款窗口已关闭')
    const currentUrl = win.webContents.getURL()
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl
      stableSince = Date.now()
    }
    if (!win.webContents.isLoading() && Date.now() - stableSince >= 500) return currentUrl
    await sleep(150)
  }
  return win.webContents.getURL()
}

async function bootstrapSearchWindow(state) {
  if (state.bootstrapComplete && state.win && !state.win.isDestroyed()) return
  if (state.initializing) return state.initializing

  state.initializing = (async () => {
    const win = state.win
    try {
      await win.loadURL(TB_IMAGE_SEARCH_REFERER)
    } catch (error) {
      const currentUrl = win.isDestroyed() ? '' : win.webContents.getURL()
      if (!currentUrl || (!error.message.includes('ERR_ABORTED') && !isTaobaoLoginPageUrl(currentUrl) && !isTaobaoVerificationUrl(currentUrl))) {
        throw error
      }
    }
    const finalUrl = await waitForTaobaoSearchPageStable(win)
    state.bootstrapComplete = !isTaobaoLoginPageUrl(finalUrl) && !isTaobaoVerificationUrl(finalUrl)
  })().finally(() => {
    state.initializing = null
  })

  return state.initializing
}

async function getOrCreateTaobaoSearchWindow(accountId) {
  // 搜同款使用账号专用分区，避免正常下单/改地址窗口更新Cookie后破坏
  // 当前承载页的MTOP Token与Bixi上下文。
  const partition = getTaobaoSamePartition(accountId)
  let state = searchWindowStates.get(partition)
  if (state && state.win && !state.win.isDestroyed()) return state

  const ses = session.fromPartition(partition)
  let cookies = await ses.cookies.get({})
  if (!hasTaobaoLoginCookie(cookies)) {
    await injectTaobaoCookiesFromAccount(ses, accountId)
    cookies = await ses.cookies.get({})
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    title: '淘宝搜同款 - 会话准备中',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      partition,
      backgroundThrottling: false,
      webSecurity: false
    }
  })
  const chromeVersion = process.versions.chrome || '134.0.6998.205'
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36'
  win.webContents.setUserAgent(userAgent)

  state = {
    partition,
    accountId,
    ses,
    win,
    initializing: null,
    bootstrapComplete: false,
    firstSearchPrepared: false,
    bixiTokens: null
  }
  searchWindowStates.set(partition, state)
  win.on('closed', () => {
    if (searchWindowStates.get(partition) === state) searchWindowStates.delete(partition)
  })
  win.webContents.on('did-navigate', (_event, url) => {
    if (isTaobaoLoginPageUrl(url)) showSearchWindow(state, '淘宝搜同款 - 请登录淘宝')
    if (isTaobaoVerificationUrl(url)) showSearchWindow(state, '淘宝搜同款 - 请完成安全验证')
  })

  if (!hasTaobaoLoginCookie(cookies)) {
    await bootstrapSearchWindow(state).catch(() => {})
    showSearchWindow(state, '淘宝搜同款 - 请登录淘宝')
    return state
  }

  await bootstrapSearchWindow(state)
  return state
}

async function recreateTaobaoSearchWindow(accountId, oldState, clearCache = false) {
  if (oldState) {
    if (searchWindowStates.get(oldState.partition) === oldState) searchWindowStates.delete(oldState.partition)
    if (clearCache && oldState.ses) {
      try { await oldState.ses.clearCache() } catch (_) {}
    }
    if (oldState.win && !oldState.win.isDestroyed()) {
      try {
        if (oldState.win.webContents.debugger.isAttached()) oldState.win.webContents.debugger.detach()
      } catch (_) {}
      oldState.win.destroy()
    }
  }
  return getOrCreateTaobaoSearchWindow(accountId)
}

async function resetTaobaoSearchWindow(accountId, oldState, reason) {
  if (!oldState) return getOrCreateTaobaoSearchWindow(accountId)
  const partition = oldState.partition
  const ses = oldState.ses
  if (searchWindowStates.get(partition) === oldState) searchWindowStates.delete(partition)
  if (oldState.win && !oldState.win.isDestroyed()) {
    try {
      if (oldState.win.webContents.debugger.isAttached()) oldState.win.webContents.debugger.detach()
    } catch (_) {}
    oldState.win.destroy()
  }

  // RGV587/USER_VALIDATE 会把搜同款专用页面会话标记为需验证。
  // 只重建 BrowserWindow 仍会复用被标记的 LocalStorage/MTOP Token，后续查询
  // 会持续失败；清理该专用分区后再从采购账号恢复 Cookie，不影响正式采购窗口。
  try { await ses.clearCache() } catch (_) {}
  try {
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
    })
  } catch (_) {}
  await injectTaobaoCookiesFromAccount(ses, accountId)
  const freshState = await getOrCreateTaobaoSearchWindow(accountId)
  runtimeLog.writeLog('TaobaoSame', '安全验证后已重置搜索专用会话: accountId=' + accountId + ', reason=' + reason)
  return freshState
}

async function restoreTaobaoSearchSession(accountId, oldState, reason) {
  const restoredCount = await injectTaobaoCookiesFromAccount(oldState.ses, accountId)
  const restoredCookies = await oldState.ses.cookies.get({})
  if (restoredCount <= 0 || !hasTaobaoLoginCookie(restoredCookies)) return null
  const freshState = await recreateTaobaoSearchWindow(accountId, oldState, true)
  runtimeLog.writeLog(
    'TaobaoSame',
    '搜索会话已自动恢复: accountId=' + accountId + ', reason=' + reason + ', count=' + restoredCount
  )
  return freshState
}

function normalizeRemoteImageUrl(imageUrl) {
  const value = String(imageUrl || '').trim()
  if (!value) throw new Error('当前商品没有可用主图')
  if (value.startsWith('//')) return 'https:' + value
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value
  throw new Error('商品主图地址无效')
}

function inferImageMimeType(buffer, contentType, imageUrl) {
  const header = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (/^image\/(jpeg|png|webp|gif|bmp)$/.test(header)) return header
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buffer.slice(0, 2).toString('ascii') === 'BM') return 'image/bmp'
  const extension = String(imageUrl || '').match(/\.(jpe?g|png|webp|gif|bmp)(?:[?#]|$)/i)
  if (extension) return extension[1].toLowerCase().startsWith('jp') ? 'image/jpeg' : 'image/' + extension[1].toLowerCase()
  return 'application/octet-stream'
}

function parseDataImage(imageUrl) {
  const match = String(imageUrl || '').match(/^data:(image\/(?:jpeg|png|webp|gif|bmp));base64,([\s\S]+)$/i)
  if (!match) return null
  return { mimeType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') }
}

async function downloadTaobaoSearchImage(ses, imageUrl) {
  const dataImage = parseDataImage(imageUrl)
  if (dataImage) {
    if (dataImage.buffer.length > MAX_IMAGE_BYTES) throw new Error('商品主图超过20MB，无法搜索')
    return dataImage
  }

  const response = await ses.fetch(imageUrl, {
    method: 'GET',
    referrer: TB_IMAGE_SEARCH_REFERER,
    cache: 'no-store'
  })
  if (!response.ok) throw new Error('商品主图下载失败（HTTP ' + response.status + '）')
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_IMAGE_BYTES) throw new Error('商品主图超过20MB，无法搜索')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('商品主图内容为空')
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('商品主图超过20MB，无法搜索')
  return {
    buffer,
    mimeType: inferImageMimeType(buffer, response.headers.get('content-type'), imageUrl)
  }
}

function convertTaobaoSearchImage(buffer, mimeType) {
  if (mimeType === 'image/jpeg' && buffer.length <= DIRECT_JPEG_BYTES) return buffer.toString('base64')

  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('淘宝无法识别当前商品主图格式')
  let output = image
  const size = image.getSize()
  if (buffer.length > DIRECT_JPEG_BYTES && Math.max(size.width, size.height) > 500) {
    const scale = 500 / Math.max(size.width, size.height)
    output = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    })
  }
  // Windows下nativeImage位图为BGRA；透明图片转JPEG前铺白底，避免透明区域变黑。
  const outputSize = output.getSize()
  const bitmap = Buffer.from(output.toBitmap())
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    const alpha = bitmap[offset + 3] / 255
    bitmap[offset] = Math.round(bitmap[offset] * alpha + 255 * (1 - alpha))
    bitmap[offset + 1] = Math.round(bitmap[offset + 1] * alpha + 255 * (1 - alpha))
    bitmap[offset + 2] = Math.round(bitmap[offset + 2] * alpha + 255 * (1 - alpha))
    bitmap[offset + 3] = 255
  }
  const whiteBackgroundImage = nativeImage.createFromBitmap(bitmap, {
    width: outputSize.width,
    height: outputSize.height,
    scaleFactor: 1
  })
  const jpeg = whiteBackgroundImage.toJPEG(80)
  if (!jpeg.length) throw new Error('商品主图转换失败')
  return jpeg.toString('base64')
}

async function prepareTaobaoSearchImage(ses, imageUrl) {
  const cacheKey = crypto.createHash('sha1').update(String(imageUrl || '')).digest('hex')
  const cached = preparedImageCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { ...cached, cacheHit: true }
  if (cached) preparedImageCache.delete(cacheKey)

  const downloaded = await downloadTaobaoSearchImage(ses, imageUrl)
  const prepared = {
    imageBase64: convertTaobaoSearchImage(downloaded.buffer, downloaded.mimeType),
    byteLength: downloaded.buffer.length,
    mimeType: downloaded.mimeType,
    expiresAt: Date.now() + PREPARED_IMAGE_CACHE_TTL
  }
  preparedImageCache.set(cacheKey, prepared)
  while (preparedImageCache.size > MAX_PREPARED_IMAGE_CACHE) {
    preparedImageCache.delete(preparedImageCache.keys().next().value)
  }
  return { ...prepared, cacheHit: false }
}

async function getTaobaoMtopToken(ses) {
  // 按实际请求URL筛选Cookie，避免同一分区存在多个同名Cookie时拿到并不会
  // 随h5api请求发送的旧Token。
  const cookies = await ses.cookies.get({ url: 'https://h5api.m.taobao.com/' })
  const candidates = cookies.filter(item => item.name === '_m_h5_tk' && isTaobaoCookieDomain(item.domain))
  candidates.sort((left, right) => {
    const leftExact = String(left.domain || '').replace(/^\./, '') === 'h5api.m.taobao.com' ? 1 : 0
    const rightExact = String(right.domain || '').replace(/^\./, '') === 'h5api.m.taobao.com' ? 1 : 0
    return rightExact - leftExact || String(right.path || '').length - String(left.path || '').length
  })
  const cookie = candidates[0]
  if (!cookie || !cookie.value) return ''
  return cookie.value.includes('_') ? cookie.value.split('_')[0] : cookie.value
}

async function waitForTaobaoMtopToken(ses, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const token = await getTaobaoMtopToken(ses)
    if (token) return token
    await sleep(200)
  }
  return ''
}

async function readTaobaoPageBixiTokens(win) {
  if (!win || win.isDestroyed()) return null
  const script = "(function() {" +
    "var entries = performance.getEntriesByType('resource') || [];" +
    "for (var i = entries.length - 1; i >= 0; i--) {" +
      "try {" +
        "var url = new URL(entries[i].name);" +
        "var bxUa = url.searchParams.get('bx-ua');" +
        "var bxUmidToken = url.searchParams.get('bx-umidtoken');" +
        "var bxEt = url.searchParams.get('bx_et');" +
        "if (bxUa && bxUmidToken && bxEt) return { bxUa: bxUa, bxUmidToken: bxUmidToken, bxEt: bxEt };" +
      "} catch (e) {}" +
    "}" +
    "return null;" +
  "})()"
  try {
    return await win.webContents.executeJavaScript(script, true)
  } catch (_) {
    return null
  }
}

async function waitForTaobaoPageBixiTokens(win, timeoutMs = 3500) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const tokens = await readTaobaoPageBixiTokens(win)
    if (tokens && tokens.bxUa && tokens.bxUmidToken && tokens.bxEt) return tokens
    await sleep(200)
  }
  return null
}

function buildTaobaoImageSearchRequest({ token, imageBase64, bixiTokens }) {
  const params = {
    pcGraphSearch: true,
    region: '',
    strimg: imageBase64,
    sortOrder: '0',
    ttid: '600000@taobao_android_10.16.10',
    tab: 'all',
    sversion: 15.8,
    vm: 'nw'
  }
  const jsonData = JSON.stringify({
    appId: TB_IMAGE_SEARCH_APP_ID,
    params: JSON.stringify(params)
  })
  const timestamp = Date.now()
  const signInput = (token || '') + '&' + timestamp + '&' + TB_IMAGE_SEARCH_APP_KEY + '&' + jsonData
  const sign = crypto.createHash('md5').update(signInput).digest('hex')
  const query = new URLSearchParams({
    jsv: '2.7.4',
    appKey: TB_IMAGE_SEARCH_APP_KEY,
    t: String(timestamp),
    sign,
    api: TB_IMAGE_SEARCH_API,
    v: '2.0',
    timeout: '8000',
    type: 'originaljson',
    dataType: 'jsonp'
  })
  if (bixiTokens && bixiTokens.bxUa && bixiTokens.bxUmidToken && bixiTokens.bxEt) {
    query.set('bx-ua', bixiTokens.bxUa)
    query.set('bx-umidtoken', bixiTokens.bxUmidToken)
    query.set('bx_et', bixiTokens.bxEt)
  }
  return {
    url: 'https://h5api.m.taobao.com/h5/' + TB_IMAGE_SEARCH_API_PATH + '/2.0/?' + query.toString(),
    body: 'data=' + encodeURIComponent(jsonData)
  }
}

async function ensureNetworkDebugger(win) {
  const debug = win.webContents.debugger
  if (!debug.isAttached()) debug.attach('1.3')
  await debug.sendCommand('Network.enable')
  return debug
}

function pageXhrPostAndCapture(win, requestUrl, postBody) {
  return new Promise(async (resolve, reject) => {
    let debug
    try {
      debug = await ensureNetworkDebugger(win)
    } catch (error) {
      reject(new Error('淘宝搜索网络监听启动失败: ' + error.message))
      return
    }

    const expected = new URL(requestUrl)
    const expectedTime = expected.searchParams.get('t')
    const expectedSign = expected.searchParams.get('sign')
    let requestId = ''
    let settled = false
    let timeout

    const cleanup = () => {
      clearTimeout(timeout)
      debug.removeListener('message', onMessage)
    }
    const finish = (error, body) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(body)
    }
    const onMessage = async (_event, method, params) => {
      try {
        if (method === 'Network.requestWillBeSent') {
          const url = params.request && params.request.url
          if (!url || !url.toLowerCase().includes(TB_IMAGE_SEARCH_API_PATH)) return
          const parsed = new URL(url)
          if (parsed.searchParams.get('t') === expectedTime && parsed.searchParams.get('sign') === expectedSign) {
            requestId = params.requestId
          }
          return
        }
        if (!requestId || params.requestId !== requestId) return
        if (method === 'Network.loadingFailed') {
          finish(new Error('淘宝图片搜索请求失败: ' + (params.errorText || '网络错误')))
          return
        }
        if (method === 'Network.loadingFinished') {
          const response = await debug.sendCommand('Network.getResponseBody', { requestId })
          const body = response.base64Encoded
            ? Buffer.from(response.body || '', 'base64').toString('utf8')
            : (response.body || '')
          finish(null, body)
        }
      } catch (error) {
        finish(error)
      }
    }
    timeout = setTimeout(() => finish(new Error('淘宝图片搜索请求超时')), SEARCH_REQUEST_TIMEOUT)
    debug.on('message', onMessage)

    const script = "(function() {" +
      "var xhr = new XMLHttpRequest();" +
      "xhr.open('POST', " + JSON.stringify(requestUrl) + ", true);" +
      "xhr.withCredentials = true;" +
      "xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');" +
      "xhr.send(" + JSON.stringify(postBody) + ");" +
      "return true;" +
    "})()"
    try {
      await win.webContents.executeJavaScript(script, true)
    } catch (error) {
      // 页面被淘宝立即导航时，Debugger仍可能捕获到真实响应，暂不提前失败。
      if (!requestId) {
        setTimeout(() => {
          if (!requestId) finish(new Error('淘宝图片搜索页面执行失败: ' + error.message))
        }, 500)
      }
    }
  })
}

function parseMtopJson(body) {
  const text = String(body || '').trim()
  if (!text) throw new Error('淘宝图片搜索返回为空')
  try {
    return JSON.parse(text)
  } catch (_) {
    const start = text.indexOf('(')
    const end = text.lastIndexOf(')')
    if (start >= 0 && end > start) return JSON.parse(text.slice(start + 1, end))
    throw new Error('淘宝图片搜索返回格式异常')
  }
}

function normalizeTaobaoPriceValue(value, seen = new Set()) {
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const price = normalizeTaobaoPriceValue(item, seen)
      if (price !== null) return price
    }
    return null
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return null
    seen.add(value)
    const preferredKeys = [
      'priceText', 'price', 'value', 'text', 'displayPrice', 'priceValue', 'amount',
      'finalPrice', 'couponPrice', 'promotionPrice', 'activityPrice', 'salePrice',
      'discountPrice', 'currentPrice', 'originalPrice', 'reservePrice', 'marketPrice'
    ]
    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const price = normalizeTaobaoPriceValue(value[key], seen)
        if (price !== null) return price
      }
    }
    // 淘宝会不定期调整价格对象的层级，例如 priceShow.priceInfo.priceText。
    // 这里只继续检查名称与价格有关的字段，避免误把商品ID、销量等数字当成价格。
    for (const [key, nestedValue] of Object.entries(value)) {
      if (!/price|amount|coupon|promotion/i.test(key)) continue
      const price = normalizeTaobaoPriceValue(nestedValue, seen)
      if (price !== null) return price
    }
    return null
  }
  const match = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  if (!match) return null
  const number = Number(match[0])
  return Number.isFinite(number) ? number : null
}

function firstTaobaoPrice(...values) {
  for (const value of values) {
    const price = normalizeTaobaoPriceValue(value)
    if (price !== null) return price
  }
  return null
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim()
}

function normalizeProductImage(value) {
  let image = value
  if (image && typeof image === 'object') image = image.url || image.picUrl || image.mainPic || image.src || ''
  image = String(image || '').trim()
  return image.startsWith('//') ? 'https:' + image : image
}

function normalizeProductLink(value, itemId) {
  let link = value
  if (link && typeof link === 'object') link = link.url || link.link || ''
  link = String(link || '').trim().replace(/&amp;/g, '&')
  if (link.startsWith('//')) link = 'https:' + link
  if (link && !/^https?:\/\//i.test(link)) {
    if (link.startsWith('/')) link = 'https://item.taobao.com' + link
    else link = 'https://' + link
  }
  return link || (itemId ? 'https://item.taobao.com/item.htm?id=' + itemId : '')
}

function isTaobaoProductPageUrl(value) {
  try {
    const url = new URL(String(value || ''))
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && (
      host === 'taobao.com' || host.endsWith('.taobao.com') ||
      host === 'tmall.com' || host.endsWith('.tmall.com') ||
      host === 'tmall.hk' || host.endsWith('.tmall.hk')
    )
  } catch (_) {
    return false
  }
}

function buildTaobaoSameSelection(context = {}, currentPageUrl = '', skuSnapshot = null) {
  const sameItem = context.sameItem || {}
  let itemId = String(sameItem.itemId || '').trim()
  let link = String(currentPageUrl || sameItem.link || '').trim()
  try {
    const parsed = new URL(link)
    itemId = parsed.searchParams.get('id') || itemId
  } catch (_) {}
  const product = { ...sameItem, itemId, link }
  if (skuSnapshot && typeof skuSnapshot === 'object') {
    product.skuCaptureAttempted = true
    const skuSelection = normalizeTaobaoSkuSelection(skuSnapshot)
    if (skuSelection.skuId || skuSelection.options.length > 0 || skuSelection.shipFrom) product.skuSelection = skuSelection
    product.shipFrom = String(skuSelection.shipFrom || '')
    product.shippingCandidates = Array.isArray(skuSnapshot.shippingCandidates)
      ? skuSnapshot.shippingCandidates.slice(0, 4)
      : []
    const currentSkuPrice = Number(skuSnapshot.price)
    product.skuPriceCaptured = Number.isFinite(currentSkuPrice) && currentSkuPrice > 0
    product.skuPriceSource = String(skuSnapshot.priceSource || '')
    product.promotionPriceMasked = !!skuSnapshot.promotionPriceMasked
    product.skuPriceCandidates = Array.isArray(skuSnapshot.priceCandidates)
      ? skuSnapshot.priceCandidates.slice(0, 6)
      : []
    if (product.skuPriceCaptured) {
      product.currentSkuPrice = currentSkuPrice
      product.price = currentSkuPrice
    }
  }
  return { accountId: context.accountId, product }
}

function getTaobaoSameLogoDataUrl() {
  const candidates = [
    path.join(app.getAppPath(), 'src', 'renderer', 'public', 'logo.png'),
    path.join(app.getAppPath(), 'out', 'renderer', 'logo.png'),
    path.join(app.getAppPath(), 'resources', 'icon.png')
  ]
  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate)
      if (!image.isEmpty()) return image.resize({ width: 24, height: 24, quality: 'best' }).toDataURL()
    } catch (_) {}
  }
  return ''
}

function buildTaobaoSameProductInjection(sourceProduct = {}, logoDataUrl = '', diagnosticId = '') {
  const safeSource = {
    goodsName: String(sourceProduct.goodsName || ''),
    image: String(sourceProduct.image || ''),
    sku: String(sourceProduct.sku || ''),
    skuSpec: String(sourceProduct.skuSpec || ''),
    quantity: Number(sourceProduct.quantity || 0),
    price: Number(sourceProduct.price || 0),
    purchasePrice: Number(sourceProduct.purchasePrice || 0),
    shippingName: String(sourceProduct.shippingName || ''),
    shippingPhone: String(sourceProduct.shippingPhone || ''),
    shippingAddress: String(sourceProduct.shippingAddress || '')
  }
  return `
(function() {
  var info = ${JSON.stringify(safeSource)};
  var logoDataUrl = ${JSON.stringify(logoDataUrl)};
  var diagnosticId = ${JSON.stringify(String(diagnosticId || ''))};

  function appendText(parent, tag, text, css) {
    var element = document.createElement(tag);
    element.textContent = text;
    if (css) element.style.cssText = css;
    parent.appendChild(element);
    return element;
  }

  function diagnosticLog(type, payload) {
    try {
      var data = payload && typeof payload === 'object' ? payload : {};
      data.type = type;
      data.window = diagnosticId;
      data.at = Date.now();
      console.info('[DXE_PRICE_DIAG]' + JSON.stringify(data));
    } catch (_) {}
  }

  function diagnosticVisible(element) {
    if (!element || !element.isConnected) return false;
    var rect = element.getBoundingClientRect();
    var style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function selectedSkuOptions() {
    var selectors = [
      '[aria-checked="true"]', '[aria-selected="true"]', '.tb-selected',
      '[class*="valueItem"][class*="selected"]', '[class*="valueItem"][class*="Selected"]',
      '[class*="skuItem"][class*="selected"]', '[class*="skuItem"][class*="Selected"]'
    ];
    var values = [];
    var seen = {};
    Array.from(document.querySelectorAll(selectors.join(','))).slice(0, 80).forEach(function(element) {
      if (!diagnosticVisible(element) || element.closest('#__dxe_sales_product_overlay__')) return;
      var text = String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 100);
      if (!text || seen[text]) return;
      seen[text] = true;
      values.push(text);
    });
    return values.slice(0, 8);
  }

  var lastPriceDiagnosticSignature = '';
  var priceDiagnosticTimer = null;
  function emitPriceState(reason, force) {
    try {
      var selectors = [
        '[class*="highlightPrice"]', '[class*="priceText"]', '[class*="PriceText"]',
        '[class*="promotionPrice"]', '[class*="salePrice"]',
        '[class*="beltPrice"]', '[class*="BeltPrice"]',
        '[class*="priceWrap"]', '[class*="PriceWrap"]'
      ];
      var nodes = [];
      var seenNodes = new Set();
      selectors.forEach(function(selector) {
        Array.from(document.querySelectorAll(selector)).slice(0, 120).forEach(function(element) {
          if (nodes.length >= 12 || seenNodes.has(element)) return;
          seenNodes.add(element);
          if (!diagnosticVisible(element) || element.closest('#__dxe_sales_product_overlay__')) return;
          var text = String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
          if (!text || !/(?:[¥￥]|价格|优惠|加补|到手|秒杀|活动|会员|\\d|[•·]{2,}|\\.{3,})/.test(text)) return;
          var rect = element.getBoundingClientRect();
          nodes.push({
            text: text,
            cls: String(element.className || '').slice(0, 100),
            top: Math.round(rect.top),
            left: Math.round(rect.left)
          });
        });
      });
      var itemId = '', skuId = '';
      try {
        var pageUrl = new URL(location.href);
        itemId = pageUrl.searchParams.get('id') || '';
        skuId = pageUrl.searchParams.get('skuId') || pageUrl.searchParams.get('sku_id') || '';
      } catch (_) {}
      var options = selectedSkuOptions();
      var signature = JSON.stringify({ itemId: itemId, skuId: skuId, options: options, nodes: nodes });
      if (!force && signature === lastPriceDiagnosticSignature) return;
      lastPriceDiagnosticSignature = signature;
      diagnosticLog('price-state', {
        reason: reason,
        itemId: itemId,
        skuId: skuId,
        selectedOptions: options,
        masked: nodes.some(function(node) { return /[•·]{2,}|\\.{3,}/.test(node.text); }),
        nodes: nodes
      });
    } catch (error) {
      diagnosticLog('price-state-error', { reason: reason, message: String(error && error.message || error).slice(0, 200) });
    }
  }

  function schedulePriceState(reason, delay, force) {
    setTimeout(function() { emitPriceState(reason, force); }, delay || 0);
  }

  function installPriceDiagnostics() {
    if (window.__dxePriceDiagnosticsInstalled === diagnosticId) return;
    window.__dxePriceDiagnosticsInstalled = diagnosticId;
    document.addEventListener('click', function(event) {
      var target = event.target && event.target.closest ? event.target.closest([
        '[class*="valueItem--"]', '[class*="ValueItem--"]',
        '[class*="skuValue--"]', '[class*="SkuValue--"]',
        '[class*="skuItemValue"]', '[class*="SkuItemValue"]',
        '.J_TSaleProp li', '.tb-sku li', '.tm-sale-prop li',
        '[role="radio"]', '[role="option"]', '[data-prop-value]', '[data-property-value]'
      ].join(',')) : null;
      if (!target || target.closest('#__dxe_sales_product_overlay__')) return;
      diagnosticLog('sku-click', {
        text: String(target.getAttribute('aria-label') || target.getAttribute('title') || target.textContent || '')
          .replace(/\s+/g, ' ').trim().slice(0, 120)
      });
      emitPriceState('sku-click-before', true);
      schedulePriceState('sku-click-200ms', 200, true);
      schedulePriceState('sku-click-800ms', 800, true);
      schedulePriceState('sku-click-2000ms', 2000, true);
      schedulePriceState('sku-click-5000ms', 5000, true);
    }, true);
    emitPriceState('diagnostic-installed', true);
  }

  function buildSourceOverlay() {
    var old = document.getElementById('__dxe_sales_product_overlay__');
    if (old) old.remove();
    if (window.__dxeSalesProductOverlayClosed || !document.body) return;

    var overlay = document.createElement('aside');
    overlay.id = '__dxe_sales_product_overlay__';
    overlay.style.cssText = 'position:fixed;left:20px;top:190px;width:185px;max-height:calc(100vh - 210px);z-index:2147483000;overflow:hidden;box-sizing:border-box;border:1px solid #ebeef5;border-radius:8px;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.14);color:#303133;font-family:"Microsoft YaHei",sans-serif;font-size:12px;line-height:1.5;';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;height:40px;padding:0 12px;box-sizing:border-box;border-bottom:1px solid #eee;background:#fafafa;user-select:none;cursor:move;';
    appendText(header, 'strong', '\u5546\u54c1\u4fe1\u606f', 'flex:1;min-width:0;font-size:13px;color:#303133;');
    var collapse = appendText(header, 'button', '\u25b2', 'width:24px;height:24px;padding:0;border:0;background:transparent;color:#909399;font-size:12px;cursor:pointer;');
    collapse.title = '\u6536\u8d77';
    var close = appendText(header, 'button', '\u00d7', 'width:24px;height:24px;padding:0;border:0;background:transparent;color:#909399;font-size:17px;cursor:pointer;');
    close.title = '\u5173\u95ed';

    var body = document.createElement('div');
    body.style.cssText = 'max-height:calc(100vh - 250px);overflow-y:auto;padding:12px;box-sizing:border-box;background:#fff;';
    if (info.image) {
      var image = document.createElement('img');
      image.src = info.image;
      image.alt = '';
      image.style.cssText = 'display:block;width:100%;aspect-ratio:1/1;border-radius:6px;background:#f7f7f7;object-fit:contain;';
      image.onerror = function() { image.style.display = 'none'; };
      body.appendChild(image);
    }
    appendText(body, 'div', info.goodsName || '\u672a\u83b7\u53d6\u5230\u8ba2\u5355\u5546\u54c1\u6807\u9898', 'margin-top:10px;color:#303133;font-size:13px;font-weight:600;line-height:1.5;white-space:normal;word-break:break-all;');
    if (info.skuSpec) appendText(body, 'div', '\u9500\u552e\u89c4\u683c\uff1a' + info.skuSpec, 'margin-top:7px;padding:6px 8px;border:1px solid #ffd7ba;border-radius:5px;background:#fff7e8;color:#fa541c;font-size:12px;font-weight:700;line-height:1.5;word-break:break-all;');
    if (info.sku) appendText(body, 'div', 'SKU: ' + info.sku, 'margin-top:5px;color:#909399;word-break:break-all;');

    var priceRow = document.createElement('div');
    priceRow.style.cssText = 'display:flex;justify-content:space-between;gap:8px;margin-top:9px;';
    appendText(priceRow, 'span', '\u6570\u91cf: ' + info.quantity, 'color:#606266;');
    appendText(priceRow, 'span', '\u5355\u4ef7: \u00a5' + Number(info.price || 0).toFixed(2), 'color:#e6a23c;font-weight:600;');
    body.appendChild(priceRow);
    appendText(body, 'div', '\u91c7\u8d2d\u4ef7: \u00a5' + Number(info.purchasePrice || 0).toFixed(2), 'margin-top:5px;color:#67c23a;');

    if (info.shippingName || info.shippingPhone || info.shippingAddress) {
      var contact = document.createElement('div');
      contact.style.cssText = 'margin-top:9px;padding-top:9px;border-top:1px solid #f0f0f0;';
      var contactRow = document.createElement('div');
      contactRow.style.cssText = 'display:flex;justify-content:space-between;gap:8px;color:#606266;';
      if (info.shippingName) appendText(contactRow, 'span', info.shippingName, 'min-width:0;word-break:break-all;');
      if (info.shippingPhone) appendText(contactRow, 'span', info.shippingPhone, 'flex:0 0 auto;');
      contact.appendChild(contactRow);
      if (info.shippingAddress) appendText(contact, 'div', info.shippingAddress, 'margin-top:6px;color:#909399;font-size:11px;line-height:1.45;word-break:break-all;');
      body.appendChild(contact);
    }

    overlay.appendChild(header);
    overlay.appendChild(body);
    document.body.appendChild(overlay);

    var collapsed = false;
    collapse.addEventListener('click', function(event) {
      event.stopPropagation();
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      collapse.textContent = collapsed ? '\u25bc' : '\u25b2';
      collapse.title = collapsed ? '\u5c55\u5f00' : '\u6536\u8d77';
    });
    close.addEventListener('click', function(event) {
      event.stopPropagation();
      window.__dxeSalesProductOverlayClosed = true;
      overlay.remove();
    });

    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener('mousedown', function(event) {
      if (event.target === collapse || event.target === close) return;
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      var rect = overlay.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      event.preventDefault();
    });
    document.addEventListener('mousemove', function(event) {
      if (!dragging) return;
      overlay.style.left = (startLeft + event.clientX - startX) + 'px';
      overlay.style.top = (startTop + event.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', function() { dragging = false; });
  }

  function isValidTitle(element) {
    if (!element) return false;
    var rect = element.getBoundingClientRect();
    var text = String(element.textContent || '').trim();
    return rect.width > 0 && rect.height > 0 && text.length >= 4 && text.length <= 260 &&
      rect.top > 50 && rect.top < window.innerHeight * 0.72 && rect.left > window.innerWidth * 0.28 &&
      !/^[\s\d.,\u00a5\uffe5$-]+$/.test(text);
  }

  function findProductTitle() {
    var selectors = [
      '[class*="ItemTitle--"] span[class*="mainTitle--"]',
      'span[class*="mainTitle--"]',
      '[class*="ItemTitle--"] div[class*="MainTitle--"]',
      'div[class*="MainTitle--"] > span[title]',
      '[class*="titleWrap--"] [title]',
      'h1'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var candidates = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < candidates.length; j++) if (isValidTitle(candidates[j])) return candidates[j];
    }
    var fallback = document.querySelectorAll('h1,[title],strong,span');
    var best = null, bestScore = 0;
    for (var k = 0; k < fallback.length && k < 5000; k++) {
      var element = fallback[k];
      if (!isValidTitle(element)) continue;
      var textLength = String(element.textContent || '').trim().length;
      var fontSize = parseFloat(getComputedStyle(element).fontSize || '0');
      if (fontSize < 15) continue;
      var score = fontSize * 10 + Math.min(textLength, 100);
      if (score > bestScore) { best = element; bestScore = score; }
    }
    return best;
  }

  function createSelectRow() {
    var row = document.createElement('div');
    row.id = '__dxe_same_source_row__';
    row.setAttribute('data-name', 'dianxiaoer-source');
    row.setAttribute('data-label', '\u9009\u8d27\u6e90');
    var button = document.createElement('button');
    button.id = '__dxe_same_source_control__';
    button.type = 'button';
    button.title = '\u9009\u4e3a\u8d27\u6e90';
    button.setAttribute('aria-label', '\u9009\u4e3a\u8d27\u6e90');
    if (logoDataUrl) {
      var logo = document.createElement('img');
      logo.src = logoDataUrl;
      logo.alt = '\u5e97\u5c0f\u4e8c';
      logo.setAttribute('data-dxe-source-logo', '1');
      button.appendChild(logo);
    }
    var label = appendText(button, 'span', '\u9009\u8d27\u6e90');
    label.setAttribute('data-dxe-source-label', '1');
    var tooltip = appendText(row, 'span', '\u9009\u4e3a\u8d27\u6e90');
    tooltip.setAttribute('data-dxe-source-tooltip', '1');
    var tooltipArrow = document.createElement('i');
    tooltipArrow.setAttribute('data-dxe-source-tooltip-arrow', '1');
    tooltip.appendChild(tooltipArrow);
    button.addEventListener('mouseenter', function() {
      if (button.disabled) return;
      if (row.getAttribute('data-dxe-placement') === 'toolkit') {
        button.style.background = 'rgba(255,80,0,.08)';
        tooltip.style.display = 'block';
      } else button.style.opacity = '.78';
    });
    button.addEventListener('mouseleave', function() {
      button.style.opacity = '1';
      if (row.getAttribute('data-dxe-placement') === 'toolkit') {
        button.style.background = 'transparent';
        tooltip.style.display = 'none';
      }
    });
    button.addEventListener('click', function(event) {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      button.style.cursor = 'default';
      tooltip.style.display = 'none';
      label.textContent = '\u9009\u62e9\u4e2d...';
      emitPriceState('select-source-click', true);
      window.open('dianxiaoer://select-taobao-same-source', '_blank');
    });
    row.appendChild(button);
    return row;
  }

  function findTaobaoToolkitList() {
    return document.querySelector('#J_Toolkit .tb-toolkit-list-new') ||
      document.querySelector('#J_Toolkit .tb-toolkit-list') ||
      document.querySelector('#tb-toolkit-new .tb-toolkit-list-new');
  }

  function styleSelectRow(row, placement) {
    var button = row.querySelector('#__dxe_same_source_control__');
    var logo = row.querySelector('[data-dxe-source-logo="1"]');
    var label = row.querySelector('[data-dxe-source-label="1"]');
    var tooltip = row.querySelector('[data-dxe-source-tooltip="1"]');
    var tooltipArrow = row.querySelector('[data-dxe-source-tooltip-arrow="1"]');
    row.setAttribute('data-dxe-placement', placement);
    if (placement === 'toolkit') {
      row.className = 'toolkit-item-new toolkit-item-link dxe-toolkit-source-item';
      row.removeAttribute('data-label');
      row.style.cssText = 'position:relative;z-index:1;display:flex;flex:0 0 48px;align-items:center;justify-content:center;width:100%;min-width:0;height:48px;margin:0;padding:0;box-sizing:border-box;overflow:visible;';
      button.className = 'dxe-toolkit-source-button';
      button.removeAttribute('title');
      button.style.cssText = 'appearance:none;display:flex;align-items:center;justify-content:center;width:100%;min-width:0;height:48px;margin:0;padding:0;border:0;background:transparent;color:#333;cursor:pointer;box-shadow:none;overflow:hidden;';
      if (logo) logo.style.cssText = 'display:block;width:22px;height:22px;flex:0 0 22px;margin:0;border-radius:5px;object-fit:cover;';
      if (label) {
        label.className = 'toolkit-label dxe-toolkit-source-label';
        label.style.cssText = 'display:none;';
      }
      if (tooltip) tooltip.style.cssText = 'display:none;position:absolute;right:calc(100% + 9px);top:50%;z-index:2147483002;transform:translateY(-50%);padding:7px 10px;border-radius:6px;background:rgba(24,24,24,.92);color:#fff;font-family:"Microsoft YaHei",sans-serif;font-size:13px;font-style:normal;font-weight:400;line-height:18px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.18);';
      if (tooltipArrow) tooltipArrow.style.cssText = 'position:absolute;left:100%;top:50%;width:0;height:0;transform:translateY(-50%);border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:6px solid rgba(24,24,24,.92);';
    } else {
      row.className = '';
      row.setAttribute('data-label', '\u9009\u8d27\u6e90');
      row.style.cssText = 'position:fixed;left:20px;top:146px;z-index:2147483001;display:flex;align-items:center;width:auto;height:34px;margin:0;padding:0;box-sizing:border-box;';
      button.className = '';
      button.title = '\u9009\u4e3a\u8d27\u6e90';
      button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;height:30px;padding:2px 8px 2px 4px;border:1px solid #ff6500;border-radius:6px;background:#fff7f0;color:#ff6500;font-family:"Microsoft YaHei",sans-serif;font-size:13px;line-height:24px;white-space:nowrap;cursor:pointer;box-shadow:none;';
      if (logo) logo.style.cssText = 'display:block;width:22px;height:22px;flex:0 0 22px;border-radius:6px;object-fit:cover;margin-right:5px;';
      if (label) {
        label.className = '';
        label.style.cssText = '';
      }
      if (tooltip) tooltip.style.cssText = 'display:none;';
    }
  }

  function placeSelectRow() {
    var existing = document.getElementById('__dxe_same_source_row__');
    if (!document.body) return false;
    var row = existing && existing.isConnected ? existing : createSelectRow();
    var toolkitList = findTaobaoToolkitList();
    if (toolkitList) {
      if (row.parentElement !== toolkitList || toolkitList.firstElementChild !== row) {
        toolkitList.insertBefore(row, toolkitList.firstChild);
      }
      if (row.getAttribute('data-dxe-placement') !== 'toolkit') styleSelectRow(row, 'toolkit');
      return true;
    }
    // 极少数页面没有淘宝工具条时保留独立浮窗，确保仍可选货源。
    if (row.parentElement !== document.body) document.body.appendChild(row);
    if (row.getAttribute('data-dxe-placement') !== 'fallback') styleSelectRow(row, 'fallback');
    return true;
  }

  function initialize() {
    buildSourceOverlay();
    placeSelectRow();
    installPriceDiagnostics();
    requestAnimationFrame(function() { placeSelectRow(); });
    if (window.__dxeSameSourceObserver) window.__dxeSameSourceObserver.disconnect();
    var scheduled = false;
    window.__dxeSameSourceObserver = new MutationObserver(function() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function() {
        scheduled = false;
        placeSelectRow();
        if (priceDiagnosticTimer) clearTimeout(priceDiagnosticTimer);
        priceDiagnosticTimer = setTimeout(function() { emitPriceState('dom-mutation', false); }, 120);
      });
    });
    window.__dxeSameSourceObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    var attempts = 0;
    var timer = setInterval(function() {
      attempts++;
      if (placeSelectRow() || attempts >= 100) clearInterval(timer);
    }, 100);
  }

  if (document.body) initialize();
  else document.addEventListener('DOMContentLoaded', initialize, { once: true });
  return '[DXE_SAME_PRODUCT] injected';
})()
`
}

async function openTaobaoSameProductPage(params, ownerWebContents) {
  const accountId = params && params.accountId
  const url = String((params && params.url) || '').trim()
  if (!accountId || !isTaobaoProductPageUrl(url)) {
    return { success: false, message: '淘宝商品链接或采购账号无效' }
  }

  await getOrCreateTaobaoSearchWindow(accountId)
  // 隐藏搜索页继续使用独立分区，商品详情页改用与正式采购下单完全相同的
  // purchase分区。活动价会依赖该分区内的登录上下文与站点存储。
  const productPartition = getTaobaoPurchasePartition(accountId)
  const productSession = session.fromPartition(productPartition)
  let productCookies = await productSession.cookies.get({})
  if (!hasTaobaoLoginCookie(productCookies)) {
    await injectTaobaoCookiesFromAccount(productSession, accountId)
    productCookies = await productSession.cookies.get({})
  }
  const context = {
    accountId,
    sourceProduct: params.sourceProduct || {},
    sameItem: { ...(params.sameItem || {}), link: url }
  }
  const diagnosticId = `${accountId}-${++productWindowSequence}-${Date.now().toString(36)}`
  const productWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: '淘宝同款商品',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: productPartition
    }
  })
  productWindows.add(productWindow)
  attachTaobaoProductPriceDiagnostics(productWindow, diagnosticId)
  const chromeVersion = process.versions.chrome || '134.0.6998.205'
  productWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chromeVersion + ' Safari/537.36'
  )

  let selecting = false
  const selectCurrentProduct = async () => {
    if (selecting || productWindow.isDestroyed()) return
    selecting = true
    let skuSnapshot = null
    for (let captureAttempt = 0; captureAttempt < 6; captureAttempt++) {
      try {
        skuSnapshot = await productWindow.webContents.executeJavaScript(buildTaobaoSelectedSkuExtractionScript(), true)
      } catch (error) {
        runtimeLog.writeLog('TaobaoSame', '读取当前SKU失败: ' + error.message)
        break
      }
      const capturedPrice = Number(skuSnapshot && skuSnapshot.price)
      if (Number.isFinite(capturedPrice) && capturedPrice > 0) break
      if (captureAttempt < 5) await sleep(650)
    }
    if (productWindow.isDestroyed()) return
    const selected = buildTaobaoSameSelection(context, productWindow.webContents.getURL(), skuSnapshot)
    if (ownerWebContents && !ownerWebContents.isDestroyed()) {
      ownerWebContents.send('taobao-same-source-selected', selected)
      const ownerWindow = BrowserWindow.fromWebContents(ownerWebContents)
      if (ownerWindow && !ownerWindow.isDestroyed()) {
        ownerWindow.show()
        ownerWindow.focus()
      }
    }
    const selectedSku = selected.product.skuSelection
    runtimeLog.writeLog(
      'TaobaoSame',
      '商品页选为货源: accountId=' + accountId +
      ', window=' + diagnosticId +
      ', itemId=' + (selected.product.itemId || '') +
      ', skuId=' + (selectedSku?.skuId || '') +
      ', options=' + (selectedSku?.options?.length || 0) +
      ', price=' + (selected.product.currentSkuPrice || '') +
      ', priceCaptured=' + !!selected.product.skuPriceCaptured +
      ', priceSource=' + (selected.product.skuPriceSource || '') +
      ', shipFrom=' + (selected.product.shipFrom || '') +
      ', candidates=' + JSON.stringify(selected.product.skuPriceCandidates || []) +
      ', shippingCandidates=' + JSON.stringify(selected.product.shippingCandidates || [])
    )
    if (selected.product.skuPriceCaptured) {
      setTimeout(() => {
        if (!productWindow.isDestroyed()) productWindow.close()
      }, 120)
    } else {
      selecting = false
      productWindow.webContents.executeJavaScript(
        "(function(){var button=document.getElementById('__dxe_same_source_control__');" +
        "if(!button)return;button.disabled=false;button.style.cursor='pointer';" +
        "var label=button.querySelector('span');if(label)label.textContent=" +
        JSON.stringify(selected.product.promotionPriceMasked ? '价格重试' : '重新选择') + ";})()"
      ).catch(() => {})
    }
  }
  productWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('dianxiaoer://select-taobao-same-source')) selectCurrentProduct().catch(() => {})
    return { action: 'deny' }
  })
  productWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith('dianxiaoer://select-taobao-same-source')) return
    event.preventDefault()
    selectCurrentProduct().catch(() => {})
  })

  const logoDataUrl = getTaobaoSameLogoDataUrl()
  const inject = () => {
    if (productWindow.isDestroyed()) return
    const script = buildTaobaoSameProductInjection(context.sourceProduct, logoDataUrl, diagnosticId)
    productWindow.webContents.executeJavaScript(script, true).catch(error => {
      runtimeLog.writeLog('TaobaoSame', '商品页控件注入失败: ' + error.message)
    })
  }
  // DOM就绪立即注入；脚本内的MutationObserver负责淘宝SPA后续异步重绘，
  // 无需在did-finish-load时再次重建浮窗和按钮。
  productWindow.webContents.on('dom-ready', inject)
  productWindow.on('closed', () => {
    productWindows.delete(productWindow)
    runtimeLog.writeLog('TaobaoPriceDiag', `window=${diagnosticId}, closed`)
  })

  await productWindow.loadURL(url)
  runtimeLog.writeLog(
    'TaobaoSame',
    '打开同款商品页: accountId=' + accountId +
    ', window=' + diagnosticId +
    ', partition=' + productPartition +
    ', loginCookie=' + (hasTaobaoLoginCookie(productCookies) ? 'YES' : 'NO')
  )
  return { success: true }
}

function normalizeTaobaoSearchItems(items, limit = 20) {
  const source = Array.isArray(items) ? items : []
  const products = []
  for (const item of source) {
    if (!item || typeof item !== 'object') continue
    const itemId = String(item.item_id || item.itemId || item.nid || '').trim()
    const priceInfo = item.priceInfo || {}
    const promotion = item.pricePromotionInfo || {}
    const priceShow = item.priceShow || {}
    const preferredPrice = firstTaobaoPrice(
      priceInfo.finalPrice, priceInfo.couponPrice, priceInfo.promotionPrice, priceInfo.salePrice,
      promotion.finalPrice, promotion.promotionPrice, promotion.activityPrice,
      priceShow.finalPrice, priceShow.couponPrice, priceShow.promotionPrice, priceShow.price,
      item.finalPrice, item.couponPrice, item.promotionPrice, item.activityPrice,
      item.salePrice, item.discountPrice, item.currentPrice,
      item.price, item.view_price, item.viewPrice, item.priceWithRate,
      // 新返回结构可能直接把可展示价格放在 priceInfo/priceShow 的更深层。
      priceInfo, promotion, priceShow
    )
    const originalPriceCandidate = firstTaobaoPrice(
      priceInfo.originalPrice, priceInfo.originPrice, priceInfo.reservePrice, priceInfo.marketPrice,
      promotion.reservePrice, priceShow.originalPrice, priceShow.linePrice, priceShow.marketPrice,
      item.originalPrice, item.reserve_price
    )
    // 参考实现要求普通价格缺失时以原价兜底。此前漏掉这一步，会导致接口有价
    // 但界面仍显示“价格待查看”。
    const price = preferredPrice !== null ? preferredPrice : originalPriceCandidate
    const title = stripHtml(item.title || item.raw_title)
    const image = normalizeProductImage(
      item.pic_path || item.pic || item.img || item.picUrl || (item.pics && item.pics.mainPic)
    )
    const link = normalizeProductLink(item.auctionURL || item.url || item.itemUrl, itemId)
    if (!itemId && !link) continue
    const product = {
      itemId,
      title,
      price,
      originalPrice: originalPriceCandidate !== null && price !== null && originalPriceCandidate > price
        ? originalPriceCandidate
        : null,
      sales: stripHtml((item.salesInfo && item.salesInfo.totalSale) || item.realSales || item.view_sales),
      shop: stripHtml(
        (item.shopInfo && item.shopInfo.title) ||
        (item.sellerInfo && item.sellerInfo.shopTitle) ||
        item.nick ||
        item.shop
      ),
      img: image,
      link
    }
    const shopId = String(
      item.shopId || item.shop_id || item.shopInfo?.shopId || item.shopInfo?.shop_id ||
      item.sellerInfo?.shopId || item.sellerInfo?.shop_id || ''
    ).trim()
    const sellerId = String(
      item.sellerId || item.seller_id || item.userId || item.user_id ||
      item.shopInfo?.sellerId || item.shopInfo?.userId ||
      item.sellerInfo?.sellerId || item.sellerInfo?.userId || ''
    ).trim()
    if (shopId) product.shopId = shopId
    if (sellerId) product.sellerId = sellerId
    products.push(product)
    if (products.length >= limit) break
  }
  return products
}

function summarizeTaobaoPriceFields(items) {
  const summaries = []
  const visit = (value, path, depth) => {
    if (summaries.length >= 16 || depth > 5 || value === null || value === undefined) return
    if (Array.isArray(value)) {
      value.slice(0, 2).forEach((item, index) => visit(item, path + '[' + index + ']', depth + 1))
      return
    }
    if (typeof value !== 'object') return
    for (const [key, nestedValue] of Object.entries(value)) {
      if (summaries.length >= 16) break
      const nextPath = path ? path + '.' + key : key
      if (/price|amount|coupon|promotion/i.test(key)) {
        let text
        try { text = typeof nestedValue === 'object' ? JSON.stringify(nestedValue) : String(nestedValue) } catch (_) { text = '[object]' }
        summaries.push(nextPath + '=' + text.slice(0, 120))
      }
      if (nestedValue && typeof nestedValue === 'object') visit(nestedValue, nextPath, depth + 1)
    }
  }
  const firstItem = Array.isArray(items) ? items[0] : null
  visit(firstItem, 'item[0]', 0)
  return summaries.join('; ').slice(0, 1200) || '未发现price相关字段'
}

function extractItemsArray(resultJson) {
  let items = resultJson && resultJson.data && resultJson.data.itemsArray
  if (typeof items === 'string') {
    try { items = JSON.parse(items) } catch (_) { items = [] }
  }
  return Array.isArray(items) ? items : []
}

function summarizeTaobaoSearchResponse(resultJson, responseBody) {
  const collectionPaths = []
  const objectShapes = []
  const seen = new Set()
  const visit = (value, path, depth) => {
    if (collectionPaths.length >= 24 || depth > 4 || value === null || value === undefined) return
    if (Array.isArray(value)) {
      collectionPaths.push(path + '=array(' + value.length + ')')
      if (value.length > 0 && depth < 4) visit(value[0], path + '[0]', depth + 1)
      return
    }
    if (typeof value === 'string') {
      const text = value.trim()
      if ((text.startsWith('[') || text.startsWith('{')) && text.length <= 2 * 1024 * 1024) {
        try {
          const parsed = JSON.parse(text)
          collectionPaths.push(path + '=json-' + (Array.isArray(parsed) ? 'array(' + parsed.length + ')' : 'object'))
          visit(parsed, path + '$json', depth + 1)
        } catch (_) {}
      }
      return
    }
    if (typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const entries = Object.entries(value)
    if (path.includes('[0]') && objectShapes.length < 12) {
      objectShapes.push(path + '={' + entries.slice(0, 30).map(([key]) => key).join(',') + '}')
    }
    for (const [key, nested] of entries) {
      visit(nested, path ? path + '.' + key : key, depth + 1)
      if (collectionPaths.length >= 24) break
    }
  }

  const data = resultJson && typeof resultJson.data === 'object' && resultJson.data !== null
    ? resultJson.data
    : null
  visit(data, 'data', 0)
  const body = String(responseBody || '')
  return JSON.stringify({
    bodyBytes: Buffer.byteLength(body, 'utf8'),
    bodySha256: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
    ret: Array.isArray(resultJson?.ret) ? resultJson.ret.slice(0, 3) : resultJson?.ret,
    topLevelKeys: resultJson && typeof resultJson === 'object' ? Object.keys(resultJson).slice(0, 20) : [],
    dataKeys: data ? Object.keys(data).slice(0, 30) : [],
    itemsArrayCount: extractItemsArray(resultJson).length,
    collectionPaths,
    objectShapes
  })
}

function enqueueSearch(partition, task) {
  const previous = searchQueues.get(partition) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  searchQueues.set(partition, current)
  current.finally(() => {
    if (searchQueues.get(partition) === current) searchQueues.delete(partition)
  }).catch(() => {})
  return current
}

async function searchTaobaoImageDirect({ accountId, imageUrl, limit = 20, automatic = false }) {
  let state = await getOrCreateTaobaoSearchWindow(accountId)
  const partition = state.partition
  return enqueueSearch(partition, async () => {
    let win = state.win
    let ses = state.ses
    let restoreAttempted = false
    const tryRestoreSession = async (reason) => {
      if (restoreAttempted) return false
      restoreAttempted = true
      const restoredState = await restoreTaobaoSearchSession(accountId, state, reason)
      if (!restoredState) return false
      state = restoredState
      win = state.win
      ses = state.ses
      return true
    }
    runtimeLog.writeLog('TaobaoSame', '开始搜同款: accountId=' + accountId + ', automatic=' + !!automatic)
    let currentCookies = await ses.cookies.get({})
    if (!hasTaobaoLoginCookie(currentCookies)) {
      const restored = await tryRestoreSession('login_cookie_missing')
      if (!restored) {
        runtimeLog.writeLog('TaobaoSame', '搜索会话需要登录: reason=login_cookie_missing')
        showSearchWindow(state, '淘宝搜同款 - 请登录淘宝')
        return { success: false, needLogin: true, message: '请先登录淘宝，登录后重新搜索' }
      }
      currentCookies = await ses.cookies.get({})
    }

    let currentUrl = win.webContents.getURL()
    if (isTaobaoLoginPageUrl(currentUrl)) {
      const restored = await tryRestoreSession('login_page_redirect')
      currentUrl = win.webContents.getURL()
      if (!restored || isTaobaoLoginPageUrl(currentUrl)) {
        runtimeLog.writeLog('TaobaoSame', '搜索会话需要登录: reason=login_page_redirect')
        showSearchWindow(state, '淘宝搜同款 - 请登录淘宝')
        return { success: false, needLogin: true, message: '请先登录淘宝，登录后重新搜索' }
      }
    }
    if (isTaobaoVerificationUrl(currentUrl)) {
      showSearchWindow(state, '淘宝搜同款 - 请完成安全验证')
      return {
        success: false,
        needVerification: true,
        message: '淘宝要求安全验证，请在弹窗中完成后重新搜索'
      }
    }

    if (!state.bootstrapComplete) {
      await bootstrapSearchWindow(state)
      const preparedUrl = win.webContents.getURL()
      if (isTaobaoLoginPageUrl(preparedUrl)) {
        showSearchWindow(state, '淘宝搜同款 - 请登录淘宝')
        return { success: false, needLogin: true, message: '请先登录淘宝，登录后重新搜索' }
      }
      if (isTaobaoVerificationUrl(preparedUrl)) {
        showSearchWindow(state, '淘宝搜同款 - 请完成安全验证')
        return {
          success: false,
          needVerification: true,
          message: '淘宝要求安全验证，请在弹窗中完成后重新搜索'
        }
      }
    }

    const normalizedImageUrl = normalizeRemoteImageUrl(imageUrl)
    const imagePreparedAt = Date.now()
    const preparedImage = await prepareTaobaoSearchImage(ses, normalizedImageUrl)
    const imageBase64 = preparedImage.imageBase64
    runtimeLog.writeLog(
      'TaobaoSame',
      '图片准备完成: bytes=' + preparedImage.byteLength +
      ', mime=' + preparedImage.mimeType +
      ', cache=' + (preparedImage.cacheHit ? 'HIT' : 'MISS') +
      ', ms=' + (Date.now() - imagePreparedAt)
    )

    let lastMessage = ''
    let validationResetAttempted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await waitForTaobaoMtopToken(ses, attempt === 0 ? 1200 : 3500)
      const bixiTokens = state.bixiTokens || await waitForTaobaoPageBixiTokens(win, attempt === 0 ? 2500 : 4500)
      if (bixiTokens) state.bixiTokens = bixiTokens
      const request = buildTaobaoImageSearchRequest({ token, imageBase64, bixiTokens })
      const responseBody = await pageXhrPostAndCapture(win, request.url, request.body)
      const resultJson = parseMtopJson(responseBody)
      const retText = String(((resultJson.ret || [])[0] || ''))
      lastMessage = retText || '淘宝图片搜索失败'

      if (/RGV587|FAIL_SYS_USER_VALIDATE/i.test(retText)) {
        if (!validationResetAttempted) {
          validationResetAttempted = true
          runtimeLog.writeLog('TaobaoSame', '淘宝安全验证命中，重置搜索专用会话后重试')
          state = await resetTaobaoSearchWindow(accountId, state, retText.substring(0, 80))
          win = state.win
          ses = state.ses
          await sleep(800)
          continue
        }
        showSearchWindow(state, '淘宝搜同款 - 请完成安全验证')
        runtimeLog.writeLog('TaobaoSame', '淘宝要求安全验证，自动重置后仍未恢复')
        return {
          success: false,
          needVerification: true,
          message: '淘宝要求安全验证，请在弹窗中完成后重新搜索'
        }
      }

      if (/TOKEN_(?:EMPTY|EXPIRED|ILLEGAL)|SESSION_EXPIRED/i.test(retText)) {
        await sleep(300)
        await waitForTaobaoMtopToken(ses, 3500)
        continue
      }

      if (/FAIL_SYS_ILLEGAL_ACCESS/i.test(retText) && attempt < 2) {
        let pageHost = ''
        try { pageHost = new URL(win.webContents.getURL()).hostname } catch (_) {}
        runtimeLog.writeLog(
          'TaobaoSame',
          '检测到非法请求，重建搜索窗口后重试: attempt=' + (attempt + 1) +
          ', token=' + (token ? 'YES' : 'NO') + ', bixi=' + (bixiTokens ? 'YES' : 'NO') +
          ', pageHost=' + (pageHost || 'unknown')
        )
        state = await recreateTaobaoSearchWindow(accountId, state, attempt > 0)
        win = state.win
        ses = state.ses
        await sleep(attempt === 0 ? 600 : 1200)
        continue
      }

      if (/SUCCESS|调用成功|成功/i.test(retText)) {
        const rawItems = extractItemsArray(resultJson)
        const products = normalizeTaobaoSearchItems(rawItems, limit)
        if (products.length > 0) {
          state.firstSearchPrepared = true
          const pricedCount = products.filter(product => product.price !== null).length
          runtimeLog.writeLog('TaobaoSame', '搜同款成功: count=' + products.length + ', priced=' + pricedCount)
          if (pricedCount < products.length) {
            runtimeLog.writeLog('TaobaoSame', '未解析价格字段样例: ' + summarizeTaobaoPriceFields(rawItems))
          }
          return {
            success: true,
            items: products,
            products,
            source: 'taobao-mtop-hsq-34850'
          }
        }
        runtimeLog.writeLog(
          'TaobaoSame',
          '搜同款返回空结果: attempt=' + (attempt + 1) +
          ', response=' + summarizeTaobaoSearchResponse(resultJson, responseBody)
        )
        if (attempt < 2) {
          const delays = automatic ? [1500, 6000] : [500, 900]
          await sleep(delays[Math.min(attempt, delays.length - 1)])
          continue
        }
        runtimeLog.writeLog('TaobaoSame', '搜同款失败: 淘宝接口调用成功，但解析结果为空；未自动扩大请求次数')
        return {
          success: false,
          message: '淘宝接口调用成功，但未返回同款商品',
          error: '淘宝接口调用成功，但未返回同款商品'
        }
      }

      if (!token && attempt < 2) {
        await waitForTaobaoMtopToken(ses, 3500)
        continue
      }
      break
    }

    runtimeLog.writeLog('TaobaoSame', '搜同款失败: ' + lastMessage.substring(0, 160))
    return { success: false, message: lastMessage, error: lastMessage }
  })
}

function registerTaobaoSameSearchIpc() {
  ipcMain.handle('search-taobao-same-product', async (_event, params = {}) => {
    const accountId = params.accountId
    if (!accountId) return { success: false, message: '未找到可用的淘宝采购账号' }
    try {
      return await searchTaobaoImageDirect({
        accountId,
        imageUrl: params.imgUrl || params.imageUrl,
        limit: Math.min(Math.max(Number(params.limit) || 20, 1), 20),
        automatic: !!params.automatic
      })
    } catch (error) {
      runtimeLog.writeLog('TaobaoSame', '搜同款异常: ' + error.message)
      return { success: false, message: error.message, error: error.message }
    }
  })
  ipcMain.handle('open-taobao-same-product', async (event, params = {}) => {
    try {
      return await openTaobaoSameProductPage(params, event.sender)
    } catch (error) {
      runtimeLog.writeLog('TaobaoSame', '打开同款商品页异常: ' + error.message)
      return { success: false, message: error.message, error: error.message }
    }
  })
}

module.exports = {
  registerTaobaoSameSearchIpc,
  searchTaobaoImageDirect,
  normalizeRemoteImageUrl,
  normalizeTaobaoPriceValue,
  firstTaobaoPrice,
  normalizeTaobaoSearchItems,
  summarizeTaobaoSearchResponse,
  isTaobaoProductPageUrl,
  buildTaobaoSameSelection,
  buildTaobaoSameProductInjection,
  getTaobaoSamePartition,
  getTaobaoPurchasePartition,
  parseMtopJson,
  buildTaobaoImageSearchRequest,
  hasTaobaoLoginCookie,
  isTaobaoCookieDomain
}
