'use strict'

function safeEndpoint(value) {
  try {
    const url = new URL(String(value || ''))
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

function creationLogText(value, limit = 500) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, safeEndpoint)
    .replace(/\b(cookie|set-cookie|authorization)\s*[:=]\s*[^\r\n]+/gi, '$1=[redacted]')
    .replace(/\b(eid|h5st|token|password|pt_key|thor|trackid)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, '$1=[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, limit)
}

function creationErrorDetails(error) {
  const details = {
    stage: creationLogText(error?.creationStage || 'unknown', 80),
    endpoint: safeEndpoint(error?.endpoint),
    code: creationLogText(error?.code || 'JD_EXPRESS_CREATE_FAILED', 100),
    message: creationLogText(error?.message || '创建失败')
  }
  for (const key of ['httpStatus', 'jdCode', 'jdSubCode', 'traceId']) {
    if (error?.[key] != null) details[key] = creationLogText(error[key], 160)
  }
  if (error?.jdMessage) details.jdMessage = creationLogText(error.jdMessage)
  const networkCause = error?.cause?.cause || error?.cause
  if (networkCause?.code) details.networkCode = creationLogText(networkCause.code, 100)
  if (networkCause?.message) details.networkMessage = creationLogText(networkCause.message)
  return details
}

function creationResponseError(message, payload, stage, endpoint) {
  const error = new Error(message)
  error.code = 'JD_EXPRESS_RESPONSE_FAILED'
  error.jdCode = payload?.code
  error.jdSubCode = payload?.subCode
  error.traceId = payload?.traceId ?? payload?.requestId
  error.creationStage = stage
  error.endpoint = endpoint
  return error
}

function emitCreationDiagnostic(onDiagnostic, event) {
  try {
    const pending = onDiagnostic?.(event)
    if (pending?.catch) pending.catch(() => {})
  } catch {
    // Diagnostic failures must never change or replay a real advertising request.
  }
}

async function runCreationStage(onDiagnostic, context, stage, endpoint, operation) {
  const startedAt = Date.now()
  const event = { ...context, stage, endpoint: safeEndpoint(endpoint) }
  emitCreationDiagnostic(onDiagnostic, { ...event, result: 'start' })
  try {
    const result = await operation()
    emitCreationDiagnostic(onDiagnostic, { ...event, result: 'success', elapsedMs: Date.now() - startedAt })
    return result
  } catch (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure))
    error.creationStage = error.creationStage || stage
    error.endpoint = error.endpoint || endpoint
    emitCreationDiagnostic(onDiagnostic, {
      ...event, ...creationErrorDetails(error), result: 'failed', elapsedMs: Date.now() - startedAt
    })
    throw error
  }
}

function creationUnitContext(campaign, unit, campaignIndex, unitIndex, campaignId) {
  return {
    campaignIndex: campaignIndex + 1,
    unitIndex: unitIndex + 1,
    planName: campaign?.planName || '',
    unitName: unit?.unitName || '',
    campaignId,
    skuCount: unit?.products?.length || 0,
    skuIds: (unit?.products || []).slice(0, 20).map(product => String(product.skuId)),
    keywordCount: unit?.keywordList?.length || 0
  }
}

function creationBodySummary(body = {}) {
  try {
    const campaign = body.campaignCreateCommand || {}
    const group = body.adGroupCreateCommand || body
    const keywords = Array.isArray(group.keywordList) ? group.keywordList : []
    const bids = keywords.map(keyword => Number(keyword.keywordMobilePrice)).filter(Number.isFinite)
    return {
      submittedPlanName: campaign.name,
      submittedUnitName: group.name,
      startDate: campaign.startTime,
      endDate: campaign.endTime,
      dailyBudget: campaign.dayBudget,
      automatedBiddingType: group.automatedBiddingType,
      inSearchFee: group.inSearchFee,
      premiumCoef: group.premiumCoef,
      tcpaBid: group.tcpaBid,
      crowdCount: group.dmpCrowdSettings?.length || 0,
      seedCount: group.seedsList?.length || 0,
      crowdIds: (group.dmpCrowdSettings || []).map(item => item.crowdId).slice(0, 30),
      crowdTypes: (group.dmpCrowdSettings || []).map(item => item.crowdType).slice(0, 30),
      keywordMinBid: bids.length ? Math.min(...bids) : undefined,
      keywordMaxBid: bids.length ? Math.max(...bids) : undefined
    }
  } catch {
    // Even a malformed summary must not prevent signing/submitting the original body.
    return {}
  }
}

function creationOutcome(result) {
  if (!(Number(result?.successUnitCount) > 0) && !Number(result?.failureCount) && Number(result?.skippedUnitCount) > 0) return 'skipped'
  if (!(Number(result?.successUnitCount) > 0)) return 'failed'
  return Number(result?.failureCount) > 0 || Number(result?.skippedKeywordCount) > 0 || Number(result.successUnitCount) < Number(result.unitCount) ||
    Number(result.successCampaignCount) < Number(result.campaignCount) ? 'partial' : 'success'
}

function createCreationLogger({ storeId, runId, createMode, writeLog }) {
  return event => {
    const detail = {}
    // Whitelist only diagnostic fields. Never serialize request bodies, headers or signatures.
    for (const key of ['stage', 'result', 'planName', 'unitName', 'code', 'message',
      'httpStatus', 'jdCode', 'jdSubCode', 'jdMessage', 'traceId', 'networkCode', 'networkMessage',
      'campaignId', 'campaignIndex', 'unitIndex', 'skuCount', 'keywordCount', 'elapsedMs', 'blockedByCampaign',
      'submittedPlanName', 'submittedUnitName', 'startDate', 'endDate', 'dailyBudget',
      'automatedBiddingType', 'inSearchFee', 'premiumCoef', 'tcpaBid', 'crowdCount', 'seedCount', 'keywordMinBid', 'keywordMaxBid']) {
      if (event[key] != null) detail[key] = typeof event[key] === 'number' || typeof event[key] === 'boolean'
        ? event[key] : creationLogText(event[key])
    }
    for (const key of ['keywordName', 'baseBid', 'floorBid', 'maxBid', 'submittedBid', 'reason']) {
      if (event[key] != null) detail[key] = typeof event[key] === 'number' ? event[key] : creationLogText(event[key])
    }
    for (const key of ['crowdIds', 'crowdTypes']) {
      if (Array.isArray(event[key])) detail[key] = event[key].slice(0, 30).map(value => creationLogText(value))
    }
    if (event.endpoint) detail.endpoint = safeEndpoint(event.endpoint)
    if (Array.isArray(event.skuIds)) detail.skuIds = event.skuIds.slice(0, 20).map(value => creationLogText(value, 80))
    writeLog('JD_EXPRESS', `action=create_detail run_id=${creationLogText(runId, 80)} store_id=${Number(storeId) || 0} create_mode=${createMode === 'custom' ? 'custom' : 'roi'} detail=${JSON.stringify(detail)}`)
  }
}

module.exports = {
  safeEndpoint, creationLogText, creationErrorDetails, creationResponseError,
  emitCreationDiagnostic, runCreationStage, creationUnitContext, creationBodySummary, creationOutcome, createCreationLogger
}
