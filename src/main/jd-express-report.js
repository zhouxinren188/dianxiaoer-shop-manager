'use strict'

const KUAICHE_ACCOUNT_REPORT_URL = 'https://jzt-api.jd.com/reweb/kuaiche/account/user/list'
const KUAICHE_ACCOUNT_REPORT_REFERER = 'https://jzt.jd.com/jdkc/survey.html#/report/account'

// 保留原版搜索快车账户报表的关键统计字段，当前首页只请求 cost。
const KUAICHE_ACCOUNT_REPORT_FIELDS = Object.freeze({
  impressions: 'impressions',
  cost: 'cost',
  clicks: 'clicks',
  ctr: 'CTR',
  cpm: 'CPM',
  cpc: 'CPC',
  orderCount: 'totalOrderCnt',
  orderAmount: 'totalOrderSum',
  roi: 'totalOrderROI'
})
const HOME_REPORT_COLUMNS = Object.freeze([KUAICHE_ACCOUNT_REPORT_FIELDS.cost])

function formatLocalDate(value) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildHomeSpendReportBody(now = Date.now()) {
  const end = new Date(now)
  const start = new Date(end.getFullYear(), end.getMonth(), 1)
  return {
    requestFrom: 0,
    page: 1,
    pageSize: 40,
    startDay: formatLocalDate(start),
    endDay: formatLocalDate(end),
    platform: '',
    clickOrOrderDay: 15,
    clickOrOrderCaliber: 0,
    giftFlag: 0,
    orderStatusCategory: '',
    isDaily: true,
    filters: [],
    obys: 'date|desc',
    columns: [...HOME_REPORT_COLUMNS]
  }
}

function assertReportResponse(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('京准通账户报表未返回数据')
  if (payload.success === false) throw new Error(payload.msg || payload.message || '京准通账户报表查询失败')
  const code = payload.code ?? payload.subCode
  if (code != null && ![0, 1, 200].includes(Number(code))) {
    throw new Error(payload.msg || payload.message || '京准通账户报表查询失败')
  }
}

function findReportEnvelope(value, depth = 0, visited = new Set()) {
  if (!value || typeof value !== 'object' || depth > 5 || visited.has(value)) return null
  visited.add(value)
  if (Array.isArray(value.datas)) return value
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue
    const envelope = findReportEnvelope(child, depth + 1, visited)
    if (envelope) return envelope
  }
  return null
}

function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const normalized = String(value ?? '').replace(/[￥¥,\s]/g, '')
  const number = Number(normalized)
  return Number.isFinite(number) ? number : 0
}

function normalizeReportDate(value) {
  if (value == null || value === '') return ''
  const text = String(value).trim()
  const matched = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : text
}

function extractHomeSpend(payload, now = Date.now()) {
  assertReportResponse(payload)
  const envelope = findReportEnvelope(payload)
  if (!envelope) throw new Error('京准通账户报表返回结构已变更')
  const rows = envelope.datas
  const today = formatLocalDate(now)
  const month = today.slice(0, 7)
  const getRowDate = (row) => normalizeReportDate(row?.date ?? row?.day ?? row?.startDay)
  const dailyTotals = new Map()
  for (const row of rows) {
    const date = getRowDate(row)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(month)) continue
    dailyTotals.set(date, (dailyTotals.get(date) || 0) + parseAmount(row?.cost))
  }
  // 即使当天没有花费也登记 0，服务端才能确认该店铺今日已成功同步。
  if (!dailyTotals.has(today)) dailyTotals.set(today, 0)
  const dailySpends = Array.from(dailyTotals.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, spend]) => ({
      date,
      spend: Math.round(spend * 100) / 100
    }))
  const monthSpend = dailySpends.reduce((total, item) => total + item.spend, 0)
  const todaySpend = dailyTotals.get(today) || 0
  return {
    todaySpend: Math.round(todaySpend * 100) / 100,
    monthSpend: Math.round(monthSpend * 100) / 100,
    dailySpends,
    rowCount: rows.length
  }
}

function buildHomeSpendRequestOptions(body) {
  return {
    method: 'POST',
    referer: KUAICHE_ACCOUNT_REPORT_REFERER,
    headers: {
      origin: 'https://jzt.jd.com',
      loginmode: '0',
      siteid: '0'
    },
    body,
    timeoutMs: 30000
  }
}

async function fetchHomeSpend(options = {}) {
  const { platformSession, requestJson, now = Date.now() } = options
  if (!platformSession || typeof requestJson !== 'function') {
    throw new Error('快车消耗查询缺少京东请求能力')
  }
  const body = buildHomeSpendReportBody(now)
  const payload = await requestJson(
    platformSession,
    KUAICHE_ACCOUNT_REPORT_URL,
    buildHomeSpendRequestOptions(body)
  )
  return extractHomeSpend(payload, now)
}

module.exports = {
  HOME_REPORT_COLUMNS,
  KUAICHE_ACCOUNT_REPORT_FIELDS,
  KUAICHE_ACCOUNT_REPORT_REFERER,
  KUAICHE_ACCOUNT_REPORT_URL,
  buildHomeSpendReportBody,
  buildHomeSpendRequestOptions,
  extractHomeSpend,
  fetchHomeSpend,
  formatLocalDate
}
