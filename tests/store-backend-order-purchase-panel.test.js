import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import purchasePanel from '../src/main/store-backend-order-purchase-panel.js'

const {
  ORDER_PURCHASE_ACTION_CHANNEL,
  getJdOrderId,
  getJdAftersaleServiceId,
  getPurchasePanelPageKey,
  normalizePurchaseOrder,
  normalizeReturnLogisticsRecords,
  normalizeLogisticsTracking,
  fetchPurchaseOrdersBySalesOrder,
  fetchPurchaseAccounts,
  fetchPurchaseOrderLogistics,
  updatePurchaseOrderAftersale,
  getOrderPurchaseRuntimeFunctionSource,
  resetOrderPurchaseRuntimeSourceCache,
  buildOrderPurchasePanelScript,
  buildOrderPurchaseLogisticsScript,
  buildOrderPurchaseSyncStateScript,
  buildAfterSaleOrderDiscoveryScript,
  registerOrderPurchasePanelIpc,
  attachOrderPurchasePanel
} = purchasePanel

describe('京东订单详情采购信息区域', () => {
  it('只识别京麦官方订单详情页并提取数字订单号', () => {
    expect(getJdOrderId('https://shop.jd.com/jdm/trade/orders/order-details?orderId=3599471007575277')).toBe('3599471007575277')
    expect(getJdOrderId('https://shop.jd.com/jdm/trade/orders/order-details?orderId=abc')).toBe('')
    expect(getJdOrderId('https://evil.example/jdm/trade/orders/order-details?orderId=3599471007575277')).toBe('')
    expect(getJdOrderId('http://shop.jd.com/jdm/trade/orders/order-details?orderId=3599471007575277')).toBe('')
    expect(getJdAftersaleServiceId('https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/detail?afsServiceId=4048292768')).toBe('4048292768')
    expect(getJdAftersaleServiceId('https://evil.example/jdm/trade/after-sale/independent-after-sale/detail?afsServiceId=4048292768')).toBe('')
    expect(getPurchasePanelPageKey('https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/detail?afsServiceId=4048292768')).toBe('aftersale:4048292768')
  })

  it('把采购类型、状态和物流格式化为页面展示文案', () => {
    expect(normalizePurchaseOrder({
      id: 8,
      purchase_no: 'A1234',
      purchase_type: 'warehouse',
      status: 'in_transit',
      platform: 'tmall',
      account_id: 18,
      platform_order_no: 'TB123',
      account_name: '淘_天下物品',
      goods_name: '古风油纸伞',
      goods_image: '//img.alicdn.com/item.jpg',
      sku: 'SKU-001',
      quantity: 2,
      purchase_price: '26.99',
      total_amount: '56.98',
      shipping_fee: '3.00',
      warehouse_name: '九间1号库',
      shipping_name: '张学军',
      shipping_phone: '17305271170',
      shipping_address: '内蒙古包头市九原区',
      aftersale_status: 'pending_merchant_handle',
      aftersale_remark: '等待商家确认退款',
      logistics_company: '中通快递',
      logistics_no: 'ZT123',
      updated_at: '2026-08-28 11:20:00'
    })).toMatchObject({
      purchaseNo: 'A1234',
      platform: 'taobao',
      accountId: 18,
      accountName: '淘_天下物品',
      platformOrderNo: 'TB123',
      goodsName: '古风油纸伞',
      goodsImage: 'https://img.alicdn.com/item.jpg',
      sku: 'SKU-001',
      quantity: 2,
      purchasePrice: 26.99,
      totalAmount: 56.98,
      shippingFee: 3,
      warehouseName: '九间1号库',
      purchaseTypeLabel: '仓库转发',
      statusLabel: '运输中',
      aftersaleStatusLabel: '待商家处理',
      aftersaleRemark: '等待商家确认退款',
      updatedAt: '2026-08-28 11:20:00',
      logisticsLabel: '中通快递 · ZT123'
    })
  })

  it('normalizes and deduplicates only safe return-logistics linkage fields', () => {
    expect(normalizeReturnLogisticsRecords([
      {
        sales_order_no: '3599471007575277',
        jd_sku: '10213098975565',
        afs_service_id: '44521493693',
        logistics_no: 'SF1234567890',
        logistics_company: 'SF Express',
        buyer_phone: 'should-not-be-forwarded'
      },
      {
        salesOrderNo: '3599471007575277',
        jdSku: '10213098975565',
        afsServiceId: '44521493693',
        waybillCode: 'SF1234567890',
        providerName: 'SF Express'
      },
      {
        sales_order_no: 'not-an-order',
        afs_service_id: '44521493693',
        logistics_no: 'BAD'
      },
      {
        sales_order_no: '3599471007575278',
        afs_service_id: '44521493694',
        logistics_no: 'BAD\nCONTROL'
      }
    ])).toEqual([
      {
        sales_order_no: '3599471007575277',
        jd_sku: '10213098975565',
        afs_service_id: '44521493693',
        logistics_no: 'SF1234567890',
        logistics_company: 'SF Express'
      }
    ])
  })

  it('caps return-logistics capture to the requested bounded page size', () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      sales_order_no: String(3599471007575277n + BigInt(index)),
      afs_service_id: String(44521493693n + BigInt(index)),
      logistics_no: `TRACK-${index}`
    }))
    expect(normalizeReturnLogisticsRecords(records, 3)).toHaveLength(3)
  })

  it('使用精确接口并只保留完全匹配当前销售订单的采购单', async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        list: [
          { sales_order_no: '3599471007575277', purchase_no: 'A1', purchase_type: 'dropship', status: 'pending' },
          { sales_order_no: '35994710075752770', purchase_no: 'A2', purchase_type: 'warehouse', status: 'ordered' }
        ]
      }
    })
    const result = await fetchPurchaseOrdersBySalesOrder('3599471007575277', { request })

    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toContain('/api/purchase-orders/by-sales-order/3599471007575277')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ purchaseNo: 'A1', purchaseTypeLabel: '三方代发', statusLabel: '待发货' })
  })

  it('精确接口明确返回空列表时立即结束，不再执行历史分页回退', async () => {
    const request = vi.fn().mockResolvedValue({ code: 0, data: { list: [], total: 0 } })

    const result = await fetchPurchaseOrdersBySalesOrder('3579222002237877', { request })

    expect(result).toEqual([])
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toContain('/api/purchase-orders/by-sales-order/3579222002237877')
  })

  it('正式字节码模式从打包资源读取可执行注入源码', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-order-panel-runtime-'))
    const runtimePath = path.join(tempDir, 'runtime.json')
    const previousBytecode = process.env.DXE_MAIN_BYTECODE
    const previousRuntimePath = process.env.DXE_ORDER_PURCHASE_RUNTIME_SOURCE
    try {
      fs.writeFileSync(runtimePath, JSON.stringify({
        renderOrderPurchasePanel: "function renderOrderPurchasePanel(model) { return { source: 'external-runtime', model } }"
      }))
      process.env.DXE_MAIN_BYTECODE = '1'
      process.env.DXE_ORDER_PURCHASE_RUNTIME_SOURCE = runtimePath
      resetOrderPurchaseRuntimeSourceCache()

      const source = getOrderPurchaseRuntimeFunctionSource('renderOrderPurchasePanel', () => 'inline')
      const script = buildOrderPurchasePanelScript({ state: 'ready', orderId: '3579222002237877' })

      expect(source).toContain('external-runtime')
      expect(Function('return ' + script)()).toEqual({
        source: 'external-runtime',
        model: { state: 'ready', orderId: '3579222002237877' }
      })
    } finally {
      if (previousBytecode == null) delete process.env.DXE_MAIN_BYTECODE
      else process.env.DXE_MAIN_BYTECODE = previousBytecode
      if (previousRuntimePath == null) delete process.env.DXE_ORDER_PURCHASE_RUNTIME_SOURCE
      else process.env.DXE_ORDER_PURCHASE_RUNTIME_SOURCE = previousRuntimePath
      resetOrderPurchaseRuntimeSourceCache()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('新精确接口尚未部署时回退现有列表接口，保证本地开发版可测试', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 })
    const request = vi.fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({
        code: 0,
        data: { list: [{ sales_order_no: '3599471007575277', purchase_no: 'A9', status: 'ordered' }] }
      })

    const result = await fetchPurchaseOrdersBySalesOrder('3599471007575277', { request })

    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][0]).toContain('/api/purchase-orders/by-sales-order/')
    expect(request.mock.calls[1][0]).toContain('/api/purchase-orders?page=1&pageSize=100')
    expect(result[0]).toMatchObject({ purchaseNo: 'A9', statusLabel: '已下单' })
  })

  it('兼容历史采购单只保存销售订单内部 ID 的情况', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 }))
      .mockResolvedValueOnce({ code: 0, data: { list: [], total: 0 } })
      .mockResolvedValueOnce({
        code: 0,
        data: { list: [{ id: 991, order_id: '3557440011538249' }], total: 1 }
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          list: [{ sales_order_id: 991, sales_order_no: '', purchase_no: 'A8304', status: 'shipped' }],
          total: 1
        }
      })

    const result = await fetchPurchaseOrdersBySalesOrder('3557440011538249', { request })

    expect(request).toHaveBeenCalledTimes(4)
    expect(request.mock.calls[2][0]).toContain('/api/sales-orders?page=1&pageSize=5&order_id=3557440011538249')
    expect(request.mock.calls[3][0]).toContain('/api/purchase-orders?page=1&pageSize=100')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ purchaseNo: 'A8304', statusLabel: '已发货' })
  })

  it('点击后按采购单ID查询并统一物流轨迹字段', async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        company: '邮政快递包裹',
        tracking_no: '9823054519919',
        source: 'local',
        tracks: [
          { time: '2026-08-28 10:20:00', context: '快件已到达沈阳转运中心' },
          { timestamp: '2026-08-27 19:10:00', desc: '快件已揽收' }
        ]
      }
    })

    const result = await fetchPurchaseOrderLogistics(8, { request })

    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toContain('/api/purchase-orders/8/logistics')
    expect(result).toEqual({
      company: '邮政快递包裹',
      trackingNo: '9823054519919',
      source: 'local',
      tracks: [
        { time: '2026-08-28 10:20:00', context: '快件已到达沈阳转运中心' },
        { time: '2026-08-27 19:10:00', context: '快件已揽收' }
      ]
    })
    expect(normalizeLogisticsTracking({ tracks: [{ message: '运输中' }] }).tracks[0].context).toBe('运输中')
  })

  it('按采购单ID保存售后状态和处理日志', async () => {
    const request = vi.fn().mockResolvedValue({ code: 0, data: true })

    await expect(updatePurchaseOrderAftersale(81, {
      aftersaleStatus: 'pending_return_refund',
      aftersaleRemark: '用户已退款，请申请退货退款。'
    }, { request })).resolves.toMatchObject({
      purchaseId: 81,
      aftersaleStatus: 'pending_return_refund'
    })

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining('/api/purchase-orders/81/status'),
      expect.objectContaining({
        method: 'PUT',
        body: {
          aftersale_status: 'pending_return_refund',
          aftersale_remark: '用户已退款，请申请退货退款。'
        }
      })
    )
    await expect(updatePurchaseOrderAftersale(81, { aftersaleStatus: 'unknown' }, { request }))
      .rejects.toThrow('请选择有效的售后状态')
  })

  it('售后详情只从结构化订单字段或明确订单链接解析销售订单号', () => {
    const script = buildAfterSaleOrderDiscoveryScript('4048292768')
    expect(script).toContain('/jdm/trade/after-sale/independent-after-sale/detail')
    expect(script).toContain('a[href*="orderId="]')
    expect(script).toContain("'orderid'")
    expect(script).toContain("'jdorderid'")
    expect(script).toContain("evidence: 'labeled_order_id'")
    expect(script).not.toContain('cookie')
  })

  it('附加到已打开的详情页时无需等待后续导航也会主动加载采购信息', async () => {
    vi.useFakeTimers()
    try {
      const webContents = new EventEmitter()
      webContents.id = 700
      webContents.isDestroyed = vi.fn(() => false)
      webContents.getURL = vi.fn(() => 'https://shop.jd.com/jdm/trade/orders/order-details?orderId=3599471007575277')
      webContents.executeJavaScript = vi.fn(() => Promise.resolve(true))
      const fetchPurchaseOrders = vi.fn(() => Promise.resolve([{
        id: 80,
        purchaseNo: 'A8100',
        purchaseTypeLabel: '仓库转发',
        statusLabel: '已发货'
      }]))

      attachOrderPurchasePanel(webContents, { fetchPurchaseOrders })
      await vi.advanceTimersByTimeAsync(1)
      for (let index = 0; index < 20; index += 1) await Promise.resolve()

      expect(fetchPurchaseOrders).toHaveBeenCalledWith('3599471007575277')
      expect(webContents.executeJavaScript.mock.calls.some(call => call[0].includes('"state":"ready"'))).toBe(true)
      webContents.emit('destroyed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('普通京麦页面不反复执行无效的浮层清理脚本', async () => {
    vi.useFakeTimers()
    try {
      const webContents = new EventEmitter()
      webContents.id = 702
      webContents.isDestroyed = vi.fn(() => false)
      webContents.getURL = vi.fn(() => 'https://shop.jd.com/')
      webContents.executeJavaScript = vi.fn(() => Promise.resolve(true))

      attachOrderPurchasePanel(webContents)
      webContents.emit('did-start-navigation', 'https://shop.jd.com/', false, true)
      webContents.emit('did-navigate', {}, 'https://shop.jd.com/')
      webContents.emit('dom-ready')
      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(9000)

      expect(webContents.executeJavaScript).not.toHaveBeenCalled()
      webContents.emit('destroyed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('通过页面 preload 的正式 IPC 通道查询并回填物流轨迹', async () => {
    vi.useFakeTimers()
    try {
      const registeredHandlers = new Map()
      registerOrderPurchasePanelIpc({
        handle: vi.fn((channel, handler) => registeredHandlers.set(channel, handler))
      })

      const webContents = new EventEmitter()
      webContents.id = 701
      webContents.isDestroyed = vi.fn(() => false)
      webContents.getURL = vi.fn(() => 'https://shop.jd.com/jdm/trade/orders/order-details?orderId=3599471007575277')
      webContents.executeJavaScript = vi.fn(() => Promise.resolve(true))
      const fetchPurchaseOrders = vi.fn(() => Promise.resolve([{
        id: 81,
        purchaseNo: 'A8101',
        logisticsNo: 'ZT123456',
        logisticsCompany: '中通快递'
      }]))
      const fetchPurchaseOrderLogistics = vi.fn(() => Promise.resolve({
        company: '中通快递',
        trackingNo: 'ZT123456',
        source: 'local',
        tracks: [{ time: '2026-08-28 10:20:00', context: '快件运输中' }]
      }))
      const updatePurchaseAftersale = vi.fn(() => Promise.resolve({
        purchaseId: 81,
        aftersaleStatus: 'pending_refund'
      }))

      attachOrderPurchasePanel(webContents, { fetchPurchaseOrders, fetchPurchaseOrderLogistics, updatePurchaseAftersale })
      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(300)
      const readyScript = webContents.executeJavaScript.mock.calls.map(call => call[0]).find(script => script.includes('"state":"ready"'))
      const nonce = readyScript.match(/"actionNonce":"([^"]+)"/)?.[1]
      const handler = registeredHandlers.get(ORDER_PURCHASE_ACTION_CHANNEL)

      const response = await handler({ sender: { id: 701 } }, {
        nonce,
        action: 'view-logistics',
        orderId: '3599471007575277',
        purchaseId: 81
      })

      expect(response).toMatchObject({ ok: true, result: { action: 'view-logistics', purchaseId: 81, trackCount: 1 } })
      expect(fetchPurchaseOrderLogistics).toHaveBeenCalledWith(81)
      expect(webContents.executeJavaScript.mock.calls.some(call => call[0].includes('快件运输中'))).toBe(true)

      const aftersaleResponse = await handler({ sender: { id: 701 } }, {
        nonce,
        action: 'mark-aftersale',
        orderId: '3599471007575277',
        purchaseId: 81,
        aftersaleStatus: 'pending_refund',
        aftersaleRemark: '用户已退款，商品已拒收，请申请退款。'
      })
      expect(aftersaleResponse).toMatchObject({
        ok: true,
        result: { action: 'mark-aftersale', purchaseId: 81, aftersaleStatus: 'pending_refund' }
      })
      expect(updatePurchaseAftersale).toHaveBeenCalledWith(81, {
        aftersaleStatus: 'pending_refund',
        aftersaleRemark: '用户已退款，商品已拒收，请申请退款。'
      })
      webContents.emit('destroyed')

      const aftersaleContents = new EventEmitter()
      aftersaleContents.id = 702
      aftersaleContents.isDestroyed = vi.fn(() => false)
      aftersaleContents.getURL = vi.fn(() => 'https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/detail?afsServiceId=4048292768')
      aftersaleContents.executeJavaScript = vi.fn(() => Promise.resolve(true))
      const fetchAfterSalePurchases = vi.fn(() => Promise.resolve([{
        id: 82,
        purchaseNo: 'A8303',
        platform: 'taobao',
        platformOrderNo: '5127692041018003142',
        goodsName: '古风油纸伞'
      }]))
      attachOrderPurchasePanel(aftersaleContents, { fetchPurchaseOrders: fetchAfterSalePurchases })

      const resolved = await handler({ sender: { id: 702 } }, {
        action: 'resolve-aftersale-order',
        afsServiceId: '4048292768',
        orderId: '3557439004118866',
        evidence: 'xhr:sff.jd.com'
      })
      await vi.advanceTimersByTimeAsync(1)
      for (let index = 0; index < 10; index += 1) await Promise.resolve()

      expect(resolved).toMatchObject({ ok: true, result: { action: 'resolve-aftersale-order', orderId: '3557439004118866' } })
      expect(fetchAfterSalePurchases).toHaveBeenCalledWith('3557439004118866')
      expect(aftersaleContents.executeJavaScript.mock.calls.some(call => call[0].includes('"pageKey":"aftersale:4048292768"'))).toBe(true)
      aftersaleContents.emit('destroyed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('读取当前用户可用的采购账号供未绑定账号的采购单同步', async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        list: [
          { id: 11, platform: 'taobao', cookie_valid: 1, online: 1 },
          { id: 12, platform: '1688', cookie_valid: 0, online: 0 }
        ]
      }
    })

    await expect(fetchPurchaseAccounts({ request })).resolves.toEqual([
      { id: 11, platform: 'taobao', cookieValid: true, online: true },
      { id: 12, platform: '1688', cookieValid: false, online: false }
    ])
    expect(request.mock.calls[0][0]).toContain('/api/purchase-accounts')
  })

  it('把页面同步操作桥接到现有主进程单订单同步能力并在完成后重读数据', async () => {
    vi.useFakeTimers()
    try {
      const webContents = new EventEmitter()
      webContents.isDestroyed = vi.fn(() => false)
      webContents.getURL = vi.fn(() => 'https://shop.jd.com/jdm/trade/orders/order-details?orderId=3599471007575277')
      webContents.executeJavaScript = vi.fn(() => Promise.resolve(true))
      const fetchPurchaseOrders = vi.fn(() => Promise.resolve([{
        id: 81,
        purchaseNo: 'A8101',
        platform: 'taobao',
        accountId: 18,
        platformOrderNo: 'TB8101',
        logisticsNo: ''
      }]))
      const syncSinglePurchaseOrder = vi.fn(() => Promise.resolve({ success: true, dbResult: { status: 'shipped' } }))

      attachOrderPurchasePanel(webContents, { fetchPurchaseOrders, syncSinglePurchaseOrder })
      webContents.emit('did-finish-load')
      await vi.advanceTimersByTimeAsync(300)
      const readyScript = webContents.executeJavaScript.mock.calls.map(call => call[0]).find(script => script.includes('"state":"ready"'))
      const nonce = readyScript.match(/"actionNonce":"([^"]+)"/)?.[1]
      expect(nonce).toBeTruthy()

      webContents.emit('console-message', {}, 1,
        `[DXE_ORDER_PURCHASE_LOGISTICS]${JSON.stringify({
          nonce,
          action: 'sync-orders',
          orderId: '3599471007575277'
        })}`)
      for (let index = 0; index < 40; index += 1) await Promise.resolve()

      expect(syncSinglePurchaseOrder).toHaveBeenCalledWith({
        accountId: '18',
        platformOrderNo: 'TB8101',
        platform: 'taobao'
      })
      expect(fetchPurchaseOrders).toHaveBeenCalledTimes(2)
      expect(webContents.executeJavaScript.mock.calls.some(call => call[0].includes('"successCount":1'))).toBe(true)
      webContents.emit('destroyed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('在订单状态区下方、订单信息区上方插入隔离样式区域，不使用悬浮遮挡', () => {
    const script = buildOrderPurchasePanelScript({
      state: 'ready',
      orderId: '3599471007575277',
      orders: []
    })
    const indexSource = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8')
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')
    const dbSource = fs.readFileSync(path.resolve('server/db.js'), 'utf8')
    const pagePreloadSource = fs.readFileSync(path.resolve('resources/store-backend-page-preload.js'), 'utf8')

    expect(script).toContain("findMarkerCard(['订单信息'])")
    expect(script).toContain("'售后单信息'")
    expect(script).toContain("'售后服务单信息'")
    expect(script).toContain("'申请信息'")
    expect(script).toContain("'服务单日志'")
    expect(script).toContain('insertBefore(host, anchor)')
    expect(script).toContain("attachShadow({ mode: 'open' })")
    expect(script).toContain('店小二采购信息')
    expect(script).toContain('<span class="type-pill">${escapeHtml(order.purchaseTypeLabel)}</span>')
    expect(script).toContain('采购订单号')
    expect(script).toContain('采购账户')
    expect(script).not.toContain('归属仓库')
    expect(script).not.toContain('<span>SKU：')
    expect(script).not.toContain('采购类型：${escapeHtml(order.purchaseTypeLabel)}')
    expect(script).toContain('收件地址')
    expect(script).toContain('含运费')
    expect(script).toContain('物流信息')
    expect(script).toContain('点击查看物流轨迹')
    expect(script).toContain('logistics-link')
    expect(script).toContain('logistics-value')
    expect(script).toContain('user-select:text')
    expect(script).toContain('同步采购单')
    expect(script).toContain("action: 'sync-orders'")
    expect(script).toContain('标记售后')
    expect(script).toContain("action: 'mark-aftersale'")
    expect(script).not.toContain('class="header-action refresh"')
    expect(buildOrderPurchaseLogisticsScript({ state: 'ready', orderId: '3599471007575277', purchaseId: 8, data: { tracks: [] } })).toContain('物流轨迹')
    expect(buildOrderPurchaseSyncStateScript({ state: 'ready', orderId: '3599471007575277', successCount: 1, failCount: 0 })).toContain('同步完成')
    expect(script).toContain("host.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:10px 0;'")
    expect(script).toContain('function findNearestMarkerCard')
    expect(indexSource).toContain('attachOrderPurchasePanel(webContents')
    expect(indexSource).toContain('registerOrderPurchasePanelIpc(ipcMain)')
    expect(pagePreloadSource).toContain("contextBridge.exposeInMainWorld('dxeStoreBackendBridge'")
    expect(pagePreloadSource).toContain("ipcRenderer.invoke(ORDER_PURCHASE_ACTION_CHANNEL")
    expect(pagePreloadSource).toContain("action: 'resolve-aftersale-order'")
    expect(pagePreloadSource).toContain('aftersaleStatus: String(payload.aftersaleStatus')
    expect(pagePreloadSource).toContain('aftersaleRemark: String(payload.aftersaleRemark')
    expect(pagePreloadSource).toContain('DXE_AFTERSALE_ORDER_CAPTURE_V1')
    expect(pagePreloadSource).toContain('DXE_AFTERSALE_RETURN_LOGISTICS_CAPTURE_V1')
    expect(pagePreloadSource).toContain('dsm.seller.afs.bff.serviceOrderQueryDsmService.page')
    expect(pagePreloadSource).toContain("action: 'capture-return-logistics'")
    expect(serverSource).toContain("app.post('/api/sales-return-logistics/:storeId/batch'")
    expect(serverSource.indexOf("app.post('/api/sales-return-logistics/:storeId/batch'")).toBeLessThan(
      serverSource.indexOf("app.get('/api/sales-orders'")
    )
    expect(dbSource).toContain('CREATE TABLE IF NOT EXISTS sales_return_logistics')
    expect(fs.readFileSync(path.resolve('src/main/store-backend-order-purchase-panel.js'), 'utf8')).toContain("webContents.on('console-message', onConsoleMessage)")
    const routeStart = serverSource.indexOf("app.get('/api/purchase-orders/by-sales-order/:orderNo'")
    const routeEnd = serverSource.indexOf("app.get('/api/purchase-orders'", routeStart + 1)
    const routeSource = serverSource.slice(routeStart, routeEnd)
    expect(routeStart).toBeGreaterThanOrEqual(0)
    expect(routeEnd).toBeGreaterThan(routeStart)
    expect(routeSource).toContain('STRAIGHT_JOIN sales_orders so')
    expect(routeSource).toContain('so.store_id = owner_store.id AND so.order_id = ?')
    expect(routeSource).toContain('WHERE owner_store.owner_id = ?')
    expect(routeSource).toContain("queryPurchaseRows('po.sales_order_no = ?', [orderNo])")
    expect(routeSource).toContain('po.sales_order_id IN')
    expect(routeSource).toContain('linkedSalesById')
    expect(routeSource).toContain('linked_sales_order_no: firstText')
    expect(routeSource).toContain('pa.account AS account_name')
    expect(routeSource).toContain('LEFT JOIN user_purchase_accounts upa')
    expect(routeSource).not.toContain('po.sales_order_id = CAST(so.id AS CHAR)')
    expect(routeSource).not.toContain('po.sales_order_no = so.order_id')
    expect(routeSource).not.toContain('SELECT 1 FROM stores linked_store')
  })
})
