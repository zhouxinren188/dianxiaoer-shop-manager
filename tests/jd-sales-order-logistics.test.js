import fs from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { extractJdSalesOrderLogistics } = require('../src/main/jd-sales-order-logistics')

describe('JD sales order shipping logistics', () => {
  it('reads current queryOrderPage orderLatestTrackInfo fields', () => {
    expect(extractJdSalesOrderLogistics({
      orderLatestTrackInfo: {
        latestTrackInfo: 'departed sorting center',
        noLogisticsFlag: false,
        waybillCode: 'JDVB65744946883',
        logiCoprId: '2087',
        logiCoprName: '\u4eac\u4e1c\u5feb\u9012',
        packageNum: 1
      },
      logisticsInfoList: [{ logiCoprId: '2087' }]
    })).toEqual({
      logisticsCompany: '\u4eac\u4e1c\u5feb\u9012',
      logisticsNo: 'JDVB65744946883'
    })
  })

  it('returns empty fields for an unshipped order', () => {
    expect(extractJdSalesOrderLogistics({
      orderLatestTrackInfo: {
        noLogisticsFlag: true,
        waybillCode: null,
        logiCoprName: null
      }
    })).toEqual({ logisticsCompany: '', logisticsNo: '' })
  })

  it('keeps compatibility with legacy logisticsInfoList responses', () => {
    expect(extractJdSalesOrderLogistics({
      logisticsInfoList: [{ carrier: 'ZTO', carriageId: 'ZT123456' }]
    })).toEqual({ logisticsCompany: 'ZTO', logisticsNo: 'ZT123456' })
  })

  it('keeps explicit root fields ahead of fallback fields', () => {
    expect(extractJdSalesOrderLogistics({
      logisticsCompany: 'SF',
      logisticsNo: 'SF10086',
      orderLatestTrackInfo: {
        logiCoprName: 'JD',
        waybillCode: 'JDVB00001'
      }
    })).toEqual({ logisticsCompany: 'SF', logisticsNo: 'SF10086' })
  })
})

describe('sales order shipping upsert protection', () => {
  it('does not overwrite stored shipping data with empty sync values', () => {
    const source = fs.readFileSync('server/index.js', 'utf8')
    expect(source).toContain(
      "logistics_no=COALESCE(NULLIF(TRIM(VALUES(logistics_no)), ''), logistics_no)"
    )
  })
})
