const crypto = require('crypto')
const https = require('https')
const fs = require('fs')
const path = require('path')

let privateKey = null

function getPrivateKey() {
  if (!privateKey) {
    const keyPath = path.resolve(process.env.WX_PRIVATE_KEY_PATH || './certs/apiclient_key.pem')
    privateKey = fs.readFileSync(keyPath, 'utf-8')
  }
  return privateKey
}

// 生成签名
function generateSignature(method, url, timestamp, nonceStr, body) {
  const message = `${method}\n${url}\n${timestamp}\n${nonceStr}\n${body}\n`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(message)
  return sign.sign(getPrivateKey(), 'base64')
}

// 构建 Authorization 头
function buildAuthHeader(method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonceStr = crypto.randomBytes(16).toString('hex')
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body || '')
  const signature = generateSignature(method, urlPath, timestamp, nonceStr, bodyStr)

  return {
    Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${process.env.WX_MCH_ID}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${process.env.WX_SERIAL_NO}",signature="${signature}"`,
    timestamp,
    nonceStr
  }
}

// 创建 Native Pay 订单
async function createNativeOrder(orderNo, amount, description) {
  const urlPath = '/v3/pay/transactions/native'
  const body = {
    appid: process.env.WX_APP_ID,
    mchid: process.env.WX_MCH_ID,
    description: description || '店小二订阅',
    out_trade_no: orderNo,
    notify_url: process.env.WX_NOTIFY_URL,
    amount: {
      total: amount,
      currency: 'CNY'
    }
  }

  const bodyStr = JSON.stringify(body)
  const { Authorization } = buildAuthHeader('POST', urlPath, bodyStr)

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.mch.weixin.qq.com',
      port: 443,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'DianXiaoer-API/1.0',
        'Authorization': Authorization,
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (res.statusCode === 200) {
            resolve({ code_url: result.code_url })
          } else {
            console.error('微信支付下单失败:', result)
            reject(new Error(result.message || '微信支付下单失败'))
          }
        } catch (e) {
          reject(new Error('解析微信支付响应失败'))
        }
      })
    })

    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

// 解密微信支付回调通知
function decryptNotification(resource) {
  const { ciphertext, nonce, associated_data } = resource
  const key = process.env.WX_API_V3_KEY

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'utf-8'),
    Buffer.from(nonce, 'utf-8')
  )

  decipher.setAAD(Buffer.from(associated_data || '', 'utf-8'))

  const authTag = Buffer.from(ciphertext, 'base64').slice(-16)
  const encData = Buffer.from(ciphertext, 'base64').slice(0, -16)

  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encData)
  decrypted = Buffer.concat([decrypted, decipher.final()])

  return JSON.parse(decrypted.toString('utf-8'))
}

// 查询订单状态
async function queryOrderStatus(orderNo) {
  const urlPath = `/v3/pay/transactions/out-trade-no/${orderNo}?mchid=${process.env.WX_MCH_ID}`
  const { Authorization } = buildAuthHeader('GET', urlPath, '')

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.mch.weixin.qq.com',
      port: 443,
      path: urlPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DianXiaoer-API/1.0',
        'Authorization': Authorization
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          resolve(result)
        } catch (e) {
          reject(new Error('解析微信支付响应失败'))
        }
      })
    })

    req.on('error', reject)
    req.end()
  })
}

module.exports = {
  createNativeOrder,
  decryptNotification,
  queryOrderStatus
}
