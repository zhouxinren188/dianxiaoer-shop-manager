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

  it('首次进入云仓弹窗时仅对从未查询过的订单自动查询一次', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    expect(renderer).toContain('function shouldAutoCheckCloudException(config)')
    expect(renderer).toContain("config?.transportMode === 'third_party'")
    expect(renderer).toContain('!config.workflow')
    expect(renderer).toContain('!config.exception')
    expect(renderer).toContain('!config.exceptionResolution')
    expect(renderer).toContain('await handleCloudExceptionCheck({ automatic: true })')
  })

  it('暂无异常后提供蓝色再次查询入口且不受一次性自动查询限制', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    expect(renderer).toContain('v-else-if="cloudOrderStatus.key === \'normal\'"')
    expect(renderer).toContain('>再次查询</el-button>')
    expect(renderer).toContain('type="primary"')
    expect(renderer).toContain('link')
    expect(renderer).toContain('@click="handleCloudExceptionCheck"')
  })

  it('处理异常前先尝试京东采购编号备注，失败提示后仍继续处理', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    expect(renderer).toContain('async function submitPurchaseNumberToJdRemark(row)')
    expect(renderer).toContain('await submitVendorRemark(salesOrder.storeId, salesOrder.orderId, purchaseNo)')
    expect(renderer).toContain('const remarkResult = await submitPurchaseNumberToJdRemark(row)')
    expect(renderer).toContain('京东自动备注未成功：${remarkResult.message}，将继续处理云仓异常')
    expect(renderer).toContain('duration: 3000')
    expect(renderer.indexOf('const remarkResult = await submitPurchaseNumberToJdRemark(row)'))
      .toBeLessThan(renderer.indexOf('await startCloudExceptionResolve(row.id)'))
  })

  it('异常处理成功回执后提示处理中并自动复查一次', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    expect(renderer).toContain('function shouldRecheckAfterExceptionResolve(config)')
    expect(renderer).toContain("resolution?.transportStatus !== 'completed' || resolution.status !== 'succeeded'")
    expect(renderer).toContain('异常处理中，正在重新查询是否仍有异常')
    expect(renderer).toContain('await handleCloudExceptionCheck({ automatic: true, followUp: true })')
    expect(renderer).toContain('function hasExceptionCheckAfterResolve(config)')
    expect(renderer).toContain('resultRecordedAt')
  })

  it('异常处理明确成功后进入待打印，采购列表按该状态筛选并返回订单状态', () => {
    const service = read('server/services/cloud-warehouse-third-party-service.js')
    const statusService = read('server/services/purchase-order-status-service.js')
    const server = read('server/index.js')
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    expect(service).toContain('applyConfirmedExceptionResolutionStatus')
    expect(statusService).toContain("SET status = 'pending_print'")
    expect(statusService).toContain('mergePurchaseOrderStatus')
    expect(server).toContain("if (status) { sql += ' AND po.status=?'")
    expect(server).toContain('po.account_id, po.status, po.platform_order_no')
    expect(renderer).toContain("{ label: '待打印', value: 'pending_print' }")
  })

  it('待打印页手动查询会发送一次无订单参数的云仓列表查询并在本地匹配', () => {
    const service = read('server/services/cloud-warehouse-third-party-service.js')
    const route = read('server/routes/cloud-warehouse.js')
    const api = read('src/renderer/src/api/cloudWarehouse.js')
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    const database = read('server/db.js')
    expect(service).toContain('function buildWarehouseOrderCheckPayload({ requestId, machineCode })')
    expect(service).toContain("command: assertEnabledCommand('warehouse.order.check')")
    expect(service).not.toContain("function buildWarehouseOrderCheckPayload({ requestId, machineCode, orderNo")
    expect(route).toContain("router.post('/warehouse-orders/check'")
    expect(route).toContain("router.get('/warehouse-orders/check/:requestId'")
    expect(api).toContain("post('/api/cloud-warehouse/warehouse-orders/check', {})")
    expect(renderer).toContain("filterForm.status !== 'pending_print'")
    expect(renderer).toContain('await startCloudWarehouseOrderCheck()')
    expect(renderer).toContain("String(row.sales_order_no || '').trim()")
    expect(database).toContain('MODIFY COLUMN purchase_order_id INT DEFAULT NULL')
  })

  it('云仓区域使用持久处理日志且只在有异常时展示异常明细', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    const api = read('src/renderer/src/api/cloudWarehouse.js')
    const route = read('server/routes/cloud-warehouse.js')
    const database = read('server/db.js')
    expect(renderer).toContain('<div class="cloud-conversation-title">处理日志</div>')
    expect(renderer).not.toContain('接口对话记录')
    expect(renderer).toContain('v-if="cloudHasExceptionResult"')
    expect(renderer).toContain('cloudProcessActionLabel(log.action)')
    expect(api).toContain('/process-logs/auto-remark`')
    expect(route).toContain("router.post('/orders/:purchaseOrderId/process-logs/auto-remark'")
    expect(database).toContain('CREATE TABLE IF NOT EXISTS cloud_order_process_logs')
  })

  it('处理异常按钮在本地准备和远程执行期间持续显示动态处理中', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    expect(renderer).toContain("cloudTaskActionKind.value = 'resolve'")
    expect(renderer).toContain("currentTask?.command === 'exception.order.resolve'")
    expect(renderer).toContain("{{ cloudExceptionResolving ? '处理中…' : '处理异常' }}")
    expect(renderer).toContain(':loading="cloudExceptionResolving"')
  })

  it('指令提交和后续配置刷新分别提示，成功处理不会被刷新错误误报为发送失败', () => {
    const renderer = read('src/renderer/src/views/purchase/PurchaseOrder.vue')
    const route = read('server/routes/cloud-warehouse.js')
    const client = read('server/services/cloud-warehouse-api-client.js')
    expect(renderer).toContain("ElMessage.success('云仓助手已确认异常处理成功')")
    expect(renderer).toContain('异常处理已经成功')
    expect(renderer).toContain('但读取最新状态失败')
    expect(renderer).toContain('cloudOrderConfig.workflow?.refreshFailure')
    expect(route).toContain("String(error?.code || '').startsWith('cloud_api_')")
    expect(route).toContain('refreshFailure: cloudRefreshFailure(error)')
    expect(client).toContain('function responseErrorMessage(responseBody, statusCode)')
    expect(client).not.toContain('responseBody.message || responseBody.error')
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
