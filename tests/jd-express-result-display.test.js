import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { summarizeCreationResult, creationVerificationHint } from '../src/renderer/src/utils/jdExpressCreationResult'

const view = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')
const result = { success: true, runId: 'test-run', successCampaignCount: 60, campaignCount: 61,
  successUnitCount: 127, unitCount: 133, failureCount: 6, failures: [{ message: '关键词出价低于底价' }] }
const ref = value => ({ value })

function extract(start, end) {
  const begin = view.indexOf(start)
  const finish = view.indexOf(`\n${end}`, begin)
  if (begin < 0 || finish <= begin) throw new Error(`Missing ${start}`)
  return view.slice(begin, finish)
}
function evaluate(code, bindings, returned) {
  return new Function(...Object.keys(bindings), code + `\nreturn ${returned}`)(...Object.values(bindings))
}
function harness(createResult = result, quotaResult = { success: true, pin: 'test', limitsAvailable: true,
  limits: { campaign: { surplus: 60 }, keyword: { surplus: 14763 } } }) {
  const bindings = {
    ensureStoreSelected: () => true,
    fullCreateLoading: ref(false), createdFullResult: ref(null), activeStep: ref(2),
    creationResultRef: ref({ scrollIntoView: vi.fn() }), creationDetailPanels: ref([]),
    creationQuotaRefreshFailed: ref(false), creationStartedAt: ref(0), creationSubmissionStarted: ref(false),
    refreshExpiredStartDate: () => false, startDateError: () => '',
    storeId: ref(230), activeTool: ref('custom'),
    selectedProducts: new Map([['1', { skuId: '1' }]]), excludedProducts: new Map(),
    products: ref([{ skuId: '1' }]), productTotal: ref(1),
    preview: ref({ campaignCount: 61, unitCount: 133, productCount: 328, limitWarnings: [] }),
    config: { unlimitedBudget: true, useMinKeywordBid: false, customKeywordBid: 0.1,
      maxCustomKeywordBid: 0.5, inSearchFee: 0.1, startDate: '2026-09-15', keywordTotalUsage: 34935 },
    deliveryModeLabel: ref('智能调价'), bidModeLabel: ref('建议30%'),
    readPreparationToken: () => '', rememberPreparationToken: vi.fn(), clearPreparationToken: vi.fn(),
    ElMessageBox: { confirm: vi.fn(async () => {}) },
    ElMessage: { warning: vi.fn(), error: vi.fn(), success: vi.fn() }, showCenteredMessage: vi.fn(),
    toIpcPlainData: value => JSON.parse(JSON.stringify(value)),
    creationVerification: { status: 'idle' }, keywordPrepareProgress: {},
    preparedFullResult: ref({}), preparedKeywordResult: ref({}), preflightLoading: ref(false),
    preflight: { pin: 'test', limitsAvailable: true, limits: { campaign: { surplus: 120 }, keyword: { surplus: 34935 } } },
    nextTick: async () => {},
    window: { electronAPI: { invoke: vi.fn(async channel => channel === 'jd-express-create-full' ? createResult : quotaResult) } }
  }
  bindings.runPreflight = evaluate(extract('async function runPreflight(', 'async function confirmDeleteAllCampaigns'), bindings, 'runPreflight')
  const create = evaluate(extract('async function createAllPlans(', 'async function showCreationDetails'), bindings, 'createAllPlans')
  const newDraft = evaluate(extract('function startNewCreationDraft(', 'async function runPreflight'), bindings, 'startNewCreationDraft')
  return { create, newDraft, bindings }
}

describe('快车完成结果与下一轮额度严格区分', () => {
  it.each([
    [result, 'warning', '部分成功'],
    [{ successCampaignCount: 61, campaignCount: 61, successUnitCount: 133, unitCount: 133 }, 'success', '全部创建成功'],
    [{ successCampaignCount: 0, campaignCount: 61, successUnitCount: 0, unitCount: 133, failureCount: 133 }, 'error', '全部创建失败'],
    [{ successCampaignCount: 0, campaignCount: 61, successUnitCount: 0, unitCount: 133, skippedUnitCount: 133, skippedKeywordCount: 100 }, 'info', '全部跳过'],
    [{ successCampaignCount: 61, campaignCount: 61, successUnitCount: 133, unitCount: 133, skippedKeywordCount: 1 }, 'warning', '部分成功'],
    [{ successCampaignCount: 1, campaignCount: 2, successUnitCount: 1, unitCount: 2 }, 'warning', '部分成功']
  ])('结束状态不会把部分成功当作全部失败：%j', (input, type, title) => {
    expect(summarizeCreationResult(input)).toMatchObject({ type, title: expect.stringContaining(title) })
  })
  it('没有结束结果时不显示完成；数量来自实际返回值，不来自刷新后的预览', () => {
    expect(summarizeCreationResult(null)).toBeNull()
    expect(summarizeCreationResult(result).description).toBe('成功 60/61 个计划、127/133 个单元；失败 6 个单元')
  })
  it('成功后额度刷新为 60，仍保留本轮部分成功状态和原关键词配置', async () => {
    const h = harness()
    await h.create()
    expect(h.bindings.preflight.limits.campaign.surplus).toBe(60)
    expect(h.bindings.config.keywordTotalUsage).toBe(34935)
    expect(h.bindings.createdFullResult.value).toBe(result)
    expect(h.bindings.creationResultRef.value.scrollIntoView).toHaveBeenCalledOnce()
    expect(h.bindings.fullCreateLoading.value).toBe(false)
    expect(h.bindings.creationQuotaRefreshFailed.value).toBe(false)
    expect(h.bindings.ElMessage.warning).toHaveBeenCalledWith(expect.stringContaining('成功 60/61'))
    expect(h.bindings.window.electronAPI.invoke.mock.calls.map(call => call[0]))
      .toEqual(['jd-express-create-full', 'jd-express-preflight'])
  })
  it.each([{ success: false, message: '超时' }, { success: true, limitsAvailable: false, limits: {} }])('后续额度读取失败不覆盖已经完成的结果：%j', async quota => {
    const h = harness(result, quota)
    await h.create()
    expect(h.bindings.createdFullResult.value).toBe(result)
    expect(h.bindings.creationQuotaRefreshFailed.value).toBe(true)
    expect(h.bindings.ElMessage.error).not.toHaveBeenCalled()
  })
  it('结束后再次调用创建入口也不能重发成功计划', async () => {
    const h = harness()
    await h.create()
    h.bindings.preview.value.limitWarnings = ['计划需要 61 个，当前仅剩 60 个额度']
    await h.create()
    expect(h.bindings.window.electronAPI.invoke).toHaveBeenCalledTimes(2)
    expect(h.bindings.ElMessageBox.confirm).toHaveBeenCalledOnce()
    expect(h.bindings.showCenteredMessage).toHaveBeenCalledWith('warning', expect.stringContaining('本轮任务已结束'))
  })
  it('真实创建前仍保留额度检查，不能以结果展示修复绕过上限', async () => {
    const h = harness()
    h.bindings.preview.value.limitWarnings = ['计划额度不足']
    await h.create()
    expect(h.bindings.window.electronAPI.invoke).not.toHaveBeenCalled()
    expect(h.bindings.ElMessageBox.confirm).not.toHaveBeenCalled()
  })
  it('取消确认不创建、不生成完成结果', async () => {
    const h = harness()
    h.bindings.ElMessageBox.confirm.mockRejectedValueOnce(new Error('cancel'))
    await h.create()
    expect(h.bindings.createdFullResult.value).toBeNull()
    expect(h.bindings.window.electronAPI.invoke).not.toHaveBeenCalled()
  })
  it('确认过程中换店铺，不提交旧预览', async () => {
    const h = harness()
    h.bindings.ElMessageBox.confirm.mockImplementationOnce(async () => { h.bindings.storeId.value = 9 })
    await h.create()
    expect(h.bindings.window.electronAPI.invoke).not.toHaveBeenCalled()
  })
  it('延迟返回的旧店铺结果不能覆盖新店铺或刷新新店铺额度', async () => {
    const h = harness()
    h.bindings.window.electronAPI.invoke.mockImplementationOnce(async () => {
      h.bindings.storeId.value = 9
      return result
    })
    await h.create()
    expect(h.bindings.createdFullResult.value).toBeNull()
    expect(h.bindings.window.electronAPI.invoke).toHaveBeenCalledOnce()
  })
  it('只有明确重新选品才清除结果；该按钮不调用任何创建、删除或重试接口', async () => {
    const h = harness()
    await h.create()
    h.bindings.window.electronAPI.invoke.mockClear()
    h.newDraft()
    expect(h.bindings.createdFullResult.value).toBeNull()
    expect(h.bindings.activeStep.value).toBe(0)
    expect(h.bindings.selectedProducts.size).toBe(0)
    expect(h.bindings.window.electronAPI.invoke).not.toHaveBeenCalled()
    expect(h.bindings.showCenteredMessage).toHaveBeenCalledWith('info', expect.stringContaining('过滤已有推广'))
  })
  it('重新选品也不能打断正在创建的任务', () => {
    const h = harness()
    h.bindings.fullCreateLoading.value = true
    h.bindings.createdFullResult.value = result
    h.newDraft()
    expect(h.bindings.createdFullResult.value).toBe(result)
    expect(h.bindings.selectedProducts.size).toBe(1)
  })
  it('失败明细按钮展开对应列表并滚动到列表，不创建广告', async () => {
    const details = { scrollIntoView: vi.fn() }
    const bindings = { creationDetailPanels: ref([]), nextTick: async () => {},
      creationFailureDetailsRef: ref({ $el: details }), creationSkipDetailsRef: ref(null) }
    const show = evaluate(extract('async function showCreationDetails(', 'function startNewCreationDraft'), bindings, 'showCreationDetails')
    await show('failures')
    await show('failures')
    expect(bindings.creationDetailPanels.value).toEqual(['failures'])
    expect(details.scrollIntoView).toHaveBeenCalledTimes(2)
  })
  it('核验少 4 个词仅作核验提示，不把创建成功的计划判成失败', () => {
    expect(creationVerificationHint({ status: 'mismatch', missing: { campaign: 0, adgroup: 0, ad: 0, keyword: 4 } }))
      .toBe('后台核验发现：关键词少 4 个；这是核验提示，不会自动补建或重发整批')
    expect(creationVerificationHint({ status: 'matched' })).toContain('核验通过')
    expect(creationVerificationHint({ status: 'unavailable' })).toContain('不代表创建失败')
    expect(creationVerificationHint()).toBe('')
    expect(summarizeCreationResult(result).type).toBe('warning')
  })
  it('完成摘要在预览数字和额度提示之前，额度警告只用于尚未结束的新批次', () => {
    expect(view.indexOf('class="creation-result-panel"')).toBeLessThan(view.indexOf('class="preview-metrics"'))
    expect(view).toContain('v-if="!createdFullResult && !fullCreateLoading && preview.limitWarnings.length"')
    expect(view).toContain(':disabled="fullCreateLoading || Boolean(createdFullResult) || preview.limitWarnings.length > 0"')
  })
})
