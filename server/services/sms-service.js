const crypto = require('crypto')
const https = require('https')

const DEFAULT_PROVIDER_URL = 'https://apis.shlianlu.com/sms/trade/normal/send'
const DEFAULT_SIGN_NAME = '【宿迁小灰狼电子商务】'

function getSmsConfig(env = process.env) {
  const timeout = Number.parseInt(env.SMS_REQUEST_TIMEOUT_MS, 10)
  return {
    providerUrl: String(env.SMS_PROVIDER_URL || DEFAULT_PROVIDER_URL).trim(),
    appId: String(env.SMS_PROVIDER_APP_ID || '').trim(),
    mchId: String(env.SMS_PROVIDER_MCH_ID || '').trim(),
    key: String(env.SMS_PROVIDER_KEY || '').trim(),
    signName: String(env.SMS_DEFAULT_SIGN_NAME || DEFAULT_SIGN_NAME).trim(),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 12000
  }
}

function assertSmsConfigured(config) {
  if (!config.appId || !config.mchId || !config.key) {
    throw new Error('短信服务尚未配置，请联系管理员')
  }
  let url
  try {
    url = new URL(config.providerUrl)
  } catch {
    throw new Error('短信服务地址配置无效')
  }
  if (url.protocol !== 'https:') {
    throw new Error('短信服务地址必须使用 HTTPS')
  }
}

function normalizeReceiverPhone(input) {
  let value = String(input || '').trim().replace(/[\s()]/g, '')
  if (!value) throw new Error('接收手机号不能为空')

  value = value.replace(/^\+86-?/, '')
  if (/^86-?1\d{10}(?:-[0-9]{1,12})?$/.test(value)) value = value.replace(/^86-?/, '')

  const match = value.match(/^(1\d{10})(?:-([0-9]{1,12}))?$/)
  if (!match) {
    throw new Error('接收手机号格式不正确，请先获取买家真实手机号')
  }

  return {
    phone: match[1],
    extension: match[2] || '',
    original: String(input || '').trim()
  }
}

function buildSmsMessage(message, extension = '') {
  const content = String(message || '').replace(/\r\n/g, '\n').trim()
  if (!content) throw new Error('短信内容不能为空')
  if (content.length > 500) throw new Error('短信内容不能超过500个字符')
  return extension ? `#${extension}#${content}` : content
}

function calculateSmsCount(signName, finalMessage) {
  const length = String(signName || '').length + String(finalMessage || '').length
  if (length <= 0) return 0
  return length <= 70 ? 1 : Math.ceil(length / 67)
}

function createProviderPayload({ config, phone, message, timestamp = Date.now() }) {
  assertSmsConfigured(config)
  const payload = {
    AppId: config.appId,
    MchId: config.mchId,
    Version: '1.1.0',
    Type: '1',
    PhoneNumberSet: [phone],
    SignName: config.signName,
    SessionContext: message,
    TimeStamp: String(timestamp),
    SignType: 'MD5'
  }
  const source =
    `AppId=${payload.AppId}` +
    `&MchId=${payload.MchId}` +
    `&SignName=${payload.SignName}` +
    `&SignType=${payload.SignType}` +
    `&TimeStamp=${payload.TimeStamp}` +
    `&Type=${payload.Type}` +
    `&Version=${payload.Version}` +
    `&key=${config.key}`
  payload.Signature = crypto.createHash('md5').update(source, 'utf8').digest('hex').toUpperCase()
  return payload
}

function postJson(urlString, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const data = JSON.stringify(body)
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(data)
      }
    }, response => {
      let responseText = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        responseText += chunk
        if (responseText.length > 1024 * 1024) request.destroy(new Error('短信服务响应过大'))
      })
      response.on('end', () => {
        let responseData = null
        try {
          responseData = responseText ? JSON.parse(responseText) : {}
        } catch {
          return reject(new Error(`短信服务返回格式异常（HTTP ${response.statusCode || 0}）`))
        }
        resolve({ statusCode: response.statusCode || 0, data: responseData })
      })
    })
    request.on('timeout', () => request.destroy(new Error('短信服务请求超时')))
    request.on('error', reject)
    request.write(data)
    request.end()
  })
}

async function sendSms({ config = getSmsConfig(), phone, message, transport = postJson }) {
  const normalizedPhone = normalizeReceiverPhone(phone)
  const finalMessage = buildSmsMessage(message, normalizedPhone.extension)
  const smsCount = calculateSmsCount(config.signName, finalMessage)
  const payload = createProviderPayload({ config, phone: normalizedPhone.phone, message: finalMessage })
  const response = await transport(config.providerUrl, payload, config.timeoutMs)

  if (response.statusCode !== 200) {
    throw new Error(`短信服务网络异常（HTTP ${response.statusCode}）`)
  }
  if (!response.data || String(response.data.status) !== '00') {
    throw new Error(String(response.data?.message || '短信发送失败'))
  }

  return {
    phone: normalizedPhone.phone,
    extension: normalizedPhone.extension,
    message: finalMessage,
    smsCount,
    providerResponse: response.data
  }
}

module.exports = {
  DEFAULT_PROVIDER_URL,
  DEFAULT_SIGN_NAME,
  getSmsConfig,
  assertSmsConfigured,
  normalizeReceiverPhone,
  buildSmsMessage,
  calculateSmsCount,
  createProviderPayload,
  postJson,
  sendSms
}
