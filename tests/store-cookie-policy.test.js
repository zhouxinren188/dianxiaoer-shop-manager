import { describe, expect, it } from 'vitest'
import policy from '../server/services/store-cookie-policy.js'

const { decideCookieUpdate, fingerprintCookieData } = policy

describe('京东店铺 Cookie 版本防覆盖策略', () => {
  it('Cookie 指纹与输入顺序无关', () => {
    const first = [
      { name: 'thor', value: 'a', domain: '.jd.com', path: '/' },
      { name: 'pin', value: 'b', domain: '.jd.com', path: '/' }
    ]
    expect(fingerprintCookieData(first)).toBe(fingerprintCookieData([...first].reverse()))
  })

  it('相同 Cookie 只刷新验证时间，不增加版本', () => {
    expect(decideCookieUpdate({
      currentRevision: 8,
      currentFingerprint: 'same',
      incomingFingerprint: 'same',
      sourceType: 'heartbeat',
      baseRevision: 3
    })).toMatchObject({ accepted: true, contentChanged: false, nextRevision: 8 })
  })

  it('登录捕获可无条件提升为新版本', () => {
    expect(decideCookieUpdate({
      currentRevision: 8,
      currentFingerprint: 'old',
      incomingFingerprint: 'new',
      sourceType: 'login_capture'
    })).toMatchObject({ accepted: true, contentChanged: true, nextRevision: 9 })
  })

  it('心跳仅能基于当前版本更新', () => {
    expect(decideCookieUpdate({
      currentRevision: 8,
      currentFingerprint: 'old',
      incomingFingerprint: 'new',
      sourceType: 'heartbeat',
      baseRevision: 8
    })).toMatchObject({ accepted: true, nextRevision: 9 })
  })

  it('旧设备心跳和旧版客户端不能覆盖服务器新 Cookie', () => {
    expect(decideCookieUpdate({
      currentRevision: 8,
      currentFingerprint: 'server-new',
      incomingFingerprint: 'device-old',
      sourceType: 'heartbeat',
      baseRevision: 7
    })).toMatchObject({ accepted: false, reason: 'stale_base_revision' })

    expect(decideCookieUpdate({
      currentRevision: 8,
      currentFingerprint: 'server-new',
      incomingFingerprint: 'legacy-old',
      sourceType: 'legacy'
    })).toMatchObject({ accepted: false, reason: 'legacy_overwrite_blocked' })
  })
})
