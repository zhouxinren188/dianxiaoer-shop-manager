const http = require('http')
const https = require('https')
const { session } = require('electron')
const { getAuthToken } = require('./auth-store')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const HEARTBEAT_INTERVAL = 5 * 60 * 1000 // 5 分钟
const FIRST_CHECK_DELAY = 10 * 1000 // 启动后 10 秒
const REQUEST_TIMEOUT = 10 * 1000

// 各平台心跳验证 URL
const HEARTBEAT_URLS = {
  taobao: 'https://myseller.taobao.com/home.htm',
  tmall: 'https://myseller.taobao.com/home.htm',
  jd: 'https://shop.jd.com/index.action',  // 京东商家后台首页
  pdd: 'https://mms.pinduoduo.com/home',
  douyin: 'https://fxg.jinritemai.com/ffa/mshop/homepage/overview'
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
      timeout: REQUEST_TIMEOUT,
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

// 从数据库查询店铺 Cookie 并恢复到 Electron session
async function restoreCookiesFromDB(storeId, { skipFlush = false } = {}) {
  try {
    const res = await httpRequest(`${BUSINESS_SERVER}/api/cookies/${storeId}`)
    if (res.statusCode !== 200) {
      console.log(`[Heartbeat] 数据库无Cookie记录 store_id=${storeId} (HTTP ${res.statusCode})`)
      return false
    }
    const json = JSON.parse(res.data)
    if (json.code !== 0 || !json.data || !json.data.cookie_data) {
      console.log(`[Heartbeat] 数据库Cookie记录为空 store_id=${storeId}`)
      return false
    }

    const dbCookies = typeof json.data.cookie_data === 'string'
      ? JSON.parse(json.data.cookie_data)
      : json.data.cookie_data

    if (!Array.isArray(dbCookies) || dbCookies.length === 0) {
      console.log(`[Heartbeat] 数据库Cookie数据为空数组 store_id=${storeId}`)
      return false
    }

    // 写入 Electron session
    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)

    let restored = 0
    for (const c of dbCookies) {
      if (!c.name || !c.domain) continue
      try {
        // ★ 修复：sameSite='no_restriction'(SameSite=None)必须搭配secure=true
        const sameSite = c.sameSite || undefined
        const secure = sameSite === 'no_restriction' ? true : !!c.secure
        const cookie = { url: buildCookieUrl(c), name: c.name, value: c.value || '', domain: c.domain, path: c.path || '/', secure }
        if (c.httpOnly) cookie.httpOnly = true
        if (sameSite) cookie.sameSite = sameSite
        if (c.expirationDate && c.expirationDate > 0) {
          cookie.expirationDate = c.expirationDate
        }
        await ses.cookies.set(cookie)
        restored++
      } catch (e) {
        console.warn(`[Heartbeat] Cookie写入失败: ${c.name} domain=${c.domain} sameSite=${c.sameSite} secure=${c.secure} err=${e.message}`)
      }
    }

    console.log(`[Heartbeat] 从数据库恢复Cookie store_id=${storeId} 成功=${restored}/${dbCookies.length}`)

    // 恢复后立即刷盘，确保 Cookie 持久化到磁盘
    // 否则 session 对象被 GC 后，下次 session.fromPartition() 从磁盘加载会丢失这些 Cookie
    // skipFlush: AutoSync 调用时跳过刷盘（Heartbeat 会定期刷盘），避免因 flushStorageData 卡死导致同步阻塞
    if (restored > 0 && !skipFlush) {
      try {
        await Promise.race([
          new Promise(resolve => ses.flushStorageData(resolve)),
          new Promise(resolve => setTimeout(resolve, 5000)) // 5秒超时，防止 flushStorageData 卡死
        ])
        console.log(`[Heartbeat] Cookie已刷盘 store_id=${storeId}`)
      } catch (flushErr) {
        console.warn(`[Heartbeat] Cookie刷盘超时或失败 store_id=${storeId}:`, flushErr?.message)
      }
    }

    return restored > 0
  } catch (err) {
    console.error(`[Heartbeat] 从数据库恢复Cookie失败 store_id=${storeId}:`, err.message)
    return false
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
async function checkSingleStore(storeId, platform, cookieData) {
  const heartbeatUrl = HEARTBEAT_URLS[platform]
  if (!heartbeatUrl) {
    console.log(`[Heartbeat] 未知平台: '${platform}'`)
    return null // 未知平台，跳过
  }

  const cookieHeader = cookiesToHeader(cookieData)
  if (!cookieHeader) {
    console.log(`[Heartbeat] Cookie解析失败 store_id=${storeId}`)
    return false // 无有效 Cookie
  }

  try {
    console.log(`[Heartbeat] 开始请求: ${heartbeatUrl}`)
    const res = await httpGet(heartbeatUrl, {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })
    console.log(`[Heartbeat] 响应状态: ${res.statusCode}`)

    // 302 重定向处理
    if (res.statusCode === 302 || res.statusCode === 301) {
      const location = res.headers.location || ''
      console.log(`[Heartbeat] store_id=${storeId} 重定向到: ${location.substring(0, 200)}`)
      // 所有平台：重定向到登录页 → 离线
      if (location.includes('login') || location.includes('passport') || location.includes('sign')) {
        console.log(`[Heartbeat] store_id=${storeId} 重定向到登录页 → 离线`)
        return false
      }
      // 京东：重定向到商家后台（非登录页） → 在线
      if (platform === 'jd') {
        // JD 有效会话访问 index.action 会被重定向到实际后台页面（如 /jdm/home）
        // 只有重定向到 passport.jd.com 才是 Cookie 失效
        if (location.includes('passport.jd.com') || location.includes('passport')) {
          console.log(`[Heartbeat] store_id=${storeId} JD重定向到passport → 离线`)
          return false
        }
        // 其他重定向（到商家后台页面）说明 Cookie 有效
        console.log(`[Heartbeat] store_id=${storeId} JD重定向到后台页面 → 在线`)
        return true
      }
      // 其他平台：非登录页的重定向视为在线（可能是正常的页面跳转）
      return true
    }

    // 401/403/404 = 离线（认证/权限/页面不存在）
    // JD 500 = 服务器临时故障，返回null（不确定）而非false（离线），因为Cookie元数据可能有效
    // 其他平台 500 = 离线
    if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 404) {
      return false
    }
    if (res.statusCode === 500) {
      if (platform === 'jd') {
        console.log(`[Heartbeat] store_id=${storeId} JD返回500（服务器临时故障），视为不确定`)
        return null
      }
      return false
    }

    // 200 状态码需要进一步验证
    if (res.statusCode === 200) {
      const body = res.data.toLowerCase()
      
      // 京东特殊处理：检测是否返回了错误页面或登录提示
      if (platform === 'jd') {
        if (body.includes('login') || 
            body.includes('passport.jd.com') ||
            body.includes('wlf-passport') ||
            body.includes('未登录') ||
            body.includes('请先登录')) {
          return false
        }
        
        if (body.includes('error') || body.includes('异常') || body.length < 1000) {
          return false
        }
      }
      
      // 通用检测：返回的是登录页面
      if (body.includes('login') && body.includes('password') && body.includes('form')) {
        return false
      }
      
      return true
    }

    return null // 其他状态码，不做判断
  } catch (err) {
    console.error(`[Heartbeat] 网络请求失败 store_id=${storeId}:`, err.message)
    return null // 网络错误，不更新状态
  }
}

async function checkAllStores(mainWindow) {
  try {
    // 获取所有店铺信息
    const res = await httpRequest(`${BUSINESS_SERVER}/api/stores`)
    const json = JSON.parse(res.data)
    if (json.code !== 0 || !json.data || !json.data.list) {
      console.log('[Heartbeat] 获取店铺列表失败:', json.message || '未知错误')
      return
    }

    const stores = json.data.list
    console.log(`[Heartbeat] 获取到 ${stores.length} 个店铺`)

    // 串行检测，避免并发风控
    for (const store of stores) {
      const storeId = store.id || store.store_id
      console.log(`[Heartbeat] 检测 store_id=${storeId} platform='${store.platform}'`)

      // 跳过正在同步的店铺，避免 Cookie 恢复干扰同步
      const isSyncing = global.__activeSyncStores && global.__activeSyncStores.has(storeId)
      let online
      if (isSyncing) {
        console.log(`[Heartbeat] store_id=${storeId} 正在同步中，跳过Cookie检查`)
        online = true  // 同步进行中说明Cookie有效
      } else {
        // 第一步：Cookie 元数据检查（名称、过期时间）
        const cookieCheck = await checkStoreSession(storeId, store.platform)
        if (!cookieCheck) {
          // Cookie 检查已判定离线，不需要再验证
          online = false
        } else {
          // 第二步：Cookie 元数据通过，HTTP 请求验证 Cookie 是否真的有效
          // JD 可能在服务端销毁了会话，即使 Cookie 本身过期时间未到
          const ses = session.fromPartition(`persist:platform-${storeId}`)
          const cookies = await ses.cookies.get({})
          const httpCheck = await checkSingleStore(storeId, store.platform, cookies)
          if (httpCheck === null) {
            // HTTP 验证无法完成（网络错误等），信任 Cookie 元数据检查结果
            console.log(`[Heartbeat] store_id=${storeId} HTTP验证无法完成，按Cookie元数据判定 → 在线`)
            online = true
          } else if (httpCheck === false) {
            // HTTP 验证判定离线 — 但需要区分是真的失效还是刚启动时网络/会话未就绪
            // 如果是首次检查且Cookie元数据通过，可能是会话还没加载完，暂判在线
            // 下一轮heartbeat（5分钟后）会再次验证
            if (isFirstCheck) {
              console.log(`[Heartbeat] store_id=${storeId} 首次检查HTTP验证失败，可能是会话未就绪，暂判 → 在线`)
              online = true
            } else {
              console.log(`[Heartbeat] store_id=${storeId} Cookie元数据有效但HTTP验证失败 → 离线`)
              online = false
            }
          } else {
            online = true
          }
        }
      }
      
      console.log(`[Heartbeat] store_id=${storeId} platform=${store.platform} online=${online}`)

      // 更新服务器状态
      try {
        await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ online })
        })
        console.log(`[Heartbeat] 已更新 store_id=${storeId} online=${online}`)
      } catch (e) {
        console.error(`[Heartbeat] 更新状态失败 store_id=${storeId}:`, e.message)
      }

      // 通知渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('store-status-changed', {
          storeId: storeId,
          online
        })
      }
    }
  } catch (err) {
    console.error('[Heartbeat] checkAllStores error:', err.message)
  }
}

let heartbeatTimer = null
let isFirstCheck = true

function startHeartbeat(mainWindow) {
  isFirstCheck = true
  // 首次延迟检测（必须await完成后再设置isFirstCheck=false，否则同步代码会在async函数启动后立即执行）
  setTimeout(async () => {
    await checkAllStores(mainWindow)
    isFirstCheck = false
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

module.exports = { startHeartbeat, stopHeartbeat, restoreCookiesFromDB }
