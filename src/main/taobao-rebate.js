'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')

const DEFAULT_REBATE_API_URL = 'https://xjs.xiongmsx.com/api/open/convertUrl'
const TAOBAO_HOST_SUFFIXES = ['taobao.com', 'tmall.com', 'tb.cn']

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
  const value = typeof data === 'string'
    ? data
    : data && typeof data === 'object'
      ? (data.url || data.clickUrl || data.shortUrl || data.couponUrl || '')
      : ''
  const convertedUrl = String(value || '').trim()
  if (!isTaobaoUrl(convertedUrl)) throw new Error('返利接口返回了非淘宝链接')
  return new URL(convertedUrl).toString()
}

function parseEnvFile(content) {
  const result = {}
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return result
}

function loadDevelopmentRebateConfig(appInstance) {
  if (!appInstance || appInstance.isPackaged) return null
  const candidates = [
    path.join(appInstance.getAppPath(), 'server', '.env.rebate'),
    path.join(process.cwd(), 'server', '.env.rebate')
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const env = parseEnvFile(fs.readFileSync(candidate, 'utf8'))
      const timeout = Number.parseInt(env.TAOBAO_REBATE_TIMEOUT_MS, 10)
      if (!env.TAOBAO_REBATE_API_KEY) continue
      return {
        providerUrl: env.TAOBAO_REBATE_API_URL || DEFAULT_REBATE_API_URL,
        apiKey: env.TAOBAO_REBATE_API_KEY,
        timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 10000
      }
    } catch {}
  }
  return null
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
        let data
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

async function convertTaobaoRebateUrlDirect(url, config, transport = postJson) {
  if (!isTaobaoUrl(url)) throw new Error('仅支持淘宝、天猫商品链接转链')
  if (!config || !config.apiKey) throw new Error('开发版返利密钥未配置')
  const response = await transport(
    config.providerUrl || DEFAULT_REBATE_API_URL,
    { url },
    { 'X-Api-Key': config.apiKey },
    config.timeoutMs || 10000
  )
  if (response.statusCode !== 200) throw new Error(`返利接口网络异常（HTTP ${response.statusCode}）`)
  if (!response.data || response.data.status !== true) {
    const message = String(response.data?.msg || '淘宝返利转链失败')
    if (isNoCommissionMessage(message)) {
      return {
        url: new URL(url).toString(),
        converted: false,
        reasonCode: 'no_commission',
        reason: message
      }
    }
    throw new Error(message)
  }
  const convertedUrl = extractConvertedUrl(response.data)
  return { url: convertedUrl, converted: convertedUrl !== new URL(url).toString() }
}

module.exports = {
  DEFAULT_REBATE_API_URL,
  isTaobaoUrl,
  isNoCommissionMessage,
  extractConvertedUrl,
  parseEnvFile,
  loadDevelopmentRebateConfig,
  postJson,
  convertTaobaoRebateUrlDirect
}
