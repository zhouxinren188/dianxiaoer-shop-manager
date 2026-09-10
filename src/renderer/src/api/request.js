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

async function request(url, options = {}) {
  const { method = 'GET', data, params, timeout = 10000, baseUrl } = options

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
  const token = localStorage.getItem('accessToken')
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
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
    const res = await fetch(fullUrl, fetchOptions)
    clearTimeout(timer)

    const contentType = res.headers.get('content-type') || ''

    // 检查是否是 HTML 错误页面（如 502/503/504）
    if (contentType.includes('text/html')) {
      const htmlText = await res.text()
      console.error('[API Error] 服务器返回 HTML:', htmlText.substring(0, 200))
      throw new Error(`服务器返回异常 (HTTP ${res.status})，请检查后端服务是否正常运行`)
    }

    const responseText = await res.text()

    if (!contentType.includes('application/json')) {
      console.error('[API Error] 非 JSON 响应:', responseText.substring(0, 200))
      throw new Error('服务器返回异常，请检查后端服务是否正常运行')
    }

    const json = JSON.parse(responseText)

    if (json.code !== 0) {
      // 被其他桌面端顶下线、令牌过期或服务端判定会话无效时，不能把错误响应
      // 当作业务数据继续展示，否则首页会一直保留上一次的 0。
      if (isAuthSessionFailure(res, json)) {
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

export function post(url, data, timeout) {
  return request(url, { method: 'POST', data, timeout })
}

export function put(url, data, timeout) {
  return request(url, { method: 'PUT', data, timeout })
}

export function del(url, params) {
  return request(url, { method: 'DELETE', params })
}
