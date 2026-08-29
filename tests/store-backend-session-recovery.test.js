import { describe, expect, it } from 'vitest'
import recovery from '../src/main/store-backend-session-recovery.js'

const { getBackendRecoveryDisposition } = recovery

describe('店铺后台登录恢复结果', () => {
  it('恢复成功且窗口仍存在时重载原目标并上报在线', () => {
    expect(getBackendRecoveryDisposition(true, false)).toEqual({
      succeeded: true,
      reportOnline: true,
      reloadOriginalUrl: true,
      action: 'reload_original_url'
    })
  })

  it('恢复成功但用户已关闭窗口时仍视为在线且不再重载', () => {
    expect(getBackendRecoveryDisposition(true, true)).toEqual({
      succeeded: true,
      reportOnline: true,
      reloadOriginalUrl: false,
      action: 'skip_reload_window_closed'
    })
  })

  it('身份检查不确定时允许返回原目标但不强行改在线状态', () => {
    expect(getBackendRecoveryDisposition(null, false)).toMatchObject({
      succeeded: true,
      reportOnline: false,
      reloadOriginalUrl: true
    })
  })

  it('只有明确恢复失败才上报离线', () => {
    expect(getBackendRecoveryDisposition(false, false)).toEqual({
      succeeded: false,
      reportOnline: false,
      reloadOriginalUrl: false,
      action: 'report_offline'
    })
  })
})
