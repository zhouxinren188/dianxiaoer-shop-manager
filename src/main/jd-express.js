'use strict'

const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const zlib = require('node:zlib')
const { BrowserWindow, session } = require('electron')
const runtimeLog = require('./runtime-logger')
const { getManagedTempDirectory } = require('./storage-manager')
const {
  JD_EXPRESS_READ_POLICY,
  buildScopedRoiPlanStructure,
  buildProductQuery,
  extractSpuList,
  extractTotal,
  normalizeAreaTree,
  normalizeSkuDetails,
  normalizeStoreId,
  selectLowestPricedSkuIds
} = require('./jd-express-utils')
const { prepareRoiKeywords } = require('./jd-express-keywords')
const { createCustomCampaigns, createRoiCampaigns, createSingleProductTest } = require('./jd-express-create')
const {
  CAMPAIGN_LIST_URL,
  CAMPAIGN_STATUS_UPDATE_URL,
  DELETE_CAMPAIGN_TYPES,
  buildCampaignListBody,
  buildDeleteCampaignBody,
  normalizeCampaignIds,
  normalizeCampaignList
} = require('./jd-express-delete')
const {
  formatVerificationDifference,
  verifyCreatedRoiCampaigns
} = require('./jd-express-verify')
const { fetchHomeSpend } = require('./jd-express-report')

const JZT_LOGIN_URL = 'https://jzt-api.jd.com/common/logininfo?businessFrom=26'
const PRODUCT_QUERY_URL = 'https://data.shop.jd.com/fullQuery/querySpu'
const SKU_QUERY_URL = 'https://data.shop.jd.com/fullQuery/querySkuBySpuIds'
const SKU_INFO_URL = 'https://jzt-api.jd.com/dspad/common/sku/info?businessFrom=1'
const AREA_QUERY_URL = 'https://jzt-api.jd.com/common/area/get'
const BUSINESS_WISDOM_URL = 'https://szgateway.jd.com/octopusajax/octopus/api/v1/sz/common/search_keyword_order_list_table/_table'
const BUSINESS_WISDOM_REFERER = 'https://sz.jd.com/octopusweb/sz/view/industrySearch/keywordRanks.html'
const JD_EXPRESS_SIGNER_URL = 'https://inner.dou-live.com/hc/jd_kuaiche/quick/index.html'
const JD_EXPRESS_SIGNER_PARTITION = 'jd-express-signer'
const LIMIT_REQUESTS = {
  campaign: {
    url: 'https://jzt-api.jd.com/common/limit/campaign',
    body: { businessType: 2, deliverySystemType: 0, requestFrom: 0 }
  },
  adgroup: {
    url: 'https://jzt-api.jd.com/common/limit/adgroup',
    body: { campaignId: null, businessType: 2, deliverySystemType: 0, requestFrom: 0 }
  },
  ad: {
    url: 'https://jzt-api.jd.com/common/limit/ad',
    body: { adGroupId: null, businessType: 2, deliverySystemType: 0, requestFrom: 0 }
  },
  keyword: {
    url: 'https://jzt-api.jd.com/common/limit/keyword',
    body: { adGroupId: null, businessType: 2, deliverySystemType: 0, requestFrom: 0 }
  }
}
const SKU_PAGE_SIZE = JD_EXPRESS_READ_POLICY.pageSize
const SKU_BATCH_INTERVAL_MS = JD_EXPRESS_READ_POLICY.batchIntervalMs
const SKU_RATE_LIMIT_WAIT_MS = JD_EXPRESS_READ_POLICY.rateLimitWaitMs
const activeProbeWindows = new Set()
const preparedRoiJobs = new Map()
const PREPARED_JOB_TTL_MS = 2 * 60 * 60 * 1000
const PREPARED_JOB_FILE_PATTERN = /^[0-9a-f-]{16,64}\.json$/i

function createRequestError(message, code = 'JD_EXPRESS_REQUEST_FAILED') {
  const error = new Error(message)
  error.code = code
  return error
}

function resolveCreateMode(payload = {}) {
  return payload.createMode === 'custom' || payload.config?.createMode === 'custom'
    ? 'custom'
    : 'roi'
}

function expectedFullCreateConfirmation(createMode) {
  return createMode === 'custom' ? 'CREATE_ALL_CUSTOM_CAMPAIGNS' : 'CREATE_ALL_ROI_CAMPAIGNS'
}

function isLoginUrl(url = '') {
  return /passport\.jd\.com|login\.jd\.com|passport\.shop\.jd\.com/i.test(url)
}

function getMessage(payload, fallback) {
  return payload?.subMsg || payload?.message || payload?.msg || payload?.errorMessage || fallback
}

function logSafe(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 500)
}

function assertSuccess(payload, expectedCode) {
  const responseCode = payload?.code ?? payload?.subCode
  const codeMatches = expectedCode == null || Number(responseCode) === Number(expectedCode)
  if (payload?.success === false || !codeMatches) {
    const jdCode = Number(responseCode)
    const code = jdCode === -3010
      ? 'JD_RATE_LIMIT'
      : jdCode === -301 || jdCode === -3012
        ? 'JD_JZT_NOT_OPEN'
        : 'JD_EXPRESS_REQUEST_FAILED'
    const message = code === 'JD_JZT_NOT_OPEN'
      ? '当前店铺尚未开通或未完成京准通授权，请先点击“打开京准通”完成授权后重试'
      : getMessage(payload, '京东接口返回失败')
    const error = createRequestError(message, code)
    error.jdCode = Number.isFinite(jdCode) ? jdCode : null
    throw error
  }
  return payload
}

async function buildCookieHeader(platformSession, url) {
  const cookies = await platformSession.cookies.get({ url })
  return cookies
    .filter((cookie) => cookie?.name)
    .map((cookie) => cookie.name + '=' + (cookie.value || ''))
    .join('; ')
}

function decodeNativeResponse(chunks, encoding = '') {
  const buffer = Buffer.concat(chunks)
  if (/\bbr\b/i.test(encoding)) return zlib.brotliDecompressSync(buffer).toString('utf8')
  if (/\bgzip\b/i.test(encoding)) return zlib.gunzipSync(buffer).toString('utf8')
  if (/\bdeflate\b/i.test(encoding)) return zlib.inflateSync(buffer).toString('utf8')
  return buffer.toString('utf8')
}

function nativeGetWithBody(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const requestBody = String(body || '')
    const request = https.request(url, {
      method: 'GET',
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(requestBody)
      }
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        try {
          const responseText = decodeNativeResponse(chunks, response.headers['content-encoding'])
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            url,
            text: async () => responseText
          })
        } catch (error) {
          reject(error)
        }
      })
    })

    const abortRequest = () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      request.destroy(error)
    }
    if (signal?.aborted) abortRequest()
    else signal?.addEventListener('abort', abortRequest, { once: true })
    request.on('close', () => signal?.removeEventListener('abort', abortRequest))
    request.on('error', reject)
    request.write(requestBody)
    request.end()
  })
}

async function requestJson(platformSession, url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000)

  try {
    const cookieHeader = await buildCookieHeader(platformSession, url)
    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      referer: options.referer || 'https://www.jd.com/',
      'user-agent': platformSession.getUserAgent(),
      ...(options.headers || {})
    }
    if (cookieHeader) headers.cookie = cookieHeader

    // 对齐原工具 JsManager.hcHttpRequest：由宿主进程发起 HTTP 请求，
    // 避免 data.shop.jd.com 被 Chromium 网络层拦截为 ERR_BLOCKED_BY_CLIENT。
    const method = String(options.method || 'GET').toUpperCase()
    const serializedBody = options.body == null ? undefined : JSON.stringify(options.body)
    const response = method === 'GET' && serializedBody !== undefined
      ? await nativeGetWithBody(url, headers, serializedBody, controller.signal)
      : await globalThis.fetch(url, {
        method,
        headers,
        body: serializedBody,
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal
      })

    if (isLoginUrl(response.url)) {
      throw createRequestError('京东店铺登录已失效，请先重新登录店铺', 'JD_SESSION_EXPIRED')
    }

    const text = await response.text()
    if (!response.ok) {
      throw createRequestError(`京东接口请求失败（HTTP ${response.status}）`)
    }
    if (/^\s*</.test(text)) {
      throw createRequestError('京东返回了登录页面，请先重新登录店铺', 'JD_SESSION_EXPIRED')
    }

    try {
      return JSON.parse(text)
    } catch {
      throw createRequestError('京东接口返回格式异常')
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createRequestError('京东接口请求超时，请稍后重试', 'JD_EXPRESS_TIMEOUT')
    }
    if (!error?.code || /^UND_ERR_|^E(?:CONN|HOST|NET|AI_)/.test(error.code)) {
      const requestError = createRequestError(
        '京东接口网络请求失败：' + (error?.message || '未知错误'),
        'JD_EXPRESS_NETWORK_ERROR'
      )
      requestError.cause = error
      throw requestError
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
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

async function waitForRateLimit(onProgress, reason, totalMs = SKU_RATE_LIMIT_WAIT_MS) {
  let secondsRemaining = Math.ceil(totalMs / 1000)
  while (secondsRemaining > 0) {
    onProgress({
      phase: 'rate_limit_wait',
      reason,
      secondsRemaining,
      totalSeconds: Math.ceil(totalMs / 1000)
    })
    await delay(Math.min(1000, totalMs))
    secondsRemaining -= 1
  }
  onProgress({ phase: 'rate_limit_retry', reason, secondsRemaining: 0 })
}

async function fetchSkuDetails(platformSession, skuIds, onProgress = () => {}, fallbackSkus = []) {
  const body = {
    skuIds,
    sourceType: 1,
    filterType: null,
    deliverySystemType: 0,
    businessType: 2,
    campaignId: null,
    selectRangeType: 0,
    isValidate: true,
    campaignType: 2,
    putType: 3,
    requestFrom: 0
  }

  for (let retryCount = 0; retryCount <= JD_EXPRESS_READ_POLICY.rateLimitRetries; retryCount += 1) {
    const detailPayload = await requestJson(platformSession, SKU_INFO_URL, {
      method: 'POST',
      body
    })

    if (Number(detailPayload?.code) === -3010) {
      await waitForRateLimit(onProgress, '获取 SKU 详情触发京东限流')
      if (retryCount < JD_EXPRESS_READ_POLICY.rateLimitRetries) continue
      return {
        products: [],
        errorProducts: [{
          skuIds,
          code: -3010,
          message: getMessage(detailPayload, '您的操作次数已超过上限，请稍后补查')
        }]
      }
    }

    assertSuccess(detailPayload, 1)
    return {
      products: normalizeSkuDetails(detailPayload.data, fallbackSkus.length ? fallbackSkus : skuIds),
      errorProducts: Array.isArray(detailPayload?.data?.errorDatas)
        ? detailPayload.data.errorDatas.map((item) => ({
          skuIds: item?.skuBaseInfos || [],
          code: item?.code,
          message: item?.errorMsg || 'SKU 无法用于京东快车'
        }))
        : []
    }
  }

  return { products: [], errorProducts: [] }
}

async function prepareStore(storeId, refreshCookies) {
  const normalizedStoreId = normalizeStoreId(storeId)
  if (typeof refreshCookies === 'function') {
    await refreshCookies(normalizedStoreId, {
      context: 'jd_express',
      timeoutMs: 8000
    })
  }
  return {
    storeId: normalizedStoreId,
    platformSession: session.fromPartition(`persist:platform-${normalizedStoreId}`)
  }
}

async function preflightStore(storeId, dependencies = {}) {
  const { storeId: normalizedStoreId, platformSession } = await prepareStore(
    storeId,
    dependencies.refreshCookies
  )
  const loginPayload = assertSuccess(
    await requestJson(platformSession, JZT_LOGIN_URL, { method: 'POST' }),
    1
  )

  const limitEntries = []
  const limitErrors = []
  for (const [key, request] of Object.entries(LIMIT_REQUESTS)) {
    try {
      const payload = await requestJson(platformSession, request.url, {
        method: 'GET',
        body: request.body
      })
      if (payload?.success === false || !payload?.ext) {
        throw createRequestError(getMessage(payload, `读取${key}额度失败`))
      }
      limitEntries.push([key, readLimit(payload)])
    } catch (error) {
      limitEntries.push([key, readLimit({})])
      limitErrors.push({ key, message: error?.message || '读取失败' })
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=preflight_limit store_id=${normalizedStoreId} limit=${key} result=unavailable message=${logSafe(error?.message)}`
      )
    }
  }

  return {
    success: true,
    storeId: normalizedStoreId,
    pin: loginPayload?.data?.pin || '',
    limits: Object.fromEntries(limitEntries),
    limitsAvailable: limitErrors.length === 0,
    limitErrors
  }
}

function getCampaignRequestOptions(body) {
  return {
    method: 'POST',
    referer: 'https://shop.jd.com/jdm/ware/manage/list/OnsaleWare',
    headers: {
      origin: 'https://shop.jd.com',
      'x-requested-with': 'XMLHttpRequest',
      'dsm-lang': 'undefined',
      'dsm-site': 'undefined',
      'dsm-platform': 'pc'
    },
    body
  }
}

async function fetchDeletableCampaigns(storeId, dependencies = {}) {
  const { storeId: normalizedStoreId, platformSession } = await prepareStore(
    storeId,
    dependencies.refreshCookies
  )
  const payload = assertSuccess(await requestJson(
    platformSession,
    CAMPAIGN_LIST_URL,
    getCampaignRequestOptions(buildCampaignListBody())
  ), 1)
  const campaigns = normalizeCampaignList(payload)
  return {
    success: true,
    storeId: normalizedStoreId,
    campaignTypes: [...DELETE_CAMPAIGN_TYPES],
    count: campaigns.length,
    campaigns
  }
}

async function deleteAllStoreCampaigns(storeId, payload = {}, dependencies = {}) {
  if (payload.confirmation !== 'DELETE_ALL_STORE_CAMPAIGNS') {
    throw createRequestError('缺少删除全部计划确认', 'JD_EXPRESS_CONFIRMATION_REQUIRED')
  }
  const preview = await fetchDeletableCampaigns(storeId, dependencies)
  const actualIds = normalizeCampaignIds(preview.campaigns.map((campaign) => campaign.id))
  const expectedIds = normalizeCampaignIds(payload.expectedPlanIds)
  const actualKeys = actualIds.map(String).sort()
  const expectedKeys = expectedIds.map(String).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((id, index) => id !== expectedKeys[index])) {
    throw createRequestError('店铺计划列表已发生变化，请重新预览后再删除', 'JD_EXPRESS_DELETE_SCOPE_CHANGED')
  }
  if (!actualIds.length) {
    return { ...preview, deletedCount: 0 }
  }

  const { platformSession } = await prepareStore(storeId, dependencies.refreshCookies)
  const result = assertSuccess(await requestJson(
    platformSession,
    CAMPAIGN_STATUS_UPDATE_URL,
    getCampaignRequestOptions(buildDeleteCampaignBody(actualIds))
  ), 1)
  return {
    success: true,
    storeId: preview.storeId,
    campaignTypes: preview.campaignTypes,
    deletedCount: actualIds.length,
    responseCode: result?.code ?? null
  }
}

async function fetchAreas(storeId, dependencies = {}) {
  const { storeId: normalizedStoreId, platformSession } = await prepareStore(
    storeId,
    dependencies.refreshCookies
  )
  const payload = assertSuccess(await requestJson(platformSession, AREA_QUERY_URL, {
    method: 'POST',
    referer: 'https://shop.jd.com/',
    headers: {
      origin: 'https://shop.jd.com',
      siteid: '0'
    },
    body: { id: null, requestFrom: 0 }
  }), 1)
  const areas = normalizeAreaTree(payload?.data)
  if (!areas.length) throw createRequestError('京东未返回可用地域数据')
  return { success: true, storeId: normalizedStoreId, areas }
}

async function fetchProductPage(storeId, payload = {}, dependencies = {}) {
  const { storeId: normalizedStoreId, platformSession } = await prepareStore(
    storeId,
    dependencies.refreshCookies
  )
  const query = buildProductQuery(payload)
  const spuPayload = assertSuccess(await requestJson(platformSession, PRODUCT_QUERY_URL, {
    method: 'POST',
    referer: 'https://shop.jd.com/jdm/ware/manage/list/OnsaleWare',
    headers: { 'dsm-platform': 'pc' },
    body: query
  }), 200)

  const spus = extractSpuList(spuPayload)
  const spuIds = spus
    .map((item) => item?.spuId ?? item?.wareId ?? item?.id)
    .filter((id) => id != null)

  if (!spuIds.length) {
    const total = extractTotal(spuPayload, 0)
    return {
      success: true,
      storeId: normalizedStoreId,
      pageNo: query.pageNo,
      pageSize: query.pageSize,
      total,
      products: [],
      invalidSpuIds: [],
      errorProducts: [],
      pageFailure: total > 0
        ? {
          page: query.pageNo,
          code: 'JD_EXPRESS_EMPTY_PAGE',
          message: '京东本页未返回商品数据，建议稍后补查'
        }
        : null
    }
  }

  let skuPayload
  try {
    skuPayload = assertSuccess(await requestJson(platformSession, SKU_QUERY_URL, {
      method: 'POST',
      referer: 'https://shop.jd.com/jdm/ware/manage/list/OnsaleWare',
      headers: { 'dsm-platform': 'pc' },
      body: { spuIdList: spuIds, xnztQuery: false }
    }), 200)
  } catch (error) {
    if (error?.code === 'JD_SESSION_EXPIRED' || error?.code === 'JD_JZT_NOT_OPEN') throw error
    return {
      success: true,
      storeId: normalizedStoreId,
      pageNo: query.pageNo,
      pageSize: query.pageSize,
      total: extractTotal(spuPayload, spus.length),
      products: [],
      invalidSpuIds: [],
      errorProducts: [],
      pageFailure: {
        page: query.pageNo,
        code: error?.code || 'JD_EXPRESS_REQUEST_FAILED',
        message: error?.message || '查询 SKU 失败'
      }
    }
  }
  const { skuIds, selectedSkus, invalidSpuIds } = selectLowestPricedSkuIds(skuPayload.data)

  if (!skuIds.length) {
    return {
      success: true,
      storeId: normalizedStoreId,
      pageNo: query.pageNo,
      pageSize: query.pageSize,
      total: extractTotal(spuPayload, 0),
      products: [],
      invalidSpuIds
    }
  }

  let details
  try {
    details = await fetchSkuDetails(
      platformSession,
      skuIds,
      dependencies.onProgress,
      selectedSkus
    )
  } catch (error) {
    if (error?.code === 'JD_SESSION_EXPIRED' || error?.code === 'JD_JZT_NOT_OPEN') throw error
    return {
      success: true,
      storeId: normalizedStoreId,
      pageNo: query.pageNo,
      pageSize: query.pageSize,
      total: extractTotal(spuPayload, spus.length),
      products: [],
      invalidSpuIds,
      errorProducts: [],
      pageFailure: {
        page: query.pageNo,
        code: error?.code || 'JD_EXPRESS_REQUEST_FAILED',
        message: error?.message || '获取 SKU 详情失败'
      }
    }
  }

  return {
    success: true,
    storeId: normalizedStoreId,
    pageNo: query.pageNo,
    pageSize: query.pageSize,
    total: extractTotal(spuPayload, spus.length),
    products: details.products,
    invalidSpuIds,
    errorProducts: details.errorProducts,
    retryRecommended: details.errorProducts.some((item) => Number(item.code) === -3010)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchAllProducts(storeId, payload = {}, dependencies = {}, onProgress = () => {}) {
  onProgress({ phase: 'initial_wait', waitSeconds: JD_EXPRESS_READ_POLICY.initialDelayMs / 1000 })
  await delay(JD_EXPRESS_READ_POLICY.initialDelayMs)
  const firstPage = await fetchProductPage(storeId, {
    ...payload,
    pageNo: 1,
    pageSize: SKU_PAGE_SIZE
  }, { ...dependencies, onProgress })
  const totalPages = Math.max(Math.ceil(firstPage.total / SKU_PAGE_SIZE), 1)
  const products = new Map(firstPage.products.map((item) => [item.skuId, item]))
  const invalidSpuIds = [...firstPage.invalidSpuIds]
  const errorProducts = [...(firstPage.errorProducts || [])]
  const failedPages = []
  if (firstPage.pageFailure) failedPages.push(firstPage.pageFailure)
  if (firstPage.retryRecommended) {
    failedPages.push({ page: 1, code: 'JD_RATE_LIMIT', message: 'SKU 详情连续两次触发限流，建议稍后补查' })
  }
  onProgress({
    phase: 'page_complete',
    storeId: firstPage.storeId,
    page: 1,
    totalPages,
    loaded: products.size,
    total: firstPage.total,
    batchProducts: firstPage.products
  })

  for (let page = 2; page <= totalPages; page += 1) {
    onProgress({
      phase: 'batch_interval',
      page: page - 1,
      nextPage: page,
      totalPages,
      loaded: products.size,
      waitSeconds: SKU_BATCH_INTERVAL_MS / 1000
    })
    await delay(SKU_BATCH_INTERVAL_MS)
    let batchProducts = []
    try {
      const result = await fetchProductPage(storeId, {
        ...payload,
        pageNo: page,
        pageSize: SKU_PAGE_SIZE
      }, { ...dependencies, onProgress })
      batchProducts = result.products
      for (const item of result.products) products.set(item.skuId, item)
      invalidSpuIds.push(...result.invalidSpuIds)
      errorProducts.push(...(result.errorProducts || []))
      if (result.pageFailure) failedPages.push(result.pageFailure)
      if (result.retryRecommended) {
        failedPages.push({
          page,
          code: 'JD_RATE_LIMIT',
          message: 'SKU 详情连续两次触发限流，建议稍后补查'
        })
      }
    } catch (error) {
      failedPages.push({
        page,
        code: error?.code || 'JD_EXPRESS_REQUEST_FAILED',
        message: error?.message || '读取失败'
      })
    }
    onProgress({
      phase: 'page_complete',
      storeId: firstPage.storeId,
      page,
      totalPages,
      loaded: products.size,
      total: firstPage.total,
      batchProducts
    })
  }

  onProgress({ phase: 'complete', page: totalPages, totalPages, loaded: products.size, total: firstPage.total })
  return {
    success: true,
    storeId: firstPage.storeId,
    total: firstPage.total,
    products: Array.from(products.values()),
    invalidSpuIds: [...new Set(invalidSpuIds)],
    errorProducts,
    failedPages
  }
}

async function retryProductPages(storeId, payload = {}, dependencies = {}, onProgress = () => {}) {
  const pages = [...new Set((payload.pages || [])
    .map((page) => Number.parseInt(page, 10))
    .filter((page) => Number.isFinite(page) && page > 0))]
  const products = new Map()
  const invalidSpuIds = []
  const errorProducts = []
  const failedPages = []

  if (pages.length) {
    onProgress({ phase: 'initial_wait', waitSeconds: JD_EXPRESS_READ_POLICY.initialDelayMs / 1000 })
    await delay(JD_EXPRESS_READ_POLICY.initialDelayMs)
  }

  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0) {
      onProgress({
        phase: 'batch_interval',
        page: pages[index - 1],
        nextPage: pages[index],
        totalPages: pages.length,
        loaded: products.size,
        waitSeconds: SKU_BATCH_INTERVAL_MS / 1000
      })
      await delay(SKU_BATCH_INTERVAL_MS)
    }
    const page = pages[index]
    try {
      const result = await fetchProductPage(storeId, {
        ...(payload.filters || {}),
        pageNo: page,
        pageSize: SKU_PAGE_SIZE
      }, { ...dependencies, onProgress })
      for (const item of result.products) products.set(item.skuId, item)
      invalidSpuIds.push(...result.invalidSpuIds)
      errorProducts.push(...(result.errorProducts || []))
      if (result.pageFailure) failedPages.push(result.pageFailure)
      if (result.retryRecommended) {
        failedPages.push({
          page,
          code: 'JD_RATE_LIMIT',
          message: 'SKU 详情连续两次触发限流，建议稍后补查'
        })
      }
    } catch (error) {
      failedPages.push({
        page,
        code: error?.code || 'JD_EXPRESS_REQUEST_FAILED',
        message: error?.message || '补查失败'
      })
    }
    onProgress({
      phase: 'retry_page_complete',
      page,
      completed: index + 1,
      totalPages: pages.length,
      loaded: products.size
    })
  }

  return {
    success: true,
    storeId: normalizeStoreId(storeId),
    products: Array.from(products.values()),
    invalidSpuIds: [...new Set(invalidSpuIds)],
    errorProducts,
    failedPages
  }
}

function getPreparedJobCacheDirectory() {
  try {
    return getManagedTempDirectory('jd-express-prepared')
  } catch {
    return null
  }
}

function getPreparedJobFilePath(token) {
  const normalizedToken = String(token || '').trim()
  if (!/^[0-9a-f-]{16,64}$/i.test(normalizedToken)) return null
  const directory = getPreparedJobCacheDirectory()
  return directory ? path.join(directory, `${normalizedToken}.json`) : null
}

function persistPreparedJob(token, job) {
  const filePath = getPreparedJobFilePath(token)
  if (!filePath) return false
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(job), 'utf8')
    fs.renameSync(tempPath, filePath)
    return true
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // 临时文件清理失败不影响广告创建。
    }
    runtimeLog.writeLog('JD_EXPRESS', `action=prepared_cache_write result=failed message=${logSafe(error.message)}`)
    return false
  }
}

function loadPreparedJob(token, now = Date.now()) {
  const filePath = getPreparedJobFilePath(token)
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const job = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!job?.expiresAt || job.expiresAt <= now) {
      fs.unlinkSync(filePath)
      return null
    }
    preparedRoiJobs.set(String(token), job)
    return job
  } catch (error) {
    try {
      fs.unlinkSync(filePath)
    } catch {
      // 损坏缓存清理失败时按缓存不存在处理。
    }
    runtimeLog.writeLog('JD_EXPRESS', `action=prepared_cache_read result=failed message=${logSafe(error.message)}`)
    return null
  }
}

function getPreparedJob(token, now = Date.now()) {
  const normalizedToken = String(token || '')
  const memoryJob = preparedRoiJobs.get(normalizedToken)
  if (memoryJob?.expiresAt > now) return memoryJob
  if (memoryJob) preparedRoiJobs.delete(normalizedToken)
  return loadPreparedJob(normalizedToken, now)
}

function deletePreparedJob(token) {
  const normalizedToken = String(token || '')
  preparedRoiJobs.delete(normalizedToken)
  const filePath = getPreparedJobFilePath(normalizedToken)
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch (error) {
    runtimeLog.writeLog('JD_EXPRESS', `action=prepared_cache_delete result=failed message=${logSafe(error.message)}`)
  }
}

function clearExpiredPreparedJobs(now = Date.now()) {
  for (const [token, job] of preparedRoiJobs.entries()) {
    if (!job?.expiresAt || job.expiresAt <= now) deletePreparedJob(token)
  }
  const directory = getPreparedJobCacheDirectory()
  if (!directory) return
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !PREPARED_JOB_FILE_PATTERN.test(entry.name)) continue
      const filePath = path.join(directory, entry.name)
      try {
        const job = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        if (!job?.expiresAt || job.expiresAt <= now) fs.unlinkSync(filePath)
      } catch {
        fs.unlinkSync(filePath)
      }
    }
  } catch {
    // 可再生缓存维护失败不影响主流程。
  }
}

function summarizePreparedUnits(units = []) {
  return units.map((unit) => ({
    unitName: unit.unitName,
    categoryName: unit.categoryName,
    productCount: unit.products.length,
    businessWisdomCount: unit.businessWisdomKws.length,
    productKeywordCount: unit.productKws.length,
    titleKeywordCount: unit.titleKws.length,
    dropdownKeywordCount: unit.pullDownKws.length,
    keywordCount: unit.unitKws.length,
    keywordErrors: unit.keywordErrors,
    businessWisdomUsedCidLevel: unit.businessWisdomUsedCidLevel
  }))
}

async function prepareRoiCreation(storeId, payload = {}, dependencies = {}, onProgress = () => {}) {
  const { storeId: normalizedStoreId, platformSession } = await prepareStore(
    storeId,
    dependencies.refreshCookies
  )
  const sourceProducts = Array.isArray(payload.products) ? payload.products : []
  const scope = payload.scope === 'full' ? 'full' : 'single_product_test'
  if (!sourceProducts.length) throw createRequestError('没有可准备的推广商品')

  const structure = buildScopedRoiPlanStructure(sourceProducts, payload.config || {}, scope)
  if (!structure.config.keywordSources.length) {
    throw createRequestError('请至少选择一种关键词来源')
  }
  if (structure.summary.keywordPerUnit < 1) {
    throw createRequestError('关键词额度不足，无法为每个单元分配关键词')
  }
  onProgress({
    phase: 'unit_allocation_complete',
    totalCampaigns: structure.summary.campaignCount,
    totalUnits: structure.summary.unitCount,
    productCount: structure.summary.productCount
  })

  let businessSignerWindow = null
  try {
    if (structure.config.keywordSources.includes(1)) {
      businessSignerWindow = await openReadySigningWindow(normalizedStoreId)
    }
    const prepared = await prepareRoiKeywords({
      platformSession,
      structure,
      requestJson,
      queryBusinessWisdom: businessSignerWindow
        ? async (cid2Id, categoryId) => {
            const signedRequest = await buildBusinessWisdomRequestInWindow(
              businessSignerWindow,
              cid2Id,
              categoryId
            )
            return requestJson(platformSession, BUSINESS_WISDOM_URL, {
              method: 'POST',
              referer: BUSINESS_WISDOM_REFERER,
              headers: signedRequest.headers,
              body: signedRequest.body,
              timeoutMs: 30000
            })
          }
        : null,
      delay,
      onProgress
    })
    if (!prepared.keywordSummary.readyUnitCount) {
      throw createRequestError('关键词接口已调用，但没有单元获得可提交的关键词')
    }

    clearExpiredPreparedJobs()
    const preparationToken = randomUUID()
    const expiresAt = Date.now() + PREPARED_JOB_TTL_MS
    const preparedJob = {
      storeId: normalizedStoreId,
      scope,
      createdAt: Date.now(),
      expiresAt,
      data: prepared
    }
    preparedRoiJobs.set(preparationToken, preparedJob)
    persistPreparedJob(preparationToken, preparedJob)

    return {
      success: true,
      storeId: normalizedStoreId,
      scope,
      createMode: prepared.config.createMode,
      preparationToken,
      expiresAt,
      summary: prepared.summary,
      keywordSummary: prepared.keywordSummary,
      units: summarizePreparedUnits(prepared.units)
    }
  } finally {
    if (businessSignerWindow) {
      activeProbeWindows.delete(businessSignerWindow)
      if (!businessSignerWindow.isDestroyed()) businessSignerWindow.destroy()
    }
  }
}

async function probeSigning(storeId, dependencies = {}) {
  const { storeId: normalizedStoreId } = await prepareStore(storeId, dependencies.refreshCookies)
  const probeWindow = await openReadySigningWindow(normalizedStoreId)
  try {
    const signed = await signBodyInWindow(probeWindow, {
      requestFrom: 0,
      encryptSignApiAppId: 'encryptSignApiAppId'
    })
    if (!signed?.h5st) {
      throw createRequestError('签名组件已加载，但未生成有效签名', 'JD_EXPRESS_SIGNING_UNAVAILABLE')
    }
    return {
      success: true,
      storeId: normalizedStoreId,
      ready: true,
      hasStk: Boolean(signed._stk)
    }
  } finally {
    activeProbeWindows.delete(probeWindow)
    if (!probeWindow.isDestroyed()) probeWindow.destroy()
  }
}

async function openReadySigningWindow(normalizedStoreId) {
  const signingWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      // The compatibility signer runs in an isolated, in-memory session. It
      // cannot read the selected store's JD cookies; authenticated API calls
      // continue to be sent by the main process through the store partition.
      partition: JD_EXPRESS_SIGNER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  activeProbeWindows.add(signingWindow)

  try {
    let loadTimer
    try {
      await Promise.race([
        signingWindow.loadURL(JD_EXPRESS_SIGNER_URL),
        new Promise((_, reject) => {
          loadTimer = setTimeout(
            () => reject(createRequestError('原工具签名组件加载超时', 'JD_EXPRESS_TIMEOUT')),
            25000
          )
        })
      ])
    } finally {
      clearTimeout(loadTimer)
    }

    let signingTimer
    let result
    try {
      result = await Promise.race([
        signingWindow.webContents.executeJavaScript(`
          (async () => {
            if (typeof window.yv !== 'function' && typeof window.initH5st === 'function') {
              try {
                window.initH5st()
              } catch (error) {
                return { ready: false, reason: '签名组件初始化失败：' + (error?.message || '未知错误') }
              }
            }
            const deadline = Date.now() + 12000
            while (typeof window.yv !== 'function' && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 200))
            }
            if (typeof window.yv !== 'function') {
              return { ready: false, reason: '原工具签名组件未初始化' }
            }
            const signer = window.yv('cc3bd')
            return { ready: Boolean(signer && typeof signer.sign === 'function') }
          })()
        `, true),
        new Promise((_, reject) => {
          signingTimer = setTimeout(
            () => reject(createRequestError('原工具签名组件初始化超时', 'JD_EXPRESS_TIMEOUT')),
            15000
          )
        })
      ])
    } finally {
      clearTimeout(signingTimer)
    }

    if (!result?.ready) {
      throw createRequestError(result?.reason || '原工具签名环境不可用', 'JD_EXPRESS_SIGNING_UNAVAILABLE')
    }
    return signingWindow
  } catch (error) {
    activeProbeWindows.delete(signingWindow)
    if (!signingWindow.isDestroyed()) signingWindow.destroy()
    throw error
  }
}

async function signBodyInWindow(signingWindow, body) {
  const encodedBody = Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
  let timer
  try {
    return await Promise.race([
      signingWindow.webContents.executeJavaScript(`
        (async () => {
          const bytes = Uint8Array.from(atob('${encodedBody}'), char => char.charCodeAt(0))
          const body = JSON.parse(new TextDecoder().decode(bytes))
          const signer = window.yv('cc3bd')
          return await signer.sign(body)
        })()
      `, true),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(createRequestError('京准通请求签名超时', 'JD_EXPRESS_TIMEOUT')),
          20000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function buildBusinessWisdomRequestInWindow(signingWindow, cid2Id, categoryId) {
  const encodedInput = Buffer.from(JSON.stringify({ cid2Id, categoryId }), 'utf8').toString('base64')
  let timer
  try {
    return await Promise.race([
      signingWindow.webContents.executeJavaScript(`
        (async () => {
          const bytes = Uint8Array.from(atob('${encodedInput}'), char => char.charCodeAt(0))
          const input = JSON.parse(new TextDecoder().decode(bytes))
          if (typeof ParamsSign !== 'function' || typeof getSign !== 'function' ||
              typeof getUuid !== 'function' || typeof createHash !== 'function' ||
              typeof getFormatDate !== 'function') {
            throw new Error('原工具商智签名组件未就绪')
          }
          const oneDayAgo = getFormatDate(0, 0, -1)
          const sevenDayAgo = getFormatDate(0, 0, -7)
          const validStartDay = getFormatDate(-1, -1, -4)
          const requestBody = {
            metrics: ['uv', 'clickUv', 'clickRate', 'gmvCj', 'cvrCj', 'expressBidPrice'],
            outputDimensions: ['keyword', 'firstHcCid3'],
            filters: {
              originalStartDate: { value: sevenDayAgo, operator: 'eq' },
              originalEndDate: { value: oneDayAgo, operator: 'eq' },
              dateType: { value: '0', operator: 'eq' },
              validStartDay: { value: validStartDay, operator: 'eq' },
              validEndDay: { value: oneDayAgo, operator: 'eq' },
              cid2: { value: input.cid2Id, operator: 'eq' },
              cid3: { value: input.categoryId || '-999', operator: 'eq' },
              chanType: { value: -999, operator: 'eq' },
              gmvCj: { value: '0', operator: 'gt' },
              keywordType: { value: '1', operator: 'eq' },
              cidLevel: { value: input.categoryId ? '3' : '2', operator: 'eq' }
            },
            orderBy: [
              { name: 'gmvCj', desc: true },
              { name: 'uv', desc: true },
              { name: 'clickUv', desc: true },
              { name: 'keyword', desc: true }
            ],
            pageNum: 1,
            pageSize: 500
          }
          const paramsSigner = new ParamsSign({ appId: '26e21', preRequest: true })
          const signed = await paramsSigner.sign(JSON.stringify(requestBody))
          requestBody.h5st = signed.h5st
          requestBody._stk = signed._stk
          const path = '/api/v1/sz/common/search_keyword_order_list_table/_table'
          const mixed = path + JSON.stringify(requestBody)
          const splitAt = Math.floor(0.2754 * mixed.length)
          const requestSign = getSign(mixed.substring(0, splitAt) + '652' + mixed.substring(splitAt))
          const uuid = getUuid()
          const userMup = Date.now()
          const userMnp = createHash(path + uuid + userMup + '372ad2c2b6')
          return {
            body: requestBody,
            headers: {
              'x-req-sign': requestSign,
              domainName: 'sz',
              'user-mup': String(userMup),
              uuid,
              'x-requested-with': 'XMLHttpRequest',
              'user-mnp': userMnp,
              'sec-ch-ua-platform': 'Windows'
            }
          }
        })()
      `, true),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(createRequestError('京东商智请求签名超时', 'JD_EXPRESS_TIMEOUT')),
          20000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function getJdEidCookie(platformSession) {
  const cookies = await platformSession.cookies.get({ name: '3AB9D23F7A4B3CSS' })
  const cookie = cookies.find((item) => /(^|\.)jd\.com$/i.test(item.domain || '')) || cookies[0]
  if (!cookie?.value) return ''
  try {
    return decodeURIComponent(cookie.value)
  } catch {
    return cookie.value
  }
}

async function createPreparedSingleProductTest(storeId, payload = {}, dependencies = {}) {
  if (payload.confirmation !== 'CREATE_SINGLE_PRODUCT_TEST') {
    throw createRequestError('缺少单商品测试创建确认', 'JD_EXPRESS_CONFIRMATION_REQUIRED')
  }
  clearExpiredPreparedJobs()
  const preparationToken = String(payload.preparationToken || '')
  const job = getPreparedJob(preparationToken)
  if (!job) throw createRequestError('关键词准备结果已失效，请重新执行单商品关键词测试')
  const { storeId: normalizedStoreId, platformSession } = await prepareStore(
    storeId,
    dependencies.refreshCookies
  )
  if (job.storeId !== normalizedStoreId || job.scope !== 'single_product_test') {
    throw createRequestError('关键词准备结果与当前店铺或测试范围不匹配')
  }
  const eid = await getJdEidCookie(platformSession)
  const signingWindow = await openReadySigningWindow(normalizedStoreId)
  try {
    const result = await createSingleProductTest({
      platformSession,
      prepared: job.data,
      requestJson,
      signBody: (body) => signBodyInWindow(signingWindow, body),
      eid
    })
    deletePreparedJob(preparationToken)
    return {
      success: true,
      storeId: normalizedStoreId,
      scope: job.scope,
      ...result
    }
  } finally {
    activeProbeWindows.delete(signingWindow)
    if (!signingWindow.isDestroyed()) signingWindow.destroy()
  }
}

async function createPreparedFullCampaigns(storeId, payload = {}, dependencies = {}, onProgress = () => {}) {
  if (!['CREATE_ALL_ROI_CAMPAIGNS', 'CREATE_ALL_CUSTOM_CAMPAIGNS'].includes(payload.confirmation)) {
    throw createRequestError('缺少完整批量创建确认', 'JD_EXPRESS_CONFIRMATION_REQUIRED')
  }
  clearExpiredPreparedJobs()
  const preparationToken = String(payload.preparationToken || '')
  const job = getPreparedJob(preparationToken)
  if (!job) throw createRequestError('完整关键词准备结果已失效，请重新准备全部关键词')
  const { storeId: normalizedStoreId, platformSession } = await prepareStore(
    storeId,
    dependencies.refreshCookies
  )
  if (job.storeId !== normalizedStoreId || job.scope !== 'full') {
    throw createRequestError('关键词准备结果与当前店铺或完整创建范围不匹配')
  }
  const createMode = job.data?.config?.createMode === 'custom' ? 'custom' : 'roi'
  if (payload.confirmation !== expectedFullCreateConfirmation(createMode)) {
    throw createRequestError('创建确认与已准备的投放模式不匹配', 'JD_EXPRESS_CONFIRMATION_REQUIRED')
  }
  const eid = await getJdEidCookie(platformSession)
  const signingWindow = await openReadySigningWindow(normalizedStoreId)
  try {
    // 一旦开始真实批量提交即消费令牌，避免网络返回不确定时重复创建计划。
    deletePreparedJob(preparationToken)
    onProgress({
      phase: 'creation_submission_start',
      totalCampaigns: job.data.summary?.campaignCount || job.data.campaigns?.length || 0,
      totalUnits: job.data.summary?.unitCount || job.data.units?.length || 0
    })
    const createCampaigns = createMode === 'custom' ? createCustomCampaigns : createRoiCampaigns
    const result = await createCampaigns({
      platformSession,
      prepared: job.data,
      requestJson,
      signBody: (body) => signBodyInWindow(signingWindow, body),
      eid,
      delay,
      onProgress
    })
    return {
      success: true,
      storeId: normalizedStoreId,
      scope: job.scope,
      createMode,
      ...result
    }
  } finally {
    activeProbeWindows.delete(signingWindow)
    if (!signingWindow.isDestroyed()) signingWindow.destroy()
  }
}

async function runFullRoiCreation(storeId, payload = {}, dependencies = {}, onProgress = () => {}) {
  const createMode = resolveCreateMode(payload)
  const requiredConfirmation = expectedFullCreateConfirmation(createMode)
  if (payload.confirmation !== requiredConfirmation) {
    throw createRequestError('缺少完整批量创建确认', 'JD_EXPRESS_CONFIRMATION_REQUIRED')
  }

  // 在耗时的关键词准备之前先验证真实创建所依赖的登录、EID 和签名组件。
  // 这里只生成测试签名，不调用任何广告创建接口。
  onProgress({ phase: 'submission_preflight_start' })
  const { platformSession } = await prepareStore(storeId, dependencies.refreshCookies)
  const eid = await getJdEidCookie(platformSession)
  if (!eid) {
    throw createRequestError('京东 eid Cookie 缺失，请重新登录京准通', 'JD_EXPRESS_SIGNING_UNAVAILABLE')
  }
  await probeSigning(storeId, dependencies)
  onProgress({ phase: 'submission_preflight_complete' })

  let preparationToken = String(payload.preparationToken || '')
  let preparedResult = null
  if (!preparationToken) {
    onProgress({ phase: 'prepare_start' })
    preparedResult = await prepareRoiCreation(
      storeId,
      { ...payload, scope: 'full' },
      dependencies,
      onProgress
    )
    preparationToken = preparedResult.preparationToken
  } else {
    const resumedJob = getPreparedJob(preparationToken)
    if (!resumedJob) {
      throw createRequestError('已保存的关键词准备结果已失效，将在下次点击时重新准备', 'JD_EXPRESS_PREPARATION_EXPIRED')
    }
    const resumedMode = resumedJob.data?.config?.createMode === 'custom' ? 'custom' : 'roi'
    if (resumedMode !== createMode) {
      throw createRequestError('已保存的关键词结果与当前投放模式不匹配，请重新准备', 'JD_EXPRESS_PREPARATION_EXPIRED')
    }
    preparedResult = {
      preparationToken,
      expiresAt: resumedJob.expiresAt,
      summary: resumedJob.data.summary,
      keywordSummary: resumedJob.data.keywordSummary
    }
  }

  onProgress({
    phase: 'keyword_prepare_complete',
    preparationToken,
    expiresAt: preparedResult.expiresAt,
    totalCampaigns: preparedResult.summary?.campaignCount || 0,
    totalUnits: preparedResult.summary?.unitCount || 0,
    keywordCount: preparedResult.keywordSummary?.actualKeywordCount || 0
  })

  try {
    const created = await createPreparedFullCampaigns(
      storeId,
      {
        ...payload,
        preparationToken,
        confirmation: requiredConfirmation
      },
      dependencies,
      onProgress
    )
    onProgress({
      phase: 'creation_complete',
      completedUnits: created.successUnitCount + created.failureCount,
      totalUnits: created.unitCount,
      totalCampaigns: created.campaignCount
    })
    return {
      ...created,
      createMode,
      keywordSummary: preparedResult.keywordSummary
    }
  } catch (error) {
    const resumableJob = getPreparedJob(preparationToken)
    if (resumableJob) {
      error.preparationToken = preparationToken
      error.preparationExpiresAt = resumableJob.expiresAt
    }
    throw error
  }
}

function closeAllJdExpressWindows() {
  for (const window of activeProbeWindows) {
    try {
      if (!window.isDestroyed()) window.destroy()
    } catch {
      // 退出清理不能阻止主应用关闭。
    }
  }
  activeProbeWindows.clear()
}

function serializeError(error) {
  return {
    success: false,
    code: error?.code || 'JD_EXPRESS_FAILED',
    message: error?.message || '操作失败',
    ...(error?.preparationToken ? {
      preparationToken: error.preparationToken,
      preparationExpiresAt: error.preparationExpiresAt,
      retryWithoutPreparation: true
    } : {})
  }
}

function sendCreationVerificationUpdate(sender, storeId, payload = {}) {
  if (!sender || sender.isDestroyed()) return
  try {
    sender.send('jd-express-verification-result', {
      ...payload,
      storeId
    })
  } catch {
    // 用户离开页面或窗口关闭时只停止展示，不影响后台核验和应用其他功能。
  }
}

async function runPostCreationVerification(storeId, created, sender) {
  sendCreationVerificationUpdate(sender, storeId, { status: 'checking' })
  try {
    // 创建接口已使用并验证过当前店铺会话；核验仅复用该会话读取京准通列表，
    // 不刷新登录、不补建、不删除，也不会影响创建接口的返回。
    const { platformSession } = await prepareStore(storeId)
    const result = await verifyCreatedRoiCampaigns({
      created,
      platformSession,
      requestJson,
      onProgress: (progress) => sendCreationVerificationUpdate(sender, storeId, progress)
    })
    const difference = formatVerificationDifference(result)
    runtimeLog.writeLog(
      'JD_EXPRESS',
      `action=verify_creation store_id=${storeId} status=${result.status} campaigns=${result.actual?.campaign || 0}/${result.expected?.campaign || 0} units=${result.actual?.adgroup || 0}/${result.expected?.adgroup || 0} creatives=${result.actual?.ad || 0}/${result.expected?.ad || 0} keywords=${result.actual?.keyword || 0}/${result.expected?.keyword || 0}${difference ? ` missing=${logSafe(difference)}` : ''}${result.message ? ` message=${logSafe(result.message)}` : ''}`
    )
    sendCreationVerificationUpdate(sender, storeId, result)
  } catch (error) {
    runtimeLog.writeLog(
      'JD_EXPRESS',
      `action=verify_creation store_id=${storeId} status=unavailable message=${logSafe(error.message)}`
    )
    sendCreationVerificationUpdate(sender, storeId, {
      success: false,
      status: 'unavailable',
      message: error?.message || '京准通核验暂未完成'
    })
  }
}

function registerJdExpressIpc(ipcMain, dependencies = {}) {
  ipcMain.handle('jd-express-home-spend', async (_event, payload = {}) => {
    const startedAt = Date.now()
    let normalizedStoreId = null
    try {
      const prepared = await prepareStore(payload.storeId)
      normalizedStoreId = prepared.storeId
      const result = await fetchHomeSpend({
        platformSession: prepared.platformSession,
        requestJson
      })
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=home_spend store_id=${normalizedStoreId} status=success today=${result.todaySpend} month=${result.monthSpend} days=${result.dailySpends.length} duration_ms=${Date.now() - startedAt}`
      )
      return { success: true, storeId: normalizedStoreId, ...result }
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=home_spend store_id=${normalizedStoreId || payload.storeId || ''} status=unavailable duration_ms=${Date.now() - startedAt} message=${logSafe(error?.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-preflight', async (_event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await preflightStore(payload.storeId, dependencies)
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=preflight store_id=${result.storeId} result=success elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=preflight store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-delete-preview', async (_event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await fetchDeletableCampaigns(payload.storeId, dependencies)
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=delete_preview store_id=${result.storeId} count=${result.count} result=success elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=delete_preview store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-delete-all', async (_event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await deleteAllStoreCampaigns(payload.storeId, payload, dependencies)
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=delete_all store_id=${result.storeId} count=${result.deletedCount} result=success elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=delete_all store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-products', async (event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await fetchProductPage(payload.storeId, payload.filters, {
        ...dependencies,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('jd-express-products-progress', { ...progress, storeId: payload.storeId })
          }
        }
      })
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=products store_id=${result.storeId} result=success count=${result.products.length} elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=products store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-all-products', async (event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await fetchAllProducts(
        payload.storeId,
        payload.filters,
        dependencies,
        (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('jd-express-products-progress', { ...progress, storeId: payload.storeId })
          }
        }
      )
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=all_products store_id=${result.storeId} result=success count=${result.products.length} elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=all_products store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-retry-pages', async (event, payload = {}) => {
    const startedAt = Date.now()
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('jd-express-products-progress', { ...progress, storeId: payload.storeId })
      }
    }
    try {
      const result = await retryProductPages(payload.storeId, payload, dependencies, sendProgress)
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=retry_pages store_id=${result.storeId} result=success recovered=${result.products.length} remaining_pages=${result.failedPages.length} elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=retry_pages store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-areas', async (_event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await fetchAreas(payload.storeId, dependencies)
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=areas store_id=${result.storeId} result=success roots=${result.areas.length} elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=areas store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-signing-probe', async (_event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await probeSigning(payload.storeId, dependencies)
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=signing_probe store_id=${result.storeId} result=success elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=signing_probe store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-prepare-creation', async (event, payload = {}) => {
    const startedAt = Date.now()
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('jd-express-creation-progress', {
          ...progress,
          storeId: payload.storeId,
          createMode: resolveCreateMode(payload)
        })
      }
    }
    try {
      const result = await prepareRoiCreation(
        payload.storeId,
        payload,
        dependencies,
        sendProgress
      )
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=prepare_creation store_id=${result.storeId} scope=${result.scope} units=${result.keywordSummary.unitCount} keywords=${result.keywordSummary.actualKeywordCount} result=success elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=prepare_creation store_id=${payload.storeId || 0} scope=${payload.scope || 'single_product_test'} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-create-single-test', async (_event, payload = {}) => {
    const startedAt = Date.now()
    try {
      const result = await createPreparedSingleProductTest(payload.storeId, payload, dependencies)
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=create_single_test store_id=${result.storeId} campaign_id=${result.campaignId || ''} sku_id=${result.skuId || ''} result=success elapsed_ms=${Date.now() - startedAt}`
      )
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=create_single_test store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })

  ipcMain.handle('jd-express-create-full', async (event, payload = {}) => {
    const startedAt = Date.now()
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('jd-express-creation-progress', {
          ...progress,
          storeId: payload.storeId,
          createMode: resolveCreateMode(payload)
        })
      }
    }
    try {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=create_full store_id=${payload.storeId || 0} create_mode=${resolveCreateMode(payload)} phase=start mode=${payload.preparationToken ? 'resume' : 'automatic'}`
      )
      const result = await runFullRoiCreation(
        payload.storeId,
        payload,
        dependencies,
        sendProgress
      )
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=create_full store_id=${result.storeId} campaigns=${result.successCampaignCount}/${result.campaignCount} units=${result.successUnitCount}/${result.unitCount} failures=${result.failureCount} result=success elapsed_ms=${Date.now() - startedAt}`
      )
      if (result.successCampaignCount > 0) {
        // 核验与创建结果解耦：不等待、不改变创建结果，也绝不自动补建。
        void runPostCreationVerification(result.storeId, result, event.sender)
      }
      return result
    } catch (error) {
      runtimeLog.writeLog(
        'JD_EXPRESS',
        `action=create_full store_id=${payload.storeId || 0} result=failed code=${error.code || 'unknown'} message=${logSafe(error.message)}`
      )
      return serializeError(error)
    }
  })
}

module.exports = {
  closeAllJdExpressWindows,
  createPreparedFullCampaigns,
  createPreparedSingleProductTest,
  deleteAllStoreCampaigns,
  fetchAreas,
  fetchAllProducts,
  fetchDeletableCampaigns,
  fetchProductPage,
  fetchSkuDetails,
  fetchHomeSpend,
  preflightStore,
  prepareRoiCreation,
  probeSigning,
  readLimit,
  registerJdExpressIpc,
  runFullRoiCreation,
  requestJson,
  retryProductPages,
  waitForRateLimit
}
