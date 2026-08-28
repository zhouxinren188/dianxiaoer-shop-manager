import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

describe('售后纠纷同步安全机制', () => {
  const fetchSource = fs.readFileSync('src/main/aftersale-fetch.js', 'utf8')
  const metricsSource = fs.readFileSync('src/main/aftersale-metrics.js', 'utf8')
  const viewSource = fs.readFileSync('src/renderer/src/views/aftersale/ReturnExchange.vue', 'utf8')
  const serverSource = fs.readFileSync('server/index.js', 'utf8')
  const preloadSource = fs.readFileSync('src/preload/index.js', 'utf8')
  const homeSource = fs.readFileSync('src/renderer/src/views/home/HomePage.vue', 'utf8')

  it('不会使用可能永久悬空的 async Promise executor', () => {
    expect(fetchSource).not.toContain('new Promise(async')
    expect(fetchSource).toContain("message: '读取店铺Cookie失败: ' + error.message")
  })

  it('同一店铺复用进行中的同步并安全清理轮询窗口', () => {
    expect(fetchSource).toContain('activeAftersaleFetches.get(key)')
    expect(fetchSource).toContain('aftersaleFetchQueue')
    expect(fetchSource).toContain('action=reuse_inflight')
    expect(fetchSource).toContain('if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }')
    expect(fetchSource).toContain('if (!win || win.isDestroyed() || resolved) return')
  })

  it('服务端 HTTP 200 仍需业务 code 为 0 才判定保存成功', () => {
    expect(fetchSource).toContain('if (!result || result.code !== 0)')
    expect(fetchSource).toContain("throw new Error(result?.message || '服务器保存售后指标失败')")
  })

  it('自动同步由用户勾选控制且 IPC 仅通过白名单暴露', () => {
    expect(viewSource).toContain('v-model="autoSyncEnabled"')
    expect(viewSource).toContain('每小时自动同步')
    expect(fetchSource).toContain("ipcMain.handle('toggle-aftersale-auto-sync'")
    expect(fetchSource).toContain("ipcMain.handle('aftersale-auto-sync-status'")
    expect(fetchSource).toContain("autoSyncController.run('enabled')")
    expect(preloadSource).toContain("'toggle-aftersale-auto-sync'")
    expect(preloadSource).toContain("'aftersale-auto-sync-status'")
    expect(preloadSource).toContain("'aftersale-auto-sync-start'")
  })

  it('完整保存首页原始响应并展示物流异常与消费者发票', () => {
    expect(fetchSource).toContain('raw_data: JSON.stringify(apiResponse)')
    expect(metricsSource).toContain("1011: 'pending_logistics_exceptions'")
    expect(metricsSource).toContain("1012: 'pending_consumer_invoices'")
    expect(serverSource).toContain('pending_logistics_exceptions')
    expect(serverSource).toContain('pending_consumer_invoices')
    expect(viewSource).toContain('pendingLogisticsExceptions')
    expect(viewSource).toContain('pendingConsumerInvoices')
    expect(homeSource).toContain('待开发票（{{ pendingInvoiceTotal }}）')
    expect(homeSource).toContain('fetchAftersaleMetrics({ _ts: Date.now() })')
    expect(homeSource).toContain('totalPendingConsumerInvoices')
    expect(homeSource).toContain('store?.pendingConsumerInvoices')
    expect(homeSource).toContain('Math.max(summaryTotal, storeTotal, invoiceList.length)')
    expect(fetchSource).toContain("'pending_consumer_invoices'")
    expect(fetchSource).toContain("webContents.send('aftersale-metric-updated'")
    expect(homeSource).toContain("window.electronAPI.onUpdate('aftersale-metric-updated'")
    expect(homeSource).toContain("event?.metric !== 'pending_consumer_invoices'")
    expect(fetchSource).toContain('queryPendingReviewApplyOrderList')
    expect(fetchSource).toContain("'[AftersaleFetch] calling pending invoice API for store:'")
    expect(fetchSource).toContain('if (pendingInvoiceCount <= 0)')
    expect(fetchSource).toContain('requestBody.pending_invoices = []')
    expect(fetchSource).toContain('pending invoice count is 0; skipping invoice page')
    expect(fetchSource).toContain('buildPendingInvoiceDirectQueryScript()')
    expect(fetchSource).toContain("JD_PENDING_INVOICE_APP_ID = 'QDWB4GJVETRIFPT7RHSL'")
    expect(fetchSource).toContain("phase=invoice_api result=success")
    expect(fetchSource).not.toContain('new CDPNetworkCapture')
    expect(fetchSource).not.toContain('JD_PENDING_INVOICE_URL')
    expect(fetchSource).toContain('pending_invoices: pendingInvoiceSnapshot.items')
    expect(serverSource).toContain('pending_invoices_json')
    expect(serverSource).toContain('pendingInvoices')
    expect(serverSource).toContain('normalizedApplyTime + PENDING_INVOICE_DEADLINE_MS')
    expect(homeSource).toContain('发票抬头')
    expect(homeSource).toContain('发票金额')
    expect(homeSource).toContain('开票主体')
    expect(homeSource).toContain('倒计时')
    expect(homeSource).toContain('已超时 ${days}天 ${clock}')
    expect(homeSource).toContain("invoke('open-store-backend-url'")
    expect(homeSource).toContain('https://shop.jd.com/jdm/finance/consumerInvoice/cinvoiceOrder')
    expect(homeSource).not.toContain('order-details?orderId=${encodeURIComponent(invoice.orderId)}')
  })

  it('实时违约数量先更新当前行再无缓存复核服务器数据', () => {
    expect(viewSource).toContain("const params = { _ts: Date.now() }")
    expect(viewSource).toContain("window.electronAPI.onUpdate('aftersale-metric-updated'")
    expect(viewSource).toContain('row.pendingViolations = value')
    expect(viewSource).toContain('summary.totalPendingViolations = Math.max(')
    expect(viewSource).toContain('metricRefreshTimer = setTimeout(() => { loadData() }, 300)')
  })

  it('手动同步每完成一家店铺就立即刷新服务器结果', () => {
    expect(viewSource).toContain('successCount++')
    expect(viewSource).toContain('不再等所有店铺同步完成后才统一展示')
    expect(viewSource).toMatch(/successCount\+\+[\s\S]*?await loadData\(\)[\s\S]*?else if/)
    expect(viewSource).not.toMatch(/syncProgress\.value = ''[\s\S]*?if \(successCount > 0\) await loadData\(\)/)
  })

  it('首页指标先上传，发票详情失败不阻塞整店数据', () => {
    expect(fetchSource).toContain('async function uploadMetrics(requestBody)')
    expect(fetchSource).toContain('phase=metrics_uploaded invoice_count=')
    expect(fetchSource).toMatch(/await uploadMetrics\(requestBody\)[\s\S]*?capturePendingInvoiceDetails\(metrics\)/)
    expect(fetchSource).toContain('phase=invoice_details result=not_captured')
    expect(fetchSource).toContain("finish({ success: true, metrics, pendingInvoiceDetails: null })")
  })

  it('直接打开京东工作台首页并在页面完成加载前开始捕获', () => {
    expect(fetchSource).toContain("const JD_HOME_URL = 'https://shop.jd.com/jdm/home'")
    expect(fetchSource).toContain('startPolling()')
    expect(fetchSource).toContain('页面尚未建立脚本上下文时仍继续检查 CDP 捕获结果')
    expect(fetchSource).toContain('phase=home_capture result=timeout')
    expect(fetchSource).toContain('schedulePoll(1000)')
    expect(fetchSource).not.toContain('const OVERALL_TIMEOUT = 120000')
  })
})
