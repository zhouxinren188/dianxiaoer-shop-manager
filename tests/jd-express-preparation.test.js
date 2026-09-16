import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { reactive, ref, watch, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { assertCrowdSettings } = require('../src/main/jd-express-crowds')
const { assertCreationDates, assertPreparedInputsMatch, withPreparedCreationDates,
  normalizeRoiConfig } = require('../src/main/jd-express-utils')
const main = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
const view = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')
const token = '71c52c66-3488-4617-b675-261db31b7a32'
const ttl = Number(new Function(main.match(/const PREPARED_JOB_TTL_MS = ([^\r\n]+)/)[0] + '; return PREPARED_JOB_TTL_MS')())
const stops = []

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 15, 23, 50)) })
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers() })

function evaluate(source, bindings, returned) {
  return new Function(...Object.keys(bindings), source + `\nreturn ${returned}`)(...Object.values(bindings))
}

function mainFunction(name, next, bindings) {
  const start = main.indexOf(`async function ${name}(`)
  const end = main.indexOf(`\n${next}`, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return evaluate(main.slice(start, end), bindings, name)
}

function preparedFixture() {
  const keywordList = [{ keyword: '光纤传感器', bid: 0.1 }]
  const unit = { unitName: '单元1', products: [{ skuId: '1' }], keywordList }
  return { config: normalizeRoiConfig({ createMode: 'custom', startDate: '2026-09-15', keywordSources: [2] }),
    products: [{ skuId: '1' }], units: [unit], campaigns: [{ planName: '计划1', units: [unit] }],
    summary: { campaignCount: 1, unitCount: 1, productCount: 1 }, keywordSummary: { actualKeywordCount: 1 } }
}

function cacheHarness() {
  const files = new Map()
  const memory = new Map()
  const fs = {
    failDelete: false, failWrite: false,
    existsSync: name => files.has(name),
    writeFileSync: vi.fn((name, value) => { if (fs.failWrite) throw new Error('disk full'); files.set(name, value) }),
    readFileSync: name => files.get(name),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    unlinkSync: vi.fn(name => { if (fs.failDelete) throw new Error('access denied'); files.delete(name) }),
    readdirSync: directory => [...files.keys()].filter(name => path.dirname(name) === directory)
      .map(name => ({ name: path.basename(name), isFile: () => true }))
  }
  const source = main.slice(main.indexOf('function getPreparedJobCacheDirectory('), main.indexOf('\nfunction summarizePreparedUnits('))
  const cache = evaluate(source, {
    fs, path, process: { pid: 1 }, preparedRoiJobs: memory,
    getManagedTempDirectory: () => path.resolve('managed-data', 'jd-express-prepared'),
    PREPARED_JOB_FILE_PATTERN: /^[0-9a-f-]{16,64}\.json$/i,
    runtimeLog: { writeLog: vi.fn() }, logSafe: String,
    createRequestError: (message, code) => Object.assign(new Error(message), { code })
  }, '{ getPreparedJob, persistPreparedJob, consumePreparedJob, clearExpiredPreparedJobs, getPreparedJobFilePath }')
  const job = { storeId: 230, scope: 'full', createdAt: Date.now(), expiresAt: Date.now() + ttl, data: preparedFixture() }
  cache.persistPreparedJob(token, job)
  return { ...cache, fs, files, memory, job }
}

function viewHarness() {
  const config = reactive({ ...preparedFixture().config })
  const selectedProducts = reactive(new Map([['1', { skuId: '1' }]]))
  const storeId = ref(230), activeTool = ref('custom'), resumePreparationToken = ref('')
  const preparedKeywordResult = ref({ prepared: true }), preparedFullResult = ref({ prepared: true })
  const storage = new Map()
  const localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const source = view.slice(view.indexOf('function keywordPreparationConfig('), view.indexOf('\nfunction ensureStoreSelected('))
  const functions = evaluate(source, { config, selectedProducts, storeId, activeTool, resumePreparationToken, localStorage,
    preparationStorageKey: () => 'prepared', toIpcPlainData: value => JSON.parse(JSON.stringify(value))
  }, '{ creationInputSignature, rememberPreparationToken, readPreparationToken }')
  const dateSource = view.slice(view.indexOf('function formatLocalDate('), view.indexOf('\nfunction formatMonthDay('))
  const dates = evaluate(dateSource, { config }, '{ refreshExpiredStartDate }')
  const watches = view.slice(view.indexOf('watch(config,'), view.indexOf('\nfunction createDefaultConfig('))
  evaluate(watches, { watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop }, config,
    storeId, localStorage, configStorageKey: () => 'config', ...functions, preparedKeywordResult, preparedFullResult, resumePreparationToken
  }, 'undefined')
  return { config, selectedProducts, activeTool, storeId, resumePreparationToken,
    preparedKeywordResult, preparedFullResult, ...functions, ...dates }
}

function creationHarness(cache = cacheHarness()) {
  const prepared = preparedFixture()
  const createCampaigns = vi.fn(async () => ({ successUnitCount: 1, successCampaignCount: 1, failureCount: 0, unitCount: 1, campaignCount: 1 }))
  const createSingle = vi.fn(async () => ({ campaignId: '1' }))
  const openReadySigningWindow = vi.fn(async () => ({ isDestroyed: () => false, destroy: vi.fn() }))
  const bindings = { ...cache, assertCreationDates, assertPreparedInputsMatch, withPreparedCreationDates, assertCrowdSettings,
    normalizeStoreId: Number, prepareStore: vi.fn(async () => ({ storeId: 230, platformSession: {} })),
    getJdEidCookie: async () => 'eid', openReadySigningWindow, activeProbeWindows: new Set(),
    createRequestError: (message, code) => Object.assign(new Error(message), { code }),
    expectedFullCreateConfirmation: mode => mode === 'custom' ? 'CREATE_ALL_CUSTOM_CAMPAIGNS' : 'CREATE_ALL_ROI_CAMPAIGNS',
    createCustomCampaigns: createCampaigns, createRoiCampaigns: createCampaigns, createSingleProductTest: createSingle,
    requestJson: vi.fn(), signBodyInWindow: vi.fn(), delay: vi.fn(),
    resolveCreateMode: () => 'custom', probeSigning: vi.fn(), runtimeLog: { writeLog: vi.fn() },
    prepareRoiCreation: vi.fn(async () => {
      vi.setSystemTime(new Date(2026, 8, 16, 0, 10))
      const job = { ...cache.job, createdAt: Date.now(), expiresAt: Date.now() + ttl, data: prepared }
      cache.memory.set(token, job); cache.persistPreparedJob(token, job)
      return { preparationToken: token, expiresAt: job.expiresAt, summary: prepared.summary, keywordSummary: prepared.keywordSummary }
    }) }
  const createFull = mainFunction('createPreparedFullCampaigns', 'async function runFullRoiCreation', bindings)
  const createSinglePrepared = mainFunction('createPreparedSingleProductTest', 'async function createPreparedFullCampaigns', bindings)
  const run = mainFunction('runFullRoiCreation', 'function closeAllJdExpressWindows', { ...bindings, createPreparedFullCampaigns: createFull })
  return { cache, run, createFull, createSinglePrepared, createCampaigns, createSingle, bindings, prepared }
}

describe('未提交的关键词跨夜恢复', () => {
  it('默认缓存24小时，跨午夜且重启后能恢复，但到期不继续复用最低出价', () => {
    const cache = cacheHarness()
    expect(ttl).toBe(24 * 60 * 60 * 1000)
    vi.setSystemTime(new Date(2026, 8, 16, 8))
    expect(cache.getPreparedJob(token).data.units[0].keywordList).toEqual(cache.job.data.units[0].keywordList)
    cache.memory.clear()
    expect(cache.getPreparedJob(token)).not.toBeNull()
    vi.setSystemTime(cache.job.expiresAt)
    expect(cache.getPreparedJob(token)).toBeNull()
  })

  it('仅日期变化不改变前端恢复签名，不清空关键词/令牌，其他字段照常保存', async () => {
    const h = viewHarness()
    h.rememberPreparationToken(token, Date.now() + ttl)
    const signature = h.creationInputSignature()
    vi.setSystemTime(new Date(2026, 8, 16, 8))
    expect(h.refreshExpiredStartDate()).toBe(true)
    h.config.endDate = '2026-09-20'; h.config.unlimitedEndDate = false
    await nextTick()
    expect(h.config.startDate).toBe('2026-09-16')
    expect(h.creationInputSignature()).toBe(signature)
    expect(h.preparedFullResult.value).not.toBeNull()
    expect(h.preparedKeywordResult.value).not.toBeNull()
    expect(h.readPreparationToken()).toBe(token)
    vi.setSystemTime(new Date(2026, 8, 16, 23, 50))
    expect(h.readPreparationToken()).toBe('')
  })

  it('未来日期、损坏日期和空值不会被跨天刷新静默替换', () => {
    const h = viewHarness()
    for (const value of ['2026-09-20', '2026-09-31', 'invalid', '']) {
      h.config.startDate = value
      expect(h.refreshExpiredStartDate()).toBe(false)
      expect(h.config.startDate).toBe(value)
    }
  })

  it.each(['bid', 'maxBid', 'source', 'sku', 'mode'])('%s变动必须使前端准备结果失效', async change => {
    const h = viewHarness()
    h.rememberPreparationToken(token, Date.now() + ttl)
    if (change === 'bid') h.config.customKeywordBid = 0.3
    if (change === 'maxBid') h.config.maxCustomKeywordBid = 0.5
    if (change === 'source') h.config.keywordSources = [3]
    if (change === 'sku') h.selectedProducts.set('2', { skuId: '2' })
    if (change === 'mode') h.activeTool.value = 'roi'
    await nextTick()
    expect(h.preparedFullResult.value).toBeNull()
    expect(h.preparedKeywordResult.value).toBeNull()
    expect(h.readPreparationToken()).toBe('')
  })

  it('只覆盖日期，保持原关键词和出价，不修改持久化准备数据', () => {
    const prepared = preparedFixture()
    vi.setSystemTime(new Date(2026, 8, 16, 8))
    const result = withPreparedCreationDates(prepared, { startDate: '2026-09-16', customKeywordBid: 99, namePrefix: 'bad' })
    expect(result.config.startDate).toBe('2026-09-16')
    expect(result.config.customKeywordBid).toBe(0.1)
    expect(result.units[0].keywordList).toBe(prepared.units[0].keywordList)
    expect(prepared.config.startDate).toBe('2026-09-15')
    expect(() => assertPreparedInputsMatch(prepared, { config: { customKeywordBid: 99 } })).toThrow('不匹配')
    expect(() => assertPreparedInputsMatch(prepared, { products: [{ skuId: '2' }] })).toThrow('不匹配')
  })

  it('耗时准备跨午夜被拦截后返回令牌，更正日期直接复用，不重复查词', async () => {
    const h = creationHarness()
    const payload = { confirmation: 'CREATE_ALL_CUSTOM_CAMPAIGNS', config: h.prepared.config, products: h.prepared.products }
    await expect(h.run(230, payload)).rejects.toMatchObject({ code: 'JD_EXPRESS_DATE_INVALID', preparationToken: token })
    expect(h.createCampaigns).not.toHaveBeenCalled()
    expect(h.cache.getPreparedJob(token)).not.toBeNull()
    await expect(h.run(230, { ...payload, preparationToken: token, config: { ...payload.config, startDate: '2026-09-16' } }))
      .resolves.toMatchObject({ successUnitCount: 1 })
    expect(h.bindings.prepareRoiCreation).toHaveBeenCalledTimes(1)
    expect(h.createCampaigns.mock.calls[0][0].prepared.units[0].keywordList).toBe(h.prepared.units[0].keywordList)
    expect(h.createCampaigns.mock.calls[0][0].prepared.config.startDate).toBe('2026-09-16')
    expect(h.cache.getPreparedJob(token)).toBeNull()
  })

  it('打开签名窗口时再次跨午夜，校验失败不能消费准备令牌', async () => {
    const h = creationHarness()
    h.bindings.openReadySigningWindow.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(2026, 8, 16, 0, 1))
      return { isDestroyed: () => false, destroy: vi.fn() }
    })
    await expect(h.createFull(230, { preparationToken: token, confirmation: 'CREATE_ALL_CUSTOM_CAMPAIGNS' }))
      .rejects.toMatchObject({ code: 'JD_EXPRESS_DATE_INVALID' })
    expect(h.cache.getPreparedJob(token)).not.toBeNull()
    expect(h.createCampaigns).not.toHaveBeenCalled()
  })
})

describe('24小时缓存不允许重复创建', () => {
  it('旧草稿含需要种子的人群时提前拒绝，保留未提交的关键词令牌', async () => {
    const h = creationHarness()
    const job = h.cache.getPreparedJob(token)
    job.data.config.dmpCrowdSettings = [{ crowdId: 762589, crowdType: 4, crowdName: '店铺或品牌相关人群' }]
    await expect(h.createFull(230, { preparationToken: token, confirmation: 'CREATE_ALL_CUSTOM_CAMPAIGNS' }))
      .rejects.toMatchObject({ code: 'JD_EXPRESS_CROWD_SEED_REQUIRED' })
    expect(h.cache.getPreparedJob(token)).not.toBeNull()
    expect(h.createCampaigns).not.toHaveBeenCalled()
    expect(h.bindings.openReadySigningWindow).not.toHaveBeenCalled()
  })
  it('真实提交失败或返回不确定后，不能恢复已经消费的批次', async () => {
    const h = creationHarness()
    h.createCampaigns.mockRejectedValueOnce(new Error('network uncertain'))
    const payload = { preparationToken: token, confirmation: 'CREATE_ALL_CUSTOM_CAMPAIGNS', config: h.prepared.config }
    let error
    try { await h.run(230, payload) } catch (caught) { error = caught }
    expect(error.message).toBe('network uncertain')
    expect(error.preparationToken).toBeUndefined()
    await expect(h.run(230, payload)).rejects.toMatchObject({ code: 'JD_EXPRESS_PREPARATION_EXPIRED' })
    expect(h.createCampaigns).toHaveBeenCalledTimes(1)
  })

  it('单商品也按修正日期使用已有关键词，开始提交前消费令牌', async () => {
    const h = creationHarness()
    h.cache.job.scope = 'single_product_test'
    h.cache.persistPreparedJob(token, h.cache.job)
    vi.setSystemTime(new Date(2026, 8, 16, 8))
    h.createSingle.mockImplementationOnce(async options => {
      expect(h.cache.getPreparedJob(token)).toBeNull()
      expect(options.prepared.config.startDate).toBe('2026-09-16')
      throw new Error('network uncertain')
    })
    await expect(h.createSinglePrepared(230, { preparationToken: token, confirmation: 'CREATE_SINGLE_PRODUCT_TEST',
      creationDates: { startDate: '2026-09-16' } })).rejects.toThrow('network uncertain')
    expect(h.cache.getPreparedJob(token)).toBeNull()
  })

  it('即使磁盘文件删除失败，消费标记仍阻止重启后再次提交', () => {
    const cache = cacheHarness()
    cache.fs.failDelete = true
    cache.consumePreparedJob(token)
    cache.memory.clear()
    expect(cache.getPreparedJob(token)).toBeNull()
    expect(JSON.parse(cache.files.get(cache.getPreparedJobFilePath(token))).consumed).toBe(true)
  })

  it('不能持久化消费标记时，停止在提交前，仍保留原准备结果', async () => {
    const h = creationHarness()
    h.cache.fs.failWrite = true
    await expect(h.createFull(230, { preparationToken: token, confirmation: 'CREATE_ALL_CUSTOM_CAMPAIGNS' }))
      .rejects.toMatchObject({ code: 'JD_EXPRESS_PREPARATION_CACHE_FAILED' })
    expect(h.createCampaigns).not.toHaveBeenCalled()
    expect(h.cache.getPreparedJob(token)).not.toBeNull()
  })
})
