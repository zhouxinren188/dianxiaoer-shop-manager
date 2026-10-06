import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const mainSource = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
const viewSource = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`async function ${name}(`)
  const end = source.indexOf(`\n${nextName}`, start)
  if (start < 0 || end < 0) throw new Error(`找不到待测函数 ${name}`)
  return source.slice(start, end)
}

function readLimit(payload) {
  const ext = payload?.ext || payload?.data?.ext || payload?.data || {}
  const total = Number(ext.pinTotal)
  const current = Number(ext.pinCurrent)
  const surplusValue = Number(ext.pinSurplus)
  const safeTotal = Number.isFinite(total) ? total : 0
  const safeCurrent = Number.isFinite(current) ? current : 0
  return {
    total: safeTotal,
    current: safeCurrent,
    surplus: Number.isFinite(surplusValue) ? surplusValue : Math.max(safeTotal - safeCurrent, 0)
  }
}

const limitPayloadSource = mainSource.slice(
  mainSource.indexOf('function hasLimitPayload('),
  mainSource.indexOf('\n\nasync function waitForRateLimit', mainSource.indexOf('function hasLimitPayload('))
)
const hasLimitPayload = new Function(`${limitPayloadSource}\nreturn hasLimitPayload`)()

describe('京东快车投放环境检测', () => {
  it('保留原店铺或切换店铺后都会立即检测，失败时提供重新检测入口', () => {
    expect(viewSource).toContain("await runPreflight({ silent: true })\n      return")
    expect(viewSource).toContain("await runPreflight({ silent: true })\n  if (config.areaType")
    expect(viewSource).toContain("{{ preflightLoading ? '检测中' : '重新检测' }}")
    expect(viewSource).toContain('v-if="preflight.pin && preflight.limitsAvailable"')
    expect(viewSource).toContain("preflight.limitsAvailable ? item.surplus : '--'")
    expect(viewSource).toContain('if (!preflight.pin || !preflight.limitsAvailable)')
  })

  it('四项额度并行读取，并接受京东 data.ext 的有效返回结构', async () => {
    const limitRequests = Object.fromEntries(['campaign', 'adgroup', 'ad', 'keyword'].map(key => [key, {
      url: `https://limit.test/${key}`,
      body: { key }
    }]))
    const pending = []
    const requestJson = vi.fn(async (_session, url, options) => {
      if (url === 'https://login.test') return { code: 1, data: { pin: 'test-pin' } }
      return new Promise(resolve => pending.push({ resolve, url, options }))
    })
    const dependencies = {
      prepareStore: async () => ({ storeId: 391, platformSession: {} }),
      requestJson,
      JZT_LOGIN_URL: 'https://login.test',
      LIMIT_REQUESTS: limitRequests,
      assertSuccess: payload => payload,
      isJdSessionExpiredPayload: () => false,
      createRequestError: message => new Error(message),
      hasLimitPayload,
      readLimit,
      isJdSessionFailure: () => false,
      runtimeLog: { writeLog: vi.fn() },
      logSafe: value => String(value || '')
    }
    const code = extractFunction(mainSource, 'preflightStore', 'function getCampaignRequestOptions')
    const preflightStore = new Function(...Object.keys(dependencies), `${code}\nreturn preflightStore`)(
      ...Object.values(dependencies)
    )

    const resultPromise = preflightStore(391)
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    for (const request of pending) {
      expect(request.options.timeoutMs).toBe(12000)
      request.resolve({ success: true, data: { ext: { pinTotal: 100, pinCurrent: 10, pinSurplus: 90 } } })
    }
    const result = await resultPromise

    expect(result).toMatchObject({ success: true, pin: 'test-pin', limitsAvailable: true })
    expect(result.limits.keyword).toEqual({ total: 100, current: 10, surplus: 90 })
  })

  it('空额度对象不能被当成真实的零额度', () => {
    expect(hasLimitPayload({ success: true, data: {} })).toBe(false)
    expect(hasLimitPayload({ success: true, data: { ext: { pinTotal: 0, pinCurrent: 0, pinSurplus: 0 } } })).toBe(true)
  })

  it('快速切换店铺时旧请求不能覆盖当前店铺的检测结果', async () => {
    let resolveOld
    const oldResult = new Promise(resolve => { resolveOld = resolve })
    const invoke = vi.fn()
      .mockReturnValueOnce(oldResult)
      .mockResolvedValueOnce({
        success: true,
        pin: 'new-store',
        limitsAvailable: true,
        limits: { keyword: { total: 20, current: 5, surplus: 15 } }
      })
    const storeId = { value: 'old' }
    const preflight = {
      pin: '',
      limitsAvailable: false,
      limits: { keyword: { total: 0, current: 0, surplus: 0 } }
    }
    const bindings = {
      ensureStoreSelected: () => Boolean(storeId.value),
      storeId,
      preflightLoading: { value: false },
      preflight,
      config: { keywordTotalUsage: 0 },
      resetLimits: vi.fn(),
      ElMessage: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
      window: { electronAPI: { invoke } }
    }
    const code = extractFunction(viewSource, 'runPreflight', 'async function confirmDeleteAllCampaigns')
    const runPreflight = new Function(
      ...Object.keys(bindings),
      `let preflightRequestId = 0;\n${code}\nreturn runPreflight`
    )(...Object.values(bindings))

    const oldRequest = runPreflight({ silent: true })
    storeId.value = 'new'
    const newRequest = runPreflight({ silent: true })
    await newRequest
    resolveOld({
      success: true,
      pin: 'old-store',
      limitsAvailable: true,
      limits: { keyword: { total: 99, current: 0, surplus: 99 } }
    })
    await oldRequest

    expect(preflight.pin).toBe('new-store')
    expect(preflight.limits.keyword.surplus).toBe(15)
    expect(bindings.preflightLoading.value).toBe(false)
  })
})
