const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const DEVICE_ID_FILE = 'store-device-id.txt'
let cachedDeviceId = ''

function isValidDeviceId(value) {
  return /^device_[a-zA-Z0-9-]{16,80}$/.test(String(value || '').trim())
}

function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId

  const deviceFile = path.join(app.getPath('userData'), DEVICE_ID_FILE)
  try {
    const existing = fs.readFileSync(deviceFile, 'utf8').trim()
    if (isValidDeviceId(existing)) {
      cachedDeviceId = existing
      return cachedDeviceId
    }
  } catch {
    // 首次运行时文件不存在，继续创建。
  }

  const randomPart = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex')
  cachedDeviceId = `device_${randomPart}`
  try {
    fs.writeFileSync(deviceFile, cachedDeviceId, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.warn('[DeviceIdentity] 持久化设备标识失败，本次运行继续使用临时标识:', error.message)
  }
  return cachedDeviceId
}

function getShortDeviceId() {
  const deviceId = getDeviceId()
  return deviceId.length > 18 ? `${deviceId.slice(0, 18)}…` : deviceId
}

module.exports = { getDeviceId, getShortDeviceId }
