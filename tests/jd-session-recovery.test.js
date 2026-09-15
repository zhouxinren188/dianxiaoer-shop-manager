import { describe, expect, it, vi } from 'vitest'
import recovery from '../src/main/jd-session-recovery.js'

const {
  SESSION_EXPIRED_MESSAGE,
  isJdSessionExpiredError,
  isJdSessionExpiredPayload,
  isJdSessionFailure,
  runJdReadWithSessionRecovery
} = recovery

function sessionError(message = 'NotLogin', code = 'JD_SESSION_EXPIRED') {
  const error = new Error(message)
  error.code = code
  return error
}

describe('京准通登录态自动恢复', () => {
  it('识别接口返回的 NotLogin 与中文登录失败', () => {
    expect(isJdSessionExpiredPayload({ success: false, message: 'NotLogin' })).toBe(true)
    expect(isJdSessionExpiredPayload({ success: false, msg: '登录失败' })).toBe(true)
    expect(isJdSessionExpiredPayload({ success: false, message: '系统繁忙' })).toBe(false)
    expect(isJdSessionExpiredError(sessionError())).toBe(true)
    expect(isJdSessionFailure(sessionError())).toBe(true)
    expect(isJdSessionFailure(sessionError(SESSION_EXPIRED_MESSAGE, 'JD_SESSION_RELOGIN_REQUIRED'))).toBe(true)
    expect(isJdSessionFailure(new Error('系统繁忙'))).toBe(false)
  })

  it('首次未登录时只恢复一次云端 Cookie，然后重试原查询', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(sessionError())
      .mockResolvedValueOnce({ success: true, products: [{ skuId: '1' }] })
    const recoverSession = vi.fn().mockResolvedValue(true)
    const invalidateSession = vi.fn()

    const result = await runJdReadWithSessionRecovery({
      storeId: 230,
      operation,
      recoverSession,
      invalidateSession
    })

    expect(result.success).toBe(true)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(recoverSession).toHaveBeenCalledWith(230, 'jd')
    expect(invalidateSession).not.toHaveBeenCalled()
  })

  it('云端恢复后仍未登录时清理失效 Cookie 并返回明确提示', async () => {
    const operation = vi.fn().mockRejectedValue(sessionError())
    const recoverSession = vi.fn().mockResolvedValue(null)
    const invalidateSession = vi.fn().mockResolvedValue({ success: true, removed: 28 })

    await expect(runJdReadWithSessionRecovery({
      storeId: 230,
      operation,
      recoverSession,
      invalidateSession
    })).rejects.toMatchObject({
      code: 'JD_SESSION_RELOGIN_REQUIRED',
      message: SESSION_EXPIRED_MESSAGE
    })

    expect(operation).toHaveBeenCalledTimes(2)
    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(invalidateSession).toHaveBeenCalledTimes(1)
  })

  it('云端没有可恢复快照时不重复请求京东，直接清理并提示登录', async () => {
    const operation = vi.fn().mockRejectedValue(sessionError('登录失败'))
    const recoverSession = vi.fn().mockResolvedValue(false)
    const invalidateSession = vi.fn().mockResolvedValue({ success: true })

    await expect(runJdReadWithSessionRecovery({
      storeId: 230,
      operation,
      recoverSession,
      invalidateSession
    })).rejects.toThrow(SESSION_EXPIRED_MESSAGE)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(invalidateSession).toHaveBeenCalledTimes(1)
  })

  it('已进入必须重新登录状态时不再触发云端恢复', async () => {
    const operation = vi.fn().mockRejectedValue(
      sessionError(SESSION_EXPIRED_MESSAGE, 'JD_SESSION_RELOGIN_REQUIRED')
    )
    const recoverSession = vi.fn()

    await expect(runJdReadWithSessionRecovery({
      storeId: 230,
      operation,
      recoverSession
    })).rejects.toMatchObject({ code: 'JD_SESSION_RELOGIN_REQUIRED' })

    expect(operation).toHaveBeenCalledTimes(1)
    expect(recoverSession).not.toHaveBeenCalled()
  })

  it('普通业务错误不触发登录恢复', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('系统繁忙'))
    const recoverSession = vi.fn()

    await expect(runJdReadWithSessionRecovery({
      storeId: 230,
      operation,
      recoverSession
    })).rejects.toThrow('系统繁忙')

    expect(recoverSession).not.toHaveBeenCalled()
  })
})
