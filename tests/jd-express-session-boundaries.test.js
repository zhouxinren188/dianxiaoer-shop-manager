import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import recovery from '../src/main/jd-session-recovery.js'
import crowds from '../src/main/jd-express-crowds.js'

const mainSource = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
const viewSource = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')

function functionSource(source, name, nextName) {
  const start = source.indexOf(`async function ${name}(`)
  const end = source.indexOf(`\n${nextName}`, start)
  if (start < 0 || end < 0) throw new Error(`找不到待测函数 ${name}`)
  return source.slice(start, end)
}

function sessionError(code = 'JD_SESSION_EXPIRED') {
  return Object.assign(new Error('NotLogin'), { code })
}

function readFunction(name, nextName, dependencies) {
  return new Function(...Object.keys(dependencies),
    functionSource(mainSource, name, nextName) + `\nreturn ${name}`
  )(...Object.values(dependencies))
}

describe('快车只读查询的登录失效边界', () => {
  it('后续全店商品页返回 NotLogin 时立即停止，交给上层恢复而不是继续扫页', async () => {
    const error = sessionError()
    const fetchProductPage = vi.fn()
      .mockResolvedValueOnce({ storeId: 12, total: 300, products: [], invalidSpuIds: [] })
      .mockRejectedValueOnce(error)
    const read = readFunction('fetchAllProducts', 'async function retryProductPages', {
      preparePromotionFilter: async () => null,
      JD_EXPRESS_READ_POLICY: { initialDelayMs: 0 },
      delay: async () => {},
      fetchProductPage,
      SKU_PAGE_SIZE: 100,
      SKU_BATCH_INTERVAL_MS: 0,
      isJdSessionFailure: recovery.isJdSessionFailure
    })
    await expect(read(12)).rejects.toBe(error)
    expect(fetchProductPage).toHaveBeenCalledTimes(2)
  })

  it('补查页遇到必须重新登录状态时不继续请求剩余页面', async () => {
    const error = sessionError('JD_SESSION_RELOGIN_REQUIRED')
    const fetchProductPage = vi.fn().mockRejectedValue(error)
    const read = readFunction('retryProductPages', 'function getPreparedJobCacheDirectory', {
      preparePromotionFilter: async () => null,
      JD_EXPRESS_READ_POLICY: { initialDelayMs: 0 },
      delay: async () => {},
      fetchProductPage,
      SKU_PAGE_SIZE: 100,
      SKU_BATCH_INTERVAL_MS: 0,
      isJdSessionFailure: recovery.isJdSessionFailure,
      normalizeStoreId: Number
    })
    await expect(read(12, { pages: [2, 3] })).rejects.toBe(error)
    expect(fetchProductPage).toHaveBeenCalledTimes(1)
  })

  it('场景人群返回 NotLogin 时立即停止其他分类，关闭签名窗口并交给上层恢复', async () => {
    const error = sessionError()
    const signingWindow = { isDestroyed: () => false, destroy: vi.fn() }
    const requestJson = vi.fn()
      .mockResolvedValueOnce({ data: [
        { categoryCode: 0, categoryName: '默认', level: 0 },
        { categoryCode: 1, categoryName: '其他', level: 0 }
      ] })
      .mockRejectedValueOnce(error)
    const read = readFunction('fetchCrowdOptions', 'async function fetchProductPage', {
      ...crowds,
      prepareStore: async () => ({ storeId: 12, platformSession: {} }),
      openReadySigningWindow: async () => signingWindow,
      activeProbeWindows: new Set([signingWindow]),
      signSceneCrowdRequestInWindow: async () => ({}),
      getCrowdRequestOptions: body => ({ body }),
      assertCrowdPayload: payload => payload,
      requestJson,
      createRequestError: message => new Error(message),
      delay: async () => {},
      isJdSessionFailure: recovery.isJdSessionFailure,
    })
    await expect(read(12)).rejects.toBe(error)
    expect(requestJson).toHaveBeenCalledTimes(2)
    expect(signingWindow.destroy).toHaveBeenCalledOnce()
  })
})

describe('人群列表请求隔离', () => {
  it('A→B→A 快速切换时旧的 A 请求不能覆盖新的 A 请求或关闭其加载状态', async () => {
    let resolveOld
    let resolveNew
    const oldRequest = new Promise(resolve => { resolveOld = resolve })
    const newRequest = new Promise(resolve => { resolveNew = resolve })
    const context = {
      ensureStoreSelected: () => true,
      storeId: { value: 'A' },
      crowdLoading: { value: false },
      crowdError: { value: '' },
      crowdPartial: { value: false },
      crowdOptions: { value: [] },
      crowdLoadedStoreId: { value: '' },
      config: { dmpCrowdSettings: [] },
      crowdKey: item => String(item.crowdId),
      getCrowdPremium: item => item.adGroupPrice || 10,
      showCenteredMessage: vi.fn(),
      window: { electronAPI: { invoke: vi.fn()
        .mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest) } }
    }
    vm.createContext(context)
    vm.runInContext('let crowdRequestSeq = 0;\n' +
      functionSource(viewSource, 'loadCrowds', 'async function handleAreaTypeChange') +
      '\nglobalThis.invalidateCrowdRequest = () => { crowdRequestSeq += 1 }', context)

    const oldLoad = context.loadCrowds(true)
    context.storeId.value = 'B'
    context.invalidateCrowdRequest()
    context.crowdLoading.value = false
    context.storeId.value = 'A'
    const newLoad = context.loadCrowds(true)
    resolveOld({ success: true, crowds: [{ crowdId: 'old' }] })
    await oldLoad
    expect(context.crowdOptions.value).toEqual([])
    expect(context.crowdLoading.value).toBe(true)
    resolveNew({ success: true, crowds: [{ crowdId: 'new' }] })
    await newLoad
    expect(context.crowdOptions.value).toEqual([{ crowdId: 'new' }])
    expect(context.crowdLoading.value).toBe(false)
  })
})
