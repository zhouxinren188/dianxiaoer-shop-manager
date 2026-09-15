'use strict'

const SESSION_EXPIRED_MESSAGE = '店铺登录已失效，请重新登录'

function readResponseMessage(payload = {}) {
  return String(
    payload?.subMsg || payload?.message || payload?.msg || payload?.errorMessage || ''
  ).trim()
}

function isJdSessionExpiredPayload(payload) {
  const message = readResponseMessage(payload)
  return /not\s*login|未登录|登录失败|登录(?:状态|态)?已失效|请(?:先|重新)?登录/i.test(message)
}

function isJdSessionExpiredError(error) {
  if (error?.code === 'JD_SESSION_RELOGIN_REQUIRED') return false
  if (error?.code === 'JD_SESSION_EXPIRED') return true
  return isJdSessionExpiredPayload({ message: error?.message })
}

function isJdSessionFailure(error) {
  return error?.code === 'JD_SESSION_RELOGIN_REQUIRED' || isJdSessionExpiredError(error)
}

function createReloginRequiredError() {
  const error = new Error(SESSION_EXPIRED_MESSAGE)
  error.code = 'JD_SESSION_RELOGIN_REQUIRED'
  return error
}

async function runJdReadWithSessionRecovery({
  storeId,
  operation,
  recoverSession,
  invalidateSession,
  onEvent = () => {}
}) {
  try {
    return await operation({ recovered: false })
  } catch (error) {
    if (!isJdSessionExpiredError(error)) throw error
    onEvent({ phase: 'session_expired', error })
  }

  let recovered = false
  try {
    onEvent({ phase: 'recovery_start' })
    recovered = typeof recoverSession === 'function'
      ? await recoverSession(storeId, 'jd')
      : false
    onEvent({ phase: 'recovery_complete', recovered })
  } catch (error) {
    recovered = false
    onEvent({ phase: 'recovery_error', error })
  }

  if (recovered !== false) {
    try {
      const result = await operation({ recovered: true })
      onEvent({ phase: 'retry_success', recovered })
      return result
    } catch (error) {
      if (!isJdSessionExpiredError(error)) throw error
      onEvent({ phase: 'retry_session_expired', error, recovered })
    }
  }

  try {
    if (typeof invalidateSession === 'function') {
      await invalidateSession(storeId, {
        context: 'jd_express_session_invalid',
        reason: 'jd_express_not_login_after_recovery'
      })
    }
    onEvent({ phase: 'session_invalidated' })
  } catch (error) {
    onEvent({ phase: 'invalidation_error', error })
  }

  throw createReloginRequiredError()
}

module.exports = {
  SESSION_EXPIRED_MESSAGE,
  createReloginRequiredError,
  isJdSessionExpiredError,
  isJdSessionExpiredPayload,
  isJdSessionFailure,
  runJdReadWithSessionRecovery
}
