import { describe, expect, it, vi } from 'vitest'
import pool from '../src/main/concurrency-pool.js'

const { runWithConcurrency } = pool

describe('runWithConcurrency', () => {
  it('runs at most two jobs at the same time and preserves result order', async () => {
    let active = 0
    let maxActive = 0

    const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, value % 2 === 0 ? 2 : 5))
      active -= 1
      return value * 10
    })

    expect(maxActive).toBe(2)
    expect(results).toEqual([10, 20, 30, 40, 50])
  })

  it('stagger starts only the additional lane and keeps the configured lane delay', async () => {
    const waits = []
    const releaseSecondLane = []
    const wait = vi.fn(ms => {
      waits.push(ms)
      if (ms === 2000) {
        return new Promise(resolve => releaseSecondLane.push(resolve))
      }
      return Promise.resolve()
    })
    const started = []

    const running = runWithConcurrency([1, 2], 2, async (value, index, laneIndex) => {
      started.push({ value, index, laneIndex })
      return value
    }, { staggerMs: 2000, wait })

    await Promise.resolve()
    expect(started).toEqual([{ value: 1, index: 0, laneIndex: 0 }])
    expect(waits).toEqual([2000])
    releaseSecondLane[0]()
    await expect(running).resolves.toEqual([1, 2])
    expect(started[1]).toEqual({ value: 2, index: 1, laneIndex: 1 })
  })

  it('falls back to one lane for invalid concurrency', async () => {
    const lanes = []
    await runWithConcurrency([1, 2], 0, async (_value, _index, laneIndex) => {
      lanes.push(laneIndex)
    })
    expect(lanes).toEqual([0, 0])
  })

  it('continues assigning later jobs when one worker throws and onError handles it', async () => {
    const visited = []
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async value => {
      visited.push(value)
      if (value === 2) throw new Error('boom')
      return value
    }, {
      onError: (error, value) => ({ failedValue: value, message: error.message })
    })

    expect(visited.sort()).toEqual([1, 2, 3, 4])
    expect(results).toEqual([1, { failedValue: 2, message: 'boom' }, 3, 4])
  })
})
