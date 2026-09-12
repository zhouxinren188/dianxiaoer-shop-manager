'use strict'

function toPositiveInteger(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1, Math.floor(number))
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 固定并发数任务池。每个通道一次只处理一个任务，任务结果按输入顺序返回。
 * staggerMs 用于错开通道首次启动，betweenTasksDelayMs 用于同一通道任务间隔。
 */
async function runWithConcurrency(items, concurrency, worker, options = {}) {
  const list = Array.isArray(items) ? items : []
  if (typeof worker !== 'function') throw new TypeError('worker must be a function')
  if (list.length === 0) return []

  const laneCount = Math.min(toPositiveInteger(concurrency, 1), list.length)
  const staggerMs = Math.max(0, Number(options.staggerMs) || 0)
  const betweenTasksDelayMs = Math.max(0, Number(options.betweenTasksDelayMs) || 0)
  const waitFn = typeof options.wait === 'function' ? options.wait : wait
  const onError = typeof options.onError === 'function' ? options.onError : null
  const results = new Array(list.length)
  // 前 laneCount 个任务分别预留给对应通道，避免第一通道在第二通道
  // 错峰等待期间把任务全部抢走；后续任务再由先空闲的通道动态领取。
  let cursor = laneCount

  const lanes = Array.from({ length: laneCount }, (_, laneIndex) => (async () => {
    if (laneIndex > 0 && staggerMs > 0) {
      await waitFn(staggerMs * laneIndex)
    }

    let index = laneIndex
    while (index < list.length) {
      try {
        results[index] = await worker(list[index], index, laneIndex)
      } catch (error) {
        if (!onError) throw error
        results[index] = await onError(error, list[index], index, laneIndex)
      }

      if (cursor < list.length && betweenTasksDelayMs > 0) {
        await waitFn(betweenTasksDelayMs)
      }
      if (cursor >= list.length) return
      index = cursor
      cursor += 1
    }
  })())

  await Promise.all(lanes)
  return results
}

module.exports = {
  runWithConcurrency,
  toPositiveInteger
}
