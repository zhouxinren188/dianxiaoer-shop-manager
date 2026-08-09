const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const REVISION_FILE = 'store-cookie-revisions.json'
let loaded = false
let revisions = {}

function getRevisionFile() {
  return path.join(app.getPath('userData'), REVISION_FILE)
}

function loadRevisions() {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(fs.readFileSync(getRevisionFile(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      revisions = parsed
    }
  } catch {
    revisions = {}
  }
}

function getCookieRevision(storeId) {
  loadRevisions()
  const value = Number(revisions[String(storeId)] || 0)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function setCookieRevision(storeId, revision) {
  const value = Number(revision || 0)
  if (!Number.isSafeInteger(value) || value <= 0) return
  loadRevisions()
  revisions[String(storeId)] = value
  try {
    fs.writeFileSync(getRevisionFile(), JSON.stringify(revisions, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.warn('[CookieRevision] 保存版本失败:', error.message)
  }
}

module.exports = { getCookieRevision, setCookieRevision }
