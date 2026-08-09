/**
 * 采购订单同步 - 淘宝/天猫平台
 * 使用隐藏 BrowserWindow + CDP 网络捕获方案
 */

const {
  BrowserWindow, session,
  OVERALL_TIMEOUT, POLL_INTERVAL, MAX_POLLS,
  BUSINESS_SERVER, activeSyncs,
  CDPNetworkCapture, httpPostJson, VISIBILITY_OVERRIDE,
  resolveLogisticsCompany, extractTrackingFromData, normalizeTrackingItems,
  looksLikeTrackingArray, mapOrderStatus, richTextToPlain, restoreCookiesFromServer, hasValidPlatformCookies
} = require('./common')
const { extractTaobaoPickupInfo } = require('./taobao-logistics')

// ============ 平台配置 ============

const PLATFORM_CONFIG = {
  entryUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
  loginCheck: (url) => {
    const lower = url.toLowerCase()
    return lower.includes('login.taobao.com') || lower.includes('login.tmall.com')
  },
  apiKeywords: ['mtop.taobao.order', 'queryboughtlist'],
  orderPageKeyword: 'list_bought_items'
}

// ============ JSONP 剥离 ============

/**
 * 尝试解析可能被 JSONP 包装的 JSON 字符串
 * 详情页 API (detailv2) 返回 JSONP 格式: mtopjsonp4({...})
 * 列表页 API (queryboughtlistv2) 返回纯 JSON
 */
function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null
  let str = text.trim()

  // 检测并剥离 JSONP 包装
  if (str.startsWith('mtopjsonp')) {
    const start = str.indexOf('(')
    const end = str.lastIndexOf(')')
    if (start > 0 && end > start) {
      str = str.substring(start + 1, end)
    }
  }

  try {
    return JSON.parse(str)
  } catch (e) {
    return null
  }
}

// ============ 响应解析 ============

/**
 * 解析淘宝H5 API响应（组件化布局格式）
 */
function parseResponse(responseText) {
  const orders = []
  try {
    const response = tryParseJson(responseText)
    if (!response) return orders

    if (response.ret && response.ret[0] !== 'SUCCESS::调用成功') {
      return orders
    }

    if (!response.data) return orders

    let data = typeof response.data === 'string' ? tryParseJson(response.data) : response.data
    if (!data) return orders
    const hasShopInfoKey = Object.keys(data).some(k => k.startsWith('shopInfo_'))
    const hasOrderStatusKey = Object.keys(data).some(k => k.startsWith('orderStatus_'))
    if (data && data.data && typeof data.data === 'object' && !hasShopInfoKey && !hasOrderStatusKey) {
      data = data.data
    }

    const orderMap = {}

    for (const [key, component] of Object.entries(data)) {
      if (!component || typeof component !== 'object') continue

      if (key.startsWith('shopInfo_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        if (component.fields && component.fields.tradeTitle) {
          orderMap[orderId].status = component.fields.tradeTitle
        }
      }

      if (key.startsWith('orderStatus_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        const fields = component.fields || {}
        if (fields.mailNo) orderMap[orderId].logistics_no = fields.mailNo
        if (fields.cpCode) orderMap[orderId].logistics_company_code = fields.cpCode
        if (fields.title) orderMap[orderId].logistics_status = fields.title
      }

      if (key.startsWith('orderLogistics_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        const fields = component.fields || {}
        if (fields.packagePreview && fields.packagePreview.packageViewList && fields.packagePreview.packageViewList.length > 0) {
          orderMap[orderId].logistics_company = fields.packagePreview.packageViewList[0].cpName
        }
      }

      // PC端详情页：从 itemInfo 提取单价（actualTotalFee）
      if (key.startsWith('itemInfo_')) {
        const fields = component.fields || {}
        const orderId = fields.orderId || component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        const item = fields.item || {}
        const priceInfo = item.priceInfo || {}
        const fee = priceInfo.actualTotalFee || priceInfo.totalFee || ''
        if (fee) {
          const numStr = fee.replace(/[￥¥,]/g, '').trim()
          if (numStr && parseFloat(numStr) > 0) {
            orderMap[orderId].purchase_price = numStr
          }
        }
      }


    }

    for (const orderId of Object.keys(orderMap)) {
      const order = orderMap[orderId]
      if (order.order_no) {
        orders.push({
          order_no: order.order_no,
          status: order.status || '',
          logistics_no: order.logistics_no || '',
          logistics_company: resolveLogisticsCompany(order.logistics_company || '', order.logistics_company_code || ''),
          logistics_company_code: order.logistics_company_code || '',
          logistics_status: order.logistics_status || '',
          purchase_price: order.purchase_price || ''
        })
      }
    }
  } catch (e) {
    console.error('[PurchaseSync-Taobao] parseResponse error:', e.message)
  }

  return orders
}

/**
 * 解析 mtop SDK 搜索响应（mainOrders 数组格式）
 * 搜索API返回格式与CDP捕获的组件格式不同：
 * { mainOrders: [{ id, extra, statusInfo, logisticsInfo, seller, orderInfo, payInfo, subOrders, operations }], ... }
 */
function parseSearchResponse(dataObj) {
  const orders = []
  try {
    const mainOrders = dataObj.mainOrders
    if (!Array.isArray(mainOrders)) return orders

    for (const order of mainOrders) {
      if (!order || !order.id) continue

      const result = {
        order_no: String(order.id),
        status: '',
        logistics_no: '',
        logistics_company: '',
        logistics_company_code: '',
        logistics_status: '',
        purchase_price: ''
      }

      // 状态信息 - 从 extra.tradeStatus 获取
      const extra = order.extra || {}
      if (extra.tradeStatus) result.status = extra.tradeStatus

      // 物流信息 - 多层次查找
      // 1. order.logisticsInfo (mainOrders 格式专用字段)
      const logisticsInfo = order.logisticsInfo || {}
      if (logisticsInfo.mailNo) result.logistics_no = logisticsInfo.mailNo
      if (logisticsInfo.cpCode) result.logistics_company_code = logisticsInfo.cpCode
      if (logisticsInfo.cpName) result.logistics_company = logisticsInfo.cpName
      if (logisticsInfo.companyName) result.logistics_company = logisticsInfo.companyName
      if (logisticsInfo.logisticsCompany) result.logistics_company = logisticsInfo.logisticsCompany
      if (logisticsInfo.statusDesc) result.logistics_status = logisticsInfo.statusDesc

      // 2. order.logistics
      const logistics = order.logistics || {}
      if (!result.logistics_no && logistics.mailNo) result.logistics_no = logistics.mailNo
      if (!result.logistics_company_code && logistics.cpCode) result.logistics_company_code = logistics.cpCode
      if (!result.logistics_company && logistics.cpName) result.logistics_company = logistics.cpName
      if (!result.logistics_company && logistics.companyName) result.logistics_company = logistics.companyName
      if (!result.logistics_company && logistics.logisticsCompany) result.logistics_company = logistics.logisticsCompany
      if (!result.logistics_status && logistics.statusDesc) result.logistics_status = logistics.statusDesc

      // 3. statusInfo 中的物流字段
      const statusInfo = order.statusInfo || {}
      if (!result.logistics_no && statusInfo.mailNo) result.logistics_no = statusInfo.mailNo
      if (!result.logistics_company_code && statusInfo.cpCode) result.logistics_company_code = statusInfo.cpCode
      if (!result.logistics_company && statusInfo.cpName) result.logistics_company = statusInfo.cpName
      if (!result.logistics_status && statusInfo.text) result.logistics_status = statusInfo.text
      if (statusInfo.logistics) {
        const slog = statusInfo.logistics
        if (!result.logistics_no && slog.mailNo) result.logistics_no = slog.mailNo
        if (!result.logistics_company_code && slog.cpCode) result.logistics_company_code = slog.cpCode
        if (!result.logistics_company && slog.cpName) result.logistics_company = slog.cpName
        if (!result.logistics_status && slog.statusDesc) result.logistics_status = slog.statusDesc
      }

      // 4. subOrders 中的物流信息
      const subOrders = order.subOrders || []
      for (const sub of subOrders) {
        if (!sub) continue
        const subLog = sub.logisticsInfo || sub.logistics || {}
        if (!result.logistics_no && subLog.mailNo) result.logistics_no = subLog.mailNo
        if (!result.logistics_company_code && subLog.cpCode) result.logistics_company_code = subLog.cpCode
        if (!result.logistics_company && subLog.cpName) result.logistics_company = subLog.cpName
        if (!result.logistics_company && subLog.companyName) result.logistics_company = subLog.companyName
      }

      // 5. orderInfo 中可能的物流字段
      const orderInfo = order.orderInfo || {}
      if (!result.logistics_no && (orderInfo.mailNo || orderInfo.logisticsNo)) {
        result.logistics_no = orderInfo.mailNo || orderInfo.logisticsNo
      }
      if (!result.logistics_company && (orderInfo.cpName || orderInfo.logisticsCompany || orderInfo.companyName)) {
        result.logistics_company = orderInfo.cpName || orderInfo.logisticsCompany || orderInfo.companyName
      }
      if (!result.logistics_company_code && orderInfo.cpCode) {
        result.logistics_company_code = orderInfo.cpCode
      }

      // 6. extra 中可能的物流字段
      if (!result.logistics_no && extra.mailNo) result.logistics_no = extra.mailNo
      if (!result.logistics_no && extra.logisticsNo) result.logistics_no = extra.logisticsNo
      if (!result.logistics_company && extra.cpName) result.logistics_company = extra.cpName
      if (!result.logistics_company && extra.logisticsCompany) result.logistics_company = extra.logisticsCompany
      if (!result.logistics_company_code && extra.cpCode) result.logistics_company_code = extra.cpCode

      // 解析物流公司名称
      result.logistics_company = resolveLogisticsCompany(result.logistics_company, result.logistics_company_code)

      // 提取商品单价（从 payInfo 和 subOrders 中提取）
      const payInfo = order.payInfo || {}
      if (payInfo.actualFee && parseFloat(payInfo.actualFee) > 0) {
        result.purchase_price = String(parseFloat(payInfo.actualFee))
      } else if (payInfo.shouldPay && parseFloat(payInfo.shouldPay) > 0) {
        result.purchase_price = String(parseFloat(payInfo.shouldPay))
      }
      // 从 subOrders 提取单价（更精确）
      const subs = order.subOrders || []
      if (subs.length > 0) {
        for (const sub of subs) {
          if (!sub) continue
          const itemInfo = sub.itemInfo || sub.payInfo || {}
          const unitPrice = itemInfo.unitPrice || itemInfo.price || itemInfo.actualFee
          if (unitPrice && parseFloat(unitPrice) > 0) {
            result.purchase_price = String(parseFloat(unitPrice))
            break
          }
        }
      }

      orders.push(result)
    }
  } catch (e) {
    console.error('[PurchaseSync-Taobao] parseSearchResponse error:', e.message)
  }
  return orders
}

// ============ 从捕获响应中汇总订单（批量同步用） ============

function findAllOrders(allResponses) {
  const allOrders = []
  for (const r of allResponses) {
    if (r.status !== 200 || !r.body) continue
    try {
      const orders = parseResponse(r.body)
      allOrders.push(...orders)
    } catch (e) { /* skip */ }
    try {
      // parseSearchResponse 期望解析后的 JSON 对象（含 mainOrders 字段）
      const parsed = tryParseJson(r.body)
      if (parsed && parsed.data) {
        const dataObj = typeof parsed.data === 'string' ? tryParseJson(parsed.data) : parsed.data
        if (dataObj) {
          const orders = parseSearchResponse(dataObj)
          allOrders.push(...orders)
        }
      }
    } catch (e) { /* skip */ }
  }
  const seen = new Set()
  return allOrders.filter(o => {
    if (seen.has(o.order_no)) return false
    seen.add(o.order_no)
    return true
  })
}

// ============ 单个订单同步 ============

/**
 * 同步单个淘宝采购订单
 * Phase 1: 加载订单列表页，CDP捕获首页数据（组件格式含物流）
 * Phase 2: 若首页未找到，导航到订单详情页，CDP捕获详情API响应
 *
 * 参考 PDD 模式：直接导航到含订单号的页面，从 API 响应中提取物流信息
 * 参考销售订单二次同步：按订单号找到订单后再获取详细信息
 */
function syncSingle(accountId, platformOrderNo) {
  return new Promise(async (resolve, reject) => {
    const syncKey = `${accountId}-taobao`
    let resolved = false
    let win = null
  try {
    if (activeSyncs.has(syncKey)) {
      return resolve({ success: false, message: '该账号正在同步中，请等待完成' })
    }

    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)
    let cookies = await ses.cookies.get({})

    console.log(`[PurchaseSync-Taobao] accountId:${accountId} orderNo:${platformOrderNo}`)
    console.log(`[PurchaseSync-Taobao] Cookies: ${cookies.length} 条`)

    // 优化：先检查 partition 是否已有有效平台 cookies，有则跳过服务器恢复
    if (hasValidPlatformCookies(cookies, 'taobao')) {
      console.log(`[PurchaseSync-Taobao] partition 已有有效平台 cookies，跳过服务器恢复`)
    } else {
      // partition 缺少有效 cookies，尝试从服务器恢复（合并模式：只补充缺失的，不覆盖已有的）
      console.log(`[PurchaseSync-Taobao] partition 缺少有效平台 cookies，从服务器恢复（合并模式）...`)
      const restoreResult = await restoreCookiesFromServer(accountId, 'taobao')
      if (restoreResult.restored) {
        cookies = await ses.cookies.get({})
        console.log(`[PurchaseSync-Taobao] cookie 恢复完成：${restoreResult.count} 条补充，${restoreResult.skipped} 条保留，当前 Cookies: ${cookies.length} 条`)
      }
    }

    if (!hasValidPlatformCookies(cookies, 'taobao')) {
      return resolve({ success: false, message: '该采购账号未登录，请先点击"登录"按钮登录账号' })
    }

    let cdpCapture = null
    let cdpAttached = false
    let phase = 1 // 1: 首页CDP, 2: 订单详情页, 3: 物流页面
    let detailResult = null // Phase 2 的部分结果，供 Phase 3 补充
    let phaseResponses = [] // 当前阶段累积的 CDP 响应
    let pollTimer = null   // 当前阶段轮询定时器

    // syncSingle 使用更宽泛的 API 关键词，以捕获详情页的 API 调用
    const SINGLE_API_KEYWORDS = ['mtop.taobao']

    function cleanup() {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      activeSyncs.delete(syncKey)
      if (cdpCapture) { cdpCapture.detach().catch(() => {}); cdpCapture = null }
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    const overallTimer = setTimeout(() => {
      finish({ success: false, message: '同步超时，请稍后重试' })
    }, OVERALL_TIMEOUT)

    try {
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        title: '[同步] 淘宝采购订单',
        webPreferences: {
          partition: partitionName,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })

      win.webContents.setBackgroundThrottling(false)
      activeSyncs.set(syncKey, win)

      // BrowserWindow 意外关闭时清理 activeSyncs，防止残留阻塞后续同步
      win.on('closed', () => {
        if (!resolved) {
          console.log('[PurchaseSync-Taobao] BrowserWindow 被意外关闭')
          activeSyncs.delete(syncKey)
          win = null
          finish({ success: false, message: '同步窗口意外关闭' })
        }
      })

      async function ensureCDP() {
        if (cdpAttached || resolved) return
        cdpCapture = new CDPNetworkCapture(win.webContents, SINGLE_API_KEYWORDS)
        try {
          cdpAttached = await cdpCapture.attach()
          console.log(`[PurchaseSync-Taobao] CDP attach: ${cdpAttached ? 'OK' : 'FAIL'}`)
        } catch (e) {
          console.warn('[PurchaseSync-Taobao] CDP attach error:', e.message)
        }
      }

      win.webContents.on('did-navigate', async (event, url) => {
        console.log('[PurchaseSync-Taobao] navigate:', url.substring(0, 150))
        if (PLATFORM_CONFIG.loginCheck(url)) {
          finish({ success: false, message: '采购账号登录已过期，请重新登录该账号', needsRelogin: true })
          return
        }
        // CDP 常驻：已连接时不重新 attach，减少阶段切换开销
        if (!cdpAttached) await ensureCDP()
      })

      win.webContents.on('dom-ready', () => {
        if (win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(VISIBILITY_OVERRIDE).catch(() => {})
        if (!cdpAttached) ensureCDP()
      })

      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        console.log('[PurchaseSync-Taobao] 页面加载完成, phase:', phase)
        startPhasePolling()
      })

      // ============ 轮询式数据检测 ============
      // 替代固定超时等待：每 500ms 检查一次 CDP 数据，数据到就立刻进入下一阶段
      function startPhasePolling() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
        phaseResponses = []

        // 注意：不要在这里调用 cdpCapture.getCaptured() 清空缓存！
        // did-finish-load 触发时，CDP 可能已捕获到当前页面的 API 响应，
        // 清空会导致这些响应丢失。首次轮询会自然拾取已缓存的数据。

        const maxWaitMs = phase === 1 ? 2500 : (phase === 3 ? 6500 : 4000)
        const pollIntervalMs = 500
        const startTime = Date.now()

        function poll() {
          if (win.isDestroyed() || resolved) return

          const newResponses = cdpCapture ? cdpCapture.getCaptured() : []
          const hasNewData = newResponses.length > 0
          if (hasNewData) {
            phaseResponses = phaseResponses.concat(newResponses)
          }

          const elapsed = Date.now() - startTime
          const isTimeout = elapsed >= maxWaitMs

          // 没有新数据且未超时，跳过本轮检查（减少重复解析开销）
          if (!hasNewData && !isTimeout) {
            pollTimer = setTimeout(poll, pollIntervalMs)
            return
          }

          let handled = false
          if (phase === 1) handled = checkFirstPage(phaseResponses, isTimeout)
          else if (phase === 2) handled = checkDetailPage(phaseResponses, isTimeout)
          else handled = checkLogisticsPage(phaseResponses, isTimeout)

          if (handled) {
            pollTimer = null
            return
          }

          // 未处理完，继续轮询
          pollTimer = setTimeout(poll, pollIntervalMs)
        }

        // 首次轮询延迟 200ms（CDP 数据可能已在缓冲区）
        pollTimer = setTimeout(poll, 200)
      }

      // ============ Phase 1: 检查首页CDP数据 ============
      function checkFirstPage(cdpResponses, isTimeout) {
        const cdpOrders = findAllOrders(cdpResponses)
        console.log(`[PurchaseSync-Taobao] CDP捕获到 ${cdpOrders.length} 条首页订单`)

        const found = cdpOrders.find(o => o.order_no === platformOrderNo)
        if (found) {
          // 首页找到订单，检查是否需要物流轨迹
          const mappedStatus = mapOrderStatus(found.status)
          const needLogisticsDetails = (mappedStatus === 'shipped' || mappedStatus === 'in_transit') &&
            (!found.logistics_tracking || !found.pickup_code || !found.pickup_address)
          if (needLogisticsDetails) {
            // 已发货/运输中需要访问物流页，补齐轨迹及取件信息
            detailResult = found
            console.log(`[PurchaseSync-Taobao] 首页订单需要补齐物流详情(状态=${found.status}), 导航到物流页面`)
            navigateToLogisticsPage()
            return true
          }
          clearTimeout(overallTimer)
          console.log('[PurchaseSync-Taobao] 首页找到目标订单:', JSON.stringify(found))
          finish({ success: true, orderInfo: found })
          return true
        }

        // 未找到，是否应继续轮询
        if (!isTimeout) return false

        // 超时 - 首页未找到，进入 Phase 2：导航到订单详情页
        phase = 2
        const detailUrl = `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${platformOrderNo}`
        console.log('[PurchaseSync-Taobao] 首页未找到，导航到订单详情页')
        win.loadURL(detailUrl)
        return true
      }

      // ============ Phase 2: 检查订单详情页CDP数据 ============
      function checkDetailPage(cdpResponses, isTimeout) {
        console.log(`[PurchaseSync-Taobao] 详情页CDP捕获到 ${cdpResponses.length} 个API响应`)

        // 1. 用组件格式解析器（和列表页相同的格式）
        const orders = findAllOrders(cdpResponses)
        console.log(`[PurchaseSync-Taobao] findAllOrders解析到 ${orders.length} 条订单`)
        const found = orders.find(o => o.order_no === platformOrderNo)
        if (found) {
          const mappedStatus = mapOrderStatus(found.status)
          const needLogisticsDetails = mappedStatus === 'shipped' || mappedStatus === 'in_transit'
          // 已发货订单必须进入物流详情页，才能读取取件码和取件地址。
          if (needLogisticsDetails) {
            detailResult = found
            console.log(`[PurchaseSync-Taobao] 详情页订单需要补齐物流详情(状态=${found.status}), 导航到物流页面`)
            navigateToLogisticsPage()
            return true
          }
          if (found.logistics_company || found.status) {
            clearTimeout(overallTimer)
            console.log('[PurchaseSync-Taobao] 详情页找到完整订单:', JSON.stringify(found))
            finish({ success: true, orderInfo: found })
            return true
          }
        }

        // 2. 从原始响应中搜索包含目标订单号的数据（详情页可能用不同格式）
        let orderInfo = null
        for (const r of cdpResponses) {
          if (r.status !== 200 || !r.body) continue
          try {
            const response = tryParseJson(r.body)
            if (!response) continue
            if (!response.ret || !response.ret[0]) continue
            if (!response.ret[0].startsWith('SUCCESS')) continue
            if (!response.data) continue

            let data = typeof response.data === 'string' ? tryParseJson(response.data) : response.data
            if (!data) continue

            const dataStr = JSON.stringify(data)
            if (!dataStr.includes(platformOrderNo)) continue

            console.log('[PurchaseSync-Taobao] 详情页API含目标订单号, data顶层keys:', Object.keys(data).slice(0, 10).join(','))

            const parsed = parseDetailData(data, platformOrderNo)
            if (parsed) {
              orderInfo = parsed
              break
            }
          } catch (e) {
            console.log('[PurchaseSync-Taobao] 响应处理异常:', e.message)
          }
        }

        // 合并 findAllOrders 和 parseDetailData 的结果
        if (!orderInfo && found) {
          orderInfo = found
        } else if (orderInfo && found) {
          // parseDetailData 有结果但可能缺少价格，用 found 补充
          if (!orderInfo.purchase_price && found.purchase_price) {
            orderInfo.purchase_price = found.purchase_price
          }
        }

        if (orderInfo) {
          // 检查是否缺少快递公司或状态信息
          const needLogisticsPage = !orderInfo.logistics_company && !orderInfo.logistics_company_code
          const needStatus = !orderInfo.status

          // 判断是否为不需要物流信息的订单状态
          // 这些状态表示订单不会有物流：交易关闭、已取消、退款相关、等待付款、买家已付款（卖家还没发货）
          const noLogisticsStatuses = ['交易关闭', '已取消', '退款成功', '退款中', '等待买家付款', '买家已付款']
          const isNoLogisticsStatus = orderInfo.status && noLogisticsStatuses.includes(orderInfo.status)

          if (isNoLogisticsStatus) {
            // 不需要物流信息的订单，直接完成，不访问物流页面
            clearTimeout(overallTimer)
            console.log(`[PurchaseSync-Taobao] 订单状态为"${orderInfo.status}"，无需访问物流页面:`, JSON.stringify(orderInfo))
            finish({ success: true, orderInfo })
            return true
          }

          // 映射后的英文状态码
          const mappedStatus = mapOrderStatus(orderInfo.status)
          // 同步范围内的订单，只要有物流单号就必须去物流页获取完整轨迹，
          // 不管详情页是否已有轨迹数据（详情页轨迹可能不完整）
          // 没有物流单号说明还没发货，去物流页也没数据，不需要
          const needTracking = !!orderInfo.logistics_no

          // 如果已有物流单号和快递公司，且不需要轨迹，则不去物流页面
          const hasLogisticsInfo = orderInfo.logistics_no && (orderInfo.logistics_company || orderInfo.logistics_company_code)
          if (hasLogisticsInfo && !needTracking) {
            clearTimeout(overallTimer)
            console.log(`[PurchaseSync-Taobao] 详情页已获取完整物流信息:`, JSON.stringify(orderInfo))
            finish({ success: true, orderInfo })
            return true
          }

          if (needLogisticsPage || needStatus || needTracking) {
            // 保存部分结果，导航到物流页面补充
            detailResult = orderInfo
            console.log(`[PurchaseSync-Taobao] 详情页部分结果(缺company=${needLogisticsPage}, 缺status=${needStatus}, 缺tracking=${needTracking}):`, JSON.stringify(orderInfo))
            navigateToLogisticsPage()
            return true
          }

          clearTimeout(overallTimer)
          console.log('[PurchaseSync-Taobao] 详情页解析到完整订单:', JSON.stringify(orderInfo))
          finish({ success: true, orderInfo })
          return true
        }

        // 未找到，是否应继续轮询
        if (!isTimeout) return false

        // 超时 - 详情页完全未找到，尝试物流页面
        console.log(`[PurchaseSync-Taobao] 详情页未找到订单，尝试物流页面`)
        navigateToLogisticsPage()
        return true
      }

      // 导航到物流页面（Phase 3）
      function navigateToLogisticsPage() {
        phase = 3
        const logisticsUrl = `https://market.m.taobao.com/app/dinamic/pc-trade-logistics/home.html?orderId=${platformOrderNo}&entrance=pc`
        console.log('[PurchaseSync-Taobao] 导航到物流页面（延时 1 秒避免风控）...')
        // 延时 1 秒再导航，避免 Phase 2 → Phase 3 快速连续页面切换触发淘宝风控拦截
        setTimeout(() => {
          if (win && !win.isDestroyed() && !resolved) {
            win.loadURL(logisticsUrl)
          }
        }, 1000)
      }

      // ============ Phase 3: 检查物流页面CDP数据 ============
      function checkLogisticsPage(cdpResponses, isTimeout) {
        console.log(`[PurchaseSync-Taobao] 物流页CDP捕获到 ${cdpResponses.length} 个API响应`)

        // 多包裹订单可能有多个 logistics API 响应（包裹列表 + 包裹详情）
        // 需要合并所有匹配的响应，而不是只取第一个
        const parsedResults = []

        for (const r of cdpResponses) {
          if (r.status !== 200 || !r.body) continue
          try {
            const response = tryParseJson(r.body)
            if (!response) continue
            if (!response.ret || !response.ret[0]) continue
            if (!response.ret[0].startsWith('SUCCESS')) continue
            if (!response.data) continue

            let data = typeof response.data === 'string' ? tryParseJson(response.data) : response.data
            if (!data) continue

            const dataStr = JSON.stringify(data)
            if (!dataStr.includes(platformOrderNo)) continue

            console.log('[PurchaseSync-Taobao] 物流页API含目标订单号, data顶层keys:', Object.keys(data).slice(0, 10).join(','))

            // 调试：输出物流页数据结构（便于确认轨迹数据格式）
            console.log('[PurchaseSync-Taobao-Tracking-Debug] 物流页数据:', JSON.stringify(data).substring(0, 10000))

            // 物流页面可能用组件格式或其他格式
            const parsed = parseLogisticsPageData(data, platformOrderNo)
            if (parsed) {
              console.log(`[PurchaseSync-Taobao] 物流页解析到第 ${parsedResults.length + 1} 个结果:`, JSON.stringify(parsed).substring(0, 500))
              parsedResults.push(parsed)
            }
          } catch (e) {
            console.log('[PurchaseSync-Taobao] 物流页响应处理异常:', e.message)
          }
        }

        // 找到物流数据 或 超时 - 都进行最终合并
        if (parsedResults.length === 0 && !isTimeout) return false // 未找到且未超时，继续轮询

        // 合并结果
        const merged = detailResult || {
          order_no: platformOrderNo,
          status: '',
          logistics_no: '',
          logistics_company: '',
          logistics_company_code: '',
          logistics_status: '',
          logistics_tracking: null,
          pickup_code: '',
          pickup_address: '',
          purchase_price: ''
        }

        // 合并所有解析结果：后面的结果补充前面缺失的字段
        for (const logisticsInfo of parsedResults) {
          if (!merged.logistics_no && logisticsInfo.logistics_no) merged.logistics_no = logisticsInfo.logistics_no
          if (!merged.logistics_company && logisticsInfo.logistics_company) merged.logistics_company = logisticsInfo.logistics_company
          if (!merged.logistics_company_code && logisticsInfo.logistics_company_code) merged.logistics_company_code = logisticsInfo.logistics_company_code
          if (!merged.status && logisticsInfo.status) merged.status = logisticsInfo.status
          if (!merged.logistics_status && logisticsInfo.logistics_status) merged.logistics_status = logisticsInfo.logistics_status
          if (!merged.pickup_code && logisticsInfo.pickup_code) merged.pickup_code = logisticsInfo.pickup_code
          if (!merged.pickup_address && logisticsInfo.pickup_address) merged.pickup_address = logisticsInfo.pickup_address
          if (!merged.purchase_price && logisticsInfo.purchase_price) merged.purchase_price = logisticsInfo.purchase_price
          // 物流页的轨迹数据优先（更详细）
          if (logisticsInfo.logistics_tracking && logisticsInfo.logistics_tracking.length > 0) {
            merged.logistics_tracking = logisticsInfo.logistics_tracking
          }
        }

        // 重新解析快递公司名称
        merged.logistics_company = resolveLogisticsCompany(merged.logistics_company, merged.logistics_company_code)

        clearTimeout(overallTimer)
        if (merged.logistics_no || merged.status || merged.logistics_company || merged.pickup_code || merged.pickup_address) {
          console.log('[PurchaseSync-Taobao] 最终合并结果:', JSON.stringify(merged))
          finish({ success: true, orderInfo: merged })
        } else {
          console.log(`[PurchaseSync-Taobao] 物流页也未找到订单 ${platformOrderNo}`)
          finish({ success: false, message: `未找到订单 ${platformOrderNo}` })
        }
        return true
      }

      // 解析物流页面数据
      function parseLogisticsPageData(data, targetOrderNo) {
        // 1. 专用物流页组件遍历（不依赖订单号匹配）
        const logisticsComponentResult = parseLogisticsComponents(data, targetOrderNo)
        if (logisticsComponentResult) {
          console.log('[PurchaseSync-Taobao] 物流页命中专用组件解析')
          return logisticsComponentResult
        }

        // 2. 组件格式（按订单号匹配）
        const componentResult = tryComponentFormat(data, targetOrderNo) ||
          tryComponentFormat(data.data, targetOrderNo)
        if (componentResult) {
          console.log('[PurchaseSync-Taobao] 物流页命中组件格式')
          return componentResult
        }

        // 3. 通用对象搜索
        const genericPaths = [data.orderInfo, data.order, data.data, data.logisticsInfo, data.logistics]
        for (const obj of genericPaths) {
          if (!obj || typeof obj !== 'object') continue
          const info = extractLogisticsFromObject(obj, targetOrderNo)
          if (info) {
            console.log('[PurchaseSync-Taobao] 物流页命中通用格式')
            return info
          }
        }

        // 4. 深度搜索（搜索所有含物流字段的对象，不仅限第一个）
        const deepResult = deepSearchLogistics(data, targetOrderNo, 0)
        if (deepResult) {
          console.log('[PurchaseSync-Taobao] 物流页命中深度搜索')
          return deepResult
        }

        return null
      }

      // 专用物流页组件解析：遍历所有组件，提取物流信息和轨迹
      // 物流页组件不含订单号ID，需要遍历所有组件
      // 轨迹数据格式：每个轨迹点是一个独立的 logisticsDetailLine_* 组件
      function parseLogisticsComponents(data, targetOrderNo) {
        const result = {
          order_no: targetOrderNo,
          status: '',
          logistics_no: '',
          logistics_company: '',
          logistics_company_code: '',
          logistics_status: '',
          logistics_tracking: null,
          pickup_code: '',
          pickup_address: '',
          purchase_price: ''
        }
        let hasAnyInfo = false

        // 物流页数据可能在 data.data 中
        const components = (data && data.data) || data
        if (!components || typeof components !== 'object') return null

        const pickupInfo = extractTaobaoPickupInfo(components, richTextToPlain)
        if (pickupInfo.pickup_code) {
          result.pickup_code = pickupInfo.pickup_code
          hasAnyInfo = true
        }
        if (pickupInfo.pickup_address) {
          result.pickup_address = pickupInfo.pickup_address
          hasAnyInfo = true
        }

        // 收集 logisticsDetailLine 组件（每个轨迹点是一个独立组件）
        const trackingComponents = []

        // 遍历所有组件
        for (const [key, component] of Object.entries(components)) {
          if (!component || typeof component !== 'object') continue
          const fields = component.fields || component
          const tag = component.tag || key
          const type = component.type || ''

          // 调试：记录每个组件的 key、tag、type 和 fields keys
          if (component.fields) {
            const fieldKeys = Object.keys(component.fields)
            console.log(`[PurchaseSync-Taobao] 物流组件 [${key}] tag=${tag} type=${type} fieldKeys=[${fieldKeys.join(',')}]`)
          }

          // 收集轨迹步骤组件：tag=logisticsDetailLine 或 type 含 logisticsinfo_step
          if (tag === 'logisticsDetailLine' || (type && type.includes('logisticsinfo_step'))) {
            trackingComponents.push({ key, fields: component.fields || {}, tag, type })
          }

          // 提取快递公司信息（popupBodyCompany / popupBodyCompony 等组件）
          if (fields.mailNo && !result.logistics_no) {
            result.logistics_no = fields.mailNo
            hasAnyInfo = true
          }
          if (fields.cpCode && !result.logistics_company_code) {
            result.logistics_company_code = fields.cpCode
            hasAnyInfo = true
          }
          if (fields.name && fields.mailNo && !result.logistics_company) {
            // 物流页 name + mailNo 同层 = 快递公司名
            result.logistics_company = fields.name
            hasAnyInfo = true
          }
          if (fields.cpName && !result.logistics_company) {
            result.logistics_company = fields.cpName
            hasAnyInfo = true
          }

          // 提取物流状态（package 组件中的 title）
          if (type.includes('package') || tag === 'package') {
            if (fields.title && !result.logistics_status) {
              result.logistics_status = fields.title
              hasAnyInfo = true
            }
          }

          // 多包裹格式：pakcage 组件（tag=pakcage, type=native$logisticslist_package）
          // 当订单被分成多个包裹发货时，物流页返回此格式
          // mailNo 在 rightBtnUrl 查询参数中，title = 物流状态
          if (tag === 'pakcage' || (type && type.includes('logisticslist_package'))) {
            if (fields.rightBtnUrl && !result.logistics_no) {
              const mailNoMatch = fields.rightBtnUrl.match(/mailNo=([^&]+)/)
              if (mailNoMatch) {
                result.logistics_no = mailNoMatch[1]
                hasAnyInfo = true
              }
            }
            if (fields.title && !result.logistics_status) {
              result.logistics_status = fields.title
              hasAnyInfo = true
            }
          }

          // 从每个组件的 fields 中搜索轨迹数组（备用：某些格式可能仍是数组）
          if (!result.logistics_tracking && component.fields) {
            const tracking = extractTrackingFromData(component.fields, 0)
            if (tracking) {
              result.logistics_tracking = tracking
              hasAnyInfo = true
            }
          }
        }

        // 如果还没找到轨迹，尝试从 logisticsDetailLine 组件组装
        if (!result.logistics_tracking && trackingComponents.length > 0) {
          // 按key末尾数字排序：_0=最早, _N=最新
          trackingComponents.sort((a, b) => {
            const numA = parseInt(a.key.split('_').pop(), 10) || 0
            const numB = parseInt(b.key.split('_').pop(), 10) || 0
            return numA - numB
          })
          const trackingItems = []
          for (const tc of trackingComponents) {
            const f = tc.fields
            const time = richTextToPlain(f.subTitle || f.time || f.title || '')
            const context = richTextToPlain(f.desc || f.description || f.content || '')
            if (time || context) {
              trackingItems.push({ time, context })
            }
          }
          if (trackingItems.length > 0) {
            // 倒序：最新在前（前端 index=0 显示为当前状态）
            trackingItems.reverse()
            result.logistics_tracking = trackingItems
            hasAnyInfo = true
            console.log(`[PurchaseSync-Taobao] 从${trackingComponents.length}个logisticsDetailLine组件组装${trackingItems.length}条轨迹`)
          }
        }

        // 如果还没找到轨迹，在整个 data 对象中深度搜索
        if (!result.logistics_tracking) {
          const tracking = extractTrackingFromData(components, 3)
          if (tracking) {
            result.logistics_tracking = tracking
            hasAnyInfo = true
          }
        }

        if (hasAnyInfo) {
          result.logistics_company = resolveLogisticsCompany(result.logistics_company, result.logistics_company_code)
          return result
        }
        return null
      }

      // ============ 解析订单详情页数据 ============
      function parseDetailData(data, targetOrderNo) {
        let orderInfo = null

        // 1. 组件格式（和列表页一样：shopInfo_*, orderStatus_*, orderLogistics_*）
        //    可能直接在顶层，也可能嵌套在 data.data 内
        const componentResult = tryComponentFormat(data, targetOrderNo) ||
          tryComponentFormat(data.data, targetOrderNo)
        if (componentResult) {
          console.log('[PurchaseSync-Taobao] 命中组件格式')
          orderInfo = componentResult
        }

        // 2. mainOrder 格式（detailv2 API 可能返回单个 mainOrder 对象）
        if (!orderInfo) {
          const mainOrderPaths = [
            data.mainOrder,
            data.result && data.result.mainOrder,
            data.result && data.result.data && data.result.data.mainOrder,
            data.data && data.data.mainOrder,
            data.model && data.model.mainOrder,
            data.model && data.model.result && data.model.result.mainOrder
          ]
          for (const mo of mainOrderPaths) {
            if (mo && typeof mo === 'object') {
              const info = extractMainOrderInfo(mo, targetOrderNo)
              if (info) {
                console.log('[PurchaseSync-Taobao] 命中mainOrder格式')
                orderInfo = info
                break
              }
            }
          }
        }

        // 3. 通用JSON格式（data.orderInfo / data.order / data.model 等）
        if (!orderInfo) {
          const genericPaths = [data.orderInfo, data.order, data.data, data.model]
          for (const obj of genericPaths) {
            if (!obj || typeof obj !== 'object') continue
            const info = extractLogisticsFromObject(obj, targetOrderNo)
            if (info) {
              console.log('[PurchaseSync-Taobao] 命中通用JSON格式, key:', Object.keys(obj).slice(0, 5).join(','))
              orderInfo = info
              break
            }
          }
        }

        // 4. 深度递归搜索物流字段
        if (!orderInfo) {
          const deepResult = deepSearchLogistics(data, targetOrderNo, 0)
          if (deepResult) {
            console.log('[PurchaseSync-Taobao] 命中深度搜索')
            orderInfo = deepResult
          }
        }

        // 5. 如果有结果但缺少状态，尝试在整个响应中搜索 pcDetailOrderStepVOList
        //    不做任何推断（如 logistics_no 推断），保证状态准确性
        if (orderInfo && !orderInfo.status) {
          const stepStatus = searchStepStatusInData(data, 0)
          if (stepStatus) {
            orderInfo.status = stepStatus
            console.log(`[PurchaseSync-Taobao] 从API响应补充状态: ${stepStatus}`)
          }
        }

        return orderInfo
      }

      // 在整个 API 响应中递归搜索 pcDetailOrderStepVOList，提取订单步骤状态
      // 淘宝详情 API 的步骤数据不在组件 fields 中，而是在 linkage 区域
      function searchStepStatusInData(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 4) return null

        const stepToStatusMap = {
          '拍下宝贝': '等待买家付款',
          '买家付款': '买家已付款',
          '卖家发货': '卖家已发货',
          '确认收货': '交易成功'
        }

        // 找到 pcDetailOrderStepVOList 数组
        if (Array.isArray(obj.pcDetailOrderStepVOList) && obj.pcDetailOrderStepVOList.length > 0) {
          console.log(`[PurchaseSync-Taobao] 发现 pcDetailOrderStepVOList (depth=${depth}), ${obj.pcDetailOrderStepVOList.length} 个步骤`)
          // 优先找 orderStepStatus==="CURRENT" 的步骤
          for (const step of obj.pcDetailOrderStepVOList) {
            if (!step || typeof step !== 'object') continue
            if (step.orderStepStatus === 'CURRENT' && step.orderStep) {
              const mapped = stepToStatusMap[step.orderStep] || step.orderStep
              console.log(`[PurchaseSync-Taobao] 步骤状态: ${step.orderStep} → ${mapped} (CURRENT)`)
              return mapped
            }
          }
          // 回退：取最后一个 PASSED 的步骤
          for (let i = obj.pcDetailOrderStepVOList.length - 1; i >= 0; i--) {
            const step = obj.pcDetailOrderStepVOList[i]
            if (!step || typeof step !== 'object') continue
            if (step.orderStepStatus === 'PASSED' && step.orderStep) {
              const mapped = stepToStatusMap[step.orderStep] || step.orderStep
              console.log(`[PurchaseSync-Taobao] 步骤状态(回退PASSED): ${step.orderStep} → ${mapped}`)
              return mapped
            }
          }
          // 兜底：取第一个有 orderStep 的步骤
          for (const step of obj.pcDetailOrderStepVOList) {
            if (!step || typeof step !== 'object') continue
            const title = step.orderStep || step.stepTitle || step.title || step.text || ''
            if (title) {
              const mapped = stepToStatusMap[title] || title
              console.log(`[PurchaseSync-Taobao] 步骤状态(兜底): ${title} → ${mapped}`)
              return mapped
            }
          }
        }

        // 递归搜索子对象
        for (const val of Object.values(obj)) {
          if (!val || typeof val !== 'object') continue
          const result = searchStepStatusInData(val, depth + 1)
          if (result) return result
        }

        return null
      }

      // 组件格式解析（不依赖固定前缀，检查所有 id 或 key 匹配的组件）
      // 列表页: orderStatus_*, shopInfo_*, orderLogistics_*
      // 详情页: statusStepTm1_*, logisticsDetail_*, orderHeaderTm1_* 等
      function tryComponentFormat(data, targetOrderNo) {
        if (!data || typeof data !== 'object') return null
        const result = {
          order_no: targetOrderNo,
          status: '',
          logistics_no: '',
          logistics_company: '',
          logistics_company_code: '',
          logistics_status: '',
          logistics_tracking: null,
          purchase_price: ''
        }

        let hasInfo = false
        const matchedKeys = []
        let hasEmptyStatusStep = false // 是否存在空的statusStep组件（可能为交易关闭订单）

        for (const [key, component] of Object.entries(data)) {
          if (!component || typeof component !== 'object') continue

          // 按 id 匹配 或 按 key 包含订单号匹配
          // 额外匹配详情页关键组件：
          //   - statusStep/statusStepTm1：步骤条组件（详情页所有组件属于同一订单，id 可能不是订单号）
          //   - header：订单详情头部组件，fields.content 包含订单状态文本（如"卖家已发货"、"交易关闭"）
          //   - itemInfo：商品信息组件，fields.item.priceInfo 包含商品价格
          const tag = component.tag || ''
          const componentType = component.type || ''
          const isStatusStep = (tag === 'statusStep' || tag === 'statusStepTm1')
          const isDetailHeader = (tag === 'header' && componentType.includes('order_detail_header'))
          const isItemInfo = tag === 'itemInfo'
          const idMatch = component.id === targetOrderNo
          const keyMatch = key.includes(targetOrderNo)
          if (!idMatch && !keyMatch && !isStatusStep && !isDetailHeader && !isItemInfo) continue

          matchedKeys.push(key)
          const fields = component.fields || {}

          // 调试：记录匹配组件的 tag 和 fields 的所有 key
          const fieldKeys = Object.keys(fields)
          console.log(`[PurchaseSync-Taobao] 组件 [${key}] tag=${tag} type=${componentType || ''} fieldKeys=[${fieldKeys.join(',')}]`)

          // 检测空的 statusStep 组件（fieldKeys为空且tag为statusStep/statusStepTm1）
          // 这种情况通常出现在"交易关闭"订单中
          if ((tag === 'statusStep' || tag === 'statusStepTm1') && fieldKeys.length === 0) {
            hasEmptyStatusStep = true
            console.log(`[PurchaseSync-Taobao] 检测到空statusStep组件，可能为交易关闭订单`)
          }

          // 从 itemInfo 组件提取商品价格（订单详情页格式）
          // PC详情页: fields.item.priceInfo.actualTotalFee 如 "￥58.00"
          if (isItemInfo && !result.purchase_price) {
            const item = fields.item || {}
            const priceInfo = item.priceInfo || {}
            const fee = priceInfo.actualTotalFee || priceInfo.totalFee || ''
            if (fee) {
              const numStr = fee.replace(/[￥¥,]/g, '').trim()
              if (numStr && parseFloat(numStr) > 0) {
                result.purchase_price = numStr
                console.log(`[PurchaseSync-Taobao] itemInfo组件提取价格: ${fee} → ${numStr}`)
              }
            }
          }

          // 递归搜索 fields 内的所有嵌套对象，提取物流和状态字段
          extractFromFields(fields, result, tag, 0)
        }

        // 检查是否提取到了有效信息
        if (result.logistics_no || result.logistics_company_code || result.logistics_company ||
            result.status || result.logistics_status || result.purchase_price) {
          hasInfo = true
        }

        // 如果存在空的statusStep组件但未提取到状态，标记为"交易关闭"
        // 这是交易关闭订单的典型特征：有step组件但内容为空
        if (hasEmptyStatusStep && !result.status) {
          result.status = '交易关闭'
          hasInfo = true
          console.log(`[PurchaseSync-Taobao] 空statusStep兜底: 设置状态为"交易关闭"`)
        }

        if (hasInfo) {
          console.log(`[PurchaseSync-Taobao] 组件匹配keys: [${matchedKeys.join(',')}], status=${result.status}, logistics_no=${result.logistics_no}, cpCode=${result.logistics_company_code}, cpName=${result.logistics_company}, logistics_status=${result.logistics_status}`)
          result.logistics_company = resolveLogisticsCompany(result.logistics_company, result.logistics_company_code)
          return result
        }
        return null
      }

      // 递归提取组件 fields 中的物流和状态信息
      function extractFromFields(obj, result, tag, depth) {
        if (!obj || typeof obj !== 'object' || depth > 5) return

        if (Array.isArray(obj)) {
          for (const item of obj) {
            extractFromFields(item, result, tag, depth + 1)
          }
          return
        }

        // ---- 物流单号 ----
        if (!result.logistics_no) {
          if (obj.mailNo) result.logistics_no = obj.mailNo
          else if (obj.logisticsNo) result.logistics_no = obj.logisticsNo
          else if (obj.trackingNumber) result.logistics_no = obj.trackingNumber
          else if (obj.expressNo) result.logistics_no = obj.expressNo
        }

        // ---- 快递公司编码 ----
        if (!result.logistics_company_code) {
          if (obj.cpCode) result.logistics_company_code = obj.cpCode
          else if (obj.expressCode) result.logistics_company_code = obj.expressCode
          else if (obj.companyCode) result.logistics_company_code = obj.companyCode
        }

        // ---- 快递公司名称 ----
        if (!result.logistics_company) {
          if (obj.cpName) result.logistics_company = obj.cpName
          else if (obj.companyName) result.logistics_company = obj.companyName
          else if (obj.logisticsCompany) result.logistics_company = obj.logisticsCompany
          else if (obj.carrierName) result.logistics_company = obj.carrierName
          else if (obj.expressCompany) result.logistics_company = obj.expressCompany
          else if (obj.deliveryCompany) result.logistics_company = obj.deliveryCompany
          else if (obj.logisticsName) result.logistics_company = obj.logisticsName
          // 物流页 name 字段：与 mailNo 同层时通常是快递公司名
          else if (obj.name && obj.mailNo && typeof obj.name === 'string' && obj.name.length > 1) {
            result.logistics_company = obj.name
          }
        }

        // ---- 订单状态（来自详情页组件） ----
        if (!result.status) {
          // header 组件的 fields.content 包含订单状态文本（如"卖家已发货"、"交易关闭"、"买家已付款"等）
          if (obj.content && typeof obj.content === 'string' && tag === 'header') result.status = obj.content
          else if (obj.tradeTitle) result.status = obj.tradeTitle
          else if (obj.orderStep && typeof obj.orderStep === 'string') result.status = obj.orderStep
          else if (obj.statusText) result.status = obj.statusText
          else if (obj.orderStatusText) result.status = obj.orderStatusText
          else if (obj.tradeStatus) result.status = obj.tradeStatus
          else if (obj.statusDesc) result.status = obj.statusDesc
          else if (obj.actionTitle) result.status = obj.actionTitle
          else if (obj.stepTitle) result.status = obj.stepTitle
        }

        // ---- 物流状态 ----
        if (!result.logistics_status) {
          if (obj.title && typeof obj.title === 'string' && tag.includes('Status')) {
            result.logistics_status = obj.title
          }
        }

        // ---- 特殊结构处理 ----

        // companyInfos: 详情页用此字段存储快递公司信息
        // 格式: [{cpCode:"YTO", cpName:"圆通速递"}, ...]
        if (Array.isArray(obj.companyInfos) && obj.companyInfos.length > 0) {
          console.log(`[PurchaseSync-Taobao] 发现 companyInfos: ${JSON.stringify(obj.companyInfos[0])}`)
          extractFromFields(obj.companyInfos[0], result, tag, depth + 1)
        }

        // pcDetailOrderStepVOList: 详情页用此字段存储订单状态步骤
        // 实际结构: [{orderStep:"拍下宝贝", orderStepStatus:"PASSED"},
        //            {orderStep:"买家付款", orderStepStatus:"PASSED"},
        //            {orderStep:"卖家发货", orderStepStatus:"CURRENT"},
        //            {orderStep:"确认收货", orderStepStatus:"NOT_REACHED"}]
        // 注意: orderStep 是步骤进度名称，不是淘宝订单状态文本
        // 需要映射为实际状态: 拍下宝贝→等待买家付款, 买家付款→买家已付款,
        //                   卖家发货→卖家已发货, 确认收货→交易成功
        const stepToStatusMap = {
          '拍下宝贝': '等待买家付款',
          '买家付款': '买家已付款',
          '卖家发货': '卖家已发货',
          '确认收货': '交易成功'
        }
        if (Array.isArray(obj.pcDetailOrderStepVOList) && obj.pcDetailOrderStepVOList.length > 0) {
          // 优先找 orderStepStatus==="CURRENT" 的步骤
          for (const step of obj.pcDetailOrderStepVOList) {
            if (!step || typeof step !== 'object') continue
            if (step.orderStepStatus === 'CURRENT' && step.orderStep) {
              if (!result.status) {
                const mappedStatus = stepToStatusMap[step.orderStep] || step.orderStep
                result.status = mappedStatus
                console.log(`[PurchaseSync-Taobao] 发现步骤状态: ${step.orderStep} → ${mappedStatus} (CURRENT)`)
              }
            }
          }
          // 如果没找到 CURRENT，取最后一个 PASSED 的步骤
          if (!result.status) {
            for (let i = obj.pcDetailOrderStepVOList.length - 1; i >= 0; i--) {
              const step = obj.pcDetailOrderStepVOList[i]
              if (!step || typeof step !== 'object') continue
              if (step.orderStepStatus === 'PASSED' && step.orderStep) {
                const mappedStatus = stepToStatusMap[step.orderStep] || step.orderStep
                result.status = mappedStatus
                console.log(`[PurchaseSync-Taobao] 发现步骤状态(回退PASSED): ${step.orderStep} → ${mappedStatus}`)
                break
              }
            }
          }
          // 最后兜底：取任何有 orderStep 的步骤
          if (!result.status) {
            for (const step of obj.pcDetailOrderStepVOList) {
              if (!step || typeof step !== 'object') continue
              const title = step.orderStep || step.content || step.stepTitle || step.title || step.text || ''
              if (title) {
                result.status = title
                console.log(`[PurchaseSync-Taobao] 发现步骤状态(兜底): ${title}`)
                break
              }
            }
          }
        }

        // logisticsData: 详情页物流地址组件中的物流数据
        if (obj.logisticsData && typeof obj.logisticsData === 'object') {
          extractFromFields(obj.logisticsData, result, tag, depth + 1)
        }

        // packagePreview.packageViewList
        if (obj.packagePreview && obj.packagePreview.packageViewList) {
          const list = obj.packagePreview.packageViewList
          if (list.length > 0) {
            extractFromFields(list[0], result, tag, depth + 1)
          }
        }

        // subLogisticsList
        if (Array.isArray(obj.subLogisticsList)) {
          for (const sub of obj.subLogisticsList) {
            extractFromFields(sub, result, tag, depth + 1)
          }
        }

        // 物流轨迹提取（从组件字段中搜索轨迹数组）
        if (!result.logistics_tracking) {
          const tracking = extractTrackingFromData(obj, 0) // depth=0 仅检查当前层
          if (tracking) {
            result.logistics_tracking = tracking
          }
        }

        // 递归搜索子对象（排除已处理的结构）
        for (const val of Object.values(obj)) {
          if (val && typeof val === 'object' && !Array.isArray(val) &&
              val !== obj.packagePreview && val !== obj.logisticsData &&
              !obj.subLogisticsList?.includes(val) && !obj.companyInfos?.includes(val)) {
            extractFromFields(val, result, tag, depth + 1)
          }
        }
      }

      // mainOrder 格式提取（类似 parseSearchResponse 但用于单个订单）
      function extractMainOrderInfo(order, targetOrderNo) {
        const result = {
          order_no: String(order.id || order.orderId || targetOrderNo),
          status: '',
          logistics_no: '',
          logistics_company: '',
          logistics_company_code: '',
          logistics_status: '',
          logistics_tracking: null,
          purchase_price: ''
        }

        const extra = order.extra || {}
        if (extra.tradeStatus) result.status = extra.tradeStatus
        const statusInfo = order.statusInfo || {}
        if (statusInfo.title) result.status = statusInfo.title
        if (statusInfo.text) result.logistics_status = statusInfo.text

        // 从多个位置提取物流信息
        const sources = [
          order.logisticsInfo, order.logistics,
          statusInfo.logistics,
          order.subOrders && order.subOrders[0] && (order.subOrders[0].logisticsInfo || order.subOrders[0].logistics),
          order.orderInfo
        ]

        for (const lo of sources) {
          if (!lo || typeof lo !== 'object') continue
          if (!result.logistics_no && lo.mailNo) result.logistics_no = lo.mailNo
          if (!result.logistics_company_code && lo.cpCode) result.logistics_company_code = lo.cpCode
          if (!result.logistics_company && lo.cpName) result.logistics_company = lo.cpName
          if (!result.logistics_company && lo.companyName) result.logistics_company = lo.companyName
          if (!result.logistics_company && lo.logisticsCompany) result.logistics_company = lo.logisticsCompany
          if (!result.logistics_status && lo.statusDesc) result.logistics_status = lo.statusDesc
        }

        // 提取商品价格（从 payInfo）
        const payInfo = order.payInfo || {}
        if (payInfo.actualFee && parseFloat(payInfo.actualFee) > 0) {
          result.purchase_price = String(parseFloat(payInfo.actualFee))
        } else if (payInfo.shouldPay && parseFloat(payInfo.shouldPay) > 0) {
          result.purchase_price = String(parseFloat(payInfo.shouldPay))
        }

        // 直接字段
        if (!result.logistics_no && order.mailNo) result.logistics_no = order.mailNo
        if (!result.logistics_no && order.trackingNumber) result.logistics_no = order.trackingNumber
        if (!result.logistics_company && order.cpName) result.logistics_company = order.cpName
        if (!result.logistics_company_code && order.cpCode) result.logistics_company_code = order.cpCode

        // 物流轨迹提取
        if (!result.logistics_tracking) {
          result.logistics_tracking = extractTrackingFromData(order, 2)
        }

        if (result.logistics_no || result.logistics_company || result.logistics_company_code || result.status) {
          result.logistics_company = resolveLogisticsCompany(result.logistics_company, result.logistics_company_code)
          return result
        }
        return null
      }

      // 通用对象物流提取
      function extractLogisticsFromObject(obj, targetOrderNo) {
        const lo = obj.logisticsInfo || obj.logistics || {}
        const mailNo = obj.mailNo || obj.logisticsNo || obj.trackingNumber || obj.expressNo || lo.mailNo || ''
        let cpCode = obj.cpCode || obj.expressCode || obj.companyCode || lo.cpCode || ''
        let cpName = obj.cpName || obj.logisticsCompany || obj.companyName || obj.carrierName ||
          obj.expressCompany || obj.deliveryCompany || obj.logisticsName ||
          lo.cpName || lo.companyName || ''

        // companyInfos: 详情页格式 [{cpCode, cpName, ...}]
        if (!cpName && !cpCode && Array.isArray(obj.companyInfos) && obj.companyInfos.length > 0) {
          const info = obj.companyInfos[0]
          if (info && typeof info === 'object') {
            if (!cpCode && info.cpCode) cpCode = info.cpCode
            if (!cpName && info.cpName) cpName = info.cpName
            if (!cpName && info.companyName) cpName = info.companyName
          }
        }

        // name: 物流页格式，与 mailNo 同层时通常是快递公司名
        if (!cpName && obj.name && obj.mailNo && typeof obj.name === 'string' && obj.name.length > 1) {
          cpName = obj.name
        }

        // 提取状态：支持更多字段名（data.model 格式可能用不同的字段名）
        let status = obj.status || obj.orderStatus || obj.tradeStatus || obj.tradeTitle ||
          obj.statusText || obj.statusDesc || obj.orderStatusText || obj.tradeStatusText || ''

        // statusInfo 嵌套结构：{title:"交易关闭", text:"..."}
        if (!status && obj.statusInfo && typeof obj.statusInfo === 'object') {
          status = obj.statusInfo.title || obj.statusInfo.text || ''
        }
        // extra 嵌套结构
        if (!status && obj.extra && typeof obj.extra === 'object') {
          status = obj.extra.tradeStatus || obj.extra.orderStatus || ''
        }
        // 数字状态映射（data.model 中的 orderStatus 可能是数字）
        if (!status && typeof obj.orderStatus === 'number') {
          const numStatusMap = { 1: '等待买家付款', 2: '买家已付款', 3: '卖家已发货', 4: '已签收', 5: '交易关闭', 6: '交易关闭', 7: '退款中', 8: '退款成功' }
          status = numStatusMap[obj.orderStatus] || ''
        }

        // 提取价格（从 payInfo）
        let purchase_price = ''
        const payInfo = obj.payInfo || {}
        if (payInfo.actualFee && parseFloat(payInfo.actualFee) > 0) {
          purchase_price = String(parseFloat(payInfo.actualFee))
        } else if (payInfo.shouldPay && parseFloat(payInfo.shouldPay) > 0) {
          purchase_price = String(parseFloat(payInfo.shouldPay))
        }

        if (mailNo || cpName || cpCode || status) {
          // 尝试提取物流轨迹
          const tracking = extractTrackingFromData(obj, 2)
          return {
            order_no: targetOrderNo,
            status,
            logistics_no: mailNo,
            logistics_company: resolveLogisticsCompany(cpName, cpCode),
            logistics_company_code: cpCode,
            logistics_status: lo.statusDesc || '',
            logistics_tracking: tracking,
            purchase_price
          }
        }
        return null
      }

      // 深度递归搜索物流字段（最后兜底）
      function deepSearchLogistics(obj, targetOrderNo, depth) {
        if (!obj || typeof obj !== 'object' || depth > 5) return null

        // 检查当前对象是否包含物流单号相关字段
        const hasLogisticsNo = obj.mailNo || obj.logisticsNo || obj.trackingNumber || obj.expressNo
        const hasLogisticsObj = (obj.logisticsInfo && typeof obj.logisticsInfo === 'object') ||
          (obj.logistics && typeof obj.logistics === 'object')

        if (hasLogisticsNo || hasLogisticsObj) {
          // 找到包含物流信息的对象，记录所有字段名便于调试
          const allKeys = Object.keys(obj)
          console.log(`[PurchaseSync-Taobao] 深度搜索命中 depth=${depth}, keys=[${allKeys.join(',')}]`)
          const info = extractLogisticsFromObject(obj, targetOrderNo)
          if (info) return info
        }

        // 递归搜索子对象
        for (const key of Object.keys(obj)) {
          const child = obj[key]
          if (!child || typeof child !== 'object') continue
          const result = deepSearchLogistics(child, targetOrderNo, depth + 1)
          if (result) return result
        }

        return null
      }

      // 入口：加载订单列表页（不带任何URL参数）
      console.log('[PurchaseSync-Taobao] Loading:', PLATFORM_CONFIG.entryUrl)
      win.loadURL(PLATFORM_CONFIG.entryUrl)

    } catch (err) {
      finish({ success: false, message: '同步失败: ' + err.message })
    }
  } catch (err) {
    if (!resolved) {
      resolved = true
      activeSyncs.delete(syncKey)
      if (win && !win.isDestroyed()) win.destroy()
      reject(err)
    }
  }
  })
}

// ============ 批量订单同步 ============

function syncAll(accountId) {
  return new Promise(async (resolve, reject) => {
    const syncKey = `${accountId}-taobao`
    let resolved = false
    let win = null
  try {
    if (activeSyncs.has(syncKey)) {
      return resolve({ success: false, message: '该账号正在同步中，请等待完成' })
    }

    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)
    let cookies = await ses.cookies.get({})

    console.log(`[PurchaseSync-Taobao-All] accountId:${accountId}`)
    console.log(`[PurchaseSync-Taobao-All] Cookies: ${cookies.length} 条`)

    // 优化：先检查 partition 是否已有有效平台 cookies，有则跳过服务器恢复
    if (hasValidPlatformCookies(cookies, 'taobao')) {
      console.log(`[PurchaseSync-Taobao-All] partition 已有有效平台 cookies，跳过服务器恢复`)
    } else {
      console.log(`[PurchaseSync-Taobao-All] partition 缺少有效平台 cookies，从服务器恢复（合并模式）...`)
      const restoreResult = await restoreCookiesFromServer(accountId, 'taobao')
      if (restoreResult.restored) {
        cookies = await ses.cookies.get({})
        console.log(`[PurchaseSync-Taobao-All] cookie 恢复完成：${restoreResult.count} 条补充，${restoreResult.skipped} 条保留，当前 Cookies: ${cookies.length} 条`)
      }
    }

    if (!hasValidPlatformCookies(cookies, 'taobao')) {
      return resolve({ success: false, message: '该采购账号未登录，请先点击"登录"按钮登录账号' })
    }

    let overallTimer = null
    let cdpCapture = null
    let allCapturedResponses = []

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      activeSyncs.delete(syncKey)
      try {
        ses.webRequest.onBeforeSendHeaders(null)
      } catch (e) {}
      if (cdpCapture) { cdpCapture.detach().catch(() => {}); cdpCapture = null }
      if (win && !win.isDestroyed()) {
        win.destroy()
      }
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    overallTimer = setTimeout(() => {
      console.log(`[PurchaseSync-Taobao-All] 总超时，已捕获 ${allCapturedResponses.length} 个 API 响应`)
      if (allCapturedResponses.length > 0) {
        const orders = findAllOrders(allCapturedResponses)
        finish({ success: true, orders, message: `同步超时，已获取 ${orders.length} 条订单` })
      } else {
        finish({ success: false, message: '同步超时，请稍后重试' })
      }
    }, OVERALL_TIMEOUT)

    try {
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        title: '[批量同步] 淘宝采购订单',
        webPreferences: {
          partition: partitionName,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })

      win.webContents.setBackgroundThrottling(false)
      activeSyncs.set(syncKey, win)

      // BrowserWindow 意外关闭时清理 activeSyncs，防止残留阻塞后续同步
      win.on('closed', () => {
        if (!resolved) {
          console.log('[PurchaseSync-Taobao-All] BrowserWindow 被意外关闭')
          activeSyncs.delete(syncKey)
          win = null
          finish({ success: false, message: '同步窗口意外关闭' })
        }
      })

      let cdpAttached = false

      win.webContents.on('did-navigate', async (event, url) => {
        console.log('[PurchaseSync-Taobao-All] navigate:', url.substring(0, 150))
        if (PLATFORM_CONFIG.loginCheck(url)) {
          finish({ success: false, message: '采购账号登录已过期，请重新登录该账号', needsRelogin: true })
          return
        }
        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, PLATFORM_CONFIG.apiKeywords)
          try {
            cdpAttached = await cdpCapture.attach()
            console.log(`[PurchaseSync-Taobao-All] CDP attach after navigate: ${cdpAttached ? 'OK' : 'FAIL'}`)
          } catch (e) {
            console.warn('[PurchaseSync-Taobao-All] CDP attach error:', e.message)
          }
        }
      })

      win.webContents.on('dom-ready', () => {
        if (win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(VISIBILITY_OVERRIDE).catch(() => {})
        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, PLATFORM_CONFIG.apiKeywords)
          cdpCapture.attach().then(ok => {
            cdpAttached = ok
            console.log(`[PurchaseSync-Taobao-All] CDP attach on dom-ready: ${ok ? 'OK' : 'FAIL'}`)
          }).catch(e => {
            console.warn('[PurchaseSync-Taobao-All] CDP attach on dom-ready failed:', e.message)
          })
        }
      })

      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log('[PurchaseSync-Taobao-All] loaded:', currentUrl.substring(0, 150))
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          pollForData()
        }, 3000)
      })

      function pollForData() {
        let pollCount = 0
        let stableCount = 0

        function poll() {
          if (win.isDestroyed() || resolved) return
          pollCount++

          const newResponses = cdpCapture ? cdpCapture.getCaptured() : []

          if (newResponses.length > 0) {
            allCapturedResponses.push(...newResponses)
            stableCount = 0
            console.log(`[PurchaseSync-Taobao-All] poll #${pollCount}: +${newResponses.length} APIs (total: ${allCapturedResponses.length})`)
          } else {
            stableCount++
            console.log(`[PurchaseSync-Taobao-All] poll #${pollCount}: 无新 API (stable: ${stableCount})`)
          }

          if (stableCount >= 3 && allCapturedResponses.length > 0) {
            const orders = findAllOrders(allCapturedResponses)
            console.log(`[PurchaseSync-Taobao-All] 页面数据稳定，共获取 ${orders.length} 条订单`)
            finish({ success: true, orders })
            return
          }

          if (pollCount < MAX_POLLS) {
            setTimeout(poll, POLL_INTERVAL)
          } else {
            const orders = findAllOrders(allCapturedResponses)
            if (orders.length > 0) {
              finish({ success: true, orders, message: `轮询结束，获取 ${orders.length} 条订单` })
            } else {
              finish({ success: false, message: '未获取到任何订单数据' })
            }
          }
        }

        poll()
      }

      console.log('[PurchaseSync-Taobao-All] Loading:', PLATFORM_CONFIG.entryUrl)
      win.loadURL(PLATFORM_CONFIG.entryUrl)

    } catch (err) {
      finish({ success: false, message: '同步失败: ' + err.message })
    }
  } catch (err) {
    if (!resolved) {
      resolved = true
      activeSyncs.delete(syncKey)
      if (win && !win.isDestroyed()) win.destroy()
      reject(err)
    }
  }
  })
}

module.exports = {
  PLATFORM_CONFIG,
  parseResponse,
  syncSingle,
  syncAll
}
