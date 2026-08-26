'use strict'

const DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000

function isAuthRelatedFailure(result) {
  const message = String(result && result.message || '')
  return /Cookie|登录|未登录|过期/i.test(message)
}

function createAftersaleAutoSync(options = {}) {
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS
  const getToken = options.getToken
  const listStores = options.listStores
  const syncStore = options.syncStore
  const onStart = typeof options.onStart === 'function' ? options.onStart : () => {}
  const onComplete = typeof options.onComplete === 'function' ? options.onComplete : () => {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout

  let enabled = false
  let timer = null
  let runningPromise = null
  let nextRunAt = null

  function clearScheduledRun() {
    if (!timer) return
    clearTimer(timer)
    timer = null
    nextRunAt = null
  }

  function scheduleNext() {
    clearScheduledRun()
    if (!enabled || runningPromise) return
    timer = setTimer(() => {
      timer = null
      nextRunAt = null
      run('timer').catch(error => log(`timer_run_failed reason=${error.message}`))
    }, intervalMs)
    nextRunAt = Date.now() + intervalMs
    if (timer && typeof timer.unref === 'function') timer.unref()
    log(`scheduled interval_ms=${intervalMs}`)
  }

  async function execute(source) {
    const runToken = typeof getToken === 'function' ? getToken() : null
    const startedAt = new Date().toISOString()
    const summary = {
      source,
      startedAt,
      finishedAt: null,
      total: 0,
      successCount: 0,
      failCount: 0,
      skipCount: 0,
      interrupted: false
    }

    if (!enabled || !runToken) {
      summary.interrupted = true
      summary.reason = 'not_authenticated'
      summary.finishedAt = new Date().toISOString()
      return summary
    }

    let stores
    try {
      stores = await listStores()
    } catch (error) {
      summary.failCount = 1
      summary.reason = `list_stores_failed:${error.message}`
      summary.finishedAt = new Date().toISOString()
      return summary
    }

    stores = Array.isArray(stores) ? stores : []
    summary.total = stores.length

    for (let index = 0; index < stores.length; index++) {
      if (!enabled || getToken() !== runToken) {
        summary.interrupted = true
        summary.reason = 'auth_changed'
        summary.skipCount += stores.length - index
        break
      }

      const store = stores[index]
      const storeId = store && (store.id || store.store_id)
      if (!storeId) {
        summary.failCount++
        log('store_failed store_id=missing reason=missing_store_id')
        continue
      }
      try {
        const result = await syncStore(storeId)
        if (result && result.success) {
          summary.successCount++
          log(`store_completed store_id=${storeId} result=success`)
        } else if (isAuthRelatedFailure(result)) {
          summary.skipCount++
          log(`store_completed store_id=${storeId} result=skipped reason=${String(result && result.message || 'auth_invalid')}`)
        } else {
          summary.failCount++
          log(`store_completed store_id=${storeId} result=failed reason=${String(result && result.message || 'unknown')}`)
        }
      } catch (error) {
        summary.failCount++
        log(`store_failed store_id=${storeId} reason=${error.message}`)
      }
    }

    summary.finishedAt = new Date().toISOString()
    return summary
  }

  async function run(source = 'manual') {
    if (runningPromise) {
      log(`reuse_running source=${source}`)
      return runningPromise
    }

    clearScheduledRun()
    try {
      onStart({ source, startedAt: new Date().toISOString() })
    } catch (error) {
      log(`start_callback_failed reason=${error.message}`)
    }
    runningPromise = execute(source)
    let completedResult = null
    try {
      completedResult = await runningPromise
      return completedResult
    } finally {
      runningPromise = null
      scheduleNext()
      if (completedResult) {
        try {
          onComplete(completedResult)
        } catch (error) {
          log(`complete_callback_failed reason=${error.message}`)
        }
      }
    }
  }

  function start() {
    enabled = true
    scheduleNext()
  }

  function stop() {
    enabled = false
    clearScheduledRun()
    log('stopped')
  }

  return {
    start,
    stop,
    run,
    isEnabled: () => enabled,
    isRunning: () => !!runningPromise,
    hasScheduledRun: () => !!timer,
    getNextRunAt: () => nextRunAt
  }
}

module.exports = {
  DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS,
  createAftersaleAutoSync,
  isAuthRelatedFailure
}
