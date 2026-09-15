import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildSettlementDashboardPayload,
  buildSettlementOverview,
  normalizeSettlementMetrics
} = require('../server/services/settlement-overview-service')

describe('settlement overview aggregation', () => {
  it('aggregates cached store snapshots and only includes the current yesterday bucket', () => {
    const result = buildSettlementOverview([
      {
        store_id: 1,
        store_name: '店铺A',
        pending_amount: '120.50',
        pending_order_count: 3,
        yesterday_settled_amount: '42.30',
        wallet_balance: '300.00',
        frozen_amount: '20.00',
        withdrawable_amount: '280.00',
        statistics_date: '2026-09-10',
        updated_at: '2026-09-11T01:00:00.000Z'
      },
      {
        store_id: 2,
        store_name: '店铺B',
        pending_amount: '80.00',
        pending_order_count: 2,
        yesterday_settled_amount: '999.00',
        wallet_balance: '100.00',
        frozen_amount: '5.00',
        withdrawable_amount: '95.00',
        statistics_date: '2026-09-09',
        updated_at: '2026-09-11T01:00:00.000Z'
      },
      { store_id: 3, store_name: '店铺C', updated_at: null }
    ], {
      now: new Date('2026-09-11T02:00:00.000Z'),
      statisticsDate: '2026-09-10'
    })

    expect(result.summary).toMatchObject({
      pendingAmount: 200.5,
      pendingOrderCount: 5,
      yesterdaySettledAmount: 42.3,
      walletBalance: 400,
      frozenAmount: 25,
      withdrawableAmount: 375,
      storeCount: 3,
      matchedStoreCount: 2,
      yesterdayMatchedStoreCount: 1,
      staleStoreCount: 2
    })
  })

  it('normalizes non-negative wallet values and derives withdrawable balance', () => {
    expect(normalizeSettlementMetrics({
      pendingAmount: 1,
      pendingOrderCount: 2,
      yesterdaySettledAmount: 3,
      walletBalance: 10,
      frozenAmount: 12,
      statisticsDate: '2026-09-10'
    })).toMatchObject({
      walletBalance: 10,
      frozenAmount: 10,
      withdrawableAmount: 0
    })
  })

  it('builds a compact four-metric payload for the miniprogram dashboard', () => {
    const fullOverview = buildSettlementOverview([
      {
        store_id: 1,
        store_name: '店铺A',
        pending_amount: '12.30',
        pending_order_count: 2,
        yesterday_settled_amount: '4.50',
        wallet_balance: '20.00',
        frozen_amount: '1.00',
        withdrawable_amount: '19.00',
        statistics_date: '2026-09-13',
        updated_at: '2026-09-14T01:00:00.000Z'
      }
    ], {
      now: new Date('2026-09-14T02:00:00.000Z'),
      statisticsDate: '2026-09-13'
    })
    const payload = buildSettlementDashboardPayload(fullOverview)

    expect(payload.summary).toMatchObject({
      pendingAmount: 12.3,
      pendingOrderCount: 2,
      yesterdaySettledAmount: 4.5,
      walletBalance: 20,
      frozenAmount: 1,
      withdrawableAmount: 19
    })
    expect(payload.overview).toMatchObject({
      contractVersion: 1,
      currency: 'CNY',
      metricOrder: [
        'pendingAmount',
        'yesterdaySettledAmount',
        'walletBalance',
        'frozenAmount'
      ]
    })
    expect(payload.overview.metrics.map(item => item.label)).toEqual([
      '待结算金额',
      '昨日结算到账',
      '钱包余额',
      '冻结金额'
    ])
    expect(payload).not.toHaveProperty('list')
  })
})

describe('settlement integration contract', () => {
  it('uses the three verified Jingmai finance requests and persists server snapshots', () => {
    const source = [
      readFileSync(new URL('../src/main/settlement-fetch.js', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/main/finance-page-query-scripts.js', import.meta.url), 'utf8')
    ].join('\n')
    expect(source).toContain('querySumBalAndCount')
    expect(source).toContain('queryEnterpriseBalanceByVenderId')
    expect(source).toContain('settleStatus: 1')
    expect(source).toContain('settleStatus: 2')
    expect(source).toContain('/api/store-settlement-metrics/')
    expect(source).not.toContain('127.0.0.1:28868')
  })

  it('exposes authenticated overview routes and a safe preload channel', () => {
    const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
    const preloadSource = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
    expect(serverSource).toContain("app.get('/api/settlement-overview', handleSettlementOverview)")
    expect(serverSource).toContain("app.get('/api/dashboard/settlement-overview', handleDashboardSettlementOverview)")
    expect(serverSource).toContain("app.post('/api/store-settlement-metrics/:storeId'")
    expect(preloadSource).toContain("'sync-settlement-overview'")
  })
})
