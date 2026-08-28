import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import pendingMetrics from '../src/main/store-backend-pending-metrics'

const {
  PENDING_VIOLATION_API,
  PENDING_FOLLOW_UP_API,
  isPendingViolationPageUrl,
  isPendingFollowUpPageUrl,
  isPendingMetricPageUrl,
  normalizePendingMetricObservation
} = pendingMetrics

describe('store backend pending metric validation', () => {
  it('accepts the captured pending violation total', () => {
    expect(normalizePendingMetricObservation({
      metric: 'pending_violations',
      value: '1',
      api: PENDING_VIOLATION_API,
      query: {checkStatusSet: [6], penaltyType: 1, radio1: '待处理'},
      evidence: 'pending_tab_label',
      observedAt: 123
    })).toEqual({
      metric: 'pending_violations',
      value: 1,
      api: PENDING_VIOLATION_API,
      radio1: '待处理',
      evidence: 'pending_tab_label',
      observedAt: 123
    })
  })

  it('accepts zero after the final violation is processed', () => {
    expect(normalizePendingMetricObservation({
      metric: 'pending_violations',
      value: 0,
      api: PENDING_VIOLATION_API,
      query: {checkStatusSet: [6], penaltyType: 1, radio1: '待处理'},
      evidence: 'active_query'
    })?.value).toBe(0)
  })

  it('rejects another tab, API, status, or invalid total', () => {
    const base = {
      metric: 'pending_violations',
      value: 2,
      api: PENDING_VIOLATION_API,
      query: {checkStatusSet: [6], penaltyType: 1, radio1: '待处理'},
      evidence: 'response_fallback'
    }
    expect(normalizePendingMetricObservation({...base, metric: 'pending_warnings'})).toBeNull()
    expect(normalizePendingMetricObservation({...base, api: 'other'})).toBeNull()
    expect(normalizePendingMetricObservation({...base, evidence: 'unknown'})).toBeNull()
    expect(normalizePendingMetricObservation({...base, query: {checkStatusSet: [5], penaltyType: 1}})).toBeNull()
    expect(normalizePendingMetricObservation({...base, query: {checkStatusSet: [6], penaltyType: 1, radio1: '全部违规'}})).toBeNull()
    expect(normalizePendingMetricObservation({...base, value: -1})).toBeNull()
  })

  it('restricts reports to the JD compliance page', () => {
    expect(isPendingViolationPageUrl('https://illegal-jdm.shop.jd.com/legal?tabsActiveName=2')).toBe(true)
    expect(isPendingViolationPageUrl('https://shop.jd.com/jdm/home')).toBe(false)
    expect(isPendingViolationPageUrl('https://illegal-jdm.shop.jd.com/not-legal')).toBe(false)
  })

  it('accepts only handlingState 0 as pending follow-ups', () => {
    expect(normalizePendingMetricObservation({
      metric: 'pending_follow_ups',
      value: '3',
      api: PENDING_FOLLOW_UP_API,
      query: {handlingState: 0},
      evidence: 'active_query',
      observedAt: 456
    })).toEqual({
      metric: 'pending_follow_ups',
      value: 3,
      api: PENDING_FOLLOW_UP_API,
      handlingState: 0,
      evidence: 'active_query',
      observedAt: 456
    })

    const base = {
      metric: 'pending_follow_ups',
      value: 2,
      api: PENDING_FOLLOW_UP_API,
      evidence: 'response_capture'
    }
    expect(normalizePendingMetricObservation({...base, query: {handlingState: -1}})).toBeNull()
    expect(normalizePendingMetricObservation({...base, query: {handlingState: 1}})).toBeNull()
    expect(normalizePendingMetricObservation({...base, query: {handlingState: 2}})).toBeNull()
  })

  it('restricts pending follow-up reports to the warning center page', () => {
    const warningUrl = 'https://shop.jd.com/jdm/trade/risk/warning-center'
    expect(isPendingFollowUpPageUrl(warningUrl)).toBe(true)
    expect(isPendingFollowUpPageUrl('https://shop.jd.com/jdm/home')).toBe(false)
    expect(isPendingMetricPageUrl('pending_follow_ups', warningUrl)).toBe(true)
    expect(isPendingMetricPageUrl('pending_violations', warningUrl)).toBe(false)
  })

  it('keeps the live update event in the renderer preload allowlist', () => {
    const source = fs.readFileSync(path.resolve('src/preload/index.js'), 'utf8')
    expect(source).toContain("'aftersale-metric-updated'")
  })

  it('refreshes from the strict API after compliance requests without reading page counts', () => {
    const source = fs.readFileSync(path.resolve('resources/store-backend-page-preload.js'), 'utf8')
    expect(source).toContain('function isViolationBusinessRequest(urlValue)')
    expect(source).toContain("api.startsWith('dsm.pop.legal.shop.api.')")
    expect(source).toContain('scheduleFreshPendingQuery(50)')
    expect(source).not.toContain('MutationObserver')
    expect(source).not.toContain('querySelectorAll')
    expect(source).not.toContain('pending_tab_label')
  })

  it('queries handlingState 0 directly and refreshes it after a successful reply', () => {
    const source = fs.readFileSync(path.resolve('resources/store-backend-page-preload.js'), 'utf8')
    expect(source).toContain("handlingState: 0")
    expect(source).toContain("metric: 'pending_follow_ups'")
    expect(source).toContain('queryPendingFollowUps')
    expect(source).toContain("api === replyApi")
    expect(source).toContain('scheduleAfterReply()')
    expect(source).not.toContain('pendingFollowUpMutationObserver')
  })
})
