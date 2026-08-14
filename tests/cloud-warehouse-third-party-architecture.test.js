import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

describe('云仓助手第三方服务架构', () => {
  it('店小二业务服务不再公开或维护旧执行器控制面', () => {
    const server = read('server/index.js')
    expect(server).not.toContain("app.use('/api/cloud-warehouse/executor/v1'")
    expect(server).not.toContain('startCloudWarehouseExecutorMaintenance')
    expect(server).not.toContain("require('./services/cloud-warehouse-executor-service')")
    expect(server).not.toContain("'/api/cloud-warehouse/executor/v1'")
  })

  it('机器码配置不再提供旧执行器登记码入口', () => {
    const route = read('server/routes/cloud-warehouse.js')
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    const api = read('src/renderer/src/api/cloudWarehouse.js')
    expect(route).not.toContain("router.post('/machine-binding/enrollment'")
    expect(renderer).not.toContain('生成执行器登记码')
    expect(api).not.toContain('createCloudExecutorEnrollment')
  })

  it('订单指令只发送到云仓助手第三方服务，不再使用旧任务服务', () => {
    const route = read('server/routes/cloud-warehouse.js')
    expect(route).not.toContain('startExceptionCheckTask')
    expect(route).not.toContain('startExceptionResolveTask')
    expect(route).toContain('submitOrderCommand')
    expect(route).toContain("command: 'exception.order.check'")
    expect(route).toContain("command: 'exception.order.resolve'")
  })

  it('前端不能传入或自由选择单次任务机器码', () => {
    const api = read('src/renderer/src/api/cloudWarehouse.js')
    const route = read('server/routes/cloud-warehouse.js')
    expect(api).toContain("post(`/api/cloud-warehouse/orders/${purchaseOrderId}/exception/check`, {})")
    expect(api).toContain("post(`/api/cloud-warehouse/orders/${purchaseOrderId}/exception/resolve`, {})")
    expect(route).toContain('assertEmptyBody(req.body || {})')
  })

  it('新服务端未明确启用第三方模式时前端禁止发送订单指令', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    const service = read('server/services/cloud-warehouse-third-party-service.js')
    expect(renderer).toContain("transportMode === 'third_party'")
    expect(renderer).toContain('!cloudThirdPartyReady')
    expect(service).toContain("transportMode: 'third_party'")
  })

  it('第三方公开v1接口不携带或配置API Key', () => {
    const relatedFiles = [
      read('server/services/cloud-warehouse-api-client.js'),
      read('server/.env.example'),
      read('src/renderer/src/api/cloudWarehouse.js'),
      read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    ].join('\n')
    expect(relatedFiles).not.toContain('X-Cloud-Warehouse-Api-Key')
    expect(relatedFiles).not.toContain('CLOUD_WAREHOUSE_API_KEY')
  })

  it('HTTPS使用标准CA信任链和默认IP SAN校验，不固定叶证书指纹', () => {
    const client = read('server/services/cloud-warehouse-api-client.js')
    const envExample = read('server/.env.example')
    expect(client).toContain('rejectUnauthorized: true')
    expect(client).not.toContain('rejectUnauthorized: false')
    expect(client).not.toContain('checkServerIdentity')
    expect(client).not.toContain('fingerprint256')
    expect(envExample).not.toContain('CLOUD_WAREHOUSE_API_CA_FILE')
    expect(envExample).not.toContain('CLOUD_WAREHOUSE_API_CERT_SHA256')
  })
})
