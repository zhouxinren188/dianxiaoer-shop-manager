'use strict'

const https = require('https')

const DEFAULT_REBATE_API_URL = 'https://xjs.xiongmsx.com/api/open/convertUrl'
const TAOBAO_HOST_SUFFIXES = ['taobao.com', 'tmall.com', 'tb.cn']

function getTaobaoRebateConfig(env = process.env) {
  const timeout = Number.parseInt(env.TAOBAO_REBATE_TIMEOUT_MS, 10)
  return {
    providerUrl: String(env.TAOBAO_REBATE_API_URL || DEFAULT_REBATE_API_URL).trim(),
    apiKey: String(env.TAOBAO_REBATE_API_KEY || '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 10000
  }
}

function normalizeHttpUrl(input) {
  const value = String(input || '').trim()
  if (!value) throw new Error('淘宝商品链接不能为空')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('淘宝商品链接格式无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('淘宝商品链接协议无效')
  }
  return parsed.toString()
}

function isTaobaoUrl(input) {
  try {
    const hostname = new URL(input).hostname.toLowerCase()
    return TAOBAO_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

function isNoCommissionMessage(message) {
  return /(无返利|无佣金|不支持返利)/.test(String(message || ''))
}

function extractConvertedUrl(responseData) {
  const data = responseData && responseData.data
  const candidate = typeof data === 'string'
    ? data
    : data && typeof data === 'object'
      ? (data.url || data.clickUrl || data.shortUrl || data.couponUrl || '')
      : ''
  return normalizeHttpUrl(candidate)
}

function postJson(urlString, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    if (url.protocol !== 'https:') return reject(new Error('返利接口必须使用 HTTPS'))
    const payload = JSON.stringify(body)
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, response => {
      let responseText = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        responseText += chunk
        if (responseText.length > 1024 * 1024) request.destroy(new Error('返利接口响应过大'))
      })
      response.on('end', () => {
        let data = null
        try {
          data = responseText ? JSON.parse(responseText) : null
        } catch {
          return reject(new Error(`返利接口返回格式异常（HTTP ${response.statusCode || 0}）`))
        }
        resolve({ statusCode: response.statusCode || 0, data })
      })
    })
    request.on('timeout', () => request.destroy(new Error('返利转链请求超时')))
    request.on('error', reject)
    request.write(payload)
    request.end()
  })
}

async function convertTaobaoRebateUrl({ url, config = getTaobaoRebateConfig(), transport = postJson }) {
  const originalUrl = normalizeHttpUrl(url)
  if (!isTaobaoUrl(originalUrl)) throw new Error('仅支持淘宝、天猫商品链接转链')
  if (!config.apiKey) throw new Error('淘宝返利服务尚未配置')

  const response = await transport(
    config.providerUrl,
    { url: originalUrl },
    { 'X-Api-Key': config.apiKey },
    config.timeoutMs
  )
  if (response.statusCode !== 200) {
    throw new Error(`返利接口网络异常（HTTP ${response.statusCode}）`)
  }
  if (!response.data || response.data.status !== true) {
    const message = String(response.data?.msg || '淘宝返利转链失败')
    if (isNoCommissionMessage(message)) {
      return {
        originalUrl,
        convertedUrl: originalUrl,
        converted: false,
        reasonCode: 'no_commission',
        reason: message
      }
    }
    throw new Error(message)
  }

  const convertedUrl = extractConvertedUrl(response.data)
  if (!isTaobaoUrl(convertedUrl)) throw new Error('返利接口返回了非淘宝链接')
  return {
    originalUrl,
    convertedUrl,
    converted: convertedUrl !== originalUrl
  }
}

module.exports = {
  DEFAULT_REBATE_API_URL,
  getTaobaoRebateConfig,
  normalizeHttpUrl,
  isTaobaoUrl,
  isNoCommissionMessage,
  extractConvertedUrl,
  postJson,
  convertTaobaoRebateUrl
}
