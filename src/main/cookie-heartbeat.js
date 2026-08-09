const http = require('http')
const https = require('https')
const { session } = require('electron')
const { getAuthToken } = require('./auth-store')
const runtimeLog = require('./runtime-logger')
const { getDeviceId, getShortDeviceId } = require('./device-identity')
const { getCookieRevision, setCookieRevision } = require('./cookie-revision-store')
const {
  fingerprintCookies,
  isJdCookie,
  parseCookieData,
  shortFingerprint
} = require('./store-cookie-utils')
const { parseJdVendorSessionResponse } = require('./jd-vendor-session')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const HEARTBEAT_INTERVAL = 5 * 60 * 1000 // 5 分钟
const FIRST_CHECK_DELAY = 10 * 1000 // 启动后 10 秒
const REQUEST_TIMEOUT = 10 * 1000
const JD_VENDOR_CHECK_TIMEOUT = 3 * 1000
const JD_VENDOR_LIST_URL = 'https://i.shop.jd.com/switch/vendor/list?appName=shop&callback=&v=5111'

// ★ 心跳状态追踪
// storeStatusMap: 记录每个店铺上次判定的在线状态，用于 httpCheck===null 时保持原状
// httpFailCount: 记录每个店铺连续HTTP验证失败的次数，连续2次失败才判定离线
const storeStatusMap = {}
const httpFailCount = {}
const lastRestoreTime = {} // storeId -> 上次从服务器恢复Cookie的时间戳
const RESTORE_RETRY_INTERVAL = 10 * 60 * 1000 // 10分钟内不重复恢复

function writeCookieDiagnostic(storeId, context, message) {
  const line = `store_id=${storeId} device=${getShortDeviceId()} context=${context} ${message}`
  console.log(`[CookieSync] ${line}`)
  runtimeLog.writeLog('COOKIE_SYNC', line)
}

function canRetryRestore(storeId) {
  const last = lastRestoreTime[storeId]
  if (!last) return true
  return Date.now() - last > RESTORE_RETRY_INTERVAL
}

// 各平台心跳验证 URL
const HEARTBEAT_URLS = {
  taobao: 'https://myseller.taobao.com/home.htm',
  tmall: 'https://myseller.taobao.com/home.htm',
  jd: JD_VENDOR_LIST_URL,  // 京东当前商家身份接口
  pdd: 'https://mms.pinduoduo.com/home',
  douyin: 'https://fxg.jinritemai.com/ffa/mshop/homepage/overview'
}

function httpGet(url, headers = {}, timeoutMs = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: false
    }

    const req = mod.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)

    // 自动附带 auth token
    const headers = { ...options.headers }
    const token = getAuthToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: REQUEST_TIMEOUT,
      rejectUnauthorized: false
    }

    const req = mod.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

// 将 Cookie 数组转为请求头字符串
function cookiesToHeader(cookies) {
  try {
    const parsed = typeof cookies === 'string' ? JSON.parse(cookies) : cookies
    if (!Array.isArray(parsed)) return ''
    return parsed.map(c => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

async function getServerCookieSnapshot(storeId, context = 'read') {
  const res = await httpRequest(`${BUSINESS_SERVER}/api/cookies/${storeId}`)
  if (res.statusCode !== 200) {
    writeCookieDiagnostic(storeId, context, `server_read=failed http=${res.statusCode}`)
    return null
  }
  const json = JSON.parse(res.data)
  const cookies = parseCookieData(json?.data?.cookie_data)
  if (json.code !== 0 || cookies.length === 0) {
    writeCookieDiagnostic(storeId, context, 'server_read=empty')
    return null
  }
  return {
    cookies,
    revision: Number(json.data.revision || 0),
    fingerprint: json.data.fingerprint || fingerprintCookies(cookies),
    sourceDeviceId: json.data.source_device_id || '',
    sourceType: json.data.source_type || 'legacy'
  }
}

async function applyServerCookieSnapshot(storeId, snapshot, { skipFlush = false, context = 'restore' } = {}) {
  const ses = session.fromPartition(`persist:platform-${storeId}`)
  const existing = await ses.cookies.get({})
  let removed = 0
  for (const cookie of existing) {
    try {
      await ses.cookies.remove(buildCookieUrl(cookie), cookie.name)
      removed++
    } catch {
      // 单个 Cookie 删除失败不阻断后续覆盖。
    }
  }

  let restored = 0
  for (const c of snapshot.cookies) {
    if (!c.name || !c.domain) continue
    try {
      const sameSite = c.sameSite || undefined
      const secure = sameSite === 'no_restriction' ? true : !!c.secure
      const cookie = {
        url: buildCookieUrl(c),
        name: c.name,
        value: c.value || '',
        domain: c.domain,
        path: c.path || '/',
        secure
      }
      if (c.httpOnly) cookie.httpOnly = true
      if (sameSite) cookie.sameSite = sameSite
      if (c.expirationDate && c.expirationDate > 0) cookie.expirationDate = c.expirationDate
      await ses.cookies.set(cookie)
      restored++
    } catch (error) {
      console.warn(`[Heartbeat] Cookie写入失败: ${c.name} domain=${c.domain} err=${error.message}`)
    }
  }

  if (restored > 0 && snapshot.revision > 0) setCookieRevision(storeId, snapshot.revision)
  writeCookieDiagnostic(
    storeId,
    context,
    `action=server_replace removed=${removed} restored=${restored}/${snapshot.cookies.length} server_rev=${snapshot.revision || 0} fp=${shortFingerprint(snapshot.fingerprint)} source=${snapshot.sourceType}`
  )

  if (restored > 0 && !skipFlush) {
    try {
      await Promise.race([
        new Promise(resolve => ses.flushStorageData(resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])
    } catch (error) {
      writeCookieDiagnostic(storeId, context, `flush=failed reason=${error.message}`)
    }
  }
  return restored > 0
}

// 从服务器查询店铺 Cookie，并先清理分区中的旧 Cookie 后完整恢复。
async function restoreCookiesFromDB(storeId, { skipFlush = false, context = 'restore' } = {}) {
  try {
    const snapshot = await getServerCookieSnapshot(storeId, context)
    if (!snapshot) return false
    return await applyServerCookieSnapshot(storeId, snapshot, { skipFlush, context })
  } catch (error) {
    writeCookieDiagnostic(storeId, context, `restore=failed reason=${error.message}`)
    return false
  }
}

// 同步前只在服务器版本明确更新时替换本地 Cookie；版本未知且内容不同时保留本地，交由真实请求验证。
async function refreshCookiesFromServerIfNewer(storeId, { skipFlush = true, context = 'precheck' } = {}) {
  try {
    const snapshot = await getServerCookieSnapshot(storeId, context)
    if (!snapshot) return { success: false, action: 'server_unavailable' }

    const ses = session.fromPartition(`persist:platform-${storeId}`)
    const localCookies = await ses.cookies.get({})
    const localJdCount = localCookies.filter(isJdCookie).length
    const localFingerprint = fingerprintCookies(localCookies)
    const localRevision = getCookieRevision(storeId)

    if (localJdCount === 0) {
      const restored = await applyServerCookieSnapshot(storeId, snapshot, { skipFlush, context })
      return { success: restored, action: 'restored_empty_local', serverRevision: snapshot.revision }
    }

    if (localFingerprint === snapshot.fingerprint) {
      if (snapshot.revision > 0) setCookieRevision(storeId, snapshot.revision)
      writeCookieDiagnostic(storeId, context, `action=already_current local_rev=${localRevision} server_rev=${snapshot.revision || 0} fp=${shortFingerprint(localFingerprint)} jd_count=${localJdCount}`)
      return { success: true, action: 'already_current', serverRevision: snapshot.revision }
    }

    if (localRevision > 0 && snapshot.revision > localRevision) {
      const restored = await applyServerCookieSnapshot(storeId, snapshot, { skipFlush, context })
      return { success: restored, action: 'restored_newer_server', serverRevision: snapshot.revision }
    }

    writeCookieDiagnostic(
      storeId,
      context,
      `action=keep_local_divergence local_rev=${localRevision} server_rev=${snapshot.revision || 0} local_fp=${shortFingerprint(localFingerprint)} server_fp=${shortFingerprint(snapshot.fingerprint)} jd_count=${localJdCount}`
    )
    return { success: true, action: 'kept_local_divergence', serverRevision: snapshot.revision }
  } catch (error) {
    writeCookieDiagnostic(storeId, context, `refresh=failed reason=${error.message}`)
    return { success: false, action: 'error' }
  }
}

// 根据 Cookie 的 domain 和 secure 属性构建 URL
function buildCookieUrl(c) {
  const secure = c.secure !== false && !c.domain.includes('localhost')
  const domain = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain
  return `${secure ? 'https' : 'http'}://${domain}${c.path || '/'}`
}

// 直接从 Electron session 检查店铺 Cookie 是否有效
async function checkStoreSession(storeId, platform) {
  try {
    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})
    
    console.log(`[Heartbeat] Session检查 store_id=${storeId} Cookie数量=${cookies.length}`)
    
    if (!cookies || cookies.length === 0) {
      // Session 无 Cookie，尝试从数据库恢复
      console.log(`[Heartbeat] store_id=${storeId} Session无Cookie，尝试从数据库恢复...`)
      const restored = await restoreCookiesFromDB(storeId)
      if (!restored) {
        console.log(`[Heartbeat] store_id=${storeId} 数据库也无Cookie → 离线`)
        return false
      }
      // 恢复后重新检查
      const restoredCookies = await ses.cookies.get({})
      if (!restoredCookies || restoredCookies.length === 0) {
        console.log(`[Heartbeat] store_id=${storeId} 恢复后仍无Cookie → 离线`)
        return false
      }
      console.log(`[Heartbeat] store_id=${storeId} 恢复后Cookie数量=${restoredCookies.length}，继续检查有效性`)
      return checkCookieValidity(storeId, restoredCookies)
    }

    return checkCookieValidity(storeId, cookies)
  } catch (err) {
    console.error(`[Heartbeat] Session检查失败 store_id=${storeId}:`, err.message)
    return false
  }
}

// 检查 Cookie 有效性（从 checkStoreSession 抽取）
function checkCookieValidity(storeId, cookies) {
  // 检查是否有京东相关的Cookie
  const jdCookies = cookies.filter(c => 
    c.domain && (c.domain.includes('jd.com') || c.domain.includes('jd.hk'))
  )

  console.log(`[Heartbeat] store_id=${storeId} 京东Cookie数量=${jdCookies.length}`)

  if (jdCookies.length === 0) {
    // 没有京东Cookie，尝试从数据库恢复
    console.log(`[Heartbeat] store_id=${storeId} Session有Cookie但无京东Cookie，尝试从数据库恢复...`)
    return false
  }

  // 诊断：打印所有京东 Cookie 的名称、域名、过期时间
  const now = Math.floor(Date.now() / 1000)
  const jdCookieSummary = jdCookies.map(c => {
    const exp = c.expirationDate ? (c.expirationDate > 0 ? (c.expirationDate < now ? '已过期' : `还剩${Math.round((c.expirationDate - now) / 3600)}h`) : '会话级') : '无过期'
    return `${c.name}(${c.domain}, ${exp})`
  }).join(', ')
  console.log(`[Heartbeat] store_id=${storeId} Cookie详情: ${jdCookieSummary}`)

  // 京东登录凭证 Cookie 名称
  const KEY_COOKIE_NAMES = ['pt_key', 'pt_pin', 'thor', 'pinId', 'pin', 'CookieJD']
  const keyCookies = jdCookies.filter(c => KEY_COOKIE_NAMES.includes(c.name))

  console.log(`[Heartbeat] store_id=${storeId} 关键登录Cookie: ${keyCookies.length}个`, keyCookies.map(c => c.name).join(', ') || '(无)')

  if (keyCookies.length === 0) {
    // 没有找到关键登录Cookie（thor/pin等），说明登录已失效
    // 即使有其他跟踪Cookie（shop_monkey、__jda等），也无法访问商家后台
    console.log(`[Heartbeat] store_id=${storeId} 关键登录Cookie不存在 → 离线`)
    return false
  }

  const keyExpired = keyCookies.some(c => 
    c.expirationDate && c.expirationDate > 0 && c.expirationDate < now
  )

  if (keyExpired) {
    console.log(`[Heartbeat] store_id=${storeId} 关键登录Cookie已过期 → 离线`)
    return false
  }

  console.log(`[Heartbeat] store_id=${storeId} 关键Cookie有效 → 在线`)
  return true
}

// 检测单个店铺的在线状态
async function checkSingleStore(storeId, platform, cookieData, expectedMerchantId = '') {
  const heartbeatUrl = HEARTBEAT_URLS[platform]
  if (!heartbeatUrl) {
    console.log(`[Heartbeat] 未知平台: '${platform}'`)
    return { valid: null, reason: 'unsupported_platform' } // 未知平台，跳过
  }

  const cookieHeader = cookiesToHeader(cookieData)
  if (!cookieHeader) {
    console.log(`[Heartbeat] Cookie解析失败 store_id=${storeId}`)
    return { valid: false, reason: 'cookie_header_empty' }
  }

  try {
    console.log(`[Heartbeat] 开始请求: ${heartbeatUrl}`)
    const res = await httpGet(heartbeatUrl, {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': platform === 'jd' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
      'Referer': platform === 'jd' ? 'https://shop.jd.com/' : heartbeatUrl
    }, platform === 'jd' ? JD_VENDOR_CHECK_TIMEOUT : REQUEST_TIMEOUT)
    console.log(`[Heartbeat] 响应状态: ${res.statusCode}`)

    if (platform === 'jd') {
      const result = parseJdVendorSessionResponse({
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.data,
        expectedMerchantId
      })
      const safeVendorName = String(result.vendorName || '').replace(/[\r\n\t]+/g, ' ').slice(0, 80)
      const detail = [
        `result=${result.valid === true ? 'valid' : result.valid === false ? 'invalid' : 'uncertain'}`,
        `reason=${result.reason}`,
        result.vendorId ? `vendor_id=${result.vendorId}` : '',
        result.expectedMerchantId ? `expected_vendor_id=${result.expectedMerchantId}` : '',
        safeVendorName ? `vendor_name=${safeVendorName}` : ''
      ].filter(Boolean).join(' ')
      runtimeLog.writeLog('JD_VENDOR_CHECK', `store_id=${storeId} ${detail}`)
      return result
    }

    // 302 重定向处理
    if (res.statusCode === 302 || res.statusCode === 301) {
      const location = res.headers.location || ''
      console.log(`[Heartbeat] store_id=${storeId} 重定向到: ${location.substring(0, 200)}`)
      runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} ${res.statusCode}重定向 → ${location.substring(0, 150)}`)
      // 所有平台：重定向到登录页 → 离线
      if (location.includes('login') || location.includes('passport') || location.includes('sign')) {
        console.log(`[Heartbeat] store_id=${storeId} 重定向到登录页 → 离线`)
        runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} 重定向到登录页 → 离线`)
        return { valid: false, reason: 'login_redirect' }
      }
      // 其他平台：非登录页的重定向视为在线（可能是正常的页面跳转）
      return { valid: true, reason: 'non_login_redirect' }
    }

    // 其他平台沿用原有页面检测逻辑。
    if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404) {
      runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} HTTP ${res.statusCode} → 离线`)
      return { valid: false, reason: `http_${res.statusCode}` }
    }
    if (res.statusCode === 500) {
      return { valid: false, reason: 'http_500' }
    }

    // 200 状态码需要进一步验证
    if (res.statusCode === 200) {
      const body = res.data.toLowerCase()

      // 通用检测：返回的是登录页面
      if (body.includes('login') && body.includes('password') && body.includes('form')) {
        return { valid: false, reason: 'login_response' }
      }

      return { valid: true, reason: 'http_200' }
    }

    runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} 未知状态码 ${res.statusCode} → null`)
    return { valid: null, reason: `http_${res.statusCode}` }
  } catch (err) {
    console.error(`[Heartbeat] 网络请求失败 store_id=${storeId}:`, err.message)
    const reason = err.message === 'timeout' ? 'timeout' : 'network_error'
    if (platform === 'jd') {
      runtimeLog.writeLog('JD_VENDOR_CHECK', `store_id=${storeId} result=uncertain reason=${reason}`)
    } else {
      runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} 网络请求失败: ${err.message} → null`)
    }
    return { valid: null, reason } // 网络错误，不更新状态
  }
}

// 仅允许基于已知服务器版本上传；显式登录捕获可直接提升为新版本。
async function uploadCookiesToServer(storeId, platform, cookies, {
  sourceType = 'heartbeat',
  verified = true,
  context = 'heartbeat_upload'
} = {}) {
  try {
    const localFingerprint = fingerprintCookies(cookies)
    let baseRevision = getCookieRevision(storeId)

    if (sourceType === 'heartbeat' && baseRevision <= 0) {
      const snapshot = await getServerCookieSnapshot(storeId, context)
      if (snapshot && snapshot.fingerprint === localFingerprint) {
        if (snapshot.revision > 0) setCookieRevision(storeId, snapshot.revision)
        writeCookieDiagnostic(storeId, context, `action=skip_same_server server_rev=${snapshot.revision || 0} fp=${shortFingerprint(localFingerprint)}`)
        return { success: true, updated: false, revision: snapshot.revision || 0 }
      }
      // 数据库迁移后的 legacy 基线没有设备版本关系；允许首台真实验证成功的新版客户端接管一次。
      if (snapshot?.sourceType === 'legacy' && snapshot.revision > 0) {
        baseRevision = snapshot.revision
        writeCookieDiagnostic(storeId, context, `action=adopt_legacy_base server_rev=${snapshot.revision} local_fp=${shortFingerprint(localFingerprint)} server_fp=${shortFingerprint(snapshot.fingerprint)}`)
      } else {
        writeCookieDiagnostic(storeId, context, `action=skip_unknown_base server_rev=${snapshot?.revision || 0} source=${snapshot?.sourceType || 'none'} local_fp=${shortFingerprint(localFingerprint)} server_fp=${shortFingerprint(snapshot?.fingerprint)}`)
        return { success: false, skipped: true, reason: 'unknown_base_revision' }
      }
    }

    const cookieData = JSON.stringify(cookies)
    const response = await httpRequest(`${BUSINESS_SERVER}/api/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: storeId,
        cookie_data: cookieData,
        domain: platform,
        device_id: getDeviceId(),
        source_type: sourceType,
        base_revision: baseRevision,
        verified
      })
    })
    let body = null
    try { body = JSON.parse(response.data || '{}') } catch { /* ignore */ }

    if (response.statusCode === 200 && body?.code === 0) {
      const revision = Number(body.data?.revision || 0)
      if (revision > 0) setCookieRevision(storeId, revision)
      writeCookieDiagnostic(storeId, context, `upload=accepted source=${sourceType} base_rev=${baseRevision} new_rev=${revision} updated=${body.data?.updated === true} count=${cookies.length} fp=${shortFingerprint(localFingerprint)}`)
      return { success: true, ...body.data }
    }

    if (response.statusCode === 409) {
      writeCookieDiagnostic(storeId, context, `upload=rejected_stale source=${sourceType} base_rev=${baseRevision} server_rev=${Number(body?.data?.current_revision || 0)} count=${cookies.length} fp=${shortFingerprint(localFingerprint)}`)
      return { success: false, conflict: true, currentRevision: Number(body?.data?.current_revision || 0) }
    }

    // 兼容尚未部署版本接口的旧服务端：200 且 code=0 已在上方处理，data 可能只是 true。
    writeCookieDiagnostic(storeId, context, `upload=failed source=${sourceType} http=${response.statusCode} message=${body?.message || 'unknown'}`)
    return { success: false, reason: body?.message || `HTTP ${response.statusCode}` }
  } catch (error) {
    writeCookieDiagnostic(storeId, context, `upload=error source=${sourceType} reason=${error.message}`)
    return { success: false, reason: error.message }
  }
}

// ★ 清空本地Cookie并从服务器恢复最新Cookie后重试验证
async function clearAndRetryWithFreshCookies(storeId, platform, expectedMerchantId = '') {
  try {
    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)

    writeCookieDiagnostic(storeId, 'forced_recovery', 'phase=start')

    // restoreCookiesFromDB 内部会先清理分区，避免同名旧 Cookie 与服务器版本并存。
    const restored = await restoreCookiesFromDB(storeId, { context: 'forced_recovery' })
    if (!restored) {
      writeCookieDiagnostic(storeId, 'forced_recovery', 'result=server_restore_failed')
      return false
    }

    // 3. 用恢复的Cookie重试验证
    const freshCookies = await ses.cookies.get({})
    if (!freshCookies || freshCookies.length === 0) return false

    // 京东由商家身份接口作权威判断，不再依赖固定的关键 Cookie 名称。
    if (platform !== 'jd') {
      const metaCheck = checkCookieValidity(storeId, freshCookies)
      if (!metaCheck) return false
    }

    // HTTP验证
    const requestCookies = platform === 'jd'
      ? await ses.cookies.get({ url: JD_VENDOR_LIST_URL })
      : freshCookies
    const checkResult = await checkSingleStore(storeId, platform, requestCookies, expectedMerchantId)
    if (checkResult.valid === true) {
      await uploadCookiesToServer(storeId, platform, freshCookies, {
        sourceType: 'recovery_verified',
        verified: true,
        context: 'forced_recovery'
      })
      writeCookieDiagnostic(storeId, 'forced_recovery', `result=verified_online revision=${getCookieRevision(storeId)}`)
      return true
    }
    if (checkResult.valid === null) {
      writeCookieDiagnostic(storeId, 'forced_recovery', `result=verification_uncertain reason=${checkResult.reason}`)
      return null
    }
    writeCookieDiagnostic(storeId, 'forced_recovery', `result=verification_failed reason=${checkResult.reason}`)
    return false
  } catch (error) {
    writeCookieDiagnostic(storeId, 'forced_recovery', `result=exception reason=${error.message}`)
    return false
  }
}

async function reportStoreDeviceStatus(storeId, {
  online,
  verified = false,
  reason = '',
  context = 'heartbeat'
}) {
  const payload = {
    device_id: getDeviceId(),
    online: !!online,
    verified: !!verified,
    reason,
    cookie_revision: getCookieRevision(storeId)
  }
  try {
    const response = await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/device-status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    let body = null
    try { body = JSON.parse(response.data || '{}') } catch { /* ignore */ }
    if (response.statusCode === 200 && body?.code === 0) {
      const overallOnline = body.data?.overall_online !== false
      writeCookieDiagnostic(storeId, context, `device_status=reported local_online=${!!online} verified=${!!verified} overall_online=${overallOnline} active_devices=${Number(body.data?.active_device_count || 0)} reason=${reason || 'none'} revision=${payload.cookie_revision}`)
      return { success: true, overallOnline }
    }

    // 新服务端未部署时兼容旧状态接口；部署后不会进入此分支。
    if (response.statusCode === 404) {
      const legacy = await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ online: !!online })
      })
      writeCookieDiagnostic(storeId, context, `device_status=legacy_fallback http=${legacy.statusCode} local_online=${!!online}`)
      return { success: legacy.statusCode === 200, overallOnline: !!online, legacy: true }
    }
    writeCookieDiagnostic(storeId, context, `device_status=failed http=${response.statusCode} message=${body?.message || 'unknown'}`)
  } catch (error) {
    writeCookieDiagnostic(storeId, context, `device_status=error reason=${error.message}`)
  }
  return { success: false, overallOnline: !!online }
}

async function checkAllStores(mainWindow) {
  try {
    // 获取所有店铺信息（★ 必须传 pageSize=1000，否则默认只返回10条，导致后面的店铺漏检）
    const res = await httpRequest(`${BUSINESS_SERVER}/api/stores?pageSize=1000&status=enabled`)
    const json = JSON.parse(res.data)
    if (json.code !== 0 || !json.data || !json.data.list) {
      console.log('[Heartbeat] 获取店铺列表失败:', json.message || '未知错误')
      return
    }

    const stores = json.data.list
    console.log(`[Heartbeat] 获取到 ${stores.length} 个店铺`)

    // ★ 初始化：用服务器上的当前在线状态填充 storeStatusMap
    // 这样首次检查遇到 httpCheck===null 时，可以用服务器的已知状态作为"之前状态"
    // 避免在HTTP验证不可用时盲目默认为在线
    for (const store of stores) {
      const storeId = store.id || store.store_id
      if (storeStatusMap[storeId] === undefined && store.online !== undefined) {
        storeStatusMap[storeId] = !!store.online
      }
    }

    // 串行检测，避免并发风控
    for (const store of stores) {
      const storeId = store.id || store.store_id
      const storeName = store.name || ''
      console.log(`[Heartbeat] 检测 store_id=${storeId} platform='${store.platform}'`)

      // 跳过正在同步的店铺，避免 Cookie 恢复干扰同步
      const isSyncing = global.__activeSyncStores && global.__activeSyncStores.has(storeId)
      let online
      let verified = false
      let statusReason = ''
      if (isSyncing) {
        console.log(`[Heartbeat] store_id=${storeId} 正在同步中，跳过Cookie检查`)
        online = true  // 同步进行中说明Cookie有效
        statusReason = 'sync_in_progress'
      } else {
        if (store.platform === 'jd') {
          await refreshCookiesFromServerIfNewer(storeId, {
            skipFlush: true,
            context: 'heartbeat_precheck'
          })
        }
        // 京东不再依赖固定 Cookie 名称；只要分区里有京东 Cookie，就交给商家身份接口权威判断。
        // 其他平台暂时沿用原有元数据检查。
        let cookieCheck
        if (store.platform === 'jd') {
          const jdSession = session.fromPartition(`persist:platform-${storeId}`)
          const sessionCookies = await jdSession.cookies.get({ url: JD_VENDOR_LIST_URL })
          cookieCheck = sessionCookies.some(isJdCookie)
          if (!cookieCheck) {
            runtimeLog.writeLog('JD_VENDOR_CHECK', `store_id=${storeId} result=invalid reason=no_jd_cookie`)
          }
        } else {
          cookieCheck = await checkStoreSession(storeId, store.platform)
        }
        if (!cookieCheck) {
          // Cookie 检查已判定离线，不需要再验证
          online = false
          statusReason = 'cookie_metadata_invalid'
          httpFailCount[storeId] = 0 // Cookie元数据已失败，重置HTTP失败计数
        } else {
          // 第二步：Cookie 元数据通过，HTTP 请求验证 Cookie 是否真的有效
          // JD 可能在服务端销毁了会话，即使 Cookie 本身过期时间未到
          const ses = session.fromPartition(`persist:platform-${storeId}`)
          const cookies = await ses.cookies.get({})
          const requestCookies = store.platform === 'jd'
            ? await ses.cookies.get({ url: JD_VENDOR_LIST_URL })
            : cookies
          const checkResult = await checkSingleStore(
            storeId,
            store.platform,
            requestCookies,
            store.platform === 'jd' ? store.merchant_id : ''
          )

          if (checkResult.valid === true) {
            // HTTP验证通过 → 在线
            online = true
            verified = true
            statusReason = checkResult.reason || 'http_verified'
            httpFailCount[storeId] = 0
            delete lastRestoreTime[storeId]
            await uploadCookiesToServer(storeId, store.platform, cookies, {
              sourceType: 'heartbeat',
              verified: true,
              context: 'heartbeat_verified'
            })
          } else if (checkResult.valid === false) {
            // HTTP验证明确判定离线 → 累计连续失败次数
            httpFailCount[storeId] = (httpFailCount[storeId] || 0) + 1
            if (httpFailCount[storeId] >= 2) {
              // 这是恢复服务器 Cookie 前的中间状态，并非最终离线结论。
              console.log(`[Heartbeat] store_id=${storeId} 连续${httpFailCount[storeId]}次HTTP验证失败 → 准备恢复服务器Cookie`)
              runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} 连续${httpFailCount[storeId]}次HTTP验证失败 → 准备恢复服务器Cookie`)
              online = false
              statusReason = `consecutive_${checkResult.reason || 'http_failure'}`
            } else {
              // 首次HTTP验证失败，可能是临时网络波动，保持之前的状态
              const prevStatus = storeStatusMap[storeId]
              if (prevStatus !== undefined) {
                online = prevStatus
                statusReason = `first_${checkResult.reason || 'http_failure'}_keep_previous`
                console.log(`[Heartbeat] store_id=${storeId} HTTP验证首次失败，保持之前状态: ${online ? '在线' : '离线'}`)
              } else {
                // 没有之前的状态记录（首次检查），暂判在线，下次检查会再次验证
                online = true
                statusReason = `first_${checkResult.reason || 'http_failure'}_no_history`
                console.log(`[Heartbeat] store_id=${storeId} HTTP验证首次失败，无历史状态，暂判 → 在线`)
              }
            }
          } else {
            // 检测无法完成（网络错误、接口500、响应结构变化等）
            // ★ 旧逻辑直接信任Cookie元数据判在线，这是"百顺仓"等失效店铺误判在线的主因
            // 新逻辑：保持之前的状态不变，不做任何假设
            const prevStatus = storeStatusMap[storeId]
            if (prevStatus !== undefined) {
              online = prevStatus
              statusReason = `${checkResult.reason || 'http_uncertain'}_keep_previous`
              console.log(`[Heartbeat] store_id=${storeId} HTTP验证无法完成，保持之前状态: ${online ? '在线' : '离线'}`)
              runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} HTTP验证无法完成(null)，保持之前状态: ${online ? '在线' : '离线'}`)
            } else {
              // 首次检查且网络不可用，信任Cookie元数据（下次检查会再次验证）
              online = true
              statusReason = `${checkResult.reason || 'http_uncertain'}_no_history`
              console.log(`[Heartbeat] store_id=${storeId} HTTP验证无法完成，无历史状态，按Cookie元数据判定 → 在线`)
              runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} HTTP验证无法完成(null)，无历史状态，暂判在线`)
            }
          }
        }
      }

      // ★ 即将标记离线时，尝试从服务器恢复最新Cookie（其他电脑可能已上传新Cookie）
      if (!online && !isSyncing && canRetryRestore(storeId)) {
        console.log(`[Heartbeat] store_id=${storeId} 即将标记离线，尝试从服务器恢复最新Cookie...`)
        const retryResult = await clearAndRetryWithFreshCookies(
          storeId,
          store.platform,
          store.platform === 'jd' ? store.merchant_id : ''
        )
        if (retryResult === true) {
          online = true
          verified = true
          statusReason = 'server_cookie_recovery_verified'
          httpFailCount[storeId] = 0
          console.log(`[Heartbeat] store_id=${storeId} 从服务器恢复Cookie后验证通过 → 在线`)
        } else if (retryResult === false) {
          statusReason = 'server_cookie_recovery_failed'
          console.log(`[Heartbeat] store_id=${storeId} 恢复Cookie后仍验证失败 → 离线`)
        } else {
          const prevStatus = storeStatusMap[storeId]
          online = prevStatus !== undefined ? prevStatus : true
          statusReason = 'server_cookie_recovery_uncertain_keep_previous'
          runtimeLog.writeLog('HEARTBEAT', `store_id=${storeId} 恢复Cookie后身份接口结果不确定，保持之前状态: ${online ? '在线' : '离线'}`)
        }
        lastRestoreTime[storeId] = Date.now()
      }

      // 先记录旧的总体状态，用于前端判断在线→离线转场。
      const wasOnline = storeStatusMap[storeId]
      const statusResult = await reportStoreDeviceStatus(storeId, {
        online,
        verified,
        reason: statusReason,
        context: 'heartbeat_status'
      })
      online = statusResult.overallOnline
      storeStatusMap[storeId] = online

      console.log(`[Heartbeat] store_id=${storeId} platform=${store.platform} overallOnline=${online} localVerified=${verified} reason=${statusReason} httpFailCount=${httpFailCount[storeId] || 0}`)

      // 通知渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('store-status-changed', {
          storeId: storeId,
          storeName: storeName,
          online,
          wasOnline  // undefined=首次检测, true=之前在线, false=之前离线
        })
      }
    }
  } catch (err) {
    console.error('[Heartbeat] checkAllStores error:', err.message)
  }
}

let heartbeatTimer = null

function startHeartbeat(mainWindow) {
  // 启动时清空状态追踪（避免残留旧状态）
  Object.keys(storeStatusMap).forEach(k => delete storeStatusMap[k])
  Object.keys(httpFailCount).forEach(k => delete httpFailCount[k])

  // 首次延迟检测
  setTimeout(async () => {
    await checkAllStores(mainWindow)
  }, FIRST_CHECK_DELAY)

  // 定时检测
  heartbeatTimer = setInterval(() => {
    checkAllStores(mainWindow)
  }, HEARTBEAT_INTERVAL)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

module.exports = {
  startHeartbeat,
  stopHeartbeat,
  restoreCookiesFromDB,
  refreshCookiesFromServerIfNewer,
  recoverStoreSessionFromServer: clearAndRetryWithFreshCookies,
  reportStoreDeviceStatus,
  uploadCookiesToServer
}
