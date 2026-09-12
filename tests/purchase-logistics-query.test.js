import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')

describe('采购单物流轨迹查询契约', () => {
  it('使用平台订单号查询平台物流，运单号仅作为展示和第三方查询参数', () => {
    expect(serverSource).toContain('SELECT platform_order_no, logistics_no, logistics_company, platform, account_id, logistics_tracking')
    expect(serverSource).toContain('queryTaobaoLogistics(order.platform_order_no, order.logistics_no')
    expect(serverSource).toContain('query1688Logistics(order.platform_order_no, order.logistics_no')
    expect(serverSource).toContain('queryPddLogistics(order.platform_order_no, order.logistics_no')
    expect(serverSource).toContain('orderId=${encodeURIComponent(platformOrderNo)}')
    expect(serverSource).toContain('orderSn=${encodeURIComponent(platformOrderNo)}')
  })

  it('正确解构数据库查询返回的采购账号 Cookie 行', () => {
    const matches = serverSource.match(/;\[cookieRows\] = await pool\.execute\(/g) || []
    expect(matches).toHaveLength(6)
  })
})
