// 后端服务地址（远程服务器）
const BASE_URL = 'http://150.158.54.108:3002'

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
    const responseText = await res.text()

    if (!contentType.includes('application/json')) {
      throw new Error('服务器返回异常，请检查后端服务是否正常运行')
    }

    const json = JSON.parse(responseText)

    if (json.code !== 0) {
      throw new Error(json.message || '请求失败')
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

export function post(url, data) {
  return request(url, { method: 'POST', data })
}

export function put(url, data) {
  return request(url, { method: 'PUT', data })
}

export function del(url) {
  return request(url, { method: 'DELETE' })
}
