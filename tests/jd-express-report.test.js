import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  HOME_REPORT_COLUMNS,
  JZT_BALANCE_URL,
  JZT_BUSINESS_TYPE,
  KUAICHE_ACCOUNT_REPORT_FIELDS,
  KUAICHE_ACCOUNT_REPORT_URL,
  buildHomeSpendReportBody,
  extractHomeSpend,
  extractJztBalance,
  fetchHomeSpend,
  fetchJztBalance
} = require('../src/main/jd-express-report')

const now = new Date('2026-09-08T12:00:00+08:00').getTime()

describe('京东快车首页消耗', () => {
  it('保留原版账户报表字段，但首页只请求花费', () => {
    expect(KUAICHE_ACCOUNT_REPORT_FIELDS).toMatchObject({
      cost: 'cost',
      roi: 'totalOrderROI',
      orderAmount: 'totalOrderSum',
      orderCount: 'totalOrderCnt'
    })
    expect(HOME_REPORT_COLUMNS).toEqual(['cost'])
    expect(buildHomeSpendReportBody(now)).toMatchObject({
      requestFrom: 0,
      page: 1,
      pageSize: 40,
      startDay: '2026-09-01',
      endDay: '2026-09-08',
      isDaily: true,
      obys: 'date|desc',
      columns: ['cost']
    })
  })

  it('从当月按日账户报表计算今日、本月消耗并保留每日明细', () => {
    const result = extractHomeSpend({
      code: 1,
      data: {
        datas: [
          { date: '2026-09-08', cost: '12.34' },
          { date: '2026-09-07', cost: 5.66 },
          { date: '2026-09-01', cost: '¥2.00' },
          { date: '2026-04-01', cost: 100 }
        ],
        paginator: { items: 4 }
      }
    }, now)
    expect(result).toEqual({
      todaySpend: 12.34,
      monthSpend: 20,
      dailySpends: [
        { date: '2026-09-01', spend: 2 },
        { date: '2026-09-07', spend: 5.66 },
        { date: '2026-09-08', spend: 12.34 }
      ],
      rowCount: 4
    })
  })

  it('使用原版搜索快车账户接口并保持只读 POST', async () => {
    const requestJson = vi.fn(async () => ({
      code: 1,
      data: { datas: [{ date: '2026-09-08', cost: 8.88 }] }
    }))
    const result = await fetchHomeSpend({ platformSession: {}, requestJson, now })
    expect(result).toMatchObject({
      todaySpend: 8.88,
      monthSpend: 8.88,
      dailySpends: [{ date: '2026-09-08', spend: 8.88 }]
    })
    expect(requestJson).toHaveBeenCalledWith(
      {},
      KUAICHE_ACCOUNT_REPORT_URL,
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ columns: ['cost'] })
      })
    )
  })

  it('接口失败时抛出错误，由首页按单店未同步处理', () => {
    expect(() => extractHomeSpend({ code: -100, success: false, msg: '登录失败' }, now))
      .toThrow('登录失败')
  })

  it('读取京准通余额并保持 businessType=2 的只读查询口径', async () => {
    expect(JZT_BUSINESS_TYPE).toBe(2)
    expect(extractJztBalance({ code: 1, data: { jztBalance: '¥1,234.56' } })).toBe(1234.56)
    const requestJson = vi.fn(async () => ({ code: 1, data: { jztBalance: 88.9 } }))
    await expect(fetchJztBalance({ platformSession: {}, requestJson })).resolves.toBe(88.9)
    expect(requestJson).toHaveBeenCalledWith(
      {},
      JZT_BALANCE_URL,
      expect.objectContaining({
        method: 'POST',
        body: { businessType: 2 }
      })
    )
  })

  it('京准通余额缺失时不误报为零', () => {
    expect(() => extractJztBalance({ code: 1, data: {} })).toThrow('未返回余额')
  })
})
