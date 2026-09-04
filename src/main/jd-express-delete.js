'use strict'

const CAMPAIGN_LIST_URL = 'https://jzt-api.jd.com/common/select/campaign'
const CAMPAIGN_STATUS_UPDATE_URL = 'https://jzt-api.jd.com/kuaiche/campaign/status/update'
const DELETE_CAMPAIGN_TYPES = Object.freeze([2, 18, 41])

function buildCampaignListBody() {
  return {
    businessType: 2,
    yn: 1,
    campaignTypes: [...DELETE_CAMPAIGN_TYPES],
    billingType: null,
    level: '',
    requestFrom: 0
  }
}

function normalizeCampaignList(payload = {}) {
  const source = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.data?.list)
      ? payload.data.list
      : []
  return source
    .map((item) => ({
      id: item?.id ?? item?.campaignId,
      name: String(item?.name ?? item?.campaignName ?? item?.title ?? ''),
      campaignType: Number(item?.campaignType ?? item?.type ?? 0) || null,
      status: item?.status ?? null
    }))
    .filter((item) => item.id !== null && item.id !== undefined && String(item.id).trim())
}

function normalizeCampaignIds(ids = []) {
  const normalized = []
  const seen = new Set()
  for (const id of Array.isArray(ids) ? ids : []) {
    const key = String(id ?? '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    normalized.push(typeof id === 'number' && Number.isFinite(id) ? id : key)
  }
  return normalized
}

function buildDeleteCampaignBody(ids) {
  const normalizedIds = normalizeCampaignIds(ids)
  if (!normalizedIds.length) throw new Error('没有可删除的京东快车计划')
  return {
    operateType: 3,
    ids: normalizedIds,
    requestFrom: 0
  }
}

module.exports = {
  CAMPAIGN_LIST_URL,
  CAMPAIGN_STATUS_UPDATE_URL,
  DELETE_CAMPAIGN_TYPES,
  buildCampaignListBody,
  buildDeleteCampaignBody,
  normalizeCampaignIds,
  normalizeCampaignList
}
