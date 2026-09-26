const fs = require('fs')
const path = require('path')
const { safeStorage } = require('electron')
const { getStoragePaths } = require('./storage-manager')

const VAULT_FILE = 'jd-store-credentials.enc.json'

function getVaultFile() {
  const paths = getStoragePaths()
  const root = paths?.storageRoot || paths?.dataRoot
  if (!root) throw new Error('客户端数据目录尚未初始化')
  const directory = path.join(root, 'credentials')
  fs.mkdirSync(directory, { recursive: true })
  return path.join(directory, VAULT_FILE)
}

function canUseEncryption() {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function readVault() {
  if (!canUseEncryption()) return {}
  const file = getVaultFile()
  if (!fs.existsSync(file)) return {}
  try {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (envelope?.version !== 1 || !envelope?.payload) return {}
    const clearText = safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'))
    const parsed = JSON.parse(clearText)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeVault(vault) {
  if (!canUseEncryption()) {
    return { success: false, reason: '系统安全存储不可用' }
  }
  const file = getVaultFile()
  const tempFile = `${file}.tmp`
  const encrypted = safeStorage.encryptString(JSON.stringify(vault || {}))
  fs.writeFileSync(tempFile, JSON.stringify({
    version: 1,
    encryption: 'electron-safe-storage',
    payload: encrypted.toString('base64')
  }), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tempFile, file)
  return { success: true }
}

function normalizeStoreId(storeId) {
  const value = String(storeId ?? '').trim()
  if (!/^\d+$/.test(value)) throw new Error('店铺ID无效')
  return value
}

function getJdStoreCredential(storeId) {
  const key = normalizeStoreId(storeId)
  const credential = readVault()[key]
  if (!credential || typeof credential !== 'object') return null
  return {
    account: String(credential.account || ''),
    password: String(credential.password || '')
  }
}

function saveJdStoreCredential(storeId, { account = '', password = '' } = {}) {
  const key = normalizeStoreId(storeId)
  const vault = readVault()
  const previous = vault[key] && typeof vault[key] === 'object' ? vault[key] : {}
  const next = {
    account: String(account || previous.account || ''),
    password: String(password || previous.password || ''),
    updatedAt: new Date().toISOString()
  }
  if (!next.account && !next.password) return { success: false, reason: '没有可保存的登录凭据' }
  vault[key] = next
  return writeVault(vault)
}

function moveJdStoreCredential(fromStoreId, toStoreId) {
  const fromKey = normalizeStoreId(fromStoreId)
  const toKey = normalizeStoreId(toStoreId)
  if (fromKey === toKey) return { success: true, moved: false }
  const vault = readVault()
  if (!vault[fromKey]) return { success: true, moved: false }
  vault[toKey] = vault[fromKey]
  delete vault[fromKey]
  const result = writeVault(vault)
  return { ...result, moved: result.success === true }
}

module.exports = {
  getJdStoreCredential,
  saveJdStoreCredential,
  moveJdStoreCredential
}
