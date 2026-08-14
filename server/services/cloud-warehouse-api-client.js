const https = require('https')

const DEFAULT_BASE_URL = 'https://150.158.54.108:3443'
const MAX_RESPONSE_BYTES = 128 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 1000

function clientError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function assertBaseUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value || DEFAULT_BASE_URL))
  } catch {
    throw clientError('cloud_api_config_invalid', '云仓助手接口基础地址无效')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw clientError('cloud_api_config_invalid', '云仓助手接口必须使用不含凭据和参数的 HTTPS 基础地址')
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  return parsed
}

function getConfig(env = process.env) {
  const baseUrl = assertBaseUrl(env.CLOUD_WAREHOUSE_API_BASE_URL || DEFAULT_BASE_URL)
  const timeoutMs = Number(env.CLOUD_WAREHOUSE_API_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw clientError('cloud_api_config_invalid', '云仓助手接口超时配置必须在1至30秒之间')
  }
  return { baseUrl, timeoutMs }
}

function parseResponseBody(buffer, statusCode) {
  if (!buffer.length) return {}
  try {
    const parsed = JSON.parse(buffer.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    return parsed
  } catch {
    throw clientError('cloud_api_invalid_response', `云仓助手返回了无效响应 (HTTP ${statusCode})`)
  }
}

function createRequest(config) {
  return function requestJson(method, pathname, body, expectedStatuses) {
    const target = new URL(pathname, config.baseUrl)
    if (target.origin !== config.baseUrl.origin || !target.pathname.startsWith('/api/cloud-warehouse/v1/')) {
      return Promise.reject(clientError('cloud_api_path_invalid', '云仓助手接口路径不在固定白名单中'))
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')

    return new Promise((resolve, reject) => {
      const request = https.request(target, {
        method,
        // 使用 Node.js 标准 CA 信任链，并保留默认主机身份校验。
        // 当基础地址是 IP 时，默认校验要求证书 subjectAltName 包含该 IP。
        rejectUnauthorized: true,
        headers: {
          Accept: 'application/json',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length)
          } : {})
        }
      }, response => {
        const chunks = []
        let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(clientError('cloud_api_response_too_large', '云仓助手响应体积超过安全限制'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            const statusCode = Number(response.statusCode || 0)
            const responseBody = parseResponseBody(Buffer.concat(chunks), statusCode)
            if (!expectedStatuses.includes(statusCode)) {
              const message = String(responseBody.message || responseBody.error || `HTTP ${statusCode}`).slice(0, 500)
              return reject(clientError('cloud_api_request_failed', `云仓助手接口请求失败：${message}`, {
                httpStatus: statusCode,
                responseBody
              }))
            }
            resolve({ httpStatus: statusCode, body: responseBody })
          } catch (error) {
            reject(error)
          }
        })
      })
      request.setTimeout(config.timeoutMs, () => {
        request.destroy(clientError('cloud_api_timeout', '云仓助手接口请求超时，结果状态未知'))
      })
      request.on('error', error => {
        if (error?.code?.startsWith?.('cloud_api_')) return reject(error)
        reject(clientError('cloud_api_unavailable', '无法安全连接云仓助手服务器', { cause: error }))
      })
      if (payload) request.write(payload)
      request.end()
    })
  }
}

function createCloudWarehouseApiClient({ env = process.env, requestJson } = {}) {
  const config = requestJson ? null : getConfig(env)
  const request = requestJson || createRequest(config)
  return {
    getMachineStatus(machineCode) {
      return request('GET', `/api/cloud-warehouse/v1/machines/${encodeURIComponent(machineCode)}/status`, undefined, [200])
    },
    submitCommand(command) {
      return request('POST', '/api/cloud-warehouse/v1/commands', command, [200, 202])
    },
    getCommandResult(requestId) {
      return request('GET', `/api/cloud-warehouse/v1/commands/${encodeURIComponent(requestId)}`, undefined, [200, 202])
    }
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  createCloudWarehouseApiClient,
  getConfig
}
