// 后端服务地址
const BASE_URL = 'http://150.158.54.108:3002'  // 远程服务器
// const BASE_URL = 'http://localhost:3002'  // 本地开发（调试用）

function isAuthSessionFailure(response, payload) {
  if (response?.status === 401) return true
  if (payload?.needsRelogin) return true
  const message = String(payload?.message || '')
  return payload?.code === 1 && /(?:未登录|token\s*(?:无效|失效|过期)|登录(?:状态|会话)?(?:已)?失效)/i.test(message)
}

function clearExpiredAuthSession(message) {
  localStorage.removeItem('accessToken')
  localStorage.removeItem('currentUser')
  localStorage.removeItem('userInfo')
  window.electronAPI?.invoke('set-auth-token', null).catch(() => {})
  window.dispatchEvent(new CustomEvent('force-logout', { detail: message }))
  window.location.hash = '#/login'
}

export async function request(url, options = {}) {
  const {
    method = 'GET', data, params, timeout = 10000, baseUrl,
    // Electron 页面可通过主进程代理发起请求，避免渲染进程的 CORS、网络服务
    // 或页面会话异常让接口明明有数据却显示为空。
    useMainProxy = false,
    // 内部标记：登录令牌切换后，GET 请求最多只自动重试一次。
    __authSessionRetried = false
  } = options

  let fullUrl = (baseUrl || BASE_URL) + url
  if (params) {
    const search = new URLSearchParams()
    Object.entries(params).forEach(([key, val]) => {
      if (val !== '' && val !== null && val !== undefined) {
        search.append(key, val)
      }
    })
    const qs = search.toString()
    if (qs) fullUrl += '?' + qs
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  const headers = { 'Content-Type': 'application/json' }
  // 固定记录本次请求使用的令牌。若请求过程中用户重新登录，旧请求的响应
  // 不能覆盖新会话页面状态，更不能用旧 401 清掉刚写入的新令牌。
  const requestToken = localStorage.getItem('accessToken') || ''
  if (requestToken) {
    headers['Authorization'] = `Bearer ${requestToken}`
  }

  const fetchOptions = {
    method,
    headers,
    signal: controller.signal
  }
  if (data && method !== 'GET') {
    fetchOptions.body = JSON.stringify(data)
  }

  try {
    let res
    let contentType = ''
    let responseText = ''

    if (useMainProxy && window.electronAPI?.invoke) {
      const proxyResult = await window.electronAPI.invoke('proxy-fetch', {
        url: fullUrl,
        method,
        headers,
        body: fetchOptions.body
      })
      res = { status: Number(proxyResult?.status || 0) }
      contentType = proxyResult?.headers?.['content-type'] || proxyResult?.headers?.['Content-Type'] || ''
      responseText = String(proxyResult?.data ?? '')
    } else {
      const fetchResponse = await fetch(fullUrl, fetchOptions)
      res = fetchResponse
      contentType = fetchResponse.headers.get('content-type') || ''
      responseText = await fetchResponse.text()
    }
    clearTimeout(timer)

    // 检查是否是 HTML 错误页面（如 502/503/504）
    if (contentType.includes('text/html')) {
      console.error('[API Error] 服务器返回 HTML:', responseText.substring(0, 200))
      throw new Error(`服务器返回异常 (HTTP ${res.status})，请检查后端服务是否正常运行`)
    }

    if (!contentType.includes('application/json')) {
      console.error('[API Error] 非 JSON 响应:', responseText.substring(0, 200))
      throw new Error('服务器返回异常，请检查后端服务是否正常运行')
    }

    const json = JSON.parse(responseText)
    const latestToken = localStorage.getItem('accessToken') || ''
    const authSessionChanged = latestToken !== requestToken

    if (method === 'GET' && authSessionChanged) {
      if (latestToken && !__authSessionRetried) {
        return request(url, { ...options, __authSessionRetried: true })
      }
      const err = new Error('登录账号已切换，本次旧请求结果已忽略')
      err.authSessionChanged = true
      err.httpStatus = res.status
      throw err
    }

    if (json.code !== 0) {
      // 被其他桌面端顶下线、令牌过期或服务端判定会话无效时，不能把错误响应
      // 当作业务数据继续展示，否则首页会一直保留上一次的 0。
      if (isAuthSessionFailure(res, json)) {
        // 非 GET 请求不自动重放，避免重复提交；但旧请求也绝不能清除新会话。
        if (authSessionChanged) {
          const err = new Error('登录账号已切换，本次旧请求已取消')
          err.authSessionChanged = true
          err.httpStatus = res.status
          throw err
        }
        clearExpiredAuthSession(json.message || '登录状态已失效，请重新登录')
        const err = new Error(json.message)
        err.needsRelogin = true
        err.httpStatus = res.status
        throw err
      }
      const err = new Error(json.message || '请求失败')
      err.code = json.code
      err.httpStatus = res.status
      if (json.needsRelogin) err.needsRelogin = true
      throw err
    }

    return json.data
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      throw new Error('请求超时，请检查业务服务器是否正常运行')
    }
    throw err
  }
}

export function get(url, params, baseUrl) {
  return request(url, { method: 'GET', params, baseUrl })
}

export function getThroughMain(url, params, baseUrl) {
  return request(url, { method: 'GET', params, baseUrl, useMainProxy: true })
}

export function post(url, data, timeout) {
  return request(url, { method: 'POST', data, timeout })
}

export function put(url, data, timeout) {
  return request(url, { method: 'PUT', data, timeout })
}

export function del(url, params) {
  return request(url, { method: 'DELETE', params })
}
