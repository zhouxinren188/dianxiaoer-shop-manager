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
    expect(viewSource).toContain("await runPreflight({ silent: true, preserveKeywordUsage: true })\n      return")
    expect(viewSource).toContain("await runPreflight({ silent: true })\n  if (selectionRequestId !== storeSelectionRequestId")
    expect(viewSource).toContain('if (config.areaType === 2) await loadAreas()')
    expect(viewSource).toContain("{{ preflightLoading ? '检测中' : '重新检测' }}")
    expect(viewSource).toContain('v-if="preflight.limitsAvailable"')
    expect(viewSource).toContain("preflight.pin ? `已登录：${preflight.pin}` : '投放环境已就绪'")
    expect(viewSource).toContain("preflight.limitsAvailable ? item.surplus : '--'")
    expect(viewSource).toContain('if (!preflight.limitsAvailable)')
  })

  it('所有店铺值来源统一触发环境检测，且不只依赖下拉框 change 事件', () => {
    expect(viewSource).not.toContain('@change="handleStoreChange"')
    expect(viewSource).toContain('watch(storeId, (value, previousValue) => {')
    expect(viewSource).toContain('void handleStoreChange(value)')
    expect(viewSource).toContain('}, { immediate: true })')
    expect(viewSource).toContain('const selectionRequestId = ++storeSelectionRequestId')
    expect(viewSource).toContain('selectionRequestId !== storeSelectionRequestId')
    expect(viewSource).not.toContain('await handleStoreChange(storeId.value)')
  })

  it('返回快车页刷新原店铺环境时不覆盖正在编辑的关键词总用量', () => {
    expect(viewSource).toContain('await runPreflight({ silent: true, preserveKeywordUsage: true })')
    expect(viewSource).toContain('if (!options.preserveKeywordUsage && preflight.limitsAvailable')
  })

  it('后台创建进度恢复店铺时不触发普通换店重置流程', () => {
    const progressRestore = viewSource.slice(
      viewSource.indexOf("onUpdate('jd-express-creation-progress'"),
      viewSource.indexOf("onUpdate('jd-express-verification-result'")
    )
    expect(progressRestore).toContain('skipNextStoreWatch = true')
    expect(progressRestore.indexOf('skipNextStoreWatch = true')).toBeLessThan(progressRestore.indexOf('storeId.value = progress.storeId'))
  })

  it('店铺操作与投放环境合并，并为 1080P 保留下一步操作区', () => {
    const environmentCard = viewSource.indexOf('class="status-card environment-card"')
    const storeSelect = viewSource.indexOf('class="store-select"')
    const limitGrid = viewSource.indexOf('class="limit-grid"')
    const toolTabs = viewSource.indexOf('class="tool-tabs"')
    expect(environmentCard).toBeGreaterThan(-1)
    expect(storeSelect).toBeGreaterThan(environmentCard)
    expect(limitGrid).toBeGreaterThan(storeSelect)
    expect(toolTabs).toBeGreaterThan(limitGrid)
    expect(viewSource).not.toContain('class="page-header"')
    expect(viewSource).not.toContain('<h2>京东快车</h2>')
    expect(viewSource).not.toContain('<template #header>')
    expect(viewSource).toContain('const productTableHeight = ref(360)')
    expect(viewSource).toContain('Math.max(240, Math.min(720, availableHeight))')
  })

  it('地域选择使用整行分栏面板，并保留原有勾选逻辑', () => {
    expect(viewSource).toContain('class="area-config-panel"')
    expect(viewSource).toContain('class="area-mode-row"')
    expect(viewSource).toContain('<el-radio-button :value="1">全国不限</el-radio-button>')
    expect(viewSource).toContain('<el-radio-button :value="2">指定区域</el-radio-button>')
    expect(viewSource).toContain('已选 {{ config.areaIds.length }} 个')
    expect(viewSource).toContain('@change="toggleAllAreas"')
    expect(viewSource).toContain('@check="handleAreaCheck"')
    expect(viewSource).toContain('grid-template-columns: repeat(3, minmax(220px, 1fr))')
    expect(viewSource).not.toContain('label="地域设置"')
    expect(viewSource).not.toContain('label="选择投放区域"')
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

  it('首次响应缺少展示昵称但四项额度有效时仍自动展示投放环境', async () => {
    const storeId = { value: 391 }
    const preflight = {
      pin: '旧昵称',
      limitsAvailable: false,
      limits: { keyword: { total: 0, current: 0, surplus: 0 } }
    }
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      pin: '',
      limitsAvailable: true,
      limits: { keyword: { total: 35000, current: 1000, surplus: 34000 } }
    })
    const bindings = {
      ensureStoreSelected: () => true,
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

    await expect(runPreflight({ silent: true })).resolves.toBe(true)
    expect(preflight).toMatchObject({
      pin: '',
      limitsAvailable: true,
      limits: { keyword: { total: 35000, current: 1000, surplus: 34000 } }
    })
    expect(bindings.config.keywordTotalUsage).toBe(34000)
    expect(bindings.resetLimits).not.toHaveBeenCalled()
  })
})
