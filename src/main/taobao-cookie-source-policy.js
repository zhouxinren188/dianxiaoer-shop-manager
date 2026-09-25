'use strict'

/**
 * 决定打开淘宝/天猫采购页面时是否需要用云端 Cookie 恢复本地会话。
 *
 * 本机持久分区包含 Cookie 之外的 LocalStorage、IndexedDB 和设备风控状态，
 * 因此只要本地仍有登录 Cookie，且淘宝没有明确判定失效/账号不符，就应保留
 * 当前设备会话。网络错误、淘宝繁忙和风控验证都不能作为清空本地会话的依据。
 */
function decideTaobaoCookieSource({ hasLocalLogin, validationStatus } = {}) {
  if (!hasLocalLogin) {
    return { restoreFromServer: true, reason: 'local_login_cookie_missing' }
  }

  const status = String(validationStatus || 'unknown').toLowerCase()
  if (status === 'invalid') {
    return { restoreFromServer: true, reason: 'local_session_invalid' }
  }
  if (status === 'mismatch') {
    return { restoreFromServer: true, reason: 'local_account_mismatch' }
  }

  return {
    restoreFromServer: false,
    reason: status === 'valid' ? 'local_session_valid' : `local_session_preserved_${status}`
  }
}

module.exports = { decideTaobaoCookieSource }
