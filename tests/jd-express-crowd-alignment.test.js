import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const crowds = require('../src/main/jd-express-crowds')
const { normalizeRoiConfig } = require('../src/main/jd-express-utils')
const { buildCustomCampaignCreateBody, buildCustomAdditionalAdGroupBody, createCustomCampaigns } = require('../src/main/jd-express-create')
const { isJdSessionFailure, isJdSessionExpiredPayload } = require('../src/main/jd-session-recovery')
const { creationBodySummary, createCreationLogger } = require('../src/main/jd-express-creation-log')
const main = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
const view = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')

function extract(source, start, next) {
  const begin = source.indexOf(start)
  const end = source.indexOf(`\n${next}`, begin)
  if (begin < 0 || end <= begin) throw new Error(`Missing ${start}`)
  return source.slice(begin, end)
}

function evaluate(source, bindings, name) {
  return new Function(...Object.keys(bindings), source + `\nreturn ${name}`)(...Object.values(bindings))
}

function requestError(message, code) { return Object.assign(new Error(message), { code }) }
const assertCrowdPayload = evaluate(extract(main, 'function assertCrowdPayload(', 'function getCrowdRequestOptions'), {
  isJdSessionExpiredPayload, createRequestError: requestError,
  getMessage: (value, fallback) => value.message || value.msg || fallback
}, 'assertCrowdPayload')

function loader(responses) {
  const signingWindow = { isDestroyed: () => false, destroy: vi.fn() }
  const requestJson = vi.fn(async () => {
    const value = responses.shift()
    if (value instanceof Error) throw value
    return value
  })
  const activeProbeWindows = new Set([signingWindow])
  const load = evaluate(extract(main, 'async function fetchCrowdOptions(', 'async function fetchProductPage'), {
    ...crowds, prepareStore: async () => ({ storeId: 230, platformSession: {} }),
    openReadySigningWindow: async () => signingWindow,
    signSceneCrowdRequestInWindow: async () => ({ h5st: 'private-signature', stk: 'private-stk' }),
    getCrowdRequestOptions: body => ({ method: 'POST', body }),
    assertCrowdPayload, requestJson, isJdSessionFailure, activeProbeWindows,
    createRequestError: requestError, delay: async () => {}
  }, 'fetchCrowdOptions')
  return { load, requestJson, signingWindow, activeProbeWindows }
}

const category = (code, name = `场景${code}`) => ({ categoryCode: code, categoryName: name, level: 0 })
const page = (data, total) => ({ code: 1, success: true, data: { data, ...(total == null ? {} : { total }) } })
const template = { crowdId: 762589, crowdName: '店铺或品牌相关人群', crowdType: 4, recommendCrowdType: 2 }

describe('一键自定义场景人群加载与失败边界', () => {
  it('完整分页多个场景、去重、过滤种子模板，不偷偷勾选默认人群', async () => {
    const firstPage = Array.from({ length: 40 }, (_, i) => ({ crowdId: i + 1000, crowdName: `人群${i}`, crowdType: 1 }))
    const h = loader([
      { code: 1, success: true, data: [category(0), category(1)] },
      page(firstPage, 41), page([{ crowdId: 1040, crowdName: '最后一个' }], 41),
      page([template, { crowdId: 1000, crowdName: '重复人群' }, { crowdId: 2000, crowdName: '第二场景' }])
    ])
    const result = await h.load(230)
    expect(result).toMatchObject({ success: true, partial: false, sceneCount: 42, pagesRead: 3, excludedCount: 1 })
    expect(result.crowds).toHaveLength(44)
    expect(result.crowds.slice(0, 2).map(item => item.crowdId)).toEqual([100, 101])
    expect(result.crowds.find(item => item.crowdId === 762589)).toBeUndefined()
    expect(result.crowds.find(item => item.crowdId === 2000).sceneCategoryName).toBe('场景1')
    expect(h.requestJson.mock.calls[2][2].body).toMatchObject({ pageIndex: 2, firstSenceCategory: 0, crowdTabType: 1 })
    expect(h.requestJson.mock.calls.every(call => !/crowdsandseeds|searchcrowdlist/.test(call[1]))).toBe(true)
    expect(h.signingWindow.destroy).toHaveBeenCalledOnce()
    expect(h.activeProbeWindows.size).toBe(0)
    expect(normalizeRoiConfig({ createMode: 'custom' }).dmpCrowdSettings).toEqual([])
  })

  it('无总数但满 40 条时继续读取下一页，而非漏掉后续人群', async () => {
    const h = loader([{ data: [category(0)] }, page(Array.from({ length: 40 }, (_, i) => ({ crowdId: i + 1 }))), page([{ crowdId: 50 }])])
    expect(await h.load(230)).toMatchObject({ pagesRead: 2, sceneCount: 41, partial: false })
  })

  it('京东重复返回同一整页时停止并提示部分加载，避免无限循环', async () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ crowdId: i + 1 }))
    const h = loader([{ data: [category(0)] }, page(data), page(data)])
    expect(await h.load(230)).toMatchObject({ pagesRead: 2, sceneCount: 40, partial: true })
    expect(h.requestJson).toHaveBeenCalledTimes(3)
  })

  it('普通场景错误允许其他场景部分显示，但会标明错误', async () => {
    const h = loader([{ data: [category(0), category(1)] }, { code: 0, success: false, message: '京东忙' }, page([{ crowdId: 10 }])])
    expect(await h.load(230)).toMatchObject({ partial: true, errors: [{ source: 'scene', message: '场景0：京东忙' }] })
  })

  it.each([
    { code: 0, success: false, message: 'NotLogin' },
    Object.assign(new Error('请重新登录'), { code: 'JD_SESSION_RELOGIN_REQUIRED' })
  ])('后续场景失效时终止，不用无效 Cookie 继续加载：%j', async expired => {
    const h = loader([{ data: [category(0), category(1), category(2)] }, page([{ crowdId: 10 }]), expired])
    await expect(h.load(230)).rejects.toMatchObject({ code: expired.code === 0 ? 'JD_SESSION_EXPIRED' : expired.code })
    expect(h.requestJson).toHaveBeenCalledTimes(3)
    expect(h.signingWindow.destroy).toHaveBeenCalledOnce()
  })

  it.each([{ data: {} }, { data: [category(0)] }])('分类异常或所有场景失败不能伪装成加载成功', async categories => {
    const h = loader([categories, { success: false, code: 0, message: '失败' }])
    await expect(h.load(230)).rejects.toThrow()
    expect(h.signingWindow.destroy).toHaveBeenCalledOnce()
  })

  it('畸形列表不是没有人群，错误会明确提示', async () => {
    const h = loader([{ data: [category(0)] }, { code: 1, success: true, data: { datas: [] } }])
    await expect(h.load(230)).rejects.toThrow('响应格式异常')
  })

  it('null 和空溢价使用新选默认 30，已有溢价 10 不被覆盖', () => {
    expect(crowds.normalizeCrowdSettings([
      { crowdId: 1, adGroupPrice: null }, { crowdId: 2, adGroupPrice: '' }, { crowdId: 3, adGroupPrice: 10 }
    ]).map(item => item.adGroupPrice)).toEqual([30, 30, 10])
  })
})

describe('提交边界不能绕过人群校验', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 15, 12)) })
  afterEach(() => vi.useRealTimers())
  const unit = { unitName: '单元', products: [{ skuId: '1', name: '商品' }], keywordList: [{ keywordName: '商品', keywordMobilePrice: 0.1 }] }
  const config = { createMode: 'custom', startDate: '2026-09-15', dmpCrowdSettings: [template], useMinKeywordBid: true }

  it('准备结构就拒绝旧模板，而不是到广告提交阶段才发现', () => {
    expect(() => normalizeRoiConfig(config)).toThrow('需要配置种子')
  })

  it('关键词准备前拒绝旧人群，不查询登录、不重跑关键词', async () => {
    const prepareStore = vi.fn()
    const prepare = evaluate(extract(main, 'async function prepareRoiCreation(', 'async function probeSigning'), {
      assertCreationDates: () => {}, assertCrowdSettings: crowds.assertCrowdSettings, prepareStore
    }, 'prepareRoiCreation')
    await expect(prepare(230, { config })).rejects.toMatchObject({ code: 'JD_EXPRESS_CROWD_SEED_REQUIRED' })
    expect(prepareStore).not.toHaveBeenCalled()
  })

  it.each(['create', 'append'])('%s参数构造不能把种子模板提交成普通人群', mode => {
    expect(() => mode === 'create'
      ? buildCustomCampaignCreateBody({ planName: '计划', units: [unit] }, config, 'version')
      : buildCustomAdditionalAdGroupBody(unit, config, 'version', 1)).toThrow('需要配置种子')
  })

  it('底层批量入口在任何价格/签名/创建请求前拒绝旧模板', async () => {
    const requestJson = vi.fn(), signBody = vi.fn()
    await expect(createCustomCampaigns({ eid: 'private', requestJson, signBody,
      prepared: { config, campaigns: [{ planName: '计划', units: [unit] }] }
    })).rejects.toMatchObject({ code: 'JD_EXPRESS_CROWD_SEED_REQUIRED' })
    expect(requestJson).not.toHaveBeenCalled()
    expect(signBody).not.toHaveBeenCalled()
  })

  it('正常人群提交保留用户溢价、清除界面字段，并仍使用空种子列表', () => {
    const body = buildCustomAdditionalAdGroupBody(unit, { ...config,
      dmpCrowdSettings: [{ crowdId: 100, crowdType: 1, crowdName: '默认购买', adGroupPrice: 20, source: 'default', sceneCategoryName: '场景名称', editing: true }]
    }, 'version', 1)
    expect(body.seedsList).toEqual([])
    expect(body.dmpCrowdSettings).toEqual([{ crowdId: 100, crowdType: 1, crowdName: '默认购买', adGroupPrice: 20, isUsed: 1 }])
  })

  it('页面与主进程都识别种子模板，只有用户点击才清除旧选择', () => {
    const uiRequiresSeed = evaluate(extract(view, 'function requiresCrowdSeed(', 'function removeUnsupportedCrowds'), {}, 'requiresCrowdSeed')
    for (const item of [template, { crowdType: '4' }, { recommendCrowdType: 2 }, { crowdType: 1 }, null]) {
      expect(uiRequiresSeed(item)).toBe(crowds.requiresCrowdSeed(item))
    }
    const config = { dmpCrowdSettings: [template, { crowdId: 100, adGroupPrice: 10 }] }
    const clear = evaluate(extract(view, 'function removeUnsupportedCrowds(', 'function isCrowdSelected'), {
      config, requiresCrowdSeed: uiRequiresSeed, configFormRef: { value: null }
    }, 'removeUnsupportedCrowds')
    expect(config.dmpCrowdSettings).toHaveLength(2)
    clear()
    expect(config.dmpCrowdSettings).toEqual([{ crowdId: 100, adGroupPrice: 10 }])
  })

  it('请求摘要记录人群 ID/类型与种子数，不泄露 Cookie/签名', () => {
    const body = { dmpCrowdSettings: [{ crowdId: 100, crowdType: 1 }], seedsList: [], h5st: 'private' }
    const writeLog = vi.fn()
    createCreationLogger({ storeId: 230, runId: 'run', createMode: 'custom', writeLog })({
      ...creationBodySummary(body), stage: 'request_summary', cookie: 'private', body
    })
    expect(writeLog.mock.calls[0][1]).toContain('"seedCount":0')
    expect(writeLog.mock.calls[0][1]).toContain('"crowdIds":["100"]')
    expect(writeLog.mock.calls[0][1]).not.toMatch(/private|h5st|cookie/)
  })
})
