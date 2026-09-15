import { post } from '../api/request'
import { fetchStores } from '../api/store'

const SYNC_INTERVAL_MS = 30 * 60 * 1000
const MIN_MANUAL_GAP_MS = 25 * 60 * 1000

let inFlight = null
let lastCompletedAt = 0
let lastSessionKey = ''
let latestLocalPeriods = null

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        results[index] = { success: false, message: error?.message || '查询失败' }
      }
    }
  })
  await Promise.all(runners)
  return results
}

export function isJdExpressInactiveResult(result) {
  const text = `${result?.code || ''} ${result?.message || ''}`
  return /(?:code\s*=\s*-?3012|\/settled\/#\/information|未开通(?:京准通|快车)?)/i.test(text)
}

export function normalizeSyncResult(store, result) {
  const parsedBalance = result?.balanceAvailable === true && result?.jztBalance != null
    ? Number(result.jztBalance)
    : null
  const jztBalance = Number.isFinite(parsedBalance) && parsedBalance >= 0 ? parsedBalance : null
  if (result?.success) {
    return {
      storeId: Number(store.id),
      status: 'success',
      dailySpends: Array.isArray(result.dailySpends) ? result.dailySpends : [],
      jztBalance
    }
  }
  return {
    storeId: Number(store.id),
    status: isJdExpressInactiveResult(result) ? 'inactive' : 'error',
    message: result?.message || '京准通消耗查询失败',
    jztBalance
  }
}

function formatLocalDate(value = Date.now()) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildLocalJdExpressPeriods(results) {
  const today = formatLocalDate()
  const month = today.slice(0, 7)
  const successful = results.filter((item) => item.status === 'success')
  const failed = results.filter((item) => item.status === 'error')
  const shared = {
    adSyncedStoreCount: successful.length,
    adTotalStoreCount: successful.length + failed.length,
    adSpendUpdatedAt: successful.length
      ? new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : null
  }
  const sum = (predicate) => successful.reduce((storeTotal, item) => (
    storeTotal + item.dailySpends.reduce((dayTotal, daily) => (
      predicate(String(daily.date || '')) ? dayTotal + Number(daily.spend || 0) : dayTotal
    ), 0)
  ), 0)
  const canShow = results.length === 0 || successful.length > 0 || failed.length === 0
  return {
    today: { ...shared, adSpend: canShow ? sum((date) => date === today) : null },
    thisMonth: { ...shared, adSpend: canShow ? sum((date) => date.startsWith(month)) : null }
  }
}

export function getLatestLocalJdExpressPeriods() {
  return latestLocalPeriods
}

export async function fetchAllEnabledJdStores(fetchPage = fetchStores) {
  const pageSize = 100
  const stores = []
  const seen = new Set()
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchPage({
      platform: 'jd',
      status: 'enabled',
      page,
      pageSize
    })
    const list = (response?.list || response?.data?.list || [])
      .filter((store) => store.platform === 'jd' && store.status === 'enabled')
    for (const store of list) {
      const id = Number(store.id)
      if (!Number.isSafeInteger(id) || seen.has(id)) continue
      seen.add(id)
      stores.push(store)
    }
    const total = Number(response?.total ?? response?.data?.total)
    if (!list.length || (Number.isFinite(total) ? stores.length >= total : list.length < pageSize)) break
  }
  return stores
}

export function syncJdExpressSpend(options = {}) {
  const force = options.force === true
  const sessionKey = localStorage.getItem('accessToken') || ''
  if (!sessionKey || !window.electronAPI?.invoke) return Promise.resolve(null)
  if (sessionKey !== lastSessionKey) {
    lastSessionKey = sessionKey
    lastCompletedAt = 0
  }
  if (inFlight) return inFlight
  if (!force && Date.now() - lastCompletedAt < MIN_MANUAL_GAP_MS) return Promise.resolve(null)

  inFlight = (async () => {
    const stores = await fetchAllEnabledJdStores()
    const rawResults = await mapWithConcurrency(stores, 3, (store) => (
      window.electronAPI.invoke('jd-express-home-spend', { storeId: store.id })
    ))
    const results = stores.map((store, index) => normalizeSyncResult(store, rawResults[index]))
    // 本机请求一成功就先更新当前界面；服务端暂时不可用也不能让“今日”继续空白。
    latestLocalPeriods = buildLocalJdExpressPeriods(results)
    window.dispatchEvent(new CustomEvent('jd-express-spend-synced', {
      detail: { localPeriods: latestLocalPeriods, serverSaved: false }
    }))
    const saved = await post('/api/jd-express/spend-sync', { results }, 60000)
    lastCompletedAt = Date.now()
    window.dispatchEvent(new CustomEvent('jd-express-spend-synced', {
      detail: { saved, serverSaved: true }
    }))
    return saved
  })().catch((error) => {
    console.warn('[JD Express Spend Sync] 后台同步暂未完成:', error?.message || error)
    return null
  }).finally(() => {
    inFlight = null
  })

  return inFlight
}

export function startJdExpressSpendScheduler() {
  const startupTimer = setTimeout(() => syncJdExpressSpend(), 1000)
  const intervalTimer = setInterval(() => syncJdExpressSpend({ force: true }), SYNC_INTERVAL_MS)
  return () => {
    clearTimeout(startupTimer)
    clearInterval(intervalTimer)
  }
}
