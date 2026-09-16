import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 15, 12)) })
afterEach(() => vi.useRealTimers())
const { createCustomCampaigns, createRoiCampaigns, CREATE_CAMPAIGN_URL, ADD_ADGROUP_URL } = require('../src/main/jd-express-create')
const { createCreationLogger, creationBodySummary, creationErrorDetails, creationOutcome, runCreationStage } = require('../src/main/jd-express-creation-log')
const unit = {
  unitName: '单元1', products: [{ skuId: '1001', name: '测试商品', raw: {} }],
  keywordList: [{ keywordName: '商品', keywordMobilePrice: 0.1 }]
}
const config = {
  areaType: 1, createMode: 'custom', automatedBiddingType: 0, inSearchFee: 0.1,
  orientationRangeOption: [1], startDate: '2026-09-15', unlimitedEndDate: true,
  unlimitedBudget: true, dmpCrowdSettings: [], bidType: 3, bottomLimit: 3
}

function options(overrides = {}) {
  return {
    platformSession: {}, eid: 'private-eid', signBody: vi.fn(async () => ({ h5st: 'private-signature' })),
    requestJson: vi.fn(async (_session, url) => {
      if (url.includes('suggest/price')) return { code: 1, data: { recommendFloorBid: 3 } }
      if (url.includes('recommendautobidding')) return { code: 1, data: [{ sid: 'v1' }] }
      return { subCode: 1, data: { campaignId: 99 } }
    }),
    prepared: { config, summary: { campaignCount: 1 }, campaigns: [{ planName: '计划1', units: [unit] }] },
    onDiagnostic: vi.fn(), onProgress: vi.fn(), delay: vi.fn(async () => {}), ...overrides
  }
}

describe('快车逐计划/单元创建诊断', () => {
  it('全部失败保留京东返回码，所有受影响单元落日志，而且不补建或重试', async () => {
    const opts = options({
      prepared: { config, campaigns: [
        { planName: '计划1', units: [unit, { ...unit, unitName: '单元2' }] },
        { planName: '计划2', units: [unit] }
      ] },
      requestJson: vi.fn(async (_session, url) => url.includes('recommendautobidding')
        ? { code: 1, data: [{ sid: 'v1' }] }
        : { code: 0, subCode: 400, subMsg: '关键词出价不符合要求', traceId: 'trace-1' })
    })
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ successCampaignCount: 0, successUnitCount: 0, failureCount: 3 })
    expect(result.failures[1]).toMatchObject({ stage: 'submit', jdCode: '0', jdSubCode: '400',
      endpoint: CREATE_CAMPAIGN_URL, traceId: 'trace-1', blockedByCampaign: true, unitIndex: 2 })
    expect(opts.requestJson).toHaveBeenCalledTimes(4)
    expect(opts.signBody).toHaveBeenCalledTimes(2)
    const diagnostics = opts.onDiagnostic.mock.calls.map(([event]) => event)
    expect(diagnostics.filter(event => event.result === 'unit_failed')).toHaveLength(3)
    expect(diagnostics.filter(event => event.stage === 'submit' && event.result === 'failed')).toHaveLength(2)
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-eid|private-signature|h5st=/)
    expect(creationOutcome(result)).toBe('failed')
  })

  it.each([['自定义', createCustomCampaigns], ['ROI', createRoiCampaigns]])('%s 模式签名失败时记录阶段且不提交创建接口', async (_name, create) => {
    const opts = options({ signBody: vi.fn(async () => { throw new Error('签名组件超时') }) })
    const result = await create(opts)
    expect(result.failures[0]).toMatchObject({ stage: 'sign', message: '签名组件超时', endpoint: CREATE_CAMPAIGN_URL })
    expect(opts.requestJson.mock.calls.some(([, url]) => url.startsWith(CREATE_CAMPAIGN_URL))).toBe(false)
    expect(opts.onDiagnostic.mock.calls.some(([event]) => event.result === 'failed' && event.stage === 'sign')).toBe(true)
  })

  it('获取提交版本失败保留返回码，不调用签名/创建接口', async () => {
    const opts = options({ requestJson: vi.fn(async () => ({ code: -1, message: '提交版本不可用' })) })
    const result = await createCustomCampaigns(opts)
    expect(result.failures[0]).toMatchObject({ stage: 'version', jdCode: '-1' })
    expect(opts.requestJson).toHaveBeenCalledTimes(1)
    expect(opts.signBody).not.toHaveBeenCalled()
  })

  it('生成请求失败有阶段信息', async () => {
    const opts = options({ prepared: { config, campaigns: [{ planName: '空关键词', units: [{ ...unit, keywordList: [] }] }] } })
    const result = await createCustomCampaigns(opts)
    expect(result.failures[0]).toMatchObject({ stage: 'build_body', message: '推广单元没有可提交的关键词及出价' })
    expect(opts.signBody).not.toHaveBeenCalled()
  })

  it.each([createCustomCampaigns, createRoiCampaigns])('追加单元失败不标记成功，保留已创建计划及首单元', async create => {
    const opts = options({ prepared: { config, campaigns: [{ planName: '计划1', units: [unit, { ...unit, unitName: '追加单元' }] }] } })
    const original = opts.requestJson
    opts.requestJson = vi.fn((platformSession, url, body) => url.startsWith(ADD_ADGROUP_URL)
      ? Promise.resolve({ subCode: 403, subMsg: '新增单元被拒绝' }) : original(platformSession, url, body))
    const result = await create(opts)
    expect(result).toMatchObject({ successCampaignCount: 1, successUnitCount: 1, failureCount: 1 })
    expect(result.failures[0]).toMatchObject({ stage: 'submit', endpoint: ADD_ADGROUP_URL, unitIndex: 2 })
    expect(opts.onProgress.mock.calls.at(-1)[0].phase).toBe('create_adgroup_failed')
    expect(creationOutcome(result)).toBe('partial')
  })

  it('京东返回成功但缺少计划ID时记录核对返回阶段', async () => {
    const opts = options()
    const original = opts.requestJson
    opts.requestJson = vi.fn((session, url, body) => url.startsWith(CREATE_CAMPAIGN_URL)
      ? Promise.resolve({ subCode: 1, data: {} }) : original(session, url, body))
    const result = await createCustomCampaigns(opts)
    expect(result.failures[0]).toMatchObject({ stage: 'validate_response', jdSubCode: '1' })
    expect(result.successCampaignCount).toBe(0)
  })

  it('记录精简出价参数，不把请求体和签名传给日志回调', async () => {
    const opts = options()
    await createCustomCampaigns(opts)
    const summary = opts.onDiagnostic.mock.calls.map(([event]) => event).find(event => event.stage === 'request_summary')
    expect(summary).toMatchObject({ submittedPlanName: '计划1', submittedUnitName: '计划1',
      inSearchFee: 0.1, automatedBiddingType: 0, crowdCount: 0, keywordMinBid: 0.1, keywordMaxBid: 0.1 })
    expect(summary).not.toHaveProperty('body')
    expect(summary).not.toHaveProperty('keywordList')
  })

  it('日志回调异常不能影响真实创建，也不能多发一次请求', async () => {
    const opts = options({ onDiagnostic: () => { throw new Error('磁盘已满') } })
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ successCampaignCount: 1, successUnitCount: 1, failureCount: 0 })
    expect(opts.requestJson).toHaveBeenCalledTimes(2)
    expect(opts.signBody).toHaveBeenCalledTimes(1)
    expect(creationOutcome(result)).toBe('success')
  })
})

describe('诊断日志脱敏和接口异常信息', () => {
  it('异常请求摘要不会抛出错误而中断真实创建', () => {
    expect(creationBodySummary(null)).toEqual({})
    expect(creationBodySummary({ keywordList: [{ keywordMobilePrice: Symbol('invalid') }] })).toEqual({})
  })
  it('只记录允许字段，剥离URL签名参数，并遮盖报错中回显的登录信息', () => {
    const writeLog = vi.fn()
    const logger = createCreationLogger({ storeId: 230, runId: 'run-1', createMode: 'custom', writeLog })
    logger({ stage: 'submit', result: 'failed', endpoint: `${CREATE_CAMPAIGN_URL}?eid=private&h5st=secret`,
      message: `请求 ${CREATE_CAMPAIGN_URL}?eid=private&h5st=secret 失败\neid=private token=private\nCookie: thor=private; pin=private`,
      headers: { cookie: 'private' }, body: { password: 'private' }, h5st: 'secret',
      skuIds: Array.from({ length: 25 }, (_, i) => i), jdSubCode: 0 })
    const text = writeLog.mock.calls[0][1]
    expect(text).toContain('run_id=run-1 store_id=230 create_mode=custom')
    expect(text).not.toMatch(/private|secret|headers|password/)
    const detail = JSON.parse(text.split(' detail=')[1])
    expect(detail.skuIds).toHaveLength(20)
    expect(detail.jdSubCode).toBe(0)
    expect(detail.endpoint).toBe(CREATE_CAMPAIGN_URL)
  })

  it('超时阶段保留安全接口和底层网络原因', async () => {
    const error = Object.assign(new Error('请求超时'), { code: 'JD_EXPRESS_TIMEOUT',
      cause: { message: 'fetch failed', cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: '连接超时' } } })
    const onDiagnostic = vi.fn()
    await expect(runCreationStage(onDiagnostic, {}, 'submit', `${CREATE_CAMPAIGN_URL}?h5st=private`,
      () => { throw error })).rejects.toBe(error)
    expect(creationErrorDetails(error)).toMatchObject({ stage: 'submit', endpoint: CREATE_CAMPAIGN_URL,
      code: 'JD_EXPRESS_TIMEOUT', networkCode: 'UND_ERR_CONNECT_TIMEOUT', networkMessage: '连接超时' })
  })

  it('HTTP错误保留状态/京东返回码，而不是记录原始响应', async () => {
    const source = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
    const code = source.slice(source.indexOf('async function requestJson('), source.indexOf('\nfunction readLimit('))
    const request = new Function('buildCookieHeader', 'globalThis', 'isLoginUrl', 'createRequestError', 'safeEndpoint', 'getMessage',
      code + '\nreturn requestJson')(
      async () => 'private-cookie', { fetch: async () => ({ status: 403, ok: false, url: CREATE_CAMPAIGN_URL,
        text: async () => JSON.stringify({ code: 0, subCode: 4031, subMsg: '拒绝访问', cookie: 'private' }) }) },
      () => false, (message, errorCode = 'JD_EXPRESS_REQUEST_FAILED') => Object.assign(new Error(message), { code: errorCode }),
      value => value.split('?')[0], payload => payload.subMsg
    )
    const error = await request({ getUserAgent: () => 'test' }, `${CREATE_CAMPAIGN_URL}?h5st=private`).catch(error => error)
    expect(creationErrorDetails(error)).toMatchObject({ httpStatus: '403', jdCode: '0', jdSubCode: '4031', jdMessage: '拒绝访问' })
    expect(JSON.stringify(creationErrorDetails(error))).not.toContain('private')
  })

  it('最终日志基于真实创建计数，失败明细页面不新增自动重试调用', () => {
    const main = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
    const view = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')
    expect(main).toContain('const outcome = creationOutcome(result)')
    expect(main).toContain('result=${outcome} elapsed_ms=')
    expect(main).toContain('return { ...result, outcome, runId }')
    expect(view).toContain(':data="creationFailureRows"')
    expect(view).toContain('全部创建失败：')
  })

  it.each([
    [{ campaignCount: 1, unitCount: 2, successCampaignCount: 0, successUnitCount: 0, failureCount: 2 }, 'failed'],
    [{ campaignCount: 1, unitCount: 2, successCampaignCount: 1, successUnitCount: 1, failureCount: 1 }, 'partial'],
    [{ campaignCount: 1, unitCount: 2, successCampaignCount: 1, successUnitCount: 2, failureCount: 0 }, 'success']
  ])('IPC统一任务编号贯穿回调和最终结果，准确输出 %s', async (counts, expected) => {
    const source = readFileSync(new URL('../src/main/jd-express.js', import.meta.url), 'utf8')
    const registration = source.slice(source.indexOf("  ipcMain.handle('jd-express-create-full'"),
      source.indexOf('\n}\n\nmodule.exports =', source.indexOf("  ipcMain.handle('jd-express-create-full'")))
    let handler
    const writeLog = vi.fn()
    const run = vi.fn(async (storeId, _payload, dependencies, onProgress) => {
      dependencies.onCreationDiagnostic({ stage: 'version', result: 'success' })
      onProgress({ phase: 'creation_submission_start' })
      return { success: true, storeId, ...counts }
    })
    const verify = vi.fn()
    const dependencies = { refreshCookies: vi.fn() }
    const bindings = { ipcMain: { handle: (_name, callback) => { handler = callback } },
      randomUUID: () => 'run-123', createCreationLogger, emitCreationDiagnostic: (callback, event) => callback(event),
      resolveCreateMode: () => 'custom', runtimeLog: { writeLog }, dependencies,
      runFullRoiCreation: run, creationOutcome, runPostCreationVerification: verify,
      creationErrorDetails, serializeError: vi.fn() }
    new Function(...Object.keys(bindings), registration)(...Object.values(bindings))
    const sender = { isDestroyed: () => false, send: vi.fn() }
    const result = await handler({ sender }, { storeId: 230 })
    expect(result).toMatchObject({ success: true, outcome: expected, runId: 'run-123' })
    expect(sender.send.mock.calls[0][1].runId).toBe('run-123')
    expect(writeLog.mock.calls.at(-1)[1]).toContain(`result=${expected} elapsed_ms=`)
    expect(writeLog.mock.calls.every(([, line]) => line.includes('run_id=run-123'))).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][2].refreshCookies).toBe(dependencies.refreshCookies)
    expect(verify).toHaveBeenCalledTimes(counts.successCampaignCount > 0 ? 1 : 0)
  })
})
