import { describe, expect, it, vi } from 'vitest'
import serverRebate from '../server/services/taobao-rebate-service.js'
import mainRebate from '../src/main/taobao-rebate.js'

describe('淘宝返利转链服务', () => {
  it('按文档发送 X-Api-Key 和 JSON url', async () => {
    const transport = vi.fn(async () => ({
      statusCode: 200,
      data: {
        status: true,
        msg: '',
        data: 'https://s.click.taobao.com/example'
      }
    }))

    const result = await serverRebate.convertTaobaoRebateUrl({
      url: 'https://item.taobao.com/item.htm?id=123',
      config: {
        providerUrl: serverRebate.DEFAULT_REBATE_API_URL,
        apiKey: 'test-key',
        timeoutMs: 5000
      },
      transport
    })

    expect(result.convertedUrl).toBe('https://s.click.taobao.com/example')
    expect(result.converted).toBe(true)
    expect(transport).toHaveBeenCalledWith(
      serverRebate.DEFAULT_REBATE_API_URL,
      { url: 'https://item.taobao.com/item.htm?id=123' },
      { 'X-Api-Key': 'test-key' },
      5000
    )
  })

  it('拒绝非淘宝来源链接和第三方认证异常', async () => {
    await expect(serverRebate.convertTaobaoRebateUrl({
      url: 'https://example.com/item/1',
      config: { apiKey: 'test-key' }
    })).rejects.toThrow('仅支持淘宝、天猫')

    await expect(serverRebate.convertTaobaoRebateUrl({
      url: 'https://detail.tmall.com/item.htm?id=123',
      config: { providerUrl: serverRebate.DEFAULT_REBATE_API_URL, apiKey: 'test-key', timeoutMs: 5000 },
      transport: async () => ({ statusCode: 200, data: { status: false, msg: '接口密钥无效' } })
    })).rejects.toThrow('接口密钥无效')
  })

  it('商品无佣金时返回原链接且不抛异常', async () => {
    const originalUrl = 'https://item.taobao.com/item.htm?id=892600822092'
    const transport = vi.fn(async () => ({
      statusCode: 200,
      data: { status: false, msg: '无返利：undefined-当前商品无佣金' }
    }))

    const serverResult = await serverRebate.convertTaobaoRebateUrl({
      url: originalUrl,
      config: { providerUrl: serverRebate.DEFAULT_REBATE_API_URL, apiKey: 'test-key', timeoutMs: 5000 },
      transport
    })
    const mainResult = await mainRebate.convertTaobaoRebateUrlDirect(
      originalUrl,
      { providerUrl: mainRebate.DEFAULT_REBATE_API_URL, apiKey: 'test-key', timeoutMs: 5000 },
      transport
    )

    expect(serverResult).toMatchObject({ converted: false, reasonCode: 'no_commission' })
    expect(serverResult.convertedUrl).toBe(originalUrl)
    expect(mainResult).toMatchObject({ url: originalUrl, converted: false, reasonCode: 'no_commission' })
  })

  it('开发版配置解析不泄露到打包客户端', () => {
    expect(mainRebate.parseEnvFile('TAOBAO_REBATE_API_KEY=abc\n#comment\nX=1')).toEqual({
      TAOBAO_REBATE_API_KEY: 'abc',
      X: '1'
    })
    expect(mainRebate.isTaobaoUrl('https://m.tb.cn/h.test')).toBe(true)
    expect(mainRebate.isTaobaoUrl('https://example.com')).toBe(false)
  })
})
