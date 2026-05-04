// 后端服务地址
const BASE_URL = 'http://150.158.54.108:3002'  // 远程服务器
// const BASE_URL = 'http://localhost:3002'  // 本地开发（调试用）

async function request(url, options = {}) {
  const { method = 'GET', data, params, timeout = 10000 } = options

  let fullUrl = BASE_URL + url
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
      // 401 未登录错误不抛出，由调用方处理
      if (json.code === 1 && json.message && json.message.includes('登录')) {
        return json
      }
      const err = new Error(json.message || '请求失败')
      err.code = json.code
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

export function get(url, params) {
  return request(url, { method: 'GET', params })
}

export function post(url, data, timeout) {
  return request(url, { method: 'POST', data, timeout })
}

export function put(url, data, timeout) {
  return request(url, { method: 'PUT', data, timeout })
}

export function del(url) {
  return request(url, { method: 'DELETE' })
}
