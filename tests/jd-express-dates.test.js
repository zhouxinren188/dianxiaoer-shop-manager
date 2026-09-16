import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { assertCreationDates, assertPreparedInputsMatch, withPreparedCreationDates,
  formatPlanDate, isValidPlanDate, normalizeRoiConfig } = require('../src/main/jd-express-utils')
const { createCustomCampaigns, createRoiCampaigns, createSingleProductTest } = require('../src/main/jd-express-create')
const main = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
const view = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 15, 13)) })
afterEach(() => vi.useRealTimers())

function mainFunction(name, nextName, bindings) {
  const start = main.indexOf(`async function ${name}(`)
  const end = main.indexOf(`\n${nextName}`, start)
  return new Function(...Object.keys(bindings), main.slice(start, end) + `\nreturn ${name}`)(...Object.values(bindings))
}

const dateCode = view.slice(view.indexOf('function formatLocalDate('), view.indexOf('\nfunction formatMonthDay('))
function viewDates(config = {}) {
  return new Function('config', dateCode + '\nreturn { startDateError, disabledStartDate, disabledEndDate }')(config)
}

describe('快车开始日期规则', () => {
  it('默认本地今天，而不是UTC日期；今天与未来允许，昨天禁止', () => {
    expect(normalizeRoiConfig({}).startDate).toBe('2026-09-15')
    expect(formatPlanDate(new Date(2026, 8, 15, 0, 5))).toBe('2026-09-15')
    expect(assertCreationDates({ startDate: '2026-09-15' })).toBe('2026-09-15')
    expect(assertCreationDates({ startDate: '2026-09-16' })).toBe('2026-09-16')
    expect(() => assertCreationDates({ startDate: '2026-09-14' })).toThrow('开始日期不能早于今天')
  })

  it('校验真实日历日期及截止日期，不允许格式正确但不存在的日期', () => {
    expect(isValidPlanDate('2028-02-29')).toBe(true)
    expect(isValidPlanDate('2027-02-29')).toBe(false)
    for (const date of ['2026-13-01', '2026-09-31', '2026/09/15', 'invalid']) {
      expect(() => assertCreationDates({ startDate: date })).toThrow('有效的开始日期')
    }
    expect(() => assertCreationDates({ startDate: '2026-09-16', unlimitedEndDate: false, endDate: '2026-09-15' }))
      .toThrow('结束日期不能早于开始日期')
    expect(() => assertCreationDates({ startDate: '2026-09-16', unlimitedEndDate: false, endDate: '' }))
      .toThrow('有效的结束日期')
    expect(() => assertCreationDates({ startDate: '2026-09-16', unlimitedEndDate: false, endDate: '2026-09-16' }))
      .not.toThrow()
  })

  it('日期选择器禁止历史，允许今天与未来，不允许手动输入绕过', () => {
    const dates = viewDates({ startDate: '2026-09-17' })
    expect(dates.disabledStartDate(new Date(2026, 8, 14))).toBe(true)
    expect(dates.disabledStartDate(new Date(2026, 8, 15))).toBe(false)
    expect(dates.disabledStartDate(new Date(2026, 8, 16))).toBe(false)
    expect(dates.startDateError('2026-09-14')).toContain('不能早于今天')
    expect(dates.startDateError('2026-09-15')).toBe('')
    expect(dates.disabledEndDate(new Date(2026, 8, 16))).toBe(true)
    expect(dates.disabledEndDate(new Date(2026, 8, 17))).toBe(false)
    expect(view).toContain(':disabled-date="disabledStartDate"')
    expect(view).toContain(':editable="false"')
  })

  it.each(['custom', 'roi'])('恢复%s旧配置：过去或无效日期恢复今天，未来日期保留，其余参数不变', mode => {
    for (const [savedDate, expected] of [['2026-09-05', '2026-09-15'], ['', '2026-09-15'],
      ['2026-09-31', '2026-09-15'], ['2026-09-20', '2026-09-20']]) {
      const config = {}
      const defaults = { startDate: '2026-09-15', dailyBudget: 50, namePrefix: 'default' }
      const bindings = { createDefaultConfig: () => defaults, config, CONFIG_SCHEMA_VERSION: 1,
        localStorage: { getItem: () => JSON.stringify({ startDate: savedDate, dailyBudget: 80, namePrefix: 'saved', schemaVersion: 1 }), removeItem: vi.fn() },
        configStorageKey: () => 'config', keywordSourceOptions: [], keywordMatchTypeOptions: [],
        startDateError: viewDates().startDateError }
      const code = view.slice(view.indexOf('function restoreConfig('), view.indexOf('\nfunction configStorageKey('))
      const restore = new Function(...Object.keys(bindings), code + '\nreturn restoreConfig')(...Object.values(bindings))
      restore(230, mode)
      expect(config).toMatchObject({ startDate: expected, dailyBudget: 80, namePrefix: 'saved' })
    }
  })

  it('页面跨午夜后，再点击创建会发现昨日日期已失效', () => {
    const dates = viewDates()
    expect(dates.startDateError('2026-09-15')).toBe('')
    vi.setSystemTime(new Date(2026, 8, 16, 0, 1))
    expect(dates.startDateError('2026-09-15')).toContain('不能早于今天')
    expect(() => assertCreationDates({ startDate: '2026-09-15' })).toThrow('不能早于今天')
  })
})

describe('主进程在耗时读取/真实写入前拦截历史日期', () => {
  it.each([false, true])('批量创建%s恢复模式在读取登录/准备关键词前拒绝过去日期', async resume => {
    const prepareStore = vi.fn()
    const run = mainFunction('runFullRoiCreation', 'function closeAllJdExpressWindows', {
      resolveCreateMode: () => 'custom', expectedFullCreateConfirmation: () => 'CONFIRM',
      assertCreationDates, assertPreparedInputsMatch, withPreparedCreationDates, prepareStore, normalizeStoreId: Number,
      assertCrowdSettings: () => {},
      getPreparedJob: () => ({ storeId: 230, scope: 'full', data: { config: { startDate: '2026-09-05' } } })
    })
    const payload = { confirmation: 'CONFIRM', config: { startDate: '2026-09-05' },
      ...(resume ? { preparationToken: 'old-token' } : {}) }
    await expect(run(230, payload)).rejects.toMatchObject({ code: 'JD_EXPRESS_DATE_INVALID', creationStage: 'date_validation' })
    expect(prepareStore).not.toHaveBeenCalled()
  })

  it('单独准备关键词时同样在登录/接口读取前校验', async () => {
    const prepareStore = vi.fn()
    const prepare = mainFunction('prepareRoiCreation', 'async function probeSigning', { assertCreationDates, prepareStore })
    await expect(prepare(230, { config: { startDate: '2026-09-05' } })).rejects.toThrow('不能早于今天')
    expect(prepareStore).not.toHaveBeenCalled()
  })

  it.each([
    ['createPreparedFullCampaigns', 'async function runFullRoiCreation', 'CREATE_ALL_CUSTOM_CAMPAIGNS'],
    ['createPreparedSingleProductTest', 'async function createPreparedFullCampaigns', 'CREATE_SINGLE_PRODUCT_TEST']
  ])('%s没有提供修正日期时，旧准备结果仍在登录前拦截', async (name, next, confirmation) => {
    const prepareStore = vi.fn()
    const create = mainFunction(name, next, {
      assertCreationDates, assertPreparedInputsMatch, withPreparedCreationDates, prepareStore, clearExpiredPreparedJobs: vi.fn(),
      getPreparedJob: () => ({ data: { config: { startDate: '2026-09-05' } } })
    })
    await expect(create(230, { confirmation, preparationToken: 'token' }))
      .rejects.toThrow('不能早于今天')
    expect(prepareStore).not.toHaveBeenCalled()
  })

  it.each([createCustomCampaigns, createRoiCampaigns, createSingleProductTest])('底层创建不能绕过日期校验，不发送签名或京东请求', async create => {
    const requestJson = vi.fn()
    const signBody = vi.fn()
    await expect(create({ eid: 'eid', requestJson, signBody, prepared: {
      config: { startDate: '2026-09-05' },
      summary: { campaignCount: 1, unitCount: 1, productCount: 1 },
      campaigns: [{ planName: 'plan', units: [{ products: [{ skuId: '1' }], keywordList: [] }] }]
    } })).rejects.toMatchObject({ code: 'JD_EXPRESS_DATE_INVALID' })
    expect(requestJson).not.toHaveBeenCalled()
    expect(signBody).not.toHaveBeenCalled()
  })
})
