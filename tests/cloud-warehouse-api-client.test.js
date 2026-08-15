import { describe, expect, it, vi } from 'vitest'
import apiClientModule from '../server/services/cloud-warehouse-api-client.js'

const {
  DEFAULT_BASE_URL,
  createCloudWarehouseApiClient,
  getConfig,
  responseErrorMessage
} = apiClientModule

describe('云仓助手第三方接口安全配置', () => {
  it('固定使用正式 HTTPS 地址', () => {
    expect(DEFAULT_BASE_URL).toBe('https://150.158.54.108:3443')
  })

  it('不要求接口密钥、固定叶证书文件或指纹', () => {
    const config = getConfig({})
    expect(config.baseUrl.href).toBe('https://150.158.54.108:3443/')
    expect(config).not.toHaveProperty('apiKey')
    expect(config).not.toHaveProperty('ca')
    expect(config).not.toHaveProperty('fingerprint')
  })
})

describe('云仓助手第三方三接口', () => {
  it('只调用在线查询、指令提交和结果查询三个固定入口', async () => {
    const requestJson = vi.fn(async (_method, _path, _body, expectedStatuses) => ({
      httpStatus: expectedStatuses[0],
      body: {}
    }))
    const client = createCloudWarehouseApiClient({ requestJson })

    await client.getMachineStatus('YC-7F3K-92MX')
    await client.submitCommand({
      request_id: 'request-001',
      machine_code: 'YC-7F3K-92MX',
      command: 'exception.order.check',
      order_no: '3589471019934064',
      order_year: 2026
    })
    await client.getCommandResult('request-001')

    expect(requestJson.mock.calls).toEqual([
      ['GET', '/api/cloud-warehouse/v1/machines/YC-7F3K-92MX/status', undefined, [200]],
      ['POST', '/api/cloud-warehouse/v1/commands', {
        request_id: 'request-001',
        machine_code: 'YC-7F3K-92MX',
        command: 'exception.order.check',
        order_no: '3589471019934064',
        order_year: 2026
      }, [200, 202]],
      ['GET', '/api/cloud-warehouse/v1/commands/request-001', undefined, [200, 202]]
    ])
  })

  it('第三方错误体为对象时提取可读消息而不是显示 object Object', () => {
    expect(responseErrorMessage({
      error: { code: 'machine_busy', message: '目标云仓助手正在执行其他任务' }
    }, 409)).toBe('目标云仓助手正在执行其他任务')
    expect(responseErrorMessage({ error: { code: 'rate_limited' } }, 429)).toBe('rate_limited')
    expect(responseErrorMessage({ error: {} }, 502)).toBe('HTTP 502')
  })
})
