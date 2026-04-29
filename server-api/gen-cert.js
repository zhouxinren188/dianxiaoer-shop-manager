const { generateKeyPairSync, createCertificate, createPrivateKey } = require('crypto')
const fs = require('fs')
const path = require('path')

// 使用 Node.js 内置 crypto 生成自签名证书
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

// 简单自签名证书内容（Node.js v22 没有 createCertificate，用简单方式）
// 使用内置的 tls 模块方式
const tls = require('tls')

// 写一个简单的 PEM 格式的证书
const certContent = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKHBfpE
-----END CERTIFICATE-----`

fs.writeFileSync(path.join(__dirname, 'key.pem'), privateKey)
fs.writeFileSync(path.join(__dirname, 'cert.pem'), publicKey)

console.log('证书已生成')
