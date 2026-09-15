import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  decideCookieUpdate,
  isAllowedCookieDeviceId,
  normalizeCookieDeviceId
} = require('../server/services/store-cookie-policy.js')
const {
  buildDeviceCookieSnapshotUrl,
  hasLocalJdCookies
} = require('../src/main/store-cookie-utils.js')

const DEVICE_A = 'device_aaaaaaaaaaaaaaaa'
const DEVICE_B = 'device_bbbbbbbbbbbbbbbb'

describe('店铺 Cookie 多设备隔离', () => {
  it('设备标识规范化后仍校验格式，空标识只作为旧客户端槽位', () => {
    expect(normalizeCookieDeviceId(`  ${DEVICE_A}  `)).toBe(DEVICE_A)
    expect(isAllowedCookieDeviceId(DEVICE_A)).toBe(true)
    expect(isAllowedCookieDeviceId('')).toBe(true)
    expect(isAllowedCookieDeviceId('device_short')).toBe(false)
  })

  it('不同设备读取不同的服务器备份地址', () => {
    const first = buildDeviceCookieSnapshotUrl('http://127.0.0.1:3002/', 12, DEVICE_A)
    const second = buildDeviceCookieSnapshotUrl('http://127.0.0.1:3002', 12, DEVICE_B)

    expect(first).toBe(`http://127.0.0.1:3002/api/cookies/12?device_id=${DEVICE_A}`)
    expect(second).toBe(`http://127.0.0.1:3002/api/cookies/12?device_id=${DEVICE_B}`)
    expect(first).not.toBe(second)
  })

  it('本机只要存在京东 Cookie 就应优先使用本机会话', () => {
    expect(hasLocalJdCookies([
      { name: 'tracking', domain: '.example.com' },
      { name: 'thor', domain: '.jd.com' }
    ])).toBe(true)
    expect(hasLocalJdCookies([{ name: 'tracking', domain: '.example.com' }])).toBe(false)
    expect(hasLocalJdCookies([])).toBe(false)
  })

  it('两台设备拥有各自版本线，一台更新不会推进另一台版本', () => {
    const deviceState = new Map()
    const update = (deviceId, fingerprint, sourceType, baseRevision = 0) => {
      const current = deviceState.get(deviceId)
      const decision = decideCookieUpdate({
        currentRevision: current?.revision || 0,
        currentFingerprint: current?.fingerprint || '',
        incomingFingerprint: fingerprint,
        sourceType,
        baseRevision
      })
      if (decision.accepted) {
        deviceState.set(deviceId, {
          revision: decision.nextRevision,
          fingerprint
        })
      }
      return decision
    }

    expect(update(DEVICE_A, 'cookie-a-1', 'heartbeat')).toMatchObject({ nextRevision: 1 })
    expect(update(DEVICE_B, 'cookie-b-1', 'heartbeat')).toMatchObject({ nextRevision: 1 })
    expect(update(DEVICE_A, 'cookie-a-2', 'heartbeat', 1)).toMatchObject({ nextRevision: 2 })
    expect(deviceState.get(DEVICE_A)).toMatchObject({ revision: 2, fingerprint: 'cookie-a-2' })
    expect(deviceState.get(DEVICE_B)).toMatchObject({ revision: 1, fingerprint: 'cookie-b-1' })
  })

  it('数据库唯一键及服务端读写都包含设备维度', () => {
    const dbSource = readFileSync(
      fileURLToPath(new URL('../server/db.js', import.meta.url)),
      'utf8'
    )
    const serverSource = readFileSync(
      fileURLToPath(new URL('../server/index.js', import.meta.url)),
      'utf8'
    )

    expect(dbSource).toContain('UNIQUE KEY uk_store_device (store_id, source_device_id)')
    expect(serverSource).toContain(
      'SELECT * FROM cookies WHERE store_id = ? AND source_device_id = ? FOR UPDATE'
    )
    expect(serverSource).toContain(
      'SELECT * FROM cookies WHERE store_id = ? AND source_device_id = ?'
    )
    expect(serverSource).toContain("req.query?.allow_verified_fallback === '1'")
    expect(serverSource).toContain('AND c.source_device_id <> ?')
    expect(serverSource).toContain('AND c.last_verified_at IS NOT NULL')
    expect(serverSource).toContain('target_revision: Number(currentDeviceCookie?.revision || 0)')
  })

  it('查询前先检查本机会话，不再按服务器 revision 自动覆盖', () => {
    const heartbeatSource = readFileSync(
      fileURLToPath(new URL('../src/main/cookie-heartbeat.js', import.meta.url)),
      'utf8'
    )
    const start = heartbeatSource.indexOf('async function refreshCookiesFromServerIfNewer')
    const end = heartbeatSource.indexOf('// 根据 Cookie 的 domain', start)
    const functionSource = heartbeatSource.slice(start, end)

    expect(functionSource.indexOf('hasLocalJdCookies(localCookies)')).toBeGreaterThan(-1)
    expect(functionSource.indexOf('hasLocalJdCookies(localCookies)'))
      .toBeLessThan(functionSource.indexOf('getServerCookieSnapshot(storeId'))
    expect(functionSource).not.toContain('snapshot.revision > localRevision')
    expect(functionSource).toContain('allowVerifiedFallback: true')
  })

  it('本机 Cookie 已确认失效时排除当前设备并恢复其他设备已验证快照', () => {
    const heartbeatSource = readFileSync(
      fileURLToPath(new URL('../src/main/cookie-heartbeat.js', import.meta.url)),
      'utf8'
    )
    const start = heartbeatSource.indexOf('async function clearAndRetryWithFreshCookies')
    const end = heartbeatSource.indexOf('async function reportStoreDeviceStatus', start)
    const functionSource = heartbeatSource.slice(start, end)

    expect(functionSource).toContain('allowVerifiedFallback: true')
    expect(functionSource).toContain('excludeCurrentDevice: true')
    expect(heartbeatSource).toContain('targetRevision: Number(json.data.target_revision')
    expect(heartbeatSource).toContain('resetCookieRevision(storeId)')
  })

  it('云端恢复后仍失效的 Cookie 会被清除并阻止重复恢复同一指纹', () => {
    const heartbeatSource = readFileSync(
      fileURLToPath(new URL('../src/main/cookie-heartbeat.js', import.meta.url)),
      'utf8'
    )
    const refreshStart = heartbeatSource.indexOf('async function refreshCookiesFromServerIfNewer')
    const refreshEnd = heartbeatSource.indexOf('// 真实业务接口在云端恢复后仍返回未登录时', refreshStart)
    const refreshSource = heartbeatSource.slice(refreshStart, refreshEnd)
    const invalidateStart = heartbeatSource.indexOf('async function invalidateStoreSessionCookies')
    const invalidateEnd = heartbeatSource.indexOf('// 根据 Cookie 的 domain', invalidateStart)
    const invalidateSource = heartbeatSource.slice(invalidateStart, invalidateEnd)

    expect(refreshSource).toContain('excludeCurrentDevice: true')
    expect(refreshSource).toContain('rejectedFingerprints.has(snapshot.fingerprint)')
    expect(refreshSource).toContain("action: 'relogin_required'")
    expect(invalidateSource).toContain('rememberInvalidCookieFingerprint(storeId, fingerprint)')
    expect(invalidateSource).toContain('await ses.cookies.remove')
    expect(invalidateSource).toContain('online: false')
  })

  it('登录保存成功后立即禁止关窗逻辑回滚旧 Cookie', () => {
    const platformWindowSource = readFileSync(
      fileURLToPath(new URL('../src/main/platform-window.js', import.meta.url)),
      'utf8'
    )
    const saveStart = platformWindowSource.indexOf('saveStoreInfo(mw, sid, plat')
    const successBranch = platformWindowSource.slice(
      saveStart,
      platformWindowSource.indexOf('}).catch(error =>', saveStart)
    )

    expect(successBranch.indexOf('win._saveDone = true'))
      .toBeLessThan(successBranch.indexOf('setTimeout(() =>'))
  })

  it('所有云端恢复入口都拒绝已经确认失效的快照，且新登录不会忘记旧失效指纹', () => {
    const source = readFileSync(new URL('../src/main/cookie-heartbeat.js', import.meta.url), 'utf8')
    const start = source.indexOf('async function applyServerCookieSnapshot')
    const end = source.indexOf('// 从服务器查询店铺 Cookie', start)
    const applySource = source.slice(start, end)
    expect(applySource.indexOf('rejectedFingerprints?.has(snapshot.fingerprint)'))
      .toBeLessThan(applySource.indexOf('session.fromPartition'))
    expect(source).toContain('rememberInvalidCookieFingerprint(storeId, fingerprintCookies(rejectedCookies))')
    expect(source).not.toContain('invalidCookieFingerprints.delete(String(storeId))')
  })
})
