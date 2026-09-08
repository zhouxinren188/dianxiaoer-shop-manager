import { describe, expect, it } from 'vitest'
import {
  buildLocalJdExpressPeriods,
  isJdExpressInactiveResult
} from '../src/renderer/src/services/jd-express-spend-sync'

describe('京准通消耗后台同步', () => {
  it('把未开通快车与临时查询失败分开', () => {
    expect(isJdExpressInactiveResult({ message: '/settled/#/information?code=-3012' })).toBe(true)
    expect(isJdExpressInactiveResult({ message: '该店铺未开通快车' })).toBe(true)
    expect(isJdExpressInactiveResult({ message: '登录失败' })).toBe(false)
  })

  it('本地即时结果只统计成功店铺且不把未开通店铺计入总量', () => {
    const today = new Date()
    const date = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0')
    ].join('-')
    const result = buildLocalJdExpressPeriods([
      { storeId: 1, status: 'success', dailySpends: [{ date, spend: 18.85 }] },
      { storeId: 2, status: 'inactive', dailySpends: [] },
      { storeId: 3, status: 'error', dailySpends: [] }
    ])
    expect(result.today).toMatchObject({
      adSpend: 18.85,
      adSyncedStoreCount: 1,
      adTotalStoreCount: 2
    })
  })
})
