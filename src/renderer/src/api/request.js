const BASE_URL = 'http://150.158.54.108:3002'

async function request(url, options = {}) {
  const { method = 'GET', data, params } = options

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

  const fetchOptions = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (data && method !== 'GET') {
    fetchOptions.body = JSON.stringify(data)
  }

  const res = await fetch(fullUrl, fetchOptions)
  const json = await res.json()

  if (json.code !== 0) {
    throw new Error(json.message || '请求失败')
  }
  return json.data
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
